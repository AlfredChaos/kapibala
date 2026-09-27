// T-P2-08 c)：入站 message 投影 + own 回流合并 + agent 触发入口（DES/05 §3、§4.1–§4.4、
// REQ §2.1 S2/S3、REQ A2、DES/06 §2 单飞行）。真 DB（withTestDb）；handler 经
// dispatchEvent 真实分发路径（ctx.client = 事件事务载体）。
// 覆盖：外部新消息落行 + ws_event + agent 触发（run 行/trigger_context 形状）；
// (groupId,msgId) 重推吸收不重复触发（S2）；回流命中回填行幂等跳过与无行占位插入（S3）；
// 守卫（active+agentEnabled）不过时不触发；单飞行冲突进 agent_trigger_queue（A5-1）；
// triggerMessages 的 sentAt 升序字段形状（REQ §2.2）；orphan 兜底（映射缺失 → skip）。
import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { withTestDb } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { createMessageHandler } from '../../src/events/handlers/message.js';
import { dispatchEvent, type GatewayEventEnvelope } from '../../src/events/dispatch.js';
import { createDispatchRegistry } from '../../src/events/dispatch.js';

// —— 夹具 ——

const logger = { warn: () => {} };

interface InsertedGroup {
  id: string;
  gatewayGroupId: string;
}

async function insertGroup(
  pool: Pool,
  opts: { status?: string; agentEnabled?: boolean; autoKickEnabled?: boolean; gatewayGroupId?: string } = {},
): Promise<InsertedGroup> {
  const gatewayGroupId = opts.gatewayGroupId ?? `gw-${Math.random().toString(36).slice(2, 10)}`;
  const res = await pool.query<{ id: string }>(
    `INSERT INTO "group" (id, gateway_group_id, status, creator_account_id, agent_enabled, auto_kick_enabled)
     VALUES (gen_random_uuid(), $1, $2, 'acc-01', $3, $4) RETURNING id`,
    [gatewayGroupId, opts.status ?? 'active', opts.agentEnabled ?? false, opts.autoKickEnabled ?? false],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('group insert failed');
  return { id: row.id, gatewayGroupId };
}

async function setPuid(pool: Pool, accountId: string, puid: string): Promise<void> {
  await pool.query('UPDATE account SET platform_user_id=$2 WHERE id=$1', [accountId, puid]);
}

interface MsgEventOpts {
  eventId?: number;
  groupId: string;
  msgId: string;
  senderPlatformUserId: string;
  text?: string;
  sentAt?: string;
  mediaUrl?: string;
}

let seq = 0;

async function deliver(pool: Pool, ev: MsgEventOpts): Promise<void> {
  seq += 1;
  const payload: Record<string, unknown> = {
    groupId: ev.groupId,
    msgId: ev.msgId,
    senderPlatformUserId: ev.senderPlatformUserId,
    text: ev.text ?? 'hello',
    sentAt: ev.sentAt ?? new Date().toISOString(),
  };
  if (ev.mediaUrl !== undefined) payload['mediaUrl'] = ev.mediaUrl;
  const envelope: GatewayEventEnvelope = {
    eventId: ev.eventId ?? 1000 + seq,
    type: 'message',
    payload,
  };
  const registry = createDispatchRegistry();
  registry.register('message', createMessageHandler());
  await tx(pool, async (client: PoolClient) => {
    await client.query(
      'INSERT INTO gateway_event (event_id, type, payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (event_id) DO NOTHING',
      [envelope.eventId, 'message', JSON.stringify(payload)],
    );
    await dispatchEvent(registry, { client, event: envelope, logger });
  });
}

interface MessageRow {
  is_own: boolean;
  delivery_status: string | null;
  client_msg_id: string | null;
  account_id: string | null;
  text: string;
  media_url: string | null;
}

async function readMessages(pool: Pool, groupId: string): Promise<MessageRow[]> {
  const res = await pool.query<MessageRow>(
    'SELECT is_own, delivery_status, client_msg_id, account_id, text, media_url FROM message WHERE group_id=$1 ORDER BY id',
    [groupId],
  );
  return res.rows;
}

async function runsFor(pool: Pool, groupId: string): Promise<Array<{ id: string; status: string; trigger_context: Record<string, unknown> }>> {
  const res = await pool.query<{ id: string; status: string; trigger_context: Record<string, unknown> }>(
    'SELECT id, status, trigger_context FROM agent_run WHERE group_id=$1 ORDER BY created_at',
    [groupId],
  );
  return res.rows;
}

async function queuedFor(pool: Pool, groupId: string): Promise<number[]> {
  const res = await pool.query<{ message_id: string }>(
    'SELECT message_id FROM agent_trigger_queue WHERE group_id=$1 ORDER BY id',
    [groupId],
  );
  return res.rows.map((r) => Number(r.message_id));
}

async function wsEvents(pool: Pool, type: string): Promise<Array<{ payload: Record<string, unknown> }>> {
  const res = await pool.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM ws_event WHERE type=$1 ORDER BY seq',
    [type],
  );
  return res.rows;
}

