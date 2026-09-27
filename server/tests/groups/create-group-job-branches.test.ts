// 建群 job 异常分支测试（T-P3-06 c 项，先红后绿）。
// 契约出处：DES/04 §2.2 要点逐字（INVITE_NOT_READY 无上限 / INVITE_EXPIRED 重申一次 /
// ALREADY_MEMBER UPSERT / JOIN_TIMEOUT 精确到成员 / promote 总调用 ≤2 持久化累计）、
// §2.4 崩溃续传（waiting 不重发、deadline 不重置）、REQ B2 第 1 条、QR §1/§4。
// 测试形态：直接构造 job 行（脱离受理层）+ 脚本化 GatewayClient stub 驱动执行器——
// 分支响应序列逐脚本确定，真实网关集成已由 create-group-job.test.ts 覆盖主链。
// ALREADY_MEMBER 的 D2-2 端到端回归另挂真实 mock 网关（gw-22 开关验证「不推事件」）。
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
import { GatewayError } from '../../src/gateway/errors.js';
import { runCreateGroupJob } from '../../src/modules/groups/create-job.js';
import { runJoinTimeoutScan } from '../../src/modules/groups/create-job-branches.js';
import { JOIN_TIMEOUT_MS } from '../../src/constants.js';

interface JobSnapshot {
  phase: string;
  status: string;
  errors: Array<{ step: string; code: string }>;
  context: {
    inviteLink?: string;
    inviteReadyAt?: number;
    reinviteUsed?: boolean;
    members?: Record<string, string>;
    promoteCalls?: number;
  };
  join_deadline_at: Date | null;
}

type JoinReply = { accepted: boolean };
import type { GatewayClientErrorCode } from '../../src/gateway/errors.js';
type InviteReply = { inviteLink: string; readyAfterMs: number };

/** 脚本化网关：join/promote 按「队列消费，耗尽回放末项」；invite 恒成功递增链接 */
function stubGateway(script: {
  join?: Array<JoinReply | { code: GatewayClientErrorCode; status?: number; body?: unknown }>;
  promote?: Array<undefined | { code: GatewayClientErrorCode }>;
  invite?: Array<InviteReply | { code: GatewayClientErrorCode }>;
}) {
  const joinQ = [...(script.join ?? [{ accepted: true }])];
  const promoteQ = [...(script.promote ?? [undefined])];
  const inviteQ = [...(script.invite ?? [{ inviteLink: 'lnk-1', readyAfterMs: 0 }])];
  const calls = { join: [] as string[], promote: [] as string[], invite: 0 };
  const gw: Pick<GatewayClient, 'createGroup' | 'invite' | 'join' | 'promote'> = {
    createGroup: () => Promise.resolve({ groupId: 'gw-stub' }),
    invite: () => {
      calls.invite += 1;
      const item = (inviteQ.length > 1 ? inviteQ.shift() : inviteQ[0]) ?? { inviteLink: 'lnk-x', readyAfterMs: 0 };
      if ('code' in item) {
        return Promise.reject(new GatewayError({ endpoint: 'invite', status: 500, code: item.code }));
      }
      return Promise.resolve(item);
    },
    join: (_g, input) => {
      calls.join.push(input.accountId);
      const item = (joinQ.length > 1 ? joinQ.shift() : joinQ[0]) ?? { accepted: true };
      if ('code' in item) {
        return Promise.reject(
          new GatewayError({ endpoint: 'join', status: item.status ?? 409, code: item.code, body: item.body }),
        );
      }
      return Promise.resolve(item);
    },
    promote: (_g, input) => {
      calls.promote.push(input.accountId);
      const item = promoteQ.length > 1 ? promoteQ.shift() : promoteQ[0];
      if (item !== undefined) {
        return Promise.reject(new GatewayError({ endpoint: 'promote', status: 409, code: item.code }));
      }
      return Promise.resolve();
    },
  };
  return { gw, calls };
}

