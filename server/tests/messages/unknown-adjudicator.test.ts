// unknown 判定器（T-P3-03；DES/05 §2.4 逐字、REQ A2 第 2 条、QR §1 的 5s/2s 行）。
// 真测试纪律：真实 DB + 真实进程内 mock-gateway；判定节奏靠直接调 sweep() +
// 手工回拨 unknown_since 越过 2s 线（不赌墙钟）；counters/DB 行是断言真值。
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { derivePlatformUserId } from 'mock-gateway/src/state.js';
import { createGatewayClient, type GatewayClient } from '../../src/gateway/client.js';
import { createUnknownAdjudicator, type UnknownAdjudicator } from '../../src/modules/messages/adjudicator.js';
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

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 6000): Promise<void> {
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
  adjudicator: UnknownAdjudicator;
  dispatcher: OutboundDispatcher;
  /** clientMsgId → 我方发出 send 次数（503 拦截在网关计数之前，须在我侧计） */
  sendCalls: Map<string, number>;
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  await withTestDb(async (pool) => {
    await seed(pool);
    const mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    const inner = createGatewayClient({ baseUrl: base });
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
    const adjudicator = createUnknownAdjudicator({
      pool,
      gateway: gw,
      logger: silent,
      wakeDispatcher: dispatcher.wake,
    });
    try {
      await fn({ pool, gw, mockApp, adjudicator, dispatcher, sendCalls });
    } finally {
      await dispatcher.stop();
      await mockApp.close();
    }
  });
}

/** 网关侧建群 + server 侧群行（active + gateway id + 成员） */
async function setupGroup(fx: Fixture, creator: string): Promise<{ dbGroupId: string; gwGroupId: string }> {
  await fx.gw.connect(creator);
  const { groupId: gwGroupId } = await fx.gw.createGroup({ creatorAccountId: creator });
  const dbGroupId = randomUUID();
  await fx.pool.query(
    `INSERT INTO "group" (id, gateway_group_id, status, creator_account_id) VALUES ($1,$2,'active',$3)`,
    [dbGroupId, gwGroupId, creator],
  );
  await fx.pool.query(
    `INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES ($1,$2,$3,'creator')`,
    [dbGroupId, creator, derivePlatformUserId(creator)],
  );
  return { dbGroupId, gwGroupId };
}

/** 直接造一条 unknown 行（Dispatcher 的 504 写回路径已由 T-P3-02 覆盖；本卡测判定器输入态） */
async function unknownMessage(
  fx: Fixture,
  opts: {
    groupId: string;
    accountId: string;
    sinceMs?: number; // unknown_since = now()-偏移（已过 2s 线时给 2500+）
    resendCount?: number;
  },
): Promise<{ id: number; clientMsgId: string }> {
  const clientMsgId = `cm-${randomUUID()}`;
  const { rows } = await fx.pool.query<{ id: string }>(
    `INSERT INTO message (group_id, client_msg_id, sender_platform_user_id, is_own, source, text,
                          sent_at, delivery_status, account_id,
                          first_attempt_at, last_attempt_at, resend_count, unknown_since, unknown_deadline_at)
     VALUES ($1,$2,$3,true,'operator','x',now(),'unknown',$4,
             now(), now(), $5, now() - $6 * interval '1 millisecond', now())
     RETURNING id`,
    [
      opts.groupId,
      clientMsgId,
      derivePlatformUserId(opts.accountId),
      opts.accountId,
      opts.resendCount ?? 0,
      opts.sinceMs ?? 0,
    ],
  );
  return { id: Number(must(rows[0], 'inserted message').id), clientMsgId };
}

async function messageState(pool: Pool, clientMsgId: string): Promise<{
  delivery_status: string;
  msg_id: string | null;
  fail_code: string | null;
  resend_count: number;
  first_attempt_at: Date | null;
  unknown_deadline_at: Date | null;
}> {
  const { rows } = await pool.query(
    `SELECT delivery_status, msg_id, fail_code, resend_count, first_attempt_at, unknown_deadline_at
     FROM message WHERE client_msg_id=$1`,
    [clientMsgId],
  );
  return must(rows[0], `message ${clientMsgId}`) as never;
}