// —— 用例 ——

describe('inbound message projection + agent trigger (T-P2-08)', () => {
  it('external message → is_own=false, delivery_status=NULL row + ws_event(message); agentEnabled active group → running run with contract trigger_context (DES/05 §3/§4.4, REQ §2.2)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setPuid(pool, 'acc-01', 'puid-a1');
      await setPuid(pool, 'acc-02', 'puid-a2');
      const g = await insertGroup(pool, { agentEnabled: true });

      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-1', senderPlatformUserId: 'ext-user-1', text: 'hi', mediaUrl: 'http://gw/media/9' });

      const rows = await readMessages(pool, g.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        is_own: false,
        delivery_status: null, // 入站外部消息无投递状态（§5.3 语义）
        client_msg_id: null,
        account_id: null, // 发送者不是服务账号
        text: 'hi',
        media_url: 'http://gw/media/9',
      });

      const events = await wsEvents(pool, 'message');
      expect(events).toEqual([
        { payload: { groupId: g.id, msgId: 'm-1', isOwn: false } }, // clientMsgId/deliveryStatus 仅 own 携带
      ]);

      const runs = await runsFor(pool, g.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('running');
      expect(runs[0]?.trigger_context).toMatchObject({
        groupId: g.id,
        triggerMessages: [
          { msgId: 'm-1', senderPlatformUserId: 'ext-user-1', text: 'hi', sentAt: expect.any(String) },
        ],
        policy: { autoKickEnabled: false },
        ownPlatformUserIds: expect.arrayContaining(['puid-a1', 'puid-a2']),
      });
      const runEvents = await wsEvents(pool, 'agent_run');
      expect(runEvents).toEqual([
        { payload: { runId: runs[0]?.id, groupId: g.id, status: 'running', endReason: null } },
      ]);
    });
  });

  it('duplicate (groupId,msgId) re-push absorbed → single row, no second ws_event, no second run, no trigger_queue row (S2)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      const g = await insertGroup(pool, { agentEnabled: true });

      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-9', senderPlatformUserId: 'ext-1' });
      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-9', senderPlatformUserId: 'ext-1' }); // 重推
      await deliver(pool, { eventId: 1, groupId: g.gatewayGroupId, msgId: 'm-9', senderPlatformUserId: 'ext-1' }); // 账本也已吸收过的再投（eventId 不同步也会走分发——消息层仍须幂等）

      expect(await readMessages(pool, g.id)).toHaveLength(1);
      expect(await wsEvents(pool, 'message')).toHaveLength(1);
      expect(await runsFor(pool, g.id)).toHaveLength(1); // 第一次触发成功后单飞行占位
      expect(await queuedFor(pool, g.id)).toHaveLength(0); // 没有真实新消息 → 零积压
    });
  });

  it('own reflux without existing row → is_own=true, delivery_status=sent, client_msg_id=NULL placeholder (S3; §4.3 merge target), no agent trigger', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setPuid(pool, 'acc-01', 'puid-a1');
      const g = await insertGroup(pool, { agentEnabled: true }); // 触发守卫即便满足也不许触发（A2）

      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-own-1', senderPlatformUserId: 'puid-a1', text: 'mine' });

      const rows = await readMessages(pool, g.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        is_own: true,
        delivery_status: 'sent',
        client_msg_id: null, // 等 message_sent 的 finalizeSent 补关联（§4.3）
        account_id: 'acc-01',
        text: 'mine',
      });
      expect(await wsEvents(pool, 'message')).toEqual([
        { payload: { groupId: g.id, msgId: 'm-own-1', isOwn: true, deliveryStatus: 'sent' } },
      ]);
      expect(await runsFor(pool, g.id)).toHaveLength(0); // 回流不触发
      expect(await queuedFor(pool, g.id)).toHaveLength(0);
    });
  });

  it('own reflux onto backfilled row (message_sent landed first) → idempotent skip: row count 1, no extra ws_event, no trigger (§4.1/§4.2)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await setPuid(pool, 'acc-01', 'puid-a1');
      const g = await insertGroup(pool, { agentEnabled: true });
      // 模拟 message_sent 先到的回填行（出站身份的完整行）
      await pool.query(
        `INSERT INTO message (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, account_id)
         VALUES ($1,'m-own-2','cm-7','puid-a1',true,'operator','out msg',now(),'sent','acc-01')`,
        [g.id],
      );

      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-own-2', senderPlatformUserId: 'puid-a1', text: 'out msg' });

      const rows = await readMessages(pool, g.id);
      expect(rows).toHaveLength(1); // 一行原则：回流被吸收，不产生第二行
      expect(rows[0]?.client_msg_id).toBe('cm-7');
      expect(await wsEvents(pool, 'message')).toHaveLength(0); // 跳过即零事件
      expect(await runsFor(pool, g.id)).toHaveLength(0);
    });
  });

  it('second external message while a run is running → agent_trigger_queue row (single-flight A5-1); queue dedup on re-delivery', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      const g = await insertGroup(pool, { agentEnabled: true });
      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-1', senderPlatformUserId: 'ext-1' });
      expect(await runsFor(pool, g.id)).toHaveLength(1);

      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-2', senderPlatformUserId: 'ext-1' });
      const queue = await queuedFor(pool, g.id);
      expect(queue).toHaveLength(1); // running run 冲突 → 积压（message_id 指向 m-2 行）

      // 同一事件的投递层重放（账本吸收后 dispatch 仍跑到 handler）：幂等不产生第二行
      await deliver(pool, { groupId: g.gatewayGroupId, msgId: 'm-2', senderPlatformUserId: 'ext-1' });
      expect(await queuedFor(pool, g.id)).toHaveLength(1);
      expect(await runsFor(pool, g.id)).toHaveLength(1); // 不补建 run
    });
  });

  it('guard: non-active group and agentEnabled=false groups never trigger (message still lands); trigger entry returns skipped', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      const unreachable = await insertGroup(pool, { status: 'unreachable', agentEnabled: true });
      const offAgent = await insertGroup(pool, { status: 'active', agentEnabled: false });

      await deliver(pool, { groupId: unreachable.gatewayGroupId, msgId: 'm-u', senderPlatformUserId: 'ext-1' });
      await deliver(pool, { groupId: offAgent.gatewayGroupId, msgId: 'm-o', senderPlatformUserId: 'ext-1' });

      expect(await readMessages(pool, unreachable.id)).toHaveLength(1); // 消息照常入库
      expect(await readMessages(pool, offAgent.id)).toHaveLength(1);
      expect(await runsFor(pool, unreachable.id)).toHaveLength(0);
      expect(await runsFor(pool, offAgent.id)).toHaveLength(0);
      expect(await queuedFor(pool, unreachable.id)).toHaveLength(0); // 守卫不过时也不积压（与 END2/SWEEP 同判）
      expect(await queuedFor(pool, offAgent.id)).toHaveLength(0);
    });
  });

  it('unmapped gateway groupId → skip with zero rows (defensive; orphan.ts upstream)', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);
      await deliver(pool, { groupId: 'gw-no-such', msgId: 'm-x', senderPlatformUserId: 'ext-1' });
      const res = await pool.query('SELECT count(*)::int AS n FROM message');
      expect(res.rows[0]?.n).toBe(0);
      expect(await wsEvents(pool, 'message')).toHaveLength(0);
    });
  });
});