describe('建群 job 异常分支（DES/04 §2.2/§2.4 逐字）', () => {
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
    await db.pool.query("INSERT INTO event_cursor (id, last_event_id) VALUES (1, 0) ON CONFLICT DO NOTHING");
  });

  /** 落库服务账号（执行器不做 connect——puid 预置模拟已在线） */
  async function seedAccount(id: string, puid: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ($1, 'online', $2)
       ON CONFLICT (id) DO UPDATE SET status='online', platform_user_id=$2`,
      [id, puid],
    );
  }

  /** 造指定相位/上下文的 running job（不走受理层——崩溃续传与分支测试的正典 arrange） */
  async function makeJob(opts: {
    phase: string;
    context?: unknown;
    members?: string[];
    creator?: string;
    deadlineMs?: number | null;
  }): Promise<string> {
    const creator = opts.creator ?? 'acc-01';
    const members = opts.members ?? ['acc-02'];
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id) VALUES (gen_random_uuid(), $1, 'creating', 'gw-stub') RETURNING id`,
      [creator],
    );
    const context = {
      inviteLink: 'lnk-1',
      inviteReadyAt: 0,
      members: Object.fromEntries(members.map((m) => [m, 'pending'])),
      ...(opts.context as Record<string, unknown> | undefined),
    };
    const { rows: j } = await db.pool.query<{ id: string }>(
      `INSERT INTO job (id, type, group_id, payload, phase, context, join_deadline_at)
       VALUES (gen_random_uuid(), 'create_group', $1, $2::jsonb, $3, $4::jsonb,
               CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() + ($5 * interval '1 millisecond') END)
       RETURNING id`,
      [
        g[0]?.id ?? '',
        JSON.stringify({ creatorAccountId: creator, memberAccountIds: members }),
        opts.phase,
        JSON.stringify(context),
        opts.deadlineMs ?? null,
      ],
    );
    return j[0]?.id ?? '';
  }

  async function jobRow(jobId: string): Promise<JobSnapshot> {
    const { rows } = await db.pool.query<JobSnapshot>(
      'SELECT phase, status, errors, context, join_deadline_at FROM job WHERE id=$1',
      [jobId],
    );
    const row = rows[0]; if (row === undefined) throw new Error('job row missing'); return row;
  }

  /** 轮询网关调用计数（脚本化 stub 的推进观察点） */
  async function waitForCalls(list: unknown[], n: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (list.length >= n) return;
      if (Date.now() > deadline) throw new Error(`calls never reached ${n} (got ${list.length})`);
      await sleep(30);
    }
  }

  /** 等价事件路径写：把 context.members[x] 置 joined（member_joined 同事务语义） */
  async function markJoined(jobId: string, accountId: string): Promise<void> {
    await db.pool.query(
      `UPDATE job SET context = jsonb_set(context, '{members,${accountId}}', '"joined"'), updated_at=now()
       WHERE id=$1 AND status='running'`,
      [jobId],
    );
  }

  // ---------- INVITE_NOT_READY：等 readyAfterMs 重试、不设限 ----------

  it('INVITE_NOT_READY：按响应 readyAfterMs 重试直至成功（不设上限）', { timeout: 15000 }, async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({ phase: 'joining' });
    const { gw, calls } = stubGateway({
      join: [
        { code: 'INVITE_NOT_READY', body: { readyAfterMs: 120 } },
        { code: 'INVITE_NOT_READY', body: { readyAfterMs: 120 } },
        { code: 'INVITE_NOT_READY', body: { readyAfterMs: 80 } },
        { accepted: true },
      ],
    });
    const t0 = Date.now();
    const done = runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    // 等 join 调用第 4 次落地（进 waiting_joins）后置 joined 推进主链到 promote
    await waitForCalls(calls.join, 4, 10000);
    const joinedElapsed = Date.now() - t0;
    await markJoined(jobId, 'acc-02');
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(calls.join).toEqual(['acc-02', 'acc-02', 'acc-02', 'acc-02']); // 4 次 >2，证不设限
    expect(joinedElapsed).toBeGreaterThanOrEqual(300); // 三次 readyAfterMs 等待累计
    const { rows: m } = await db.pool.query("SELECT role FROM group_member WHERE account_id='acc-02'");
    expect(m[0]?.role).toBe('admin');
  });

  // ---------- INVITE_EXPIRED：重申链接一次（B2 逐字） ----------

  it('INVITE_EXPIRED → 重新申请链接后重试一次成功；群与账号状态不变（B2）', { timeout: 15000 }, async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({ phase: 'joining' });
    const { gw, calls } = stubGateway({
      join: [{ code: 'INVITE_EXPIRED', status: 410 }, { accepted: true }],
      invite: [
        { inviteLink: 'lnk-2', readyAfterMs: 0 }, // 重申返回新链接
      ],
    });
    const done = runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    await waitForCalls(calls.join, 2, 10000);
    await markJoined(jobId, 'acc-02');
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(job.context.reinviteUsed).toBe(true);
    expect(job.context.inviteLink).toBe('lnk-2'); // 重申一次得到的新链接
    expect(calls.invite).toBe(1); // 只有一次重申请
    expect(calls.join).toEqual(['acc-02', 'acc-02']); // join 两次：410 → 成功
    // B2「群与账号状态都不变」：分支期间无旁改；群状态由主链成功事务统一推进
    const { rows: a } = await db.pool.query("SELECT status FROM account WHERE id='acc-02'");
    expect(a[0]?.status).toBe('online');
  });

  it('INVITE_EXPIRED 重试再 410（重申机会已用尽）→ failed step=join:<id>', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({ phase: 'joining' });
    const { gw, calls } = stubGateway({
      join: [{ code: 'INVITE_EXPIRED', status: 410 }, { code: 'INVITE_EXPIRED', status: 410 }],
    });
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'join:acc-02', code: 'INVITE_EXPIRED' }]);
    expect(calls.invite).toBe(1);
    expect(calls.join.length).toBe(2); // 原调用 + 重申后一次——绝无第三次
  });

  it('INVITE_EXPIRED 且重申邀请本身失败 → failed step=invite', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({ phase: 'joining' });
    const { gw } = stubGateway({
      join: [{ code: 'INVITE_EXPIRED', status: 410 }],
      invite: [{ code: 'UNAVAILABLE' }],
    });
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'invite', code: 'UNAVAILABLE' }]);
  });

  // ---------- ALREADY_MEMBER：视为成功 + UPSERT（D2-2） ----------

  it('ALREADY_MEMBER → 视为成功直接 promote，UPSERT 成员行→admin（D2-2 回归）', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({ phase: 'joining', members: ['acc-02'] });
    const { gw, calls } = stubGateway({
      join: [{ code: 'ALREADY_MEMBER' }],
    });
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(job.errors).toEqual([]);
    expect(job.context.members?.['acc-02']).toBe('joined');
    expect(calls.join).toEqual(['acc-02']); // 不重发
    // D2-2：job 事务 UPSERT 的成员行存在；promote 提升 admin（行缺失时 promote 更新会静默落空）
    const { rows: m } = await db.pool.query(
      "SELECT role, left_at FROM group_member WHERE account_id='acc-02'",
    );
    expect(m[0]?.role).toBe('admin'); // memberAccountIds[0] 被 promote
    expect(m[0]?.left_at).toBeNull();
    // gateway_event 账本里绝无 member_joined（D2-2：网关不推——无行可断言即无事件路径写入）
    const { rows: ev } = await db.pool.query("SELECT type FROM gateway_event WHERE type='member_joined'");
    expect(ev.length).toBe(0);
  });

  // ---------- JOIN_TIMEOUT：10s 未到 → failed，step 精确到成员 ----------

  it('waiting_joins 到期未到齐 → 扫描体收口 failed(JOIN_TIMEOUT)，step 精确到缺席成员（A2）', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    await seedAccount('acc-03', 'puid-3');
    // acc-02 已 joined、acc-03 waiting 且 deadline 已过 → 到点应是 acc-03 背锅
    const jobId = await makeJob({
      phase: 'waiting_joins',
      members: ['acc-02', 'acc-03'],
      context: { members: { 'acc-02': 'joined', 'acc-03': 'waiting' } },
      deadlineMs: -1000, // 已过 1s
    });
    const n = await runJoinTimeoutScan({ pool: db.pool });
    expect(n).toBe(1);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'join:acc-03', code: 'JOIN_TIMEOUT' }]);
    const { rows: ev } = await db.pool.query("SELECT payload FROM ws_event WHERE type='job'");
    expect(ev.at(-1)?.payload).toMatchObject({ jobId, status: 'failed' });
  });

  it('waiting_joins 未到期 → 扫描体空转不误伤；窗口保留（§2.4 不重置）', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({
      phase: 'waiting_joins',
      deadlineMs: JOIN_TIMEOUT_MS, // 未来 10s
    });
    const n = await runJoinTimeoutScan({ pool: db.pool });
    expect(n).toBe(0);
    const job = await jobRow(jobId);
    expect(job.status).toBe('running');
    expect(job.errors).toEqual([]);
  });

  // ---------- promote NOT_MEMBER_YET：总调用 ≤2、计数持久化 ----------

  it('NOT_MEMBER_YET 第一次 → 等 1s 重试成功；context.promoteCalls 持久化=2', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({
      phase: 'promote',
      context: { members: { 'acc-02': 'joined' } },
    });
    const { gw, calls } = stubGateway({
      promote: [{ code: 'NOT_MEMBER_YET' }, undefined],
    });
    const t0 = Date.now();
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const elapsed = Date.now() - t0;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(calls.promote).toEqual(['acc-02', 'acc-02']); // 恰好 2 次
    expect(job.context.promoteCalls).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900); // 重试等 ~1s（PROMOTE_RETRY_WAIT_MS）
    const { rows: m } = await db.pool.query("SELECT role FROM group_member WHERE account_id='acc-02'");
    expect(m[0]?.role).toBe('admin');
  });

  it('NOT_MEMBER_YET 两次仍失败 → failed(promote)，调用总数恰好 2（A2 上限）', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({
      phase: 'promote',
      context: { members: { 'acc-02': 'joined' } },
    });
    const { gw, calls } = stubGateway({
      promote: [{ code: 'NOT_MEMBER_YET' }, { code: 'NOT_MEMBER_YET' }],
    });
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'promote', code: 'NOT_MEMBER_YET' }]);
    expect(calls.promote.length).toBe(2); // ≤2 硬上限：第三次调用绝不存在
    expect(job.context.promoteCalls).toBe(2);
  });

  it('崩溃续传：promoteCalls=1 已持久化 → 恢复后仅再调 1 次即达上限失败', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    // 模拟崩溃点：promote 已调 1 次（计数已落库）后被杀，context 里 promoteCalls=1
    const jobId = await makeJob({
      phase: 'promote',
      context: { members: { 'acc-02': 'joined' }, promoteCalls: 1 },
    });
    const { gw, calls } = stubGateway({
      promote: [{ code: 'NOT_MEMBER_YET' }],
    });
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'promote', code: 'NOT_MEMBER_YET' }]);
    expect(calls.promote.length).toBe(1); // 续传累计 1+1=2 到上限，绝不第三次
    expect(job.context.promoteCalls).toBe(2);
  });

  // ---------- §2.4 崩溃续传：joining ----------

  it('joining 崩溃续传：waiting 成员不重发 join，pending 成员正常发（§2.4）', { timeout: 15000 }, async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    await seedAccount('acc-03', 'puid-3');
    // 崩溃点：acc-02 已 waiting（join 已受理），acc-03 的 join 尚未发出
    const jobId = await makeJob({
      phase: 'joining',
      members: ['acc-02', 'acc-03'],
      context: { members: { 'acc-02': 'waiting', 'acc-03': 'pending' } },
    });
    const { gw, calls } = stubGateway({}); // join 默认接受
    const done = runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    // 等 acc-03 的 join 发出（context.members.acc-03 → waiting；waiting_joins deadline 由执行器钉 10s，不干扰）
    await waitForCalls(calls.join, 1, 8000);
    expect(calls.join).toEqual(['acc-03']); // acc-02 的 waiting 没有重发——续传语义的核心断言
    // 事件路径等价写：两成员 joined → promote → finished
    await markJoined(jobId, 'acc-02');
    await markJoined(jobId, 'acc-03');
    await done;
    const job = await jobRow(jobId);
    expect(job.status).toBe('finished');
    expect(calls.join).toEqual(['acc-03']); // 全程只对 acc-03 发过一次 join
  });

  it('waiting_joins 续传：原 deadline 已过 → 立即按 JOIN_TIMEOUT 收口（max(原值,now) 不重置）', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({
      phase: 'waiting_joins',
      context: { members: { 'acc-02': 'waiting' } },
      deadlineMs: -500, // 原 deadline 已过：恢复即应判超时，窗口绝不被续传重置
    });
    await runCreateGroupJob({ pool: db.pool, gateway: stubGateway({}).gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'join:acc-02', code: 'JOIN_TIMEOUT' }]);
  });

  // ---------- B2 未定义分支：其他 join 错误 → 失败终止，码逐字 ----------

  it('join 遇 B2 未定义错误（ACCOUNT_OFFLINE）→ failed step=join:<id> 码透传', async () => {
    await seedAccount('acc-01', 'puid-creator');
    await seedAccount('acc-02', 'puid-2');
    const jobId = await makeJob({ phase: 'joining' });
    const { gw } = stubGateway({
      join: [{ code: 'ACCOUNT_OFFLINE' }],
    });
    await runCreateGroupJob({ pool: db.pool, gateway: gw }, jobId);
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errors).toEqual([{ step: 'join:acc-02', code: 'ACCOUNT_OFFLINE' }]);
  });
});

