// 幂等 key 生命周期测试（T-P4-09 c 项；REQ A5-7 逐条 + DES/06 §8.2 + E13 + 解读 #18）。
// 核心不变式：key 行存在 ⇔ 该 key 已「审计 pass + 消息已建」；所有拒绝路径不落行。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { consumeIdempotencyKey, lookupIdempotencyKey } from '../../src/modules/agent/idempotency.js';
import { execSendMessage } from '../../src/modules/agent/tools/send-message.js';

describe('agent_idempotency_key（A5-7/E13）', () => {
  let db: TestDbHandle;
  let runId: string;
  let groupId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE group_member, "group", ws_event, account, agent_run_step, agent_run,
               agent_idempotency_key, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    await db.pool.query(`UPDATE account SET status='online', platform_user_id='puid-01' WHERE id='acc-01'`);
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`);
    groupId = g[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-01','puid-01','member')`,
      [groupId]);
    const { rows: r } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds') RETURNING id`,
      [groupId]);
    runId = r[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, dispatch_payload, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'turn_received', '{}'::jsonb, '[]'::jsonb)`, [runId]);
  });

  it('消耗与查询：未消耗 → undefined；消耗后命中且带出 client_msg_id', async () => {
    await tx(db.pool, async (c) => {
      expect(await lookupIdempotencyKey(c, runId, 'k-1')).toBeUndefined();
      await consumeIdempotencyKey(c, { runId, key: 'k-1', clientMsgId: 'cm-1' });
      const hit = await lookupIdempotencyKey(c, runId, 'k-1');
      expect(hit).toEqual({ clientMsgId: 'cm-1' });
      // 跨 run 隔离：别的 run 同名 key 不命中
      expect(await lookupIdempotencyKey(c, runId, 'k-other')).toBeUndefined(); // 同 run 异 key 不命中（跨 run 隔离由 PK(run_id,key) 承担）
    });
  });

  it('(run_id,key) PK 阻止二次消耗（A5-7 表级唯一约束）', async () => {
    await tx(db.pool, (c) => consumeIdempotencyKey(c, { runId, key: 'k-1', clientMsgId: 'cm-1' }));
    await expect(
      tx(db.pool, (c) => consumeIdempotencyKey(c, { runId, key: 'k-1', clientMsgId: 'cm-2' })),
    ).rejects.toThrow(); // PK 冲突
    const hit = await tx(db.pool, (c) => lookupIdempotencyKey(c, runId, 'k-1'));
    expect(hit).toEqual({ clientMsgId: 'cm-1' }); // 首次记录不被覆盖
  });

  it('T13 同事务性：key 行与 message(queued) 与 step tool_dispatched 同生共死', async () => {
    const outcome = await tx(db.pool, (c) =>
      execSendMessage(
        { client: c, runId, groupId, stepSeq: 1, input: { text: 'hi', idempotency_key: 'k-9' } },
        { pool: db.pool, waiter: async () => ({ delivery_status: 'accepted', fail_code: null }) },
      ),
    );
    expect(outcome).toMatchObject({ type: 'result' });
    const { rows: keys } = await db.pool.query(
      'SELECT client_msg_id FROM agent_idempotency_key WHERE run_id=$1 AND idempotency_key=$2',
      [runId, 'k-9']);
    expect(keys.length).toBe(1);
    const { rows: msgs } = await db.pool.query(
      "SELECT delivery_status, source, account_id FROM message WHERE client_msg_id=$1",
      [keys[0]?.client_msg_id ?? '']);
    expect(msgs[0]).toMatchObject({ delivery_status: 'queued', source: 'agent', account_id: 'acc-01' });
    const { rows: steps } = await db.pool.query(
      'SELECT status, client_msg_id, audit_verdict FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
    expect(steps[0]).toMatchObject({ status: 'tool_dispatched', audit_verdict: 'pass' });
    expect(steps[0]?.client_msg_id).toBe(keys[0]?.client_msg_id);
  });

  it('GATE1 不过（群 unreachable）→ GROUP_UNREACHABLE 且 key 不落行（解读 #18）', async () => {
    await db.pool.query(`UPDATE "group" SET status='unreachable' WHERE id=$1`, [groupId]);
    const out = await tx(db.pool, (c) =>
      execSendMessage(
        { client: c, runId, groupId, stepSeq: 1, input: { text: 'hi', idempotency_key: 'k-gu' } },
        { pool: db.pool },
      ),
    );
    expect(out).toMatchObject({ type: 'result', isError: true });
    if (out.type === 'result') expect(out.content).toContain('GROUP_UNREACHABLE');
    expect(await tx(db.pool, (c) => lookupIdempotencyKey(c, runId, 'k-gu'))).toBeUndefined();
    const { rows: msgs } = await db.pool.query('SELECT count(*)::int AS n FROM message WHERE group_id=$1', [groupId]);
    expect(msgs[0]?.n).toBe(0);
  });

  it('无 online 群成员 → NO_AVAILABLE_ACCOUNT（is_error、计步不归协议错误）且 key 不落行', async () => {
    await db.pool.query(`UPDATE account SET status='idle' WHERE id='acc-01'`); // 非 online 态（status 约束无 'offline'）
    const out = await tx(db.pool, (c) =>
      execSendMessage(
        { client: c, runId, groupId, stepSeq: 1, input: { text: 'hi', idempotency_key: 'k-na' } },
        { pool: db.pool },
      ),
    );
    if (out.type === 'result') expect(out.content).toContain('NO_AVAILABLE_ACCOUNT');
    expect(await tx(db.pool, (c) => lookupIdempotencyKey(c, runId, 'k-na'))).toBeUndefined();
  });

  it('命中路径按消息现状回结果（sent → 正常返回不 is_error；S5 第二次调用返 sent）', async () => {
    // 先消耗 key + 造出「已 sent」消息行（模拟首次调用已发成）
    await tx(db.pool, async (c) => {
      await consumeIdempotencyKey(c, { runId, key: 'k-hit', clientMsgId: 'cm-hit' });
      await c.query(
        `INSERT INTO message (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status)
         VALUES ($1, 'M-42', 'cm-hit', 'puid-01', true, 'agent', 'hi', now(), 'sent')`,
        [groupId],
      );
    });
    const out = await tx(db.pool, (c) =>
      execSendMessage(
        { client: c, runId, groupId, stepSeq: 1, input: { text: 'hi', idempotency_key: 'k-hit' } },
        { pool: db.pool },
      ),
    );
    expect(out.type).toBe('result'); if (out.type === 'result') expect(out.isError ?? false).toBe(false);
    if (out.type === 'result') {
      expect(out.content).toContain('"deliveryStatus":"sent"');
      expect(out.content).toContain('cm-hit');
    }
    const { rows: msgs } = await db.pool.query('SELECT count(*)::int AS n FROM message WHERE group_id=$1', [groupId]);
    expect(msgs[0]?.n).toBe(1); // 未二次创建（S5 核心：返回首次消息状态）
  });
});
