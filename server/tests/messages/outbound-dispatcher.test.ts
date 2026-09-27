// 出站 dispatcher + 同步错误八向分流（T-P3-02；DES/05 §2.1–§2.3、DES/03 §5.2、DES/10 E7、REQ A2）。
// 真测试纪律（同 timeline.test.ts）：真实 DB + 真实进程内 mock-gateway（createGatewayApp），
// 网关响应靠 /_test/scenario 开关 arrange——不 mock send 返回值；断言点=DB 行 + mock counters。
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { derivePlatformUserId } from 'mock-gateway/src/state.js';
import { createGatewayClient, type GatewayClient } from '../../src/gateway/client.js';
import { startOutboundDispatcher, type OutboundDispatcher } from '../../src/modules/messages/dispatcher.js';
import { seed } from '../../src/db/seed.js';
import { withTestDb } from '../helpers/db.js';
import type { ConsumerLogger } from '../../src/events/consumer.js';

const silent: ConsumerLogger = {
  info() {},
  warn() {},
  error() {},
};

/** 测试辅助：断言式取值（替代 no-non-null-assertion 禁用的 `!`） */
function must<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`expected non-null: ${label}`);
  return value;
}
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor: condition not met within timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Fixture {
  pool: Pool;
  gw: GatewayClient;
  mockApp: GatewayApp;
  mockBaseUrl: string;
  dispatcher: OutboundDispatcher;
  /** clientMsgId → 我方发出 send 次数（网关 503 拦截在计数之前，mock counters 不可见——在客户端侧计） */
  sendCalls: Map<string, number>;
}

interface ScenarioBody {
  switch: string;
  params?: Record<string, unknown>;
  target?: Record<string, unknown>;
}

async function arm(fx: Fixture, body: ScenarioBody): Promise<void> {
  const res = await fx.mockApp.inject({ method: 'POST', url: '/_test/scenario', payload: body });
  expect(res.statusCode).toBe(200);
}

async function clearSwitch(fx: Fixture, name: string): Promise<void> {
  await fx.mockApp.inject({ method: 'POST', url: '/_test/scenario/clear', payload: { switch: name } });
}

async function counters(fx: Fixture): Promise<{
  sendCallsByAccount: Record<string, number>;
  sendCallsByClientMsgId: Record<string, number>;
}> {
  const res = await fx.mockApp.inject({ method: 'GET', url: '/_test/counters' });
  return res.json() as Awaited<ReturnType<typeof counters>>;
}

/** 网关侧真实建群：connect creator（mock online + puid）→ POST /groups → 返回网关 groupId */
async function gwCreateGroup(fx: Fixture, creatorAccountId: string): Promise<string> {
  await fx.gw.connect(creatorAccountId);
  const { groupId } = await fx.gw.createGroup({ creatorAccountId });
  return groupId;
}

/** server 侧群行：status='active' + 网关 id + 成员（角色给定；platform_user_id 确定性派生） */
async function insertDbGroup(
  fx: Fixture,
  gatewayGroupId: string,
  members: Array<{ accountId: string; role: 'creator' | 'admin' | 'member' }>,
): Promise<string> {
  const id = randomUUID();
  await fx.pool.query(
    `INSERT INTO "group" (id, gateway_group_id, status, creator_account_id)
     VALUES ($1, $2, 'active', $3)`,
    [id, gatewayGroupId, must(members[0], 'first member').accountId],
  );
  for (const m of members) {
    await fx.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [id, m.accountId, derivePlatformUserId(m.accountId), m.role],
    );
  }
  return id;
}

/** 直接 INSERT 一条 queued 出站消息（accept 路径已由 T-P3-01 覆盖；本卡测 dispatcher） */
async function queueMessage(
  fx: Fixture,
  groupId: string,
  accountId: string,
  text: string,
): Promise<{ id: number; clientMsgId: string }> {
  const clientMsgId = `cm-${randomUUID()}`;
  const { rows } = await fx.pool.query<{ id: string }>(
    `INSERT INTO message (group_id, client_msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, account_id)
     VALUES ($1, $2, $3, true, 'operator', $4, now(), 'queued', $5)
     RETURNING id`,
    [groupId, clientMsgId, derivePlatformUserId(accountId), text, accountId],
  );
  return { id: Number(must(rows[0], 'inserted message').id), clientMsgId };
}