// ---------- D2-2 端到端：真实 mock 网关下 ALREADY_MEMBER（gw-22）路径 ----------
// 「网关不推 member_joined」是契约明文（REQ §2.1）；这里用真网关验证整条链：
// join 409 → 成员行 UPSERT → promote 直接成功 → role=admin。
describe('ALREADY_MEMBER 端到端（真实 mock 网关 + gw-22 开关）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockApp: GatewayApp;
  let token: string;
  let gateway: GatewayClient;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    gateway = createGatewayClient({ baseUrl });
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
      gateway,
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
    await db.pool.query("INSERT INTO event_cursor (id, last_event_id) VALUES (1, 0) ON CONFLICT DO NOTHING");
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
    await mockApp.inject({ method: 'POST', url: '/_test/scenario/clear' });
    await seed(db.pool);
  });

  it('gw-22 already_member：join 409 → job 走 ALREADY_MEMBER 分支 → finished + member[0]=admin', { timeout: 15000 }, async () => {
    const auth = { authorization: `Bearer ${token}` };
    // connect 两账号（mock 侧分配 puid；server account 行同步 puid——connect 走真实网关）
    for (const a of ['acc-01', 'acc-02']) {
      const r = await app.inject({ method: 'POST', url: `/api/accounts/${a}/connect`, headers: auth });
      expect(r.statusCode).toBe(200);
    }
    // 从 create 相位起跑：执行器向真网关建群 → invite → join（命中 gw-22）→ promote
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status) VALUES (gen_random_uuid(), 'acc-01', 'creating') RETURNING id`,
    );
    const { rows: j } = await db.pool.query<{ id: string }>(
      `INSERT INTO job (id, type, group_id, payload, phase, context)
       VALUES (gen_random_uuid(), 'create_group', $1, '{"creatorAccountId":"acc-01","memberAccountIds":["acc-02"]}'::jsonb,
               'create', '{"members":{"acc-02":"pending"}}'::jsonb) RETURNING id`,
      [g[0]?.id ?? ''],
    );
    const jobId = j[0]?.id ?? '';
    await mockApp.inject({ method: 'POST', url: '/_test/scenario', payload: { switch: 'already_member' } });
    // ALREADY_MEMBER 路径同步置 context.joined（不依赖 member_joined 事件——契约明文不推）
    await runCreateGroupJob({ pool: db.pool, gateway }, jobId);
    const job = (await db.pool.query('SELECT status, phase, errors FROM job WHERE id=$1', [jobId])).rows[0] ?? { status: '?', phase: '?', errors: [] };
    expect(job.status).toBe('finished');
    expect(job.errors).toEqual([]);
    // D2-2：成员行由 job 事务 UPSERT；promote 提升 admin（行缺失会让 promote 更新静默落空）
    const { rows: m } = await db.pool.query("SELECT role FROM group_member WHERE account_id='acc-02'");
    expect(m[0]?.role).toBe('admin');
    // 事件账本绝无 member_joined（gw-22 不推；契约明文+mock 侧已保证不 appendLedger）
    const { rows: ev } = await db.pool.query("SELECT type FROM gateway_event WHERE type='member_joined'");
    expect(ev.length).toBe(0);
  });
});
