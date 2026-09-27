// 终态原子副作用测试（T-P2-06 c 项，先红后绿）。
// 契约出处：REQ A1「进入终态时：该账号从所有群的成员表中移除；它排队中的发送变为 cancelled
// (failCode=ACCOUNT_TERMINAL)，对应的序列步骤变为 skipped；推 account_terminal 事件…
// 状态和这些后果要么都生效，要么都不生效」；DES/03 §4 六动作 mermaid + 细节 1（D1-2 收窄：
// 只取消 queued AND first_attempt_at IS NULL；在途行转 unknown 5s 判定，不置 cancelled）、
// 细节 2（步骤经 client_msg_id 关联）、细节 3（skipped 步进度照常推进）；
// DES/02 §4.2（活跃成员 = left_at IS NULL）；DES/02 §9 约束清单终态行；E10/幂等三分支 §1。
// 事务回滚注入：enterTerminal 成功后由调用方在同 tx 内抛错（覆盖 onEntered 之后的兜底窗口，
// 证明「全有或全无」不依赖副作用回调内部成败）。
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import { enterTerminal } from '../../src/modules/accounts/terminal.js';
import { createAccountStatusHandler } from '../../src/events/handlers/account-status.js';
import type { GatewayEventEnvelope } from '../../src/events/dispatch.js';
import { UNKNOWN_SETTLE_MS } from '../../src/constants.js';