describe('unknown 判定器（T-P3-03 / DES/05 §2.4）', () => {
  it('by-client-id 200 → finalizeSent → sent（gw-7 落地等价路径；5s 内落定）', async () => {
    await withFixture(async (fx) => {
      const { dbGroupId, gwGroupId } = await setupGroup(fx, 'acc-01');
      const m = await unknownMessage(fx, { groupId: dbGroupId, accountId: 'acc-01', sinceMs: 500 });
      // 网关侧真实落地该 clientMsgId（gw-7 的事后落地等价：send 202 后异步落地推帧）
      await fx.gw.send(gwGroupId, { accountId: 'acc-01', clientMsgId: m.clientMsgId, text: 'x' });
      await waitFor(async () => {
        try {
          await fx.gw.getMessageByClientMsgId(gwGroupId, m.clientMsgId);
          return true;
        } catch {
          return false;
        }
      });
      await fx.adjudicator.sweep();
      const st = await messageState(fx.pool, m.clientMsgId);
      expect(st.delivery_status).toBe('sent');
      expect(st.msg_id).not.toBeNull(); // finalizeSent 回填网关 msgId（D1-3 收口路径）
    });
  }, 15000);

  it('gw-8 恒 404：2s 内不重发（A2「确认前不得重发」）；过 2s 线 → 重发一次（resend_count=1，同 clientMsgId）→ 再确认 → failed(NETWORK_TIMEOUT)', async () => {
    await withFixture(async (fx) => {
      const { dbGroupId, gwGroupId } = await setupGroup(fx, 'acc-01');
      await fx.mockApp.inject({
        method: 'POST',
        url: '/_test/scenario',
        payload: { switch: 'send_504_not_sent', target: { groupId: gwGroupId } },
      });
      // 未过 2s 线：探测 404 → 不算数，不重发，deadline 顺延一个探测节拍
      const m = await unknownMessage(fx, { groupId: dbGroupId, accountId: 'acc-01', sinceMs: 300 });
      await fx.adjudicator.sweep();
      let st = await messageState(fx.pool, m.clientMsgId);
      expect(st.delivery_status).toBe('unknown');
      expect(st.resend_count).toBe(0);
      expect(fx.sendCalls.get(m.clientMsgId) ?? 0).toBe(0); // 确认前绝不重发（A2 逐字）
      expect(must(st.unknown_deadline_at, 'deadline').getTime()).toBeGreaterThan(Date.now());

      // 过 2s 线仍 404 → 确认未发出 → 重发一次（resend_count=1 → dispatcher 重走 send → 再 504 → unknown）。
      // 首轮 sweep 已把 deadline 顺到 +500ms——回拨 since 的同时让行「到期可扫」。
      await fx.pool.query(
        `UPDATE message SET unknown_since = now() - interval '2500 milliseconds',
                            unknown_deadline_at = now()
         WHERE client_msg_id=$1`,
        [m.clientMsgId],
      );
      await fx.adjudicator.sweep();

      await waitFor(async () => {
        const s = await messageState(fx.pool, m.clientMsgId);
        return s.delivery_status === 'unknown' && s.resend_count === 1;
      });
      expect(fx.sendCalls.get(m.clientMsgId)).toBe(1); // 恰好一次重发（同 clientMsgId）

      // 重发仍 504 → unknown；再探 404 且 resend_count=1 → failed(NETWORK_TIMEOUT)（A2 逐字）
      await fx.pool.query(
        `UPDATE message SET unknown_since = now() - interval '2500 milliseconds',
                            unknown_deadline_at = now() - interval '1 millisecond'
         WHERE client_msg_id=$1`,
        [m.clientMsgId],
      );
      await fx.adjudicator.sweep();
      st = await messageState(fx.pool, m.clientMsgId);
      expect(st.delivery_status).toBe('failed');
      expect(st.fail_code).toBe('NETWORK_TIMEOUT');
      expect(st.resend_count).toBe(1);
      expect(fx.sendCalls.get(m.clientMsgId)).toBe(1); // 重发额度用尽：不再第三次 send
      // ws_event：queued（重发交接帧）与 failed 帧各一
      const evs = await fx.pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM ws_event WHERE type='message' AND payload->>'clientMsgId'=$1 ORDER BY seq",
        [m.clientMsgId],
      );
      const statuses = evs.rows.map((r) => r.payload['deliveryStatus']);
      expect(statuses).toContain('queued');
      expect(statuses).toContain('failed');
    });
  }, 20000);

  it('gw-9 by-client-id 503：保持 unknown（不推进判定）；恢复后下一轮探测即定（I9：2s 内确定）', async () => {
    await withFixture(async (fx) => {
      const { dbGroupId, gwGroupId } = await setupGroup(fx, 'acc-01');
      // 先让消息真落地（by-client-id 恢复后能 200），再造 unknown 行嫁接到它
      const cm = 'cm-landed';
      await fx.gw.send(gwGroupId, { accountId: 'acc-01', clientMsgId: cm, text: 'x' });
      await waitFor(async () => {
        try {
          await fx.gw.getMessageByClientMsgId(gwGroupId, cm);
          return true;
        } catch {
          return false;
        }
      });
      const m = await unknownMessage(fx, {
        groupId: dbGroupId,
        accountId: 'acc-01',
        sinceMs: 2500, // 已过 2s 线——503 期间也绝不能判「未发出」
      });
      await fx.pool.query(`UPDATE message SET client_msg_id=$2 WHERE id=$1`, [m.id, cm]);
      // 探测 503（gw-9；target 只对 groupId/clientMsgId 生效——by-client-id 端点无 accountId 维度）
      await fx.mockApp.inject({
        method: 'POST',
        url: '/_test/scenario',
        payload: { switch: 'by_client_id_503', params: { durationMs: 400 }, target: { groupId: gwGroupId, clientMsgId: cm } },
      });
      await fx.adjudicator.sweep(); // 503：保持 unknown，deadline 顺延
      let st = await messageState(fx.pool, cm);
      expect(st.delivery_status).toBe('unknown');
      expect(must(st.unknown_deadline_at, 'deadline').getTime()).toBeGreaterThan(Date.now());
      await new Promise((r) => setTimeout(r, 550)); // 等 outage 过
      await fx.adjudicator.sweep(); // 恢复后下一轮探测即定
      st = await messageState(fx.pool, cm);
      expect(st.delivery_status).toBe('sent');
      expect(st.msg_id).not.toBeNull();
    });
  }, 15000);

  it('重复 sweep 幂等：已 sent 行不再被判定器触碰（守卫吸收）', async () => {
    await withFixture(async (fx) => {
      const { dbGroupId, gwGroupId } = await setupGroup(fx, 'acc-01');
      const cm = 'cm-done';
      await fx.gw.send(gwGroupId, { accountId: 'acc-01', clientMsgId: cm, text: 'x' });
      await waitFor(async () => {
        try {
          await fx.gw.getMessageByClientMsgId(gwGroupId, cm);
          return true;
        } catch {
          return false;
        }
      });
      const m = await unknownMessage(fx, { groupId: dbGroupId, accountId: 'acc-01', sinceMs: 3000 });
      await fx.pool.query(`UPDATE message SET client_msg_id=$2 WHERE id=$1`, [m.id, cm]);
      await fx.adjudicator.sweep();
      await fx.adjudicator.sweep(); // 幂等：行已 sent 不在到期集合
      const st = await messageState(fx.pool, cm);
      expect(st.delivery_status).toBe('sent');
    });
  }, 15000);
});