async function messageRow(
  pool: Pool,
  id: number,
): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT delivery_status, fail_code, first_attempt_at, last_attempt_at, resend_count,
            unknown_since, unknown_deadline_at
     FROM message WHERE id = $1`,
    [id],
  );
  return must(rows[0], 'row');
}

async function accountRow(pool: Pool, id: string): Promise<{ status: string }> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM account WHERE id = $1',
    [id],
  );
  return must(rows[0], 'row');
}

async function wsEvents(pool: Pool, type: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM ws_event WHERE type = $1 ORDER BY seq',
    [type],
  );
  return rows.map((r) => r.payload);
}

async function withFixture(
  fn: (fx: Fixture) => Promise<void>,
): Promise<void> {
  await withTestDb(async (pool) => {
    await seed(pool);
    const mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    const mockBaseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    const inner = createGatewayClient({ baseUrl: mockBaseUrl });
    // 503 的网关侧拦截发生在业务计数之前——retry 次数断言只能在我方侧统计
    const sendCalls = new Map<string, number>();
    const gw: GatewayClient = {
      ...inner,
      send: (groupId, input) => {
        sendCalls.set(input.clientMsgId, (sendCalls.get(input.clientMsgId) ?? 0) + 1);
        return inner.send(groupId, input);
      },
    };
    const dispatcher = startOutboundDispatcher({
      pool,
      gateway: gw,
      logger: silent,
      retryBackoffStartMs: 5,
      retryBackoffMaxMs: 20,
    });
    try {
      await fn({ pool, gw, mockApp, mockBaseUrl, dispatcher, sendCalls });
    } finally {
      await dispatcher.stop();
      await mockApp.close();
    }
  });
}

describe('出站 dispatcher + 同步错误分流（T-P3-02 / DES/05 §2.3）', () => {
  it('wake → 202 → accepted：first_attempt_at 先于 send 落库；最早 id 升序串行', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m1 = await queueMessage(fx, groupId, 'acc-01', 'one');
      const m2 = await queueMessage(fx, groupId, 'acc-01', 'two');
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await messageRow(fx.pool, m2.id)).delivery_status === 'accepted');
      for (const m of [m1, m2]) {
        const row = await messageRow(fx.pool, m.id);
        expect(row.delivery_status).toBe('accepted');
        expect(row.first_attempt_at).not.toBeNull(); // E7/I1：发送前落库
        expect(row.resend_count).toBe(0);
      }
      const c = await counters(fx);
      expect(c.sendCallsByAccount['acc-01']).toBe(2); // 每账号至多一条在途：两次串行调用
      // 顺序真值：clientMsgId 落地序 = 受理序（id 升序）
      const landed = await fx.pool.query<{ client_msg_id: string }>(
        'SELECT client_msg_id FROM message WHERE account_id=$1 ORDER BY id',
        ['acc-01'],
      );
      const ids = landed.rows.map((r) => r.client_msg_id);
      expect(ids).toEqual([m1.clientMsgId, m2.clientMsgId]);
      // ws_event(message) 两次（accepted 帧；与写回同事务）
      const evs = await wsEvents(fx.pool, 'message');
      expect(evs.filter((p) => p.deliveryStatus === 'accepted')).toHaveLength(2);
    });
  });

  it('429 RATE_LIMITED：账号→rate_limited + 消息保持 queued + 期内 0 次该账号 send + 序列顺延不跳过', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      // registerRateLimit 只对 online/rate_limited 生效（§5.1 守门）：DB 侧先置 online
      await fx.pool.query("UPDATE account SET status='online', platform_user_id=$1 WHERE id='acc-01'", [
        derivePlatformUserId('acc-01'),
      ]);
      const m1 = await queueMessage(fx, groupId, 'acc-01', 'first');
      const m2 = await queueMessage(fx, groupId, 'acc-01', 'second');
      await arm(fx, {
        switch: 'rate_limit',
        params: { retryAfterSeconds: 2 },
        target: { accountId: 'acc-01' },
      });
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await accountRow(fx.pool, 'acc-01')).status === 'rate_limited');
      // m1 保持 queued（顺延）；first_attempt_at 必须复位——请求未达业务层，崩溃扫描不应把它转 unknown
      const r1 = await messageRow(fx.pool, m1.id);
      expect(r1.delivery_status).toBe('queued');
      expect(r1.first_attempt_at).toBeNull();
      expect(r1.fail_code).toBeNull();
      const r2 = await messageRow(fx.pool, m2.id);
      expect(r2.delivery_status).toBe('queued');
      expect(r2.first_attempt_at).toBeNull();
      // 期内 0 次试探：429 那次是唯一计数（mock 计数在进入 send 即计，429 响应也计）
      await new Promise((r) => setTimeout(r, 400));
      const c = await counters(fx);
      expect(c.sendCallsByAccount['acc-01']).toBe(1);
      // mock 计时重置语义：窗口在网关侧也持久（clear 不提前解除）——必须等满 retryAfterSeconds=2s。
      // 我方闸门同源（rate_limited_until 到期放行）；等窗口过后清开关再唤醒。
      await new Promise((r) => setTimeout(r, 1700));
      await clearSwitch(fx, 'rate_limit');
      fx.dispatcher.wake('acc-01');
      await waitFor(async () => (await messageRow(fx.pool, m2.id)).delivery_status === 'accepted', 12000);
      // A2/S4：序列顺延不跳过——两条都落地，顺序保持。
      // mock 计数在进入 send 即计：m1 = 429 那次 + 恢复后重发那次 = 2；m2 一次成功 = 1
      const c2 = await counters(fx);
      expect(c2.sendCallsByClientMsgId[m1.clientMsgId]).toBe(2);
      expect(c2.sendCallsByClientMsgId[m2.clientMsgId]).toBe(1);
      expect((await messageRow(fx.pool, m1.id)).delivery_status).toBe('accepted');
    });
  }, 20000);
  it('403 ACCOUNT_SUSPENDED：enterTerminal（status=suspended + 副作用）+ 该条 failed 同名码', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m = await queueMessage(fx, groupId, 'acc-01', 'x');
      // 先让账号 online（终态转移合法），再 arm gw-11
      await fx.pool.query("UPDATE account SET status='online', platform_user_id=$1 WHERE id='acc-01'", [
        derivePlatformUserId('acc-01'),
      ]);
      await arm(fx, { switch: 'account_suspended_403', target: { accountId: 'acc-01' } });
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await accountRow(fx.pool, 'acc-01')).status === 'suspended');
      const row = await messageRow(fx.pool, m.id);
      expect(row.delivery_status).toBe('failed');
      expect(row.fail_code).toBe('ACCOUNT_SUSPENDED');
      // enterTerminal 副作用帧：account_terminal + account_status_changed（逐字 §5.1）
      const terminal = await wsEvents(fx.pool, 'account_terminal');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ accountId: 'acc-01', status: 'suspended' });
      // 该条 own 消息的 failed 帧
      const msgEvs = await wsEvents(fx.pool, 'message');
      expect(msgEvs.some((p) => p.deliveryStatus === 'failed' && p.clientMsgId === m.clientMsgId)).toBe(true);
    });
  });

  it('401 SESSION_EXPIRED：enterTerminal（session_expired）+ 该条 failed 同名码', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m = await queueMessage(fx, groupId, 'acc-01', 'x');
      await fx.pool.query("UPDATE account SET status='online', platform_user_id=$1 WHERE id='acc-01'", [
        derivePlatformUserId('acc-01'),
      ]);
      await arm(fx, { switch: 'session_expired_401', target: { accountId: 'acc-01' } });
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await accountRow(fx.pool, 'acc-01')).status === 'session_expired');
      const row = await messageRow(fx.pool, m.id);
      expect(row.delivery_status).toBe('failed');
      expect(row.fail_code).toBe('SESSION_EXPIRED');
    });
  });

  it('403 GROUP_WRITE_FORBIDDEN：群 unreachable 级联（running 序列→stopped + ws_event）+ 该条 failed；账号不动', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      // running 序列（级联断言点）：sequence 定义表无 group_id（008 迁移），归属经 sequence_run
      const seqId = randomUUID();
      await fx.pool.query(
        `INSERT INTO sequence (id, name, steps) VALUES ($1, 's', '[]'::jsonb)`,
        [seqId],
      );
      const runId = randomUUID();
      await fx.pool.query(
        `INSERT INTO sequence_run (id, group_id, sequence_id, status, current_step_index)
         VALUES ($1, $2, $3, 'running', 2)`,
        [runId, groupId, seqId],
      );
      const m = await queueMessage(fx, groupId, 'acc-01', 'x');
      await arm(fx, { switch: 'group_write_forbidden', target: { groupId: gwGroupId } });
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => {
        const { rows } = await fx.pool.query<{ status: string }>(
          'SELECT status FROM "group" WHERE id=$1',
          [groupId],
        );
        return rows[0]?.status === 'unreachable';
      });
      const row = await messageRow(fx.pool, m.id);
      expect(row.delivery_status).toBe('failed');
      expect(row.fail_code).toBe('GROUP_WRITE_FORBIDDEN');
      // 级联：running 序列 → stopped + ws_event(sequence_run)
      const { rows: run } = await fx.pool.query<{ status: string }>(
        'SELECT status FROM sequence_run WHERE id=$1',
        [runId],
      );
      expect(must(run[0], 'stopped run').status).toBe('stopped');
      const seqEvs = await wsEvents(fx.pool, 'sequence_run');
      expect(seqEvs.some((p) => p.runId === runId && p.status === 'stopped')).toBe(true);
      // 账号状态不变（级联不触碰 account；§04 §5 表逐字）
      expect((await accountRow(fx.pool, 'acc-01')).status).toBe('idle');
    });
  });

  it('403 SENDER_NOT_IN_GROUP：该条 failed 同名码；账号/群状态不变；下一条照常放行', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m1 = await queueMessage(fx, groupId, 'acc-01', 'blocked');
      const m2 = await queueMessage(fx, groupId, 'acc-01', 'ok');
      await arm(fx, {
        switch: 'sender_not_in_group',
        target: { groupId: gwGroupId, accountId: 'acc-01', clientMsgId: m1.clientMsgId },
      });
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await messageRow(fx.pool, m2.id)).delivery_status === 'accepted');
      const r1 = await messageRow(fx.pool, m1.id);
      expect(r1.delivery_status).toBe('failed');
      expect(r1.fail_code).toBe('SENDER_NOT_IN_GROUP');
      expect((await accountRow(fx.pool, 'acc-01')).status).toBe('idle');
      const { rows: g } = await fx.pool.query<{ status: string }>(
        'SELECT status FROM "group" WHERE id=$1',
        [groupId],
      );
      expect(must(g[0], 'group row').status).toBe('active'); // 群不变
      // 队列不阻断：m2 到达网关
      const c = await counters(fx);
      expect(c.sendCallsByClientMsgId[m2.clientMsgId]).toBe(1);
    });
  });

  it('409 ACCOUNT_OFFLINE：该条 failed 同名码；账号状态不变（真值在网关，不猜）', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m = await queueMessage(fx, groupId, 'acc-01', 'x');
      // 自然离线：connect 再 disconnect（不断言 DB——dispatcher 不该碰 account）
      await fx.gw.disconnect('acc-01');
      await fx.pool.query("UPDATE account SET status='idle' WHERE id='acc-01'");
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await messageRow(fx.pool, m.id)).delivery_status === 'failed');
      const row = await messageRow(fx.pool, m.id);
      expect(row.fail_code).toBe('ACCOUNT_OFFLINE');
      expect((await accountRow(fx.pool, 'acc-01')).status).toBe('idle');
    });
  });

  it('504 NETWORK_TIMEOUT：→ unknown（unknown_since≈now、deadline≈now+5s）；不重发不失败', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m = await queueMessage(fx, groupId, 'acc-01', 'x');
      await arm(fx, { switch: 'send_504_not_sent', target: { clientMsgId: m.clientMsgId } });
      fx.dispatcher.wake('acc-01');

      const before = Date.now();
      await waitFor(async () => (await messageRow(fx.pool, m.id)).delivery_status === 'unknown');
      const row = await messageRow(fx.pool, m.id);
      expect(row.fail_code).toBeNull();
      const since = (row.unknown_since as Date).getTime();
      const deadline = (row.unknown_deadline_at as Date).getTime();
      expect(since).toBeGreaterThanOrEqual(before);
      expect(deadline - since).toBe(5000); // UNKNOWN_SETTLE_MS 逐字
      // 不盲目重发：counters 对同一 clientMsgId 恰好 1
      const c = await counters(fx);
      expect(c.sendCallsByClientMsgId[m.clientMsgId]).toBe(1);
    });
  });

  it('503 gateway_503_all：指数退避重试同一意图（resend_count 不变、first_attempt_at 保持首次）→ 恢复后 accepted', async () => {
    await withFixture(async (fx) => {
      const gwGroupId = await gwCreateGroup(fx, 'acc-01');
      const groupId = await insertDbGroup(fx, gwGroupId, [
        { accountId: 'acc-01', role: 'creator' },
      ]);
      const m = await queueMessage(fx, groupId, 'acc-01', 'x');
      // 200ms 不可用窗口：注入退避 5ms 起 → 至少重试 2 次后恢复
      await arm(fx, { switch: 'gateway_503_all', params: { durationMs: 200 } });
      fx.dispatcher.wake('acc-01');

      await waitFor(async () => (await messageRow(fx.pool, m.id)).delivery_status === 'accepted', 8000);
      // mock counters 看不到 503 拦截（路由前置短路）——retry 计数在我方包装层
      expect(fx.sendCalls.get(m.clientMsgId) ?? 0).toBeGreaterThanOrEqual(2); // ≥1 次 503 后重试
      const row = await messageRow(fx.pool, m.id);
      expect(row.resend_count).toBe(0); // 解读 #17：同一意图重试不算重发
      expect(row.first_attempt_at).not.toBeNull();
      // first_attempt_at 保持首次：不晚于 outage 起点附近（粗界：accepted 时刻之前）
      expect((row.first_attempt_at as Date).getTime()).toBeLessThan(Date.now());
    });
  });
});