describe('enterTerminal 终态原子副作用（DES/03 §4 六动作单事务）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockApp: GatewayApp;
  let adminToken: string;

  function authed() {
    return { authorization: `Bearer ${adminToken}` };
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
      gateway: createGatewayClient({ baseUrl }),
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin' },
    });
    adminToken = (login.json() as { accessToken: string }).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await mockApp.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE ws_event, gateway_event, sequence_run_step, sequence_run, sequence, message, group_member, \"group\", account RESTART IDENTITY CASCADE",
    );
    await seed(db.pool);
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
  });

  // ---------- 夹具 ----------

  /** connect 账号（走真实 mock 网关，拿到确定性 puid） */
  async function connectAccount(id: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/connect`,
      headers: authed(),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { platformUserId: string }).platformUserId;
  }

  async function puidOf(id: string): Promise<string> {
    const { rows } = await db.pool.query<{ platform_user_id: string | null }>(
      'SELECT platform_user_id FROM account WHERE id=$1',
      [id],
    );
    return rows[0]?.platform_user_id ?? '';
  }

  let groupSeq = 0;
  /** 行存在断言助手：query 必回行（INSERT..RETURNING）——空集直接炸测试而非吞 undefined */
  function firstRow<T>(rows: T[]): T {
    const row = rows[0];
    if (row === undefined) throw new Error('expected row missing');
    return row;
  }

  async function makeGroup(): Promise<string> {
    groupSeq += 1;
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, gateway_group_id, creator_account_id)
       VALUES (gen_random_uuid(), $1, 'acc-01') RETURNING id`,
      [`gw-g-${groupSeq}`],
    );
    return firstRow(rows).id;
  }

  async function addMember(groupId: string, accountId: string, opts: { left?: boolean } = {}) {
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, left_at)
       VALUES ($1, $2, $3, 'member', now(), ${opts.left === true ? 'now()' : 'NULL'})`,
      [groupId, accountId, await puidOf(accountId)],
    );
  }

  async function addMessage(
    groupId: string,
    accountId: string,
    clientMsgId: string,
    opts: { status?: string; attempted?: boolean } = {},
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO message (group_id, client_msg_id, sender_platform_user_id, is_own, source, text,
                            sent_at, delivery_status, account_id, first_attempt_at)
       VALUES ($1, $2, $3, true, 'operator', 'hi', now(), $4, $5, ${opts.attempted === true ? 'now()' : 'NULL'})`,
      [groupId, clientMsgId, await puidOf(accountId), opts.status ?? 'queued', accountId],
    );
  }

  /** 建一个 run 挂一条「发 acc-01 的 queued 消息」步骤 + 一条后续 pending 步骤 */
  async function makeRunWithSteps(
    groupId: string,
    clientMsgId: string,
  ): Promise<{ runId: string; nextDelaySeconds: number }> {
    const { rows: seq } = await db.pool.query<{ id: string }>(
      "INSERT INTO sequence (id, name, steps) VALUES (gen_random_uuid(), 's', '[]'::jsonb) RETURNING id",
    );
    const { rows: run } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status)
       VALUES (gen_random_uuid(), $1, $2, 'running') RETURNING id`,
      [groupId, firstRow(seq).id],
    );
    const nextDelay = 42;
    await db.pool.query(
      `INSERT INTO sequence_run_step (run_id, "index", status, account_id, account_role, text_template,
                                     delay_seconds, scheduled_at, client_msg_id, resolved_vars, var_sources)
       VALUES ($1, 0, 'pending', 'acc-01', 'member', 't0', 0, now()+interval '1h', $2, '{}', '{}'),
              ($1, 1, 'pending', 'acc-01', 'member', 't1', $3, NULL, NULL, '{}', '{}')`,
      [firstRow(run).id, clientMsgId, nextDelay],
    );
    return { runId: firstRow(run).id, nextDelaySeconds: nextDelay };
  }

  async function wsEventTypes(): Promise<string[]> {
    const { rows } = await db.pool.query<{ type: string }>('SELECT type FROM ws_event ORDER BY seq');
    return rows.map((r) => r.type);
  }

  async function messageRow(clientMsgId: string) {
    const { rows } = await db.pool.query(
      'SELECT delivery_status, fail_code, unknown_since, unknown_deadline_at FROM message WHERE client_msg_id=$1',
      [clientMsgId],
    );
    return rows[0];
  }

  // ---------- 用例 ----------

  it('首次进入终态：单事务六动作全落（成员 left_at / queued 未尝试→cancelled / 步骤 skipped+链推进 / 三类 ws_event）', async () => {
    await connectAccount('acc-01');
    const g1 = await makeGroup();
    const g2 = await makeGroup();
    await addMember(g1, 'acc-01'); // 活跃
    await addMember(g2, 'acc-01', { left: true }); // 已离开——不应再被改写

    await addMessage(g1, 'acc-01', 'cm-cancel-me'); // queued, first_attempt_at NULL
    await addMessage(g1, 'acc-01', 'cm-in-flight', { attempted: true }); // queued, 在途
    await addMessage(g1, 'acc-01', 'cm-accepted', { status: 'accepted', attempted: true });
    const { nextDelaySeconds } = await makeRunWithSteps(g1, 'cm-cancel-me');

    const outcome = await tx(db.pool, (c) => enterTerminal(c, 'acc-01', 'suspended'));
    expect(outcome.outcome).toBe('entered');
    expect(outcome.from).toBe('online');

    // 1. 状态 + terminal_at
    const { rows: acc } = await db.pool.query(
      'SELECT status, terminal_at FROM account WHERE id=$1',
      ['acc-01'],
    );
    expect(acc[0]?.status).toBe('suspended');
    expect(acc[0]?.terminal_at).not.toBeNull();

    // 2. 活跃成员行 left_at；已离开行不重复写
    const { rows: members } = await db.pool.query(
      'SELECT group_id, left_at FROM group_member WHERE account_id=$1 ORDER BY group_id',
      ['acc-01'],
    );
    const g1Row = members.find((m) => m.group_id === g1);
    const g2Row = members.find((m) => m.group_id === g2);
    expect(g1Row?.left_at).not.toBeNull();
    expect(g2Row?.left_at).not.toBeNull(); // 原本就有值——无法区分改写与否，但不得报错

    // 3a. queued 未尝试 → cancelled(ACCOUNT_TERMINAL)
    const cancelled = await messageRow('cm-cancel-me');
    expect(cancelled?.delivery_status).toBe('cancelled');
    expect(cancelled?.fail_code).toBe('ACCOUNT_TERMINAL');

    // 3b. 在途行 → unknown + 5s 落定期限（D1-2：不是 cancelled）
    const inflight = await messageRow('cm-in-flight');
    expect(inflight?.delivery_status).toBe('unknown');
    expect(inflight?.fail_code).toBeNull();
    const deadlineMs = new Date(inflight?.unknown_deadline_at as string).getTime();
    const sinceMs = new Date(inflight?.unknown_since as string).getTime();
    expect(deadlineMs - sinceMs).toBe(UNKNOWN_SETTLE_MS);

    // accepted 行不动（网关已受理）
    expect((await messageRow('cm-accepted'))?.delivery_status).toBe('accepted');

    // 4+5. 关联步骤 skipped（sent_at=跳过时刻做排期锚点）+ 下一步 scheduled_at=now()+下一步delay
    const { rows: steps } = await db.pool.query(
      'SELECT "index", status, skipped_at, sent_at, scheduled_at FROM sequence_run_step ORDER BY "index"',
    );
    expect(steps[0]?.status).toBe('skipped');
    expect(steps[0]?.skipped_at).not.toBeNull();
    expect(steps[0]?.sent_at).not.toBeNull();
    expect(steps[1]?.status).toBe('pending');
    expect(steps[1]?.scheduled_at).not.toBeNull();
    const schedDeltaMs = new Date(steps[1]?.scheduled_at as string).getTime() - Date.now();
    expect(schedDeltaMs).toBeGreaterThan(0);
    expect(schedDeltaMs).toBeLessThanOrEqual(nextDelaySeconds * 1000 + 2000);

    // 6. ws_event 三类：account_terminal + account_status_changed + message(cancelled)
    const types = await wsEventTypes();
    expect(types).toEqual(
      expect.arrayContaining(['account_terminal', 'account_status_changed', 'message']),
    );
    const { rows: msgEv } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='message'",
    );
    expect(msgEv[0]?.payload).toMatchObject({
      groupId: g1,
      clientMsgId: 'cm-cancel-me',
      deliveryStatus: 'cancelled',
      isOwn: true,
    });
  });

  it('事务中途回滚注入：enterTerminal 成功后调用方抛错 → 六动作全回滚（I6 全有或全无）', async () => {
    await connectAccount('acc-01');
    const g1 = await makeGroup();
    await addMember(g1, 'acc-01');
    await addMessage(g1, 'acc-01', 'cm-rb');
    await makeRunWithSteps(g1, 'cm-rb');
    const eventsBefore = await wsEventTypes();

    await expect(
      tx(db.pool, async (c) => {
        await enterTerminal(c, 'acc-01', 'suspended');
        throw new Error('INJECTED_ROLLBACK'); // 事务内后半段失败——副作用必须整体撤销
      }),
    ).rejects.toThrow('INJECTED_ROLLBACK');

    const { rows: acc } = await db.pool.query('SELECT status, terminal_at FROM account WHERE id=$1', ['acc-01']);
    expect(acc[0]?.status).toBe('online');
    expect(acc[0]?.terminal_at).toBeNull();
    const { rows: members } = await db.pool.query('SELECT left_at FROM group_member WHERE account_id=$1', ['acc-01']);
    expect(members[0]?.left_at).toBeNull();
    expect((await messageRow('cm-rb'))?.delivery_status).toBe('queued');
    const { rows: steps } = await db.pool.query('SELECT status FROM sequence_run_step ORDER BY "index"');
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
    expect(await wsEventTypes()).toEqual(eventsBefore);
  });

  it('重复进入同一终态 → already_same 静默幂等：无副作用重放、无重复 ws_event（A1）', async () => {
    await connectAccount('acc-01');
    const g1 = await makeGroup();
    await addMember(g1, 'acc-01');
    await addMessage(g1, 'acc-01', 'cm-idem');

    const first = await tx(db.pool, (c) => enterTerminal(c, 'acc-01', 'suspended'));
    expect(first.outcome).toBe('entered');
    const eventsAfterFirst = await wsEventTypes();

    const second = await tx(db.pool, (c) => enterTerminal(c, 'acc-01', 'suspended'));
    expect(second.outcome).toBe('already_same');
    expect(await wsEventTypes()).toEqual(eventsAfterFirst); // 零重放
    expect((await messageRow('cm-idem'))?.delivery_status).toBe('cancelled'); // 不二次写
  });

  it('已是另一终态 → already_other（事件路径吞掉记日志，不写库）', async () => {
    await connectAccount('acc-01');
    await tx(db.pool, (c) => enterTerminal(c, 'acc-01', 'suspended'));
    const eventsBefore = await wsEventTypes();
    const outcome = await tx(db.pool, (c) => enterTerminal(c, 'acc-01', 'session_expired'));
    expect(outcome.outcome).toBe('already_other');
    const { rows: acc } = await db.pool.query('SELECT status FROM account WHERE id=$1', ['acc-01']);
    expect(acc[0]?.status).toBe('suspended');
    expect(await wsEventTypes()).toEqual(eventsBefore);
  });
});

describe('account_status SSE 事件 handler（dispatch 接线；DES/03 §4 来源 2）', () => {
  let db: TestDbHandle;

  const noopLogger = { warn() {} };


  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      "TRUNCATE ws_event, gateway_event, sequence_run_step, sequence_run, sequence, message, group_member, \"group\", account RESTART IDENTITY CASCADE",
    );
    await seed(db.pool);
  });

  function event(accountId: string, status: string): GatewayEventEnvelope {
    return { eventId: 1, type: 'account_status', payload: { accountId, status } };
  }

  it('account_status(suspended) → 终态流程全跑（同一事务内，由 handler 承载事件事务）', async () => {
    const handler = createAccountStatusHandler(noopLogger);
    await tx(db.pool, async (c) => {
      await handler({ client: c, event: event('acc-01', 'suspended'), logger: noopLogger });
    });
    const { rows } = await db.pool.query('SELECT status, terminal_at FROM account WHERE id=$1', ['acc-01']);
    expect(rows[0]?.status).toBe('suspended');
    expect(rows[0]?.terminal_at).not.toBeNull();
  });

  it('非终态 status / 未知 accountId → warn + 返回（事件路径不中断，不进死信）', async () => {
    const warns: unknown[] = [];
    const logger = { warn: (o: unknown) => warns.push(o) };
    const handler = createAccountStatusHandler(logger);
    await tx(db.pool, async (c) => {
      await handler({ client: c, event: event('acc-01', 'online'), logger });
      await handler({ client: c, event: event('ghost-9', 'suspended'), logger });
    });
    expect(warns.length).toBe(2);
    const { rows } = await db.pool.query('SELECT status FROM account WHERE id=$1', ['acc-01']);
    expect(rows[0]?.status).toBe('idle'); // 未被 'online' 事件改写
  });

  it('已是另一终态的事件到达 → already_other 记日志、不中断、状态不变', async () => {
    const warns: string[] = [];
    const logger = { warn: (o: unknown, m?: string) => warns.push(`${JSON.stringify(o)} ${m ?? ''}`) };
    const handler = createAccountStatusHandler(logger);
    await tx(db.pool, async (c) => {
      await handler({ client: c, event: event('acc-01', 'suspended'), logger });
    });
    await tx(db.pool, async (c) => {
      await handler({ client: c, event: event('acc-01', 'session_expired'), logger });
    });
    const { rows } = await db.pool.query('SELECT status FROM account WHERE id=$1', ['acc-01']);
    expect(rows[0]?.status).toBe('suspended');
    expect(warns.some((w) => w.includes('already'))).toBe(true);
  });
});
