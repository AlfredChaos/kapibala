// leave-all job 测试（T-P3-07 c 项，先红后绿）。
// 契约出处：DES/04 §3.1–§3.3 逐字（非群主按 accountId 串行先退、群主最后；失败记 errors[]
// 其余继续、群主不退、失败账号两端都仍是成员；member_left 确认或 5s 后查成员列表核对；
// 终局对账 member_mismatch；崩溃在途查列表定结果不重发 leave）、REQ §2.3/B2 第 2–3 条。
// 形态：job 行直接落库 + 脚本化网关 stub 驱动执行器（确定性序列）；
// 受理面（202/404/409/403）走真实 buildApp + 真 mock 网关（离开行为真值）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pino from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createGatewayClient, type GatewayClient } from '../../src/gateway/client.js';
import { GatewayError, type GatewayClientErrorCode } from '../../src/gateway/errors.js';
import { runLeaveAllJob } from '../../src/modules/groups/leave-all.js';

// ---------- 通用工具 ----------

type LeaveItem = undefined | { code: GatewayClientErrorCode; status?: number };

/** 脚本化网关：leave 队列消费（耗尽回放末项）；members 返回调用方控制的 puid 集合 */
function stubGateway(opts: {
  leave?: LeaveItem[];
  membersList?: () => Promise<Array<{ platformUserId: string }>> | Array<{ platformUserId: string }>;
}) {
  const leaveQ = [...(opts.leave ?? [undefined])];
  const calls = { leave: [] as string[], members: 0 };
  const gw: Pick<GatewayClient, 'leave' | 'members'> = {
    leave: (_g, input) => {
      calls.leave.push(input.accountId);
      const item = leaveQ.length > 1 ? leaveQ.shift() : leaveQ[0];
      if (item !== undefined) {
        return Promise.reject(
          new GatewayError({ endpoint: 'leave', status: item.status ?? 500, code: item.code }),
        );
      }
      return Promise.resolve();
    },
    members: async () => {
      calls.members += 1;
      const v = opts.membersList === undefined ? [] : await opts.membersList();
      return v;
    },
  };
  return { gw, calls };
}

interface JobSnap {
  phase: string;
  status: string;
  errors: Array<{ step: string; code: string }>;
  context: { order: string[]; states: Record<string, string>; owner: string; current?: string };
}

describe('leave-all job（DES/04 §3 逐字）', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      'TRUNCATE gateway_event, group_member, "group", job, ws_event, account RESTART IDENTITY CASCADE',
    );
  });

  async function seedAccount(id: string, puid: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ($1, 'online', $2)
       ON CONFLICT (id) DO UPDATE SET status='online', platform_user_id=$2`,
      [id, puid],
    );
  }

  /** 造群 + 成员行（creator=acc-01）+ leave_all job（指定 states/order 可注入崩溃态） */
  async function makeLeaveJob(opts: {
    members?: Array<{ accountId: string; role?: string; puid?: string; left?: boolean }>;
    context?: Partial<JobSnap['context']>;
    groupStatus?: string;
  }): Promise<{ jobId: string; groupId: string }> {
    await seedAccount('acc-01', 'puid-01');
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', $1, 'gw-1') RETURNING id`,
      [opts.groupStatus ?? 'active'],
    );
    const groupId = g[0]?.id ?? '';
    const members = opts.members ?? [
      { accountId: 'acc-01', role: 'creator', puid: 'puid-01' },
      { accountId: 'acc-02', role: 'admin', puid: 'puid-02' },
      { accountId: 'acc-03', role: 'member', puid: 'puid-03' },
    ];
    for (const m of members) {
      if (m.accountId !== 'acc-01') await seedAccount(m.accountId, m.puid ?? `puid-${m.accountId}`);
      await db.pool.query(
        `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, left_at, last_event_id)
         VALUES ($1, $2, $3, $4, now(), ${m.left === true ? 'now()' : 'NULL'}, 0)`,
        [groupId, m.accountId, m.puid ?? `puid-${m.accountId}`, m.role ?? 'member'],
      );
    }
    const owner = opts.context?.owner ?? 'acc-01';
    const order =
      opts.context?.order ??
      members
        .filter((m) => m.left !== true)
        .map((m) => m.accountId)
        .filter((id) => id !== owner)
        .concat(members.some((m) => m.accountId === owner && m.left !== true) ? [owner] : []);
    const states =
      opts.context?.states ?? Object.fromEntries(order.map((id) => [id, 'pending' as const]));
    const { rows: j } = await db.pool.query<{ id: string }>(
      `INSERT INTO job (id, type, group_id, payload, phase, context)
       VALUES (gen_random_uuid(), 'leave_all', $1, $2::jsonb, 'leaving', $3::jsonb) RETURNING id`,
      [
        groupId,
        JSON.stringify({ groupId }),
        JSON.stringify({ order, owner, states, ...opts.context }),
      ],
    );
    return { jobId: j[0]?.id ?? '', groupId };
  }

  async function jobRow(jobId: string): Promise<JobSnap> {
    const { rows } = await db.pool.query<JobSnap>(
      'SELECT phase, status, errors, context FROM job WHERE id=$1',
      [jobId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('job row missing');
    return row;
  }


  async function waitLeaveCalls(list: string[], n: number, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (list.length >= n) return;
      if (Date.now() > deadline) throw new Error(`leave calls never reached ${n} (got ${list.length})`);
      await sleep(30);
    }
  }

  /** member_left 事件等价写（§4 事件路径唯一写源；确认=DB 行 left_at 非空） */
  async function markMemberLeft(groupId: string, accountId: string): Promise<void> {
    await db.pool.query(
      'UPDATE group_member SET left_at=now() WHERE group_id=$1 AND account_id=$2 AND left_at IS NULL',
      [groupId, accountId],
    );
  }

  async function activeMembers(groupId: string): Promise<string[]> {
    const { rows } = await db.pool.query<{ account_id: string }>(
      'SELECT account_id FROM group_member WHERE group_id=$1 AND left_at IS NULL ORDER BY account_id',
      [groupId],
    );
    return rows.map((r) => r.account_id);
  }

  // ---------- b-1 正常链：顺序 + 完成态 ----------

  it('全部成功：非群主按 accountId 序先退、群主最后；group left + members=[]', { timeout: 15000 }, async () => {
    const { jobId, groupId } = await makeLeaveJob({});
    const gw = stubGateway({});
    const done = runLeaveAllJob(
      { pool: db.pool, gateway: gw.gw, confirmTimeoutMs: 2000, confirmPollMs: 30 },
      jobId,
    );
    // member_left 事件确认通道：每次 leave 成功后补 left_at（等价事件路径写入）
    for (const id of ['acc-02', 'acc-03', 'acc-01']) {
      await waitLeaveCalls(gw.calls.leave, gw.calls.leave.length + 1);
      const last = gw.calls.leave.at(-1);
      expect(last).toBe(id); // 顺序断言：非群主 accountId 序 → 群主最后
      await markMemberLeft(groupId, id);
    }
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(job.errors).toEqual([]);
    expect(gw.calls.leave).toEqual(['acc-02', 'acc-03', 'acc-01']);
    const { rows: g } = await db.pool.query('SELECT status FROM "group" WHERE id=$1', [groupId]);
    expect(g[0]?.status).toBe('left');
    expect(await activeMembers(groupId)).toEqual([]); // members=[]
    const { rows: ev } = await db.pool.query("SELECT payload FROM ws_event WHERE type='job'");
    expect(ev.at(-1)?.payload).toMatchObject({ jobId, status: 'finished' });
  });

  it('member_left 超时 → 查成员列表核对确认（设计值分支）', { timeout: 15000 }, async () => {
    const { jobId, groupId } = await makeLeaveJob({
      members: [
        { accountId: 'acc-01', role: 'creator', puid: 'puid-01' },
        { accountId: 'acc-02', role: 'member', puid: 'puid-02' },
      ],
    });
    // members() 永远按「网关侧已移除 acc-02」回报 → 事件未到也判定已退
    const gw = stubGateway({ membersList: () => [] });
    const done = runLeaveAllJob(
      { pool: db.pool, gateway: gw.gw, confirmTimeoutMs: 300, confirmPollMs: 30 },
      jobId,
    );
    await waitLeaveCalls(gw.calls.leave, 1);
    expect(gw.calls.leave).toEqual(['acc-02']);
    // 不写 left_at：走 5s(300ms) 超时 → members 核对 → absent → 确认
    await sleep(600);
    await markMemberLeft(groupId, 'acc-01'); // 群主走事件确认
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(job.context.states['acc-02']).toBe('left');
    expect(await activeMembers(groupId)).toEqual([]);
    expect(gw.calls.members).toBeGreaterThan(0); // 核对通道确实被走
  });

  // ---------- b-2 非群主失败：记 errors、其余继续、群主不退 ----------

  it('acc-02 leave 500 → LEAVE_FAILED 记 errors、acc-03 继续退、群主不退、job failed（B2）', { timeout: 15000 }, async () => {
    const { jobId, groupId } = await makeLeaveJob({});
    // acc-02 → 500（网关无码 → INTERNAL，服务端统一记 LEAVE_FAILED）；acc-03 → 200；群主不应被调用
    const gw = stubGateway({
      leave: [{ code: 'INTERNAL', status: 500 }, undefined],
      membersList: () => [],
    });
    const done = runLeaveAllJob(
      { pool: db.pool, gateway: gw.gw, confirmTimeoutMs: 300, confirmPollMs: 30 },
      jobId,
    );
    await waitLeaveCalls(gw.calls.leave, 2);
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'leave:acc-02', code: 'LEAVE_FAILED' }]);
    expect(gw.calls.leave).toEqual(['acc-02', 'acc-03']); // 群主 acc-01 绝不被调用（B2）
    expect(job.context.states['acc-01']).toBe('skipped');
    expect(job.context.states['acc-02']).toBe('failed');
    expect(job.context.states['acc-03']).toBe('left');
    // 失败账号两端仍是成员：DB 行保持活跃 + 网关列表仍含其 puid（B2 逐字）
    expect(await activeMembers(groupId)).toEqual(['acc-01', 'acc-02']);
    const { rows: g } = await db.pool.query('SELECT status FROM "group" WHERE id=$1', [groupId]);
    expect(g[0]?.status).toBe('active'); // 群不置 left
  });

  // ---------- b-3 终局对账：member_mismatch ----------

  it('终局对账不一致（网关残留我方 puid 而 DB 已退）→ inconsistency member_mismatch', { timeout: 15000 }, async () => {
    const { jobId, groupId } = await makeLeaveJob({
      members: [
        { accountId: 'acc-01', role: 'creator', puid: 'puid-01' },
        { accountId: 'acc-02', role: 'member', puid: 'puid-02' },
      ],
    });
    // 网关成员列表谎报 acc-02 仍在（与其 200/确认矛盾）→ 对账不一致
    const gw = stubGateway({ membersList: () => [{ platformUserId: 'puid-02' }] });
    const done = runLeaveAllJob(
      { pool: db.pool, gateway: gw.gw, confirmTimeoutMs: 2000, confirmPollMs: 30 },
      jobId,
    );
    for (const id of ['acc-02', 'acc-01']) {
      await waitLeaveCalls(gw.calls.leave, gw.calls.leave.length + 1);
      await markMemberLeft(groupId, id);
    }
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    const { rows: inc } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='inconsistency'",
    );
    expect(inc.length).toBe(1);
    expect(inc[0]?.payload).toMatchObject({ kind: 'member_mismatch', ref: `job:${jobId}` });
  });

  // ---------- b-4 崩溃恢复：在途不重发，查列表定结果 ----------

  it('崩溃于 leave 在途：网关侧已退 → 不重发 leave、补 left_at 继续（E6）', { timeout: 15000 }, async () => {
    const { jobId, groupId } = await makeLeaveJob({
      members: [
        { accountId: 'acc-01', role: 'creator', puid: 'puid-01' },
        { accountId: 'acc-02', role: 'member', puid: 'puid-02' },
      ],
      context: {
        // 崩溃点：acc-02 意图已落（in-flight），网关侧实际已退（members 不含 puid-02）
        states: { 'acc-02': 'in-flight', 'acc-01': 'pending' },
        current: 'acc-02',
      },
    });
    const gw = stubGateway({ membersList: () => [] }); // acc-02 已不在
    const done = runLeaveAllJob(
      { pool: db.pool, gateway: gw.gw, confirmTimeoutMs: 300, confirmPollMs: 30 },
      jobId,
    );
    await waitLeaveCalls(gw.calls.leave, 1);
    expect(gw.calls.leave).toEqual(['acc-01']); // acc-02 绝不重发——只剩群主那次
    await markMemberLeft(groupId, 'acc-01');
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(job.context.states['acc-02']).toBe('left'); // 确认路径：补 left_at
    expect(await activeMembers(groupId)).toEqual([]);
  });

  it('崩溃于 leave 在途：网关侧仍在 → 按失败路径记 LEAVE_FAILED、不重发（E6）', { timeout: 15000 }, async () => {
    const { jobId } = await makeLeaveJob({
      members: [
        { accountId: 'acc-01', role: 'creator', puid: 'puid-01' },
        { accountId: 'acc-02', role: 'member', puid: 'puid-02' },
      ],
      context: {
        states: { 'acc-02': 'in-flight', 'acc-01': 'pending' },
        current: 'acc-02',
      },
    });
    const gw = stubGateway({ membersList: () => [{ platformUserId: 'puid-02' }] });
    await runLeaveAllJob(
      { pool: db.pool, gateway: gw.gw, confirmTimeoutMs: 300, confirmPollMs: 30 },
      jobId,
    );
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'leave:acc-02', code: 'LEAVE_FAILED' }]);
    expect(gw.calls.leave).toEqual([]); // 不重发 + 群主不退
    expect(job.context.states['acc-01']).toBe('skipped');
  });
});

// ---------- 受理面（真实 HTTP + 真 mock 网关） ----------

describe('POST /api/groups/:id/leave-all 受理（§3.2 INIT）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockApp: GatewayApp;
  let token: string;

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
    const l = (await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin' },
    })).json() as { accessToken: string };
    token = l.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await mockApp.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      'TRUNCATE gateway_event, group_member, "group", job, ws_event, account RESTART IDENTITY CASCADE',
    );
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
    await mockApp.inject({ method: 'POST', url: '/_test/scenario/clear' });
    await seed(db.pool);
  });

  it('404 群不存在 / 409 已 left / 403 viewer / 202 受理后真执行器跑通（gw-26 可注入）', { timeout: 20000 }, async () => {
    const auth = { authorization: `Bearer ${token}` };
    const viewer = (await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'viewer', password: 'viewer' },
    })).json() as { accessToken: string };

    const notFound = await app.inject({
      method: 'POST',
      url: '/api/groups/00000000-0000-0000-0000-000000000000/leave-all',
      headers: auth,
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'GROUP_NOT_FOUND' } });

    // 造活跃群（connect + create + 直接落库 active 态——受理路径聚焦点）
    await app.inject({ method: 'POST', url: '/api/accounts/acc-01/connect', headers: auth });
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status) VALUES (gen_random_uuid(), 'acc-01', 'active') RETURNING id`,
    );
    const groupId = g[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, last_event_id)
       VALUES ($1, 'acc-01', 'puid-01', 'creator', now(), 0)`,
      [groupId],
    );

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/leave-all`,
      headers: { authorization: `Bearer ${viewer.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/leave-all`, headers: auth });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const { rows: j } = await db.pool.query('SELECT type, phase, status FROM job WHERE id=$1', [jobId]);
    expect(j[0]?.type).toBe('leave_all');
    expect(j[0]?.phase).toBe('leaving');
    expect(j[0]?.status).toBe('running');
  });
});
