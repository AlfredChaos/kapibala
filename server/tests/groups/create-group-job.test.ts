// 建群 job 主流程测试（T-P3-05 c 项，先红后绿）。
// 契约出处：REQ §2.3（POST /api/groups 受理形状 + GET /api/jobs/:jobId）、A3（写入时机）、
// B2（建群主链）；DES/04 §2.1–§2.3（phase 链 + 每步意图先行）+ §7（JOB_NOT_FOUND 自定码）；
// DES/02 §6.1（job 表 = outbox）；G-05（creator 无 member_joined）；QR §4（错误码）。
// 事件路径走真实 handleEventFrame（账本→孤儿分流→dispatch→member handler→context 更新），
// 执行器与测试同进程运行（JobRunner）；member_joined 帧由测试手工投递（eventId 自选）。
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import { handleEventFrame, type ConsumerLogger } from '../../src/events/consumer.js';
import { loadCursorTracker } from '../../src/events/cursor.js';
import { createDispatchRegistry } from '../../src/events/dispatch.js';
import { createMemberHandler } from '../../src/events/handlers/member.js';
import { createAccountStatusHandler } from '../../src/events/handlers/account-status.js';
import type { SseFrame } from '../../src/gateway/sse.js';
import { setTimeout as sleep } from 'node:timers/promises';

const logger: ConsumerLogger = { info() {}, warn() {}, error() {} };

interface JobView {
  status: string;
  errors: Array<{ step: string; code: string }>;
}

describe('POST /api/groups + 建群 job 主链（DES/04 §2.1–2.3）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockApp: GatewayApp;
  let adminToken: string;
  let viewerToken: string;
  let registry: ReturnType<typeof createDispatchRegistry>;
  let nextEventId: number;

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  /** 直接经 server API connect（内部调真实 mock 网关）→ 返回网关分配的 platformUserId */
  async function connectAccount(id: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${id}/connect`,
      headers: authed(adminToken),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { platformUserId: string }).platformUserId;
  }

  /** 投递一帧 member_joined（走消费层全路径：账本+孤儿分流+dispatch+投影+job context） */
  async function deliverMemberJoined(gwGroupId: string, puid: string): Promise<void> {
    const eventId = nextEventId++;
    const payload = { type: 'member_joined', eventId, groupId: gwGroupId, platformUserId: puid };
    const frame: SseFrame = { eventId, event: 'member_joined', data: payload, rawData: JSON.stringify(payload) };
    const tracker = await loadCursorTracker(db.pool);
    await handleEventFrame(
      { pool: db.pool, registry, logger, tracker },
      frame,
    );
  }

  /** 轮询 mock 网关直到成员真实入群（member_joined 定时器已 fire）——伪造帧的序前提 */
  async function waitGatewayMember(gwGroupId: string, puid: string): Promise<void> {
    const deadline = Date.now() + 15000;
    for (;;) {
      const res = await mockApp.inject({ method: 'GET', url: `/groups/${gwGroupId}/members` });
      const members = res.json() as Array<{ platformUserId: string }>;
      if (members.some((m) => m.platformUserId === puid)) return;
      if (Date.now() > deadline) throw new Error(`gateway member_joined never landed for ${puid}`);
      await sleep(50);
    }
  }

  async function jobOf(jobId: string): Promise<JobView> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${jobId}`,
      headers: authed(adminToken),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as JobView;
  }

  async function waitJob(jobId: string, statuses: string[], timeoutMs = 15000): Promise<JobView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await jobOf(jobId);
      if (statuses.includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} stuck at ${job.status}`);
      await sleep(50);
    }
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
    registry = createDispatchRegistry();
    registry.register('member_joined', createMemberHandler(logger));
    registry.register('member_left', createMemberHandler(logger));
    registry.register('account_status', createAccountStatusHandler(logger));
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
      gateway: createGatewayClient({ baseUrl }),
    });
    const login = async (u: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: u } }))
        .json() as { accessToken: string };
    adminToken = (await login('admin')).accessToken;
    viewerToken = (await login('viewer')).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await mockApp.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE ws_event, gateway_event, pending_event, event_cursor, sequence_run_step, sequence_run,
        sequence, message, group_member, "group", job, account RESTART IDENTITY CASCADE`,
    );
    await db.pool.query("INSERT INTO event_cursor (id, last_event_id) VALUES (1, 0) ON CONFLICT (id) DO NOTHING");
    await seed(db.pool);
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
    nextEventId = 1;
  });

  // ---------- 受理校验（DES/04 §2.1） ----------

  it('参数形状非法 → 400 VALIDATION_ERROR（空 members / 含群主 / 重复）', async () => {
    for (const payload of [
      { creatorAccountId: 'acc-01', memberAccountIds: [] },
      { creatorAccountId: 'acc-01', memberAccountIds: ['acc-01', 'acc-02'] },
      { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02', 'acc-02'] },
      { memberAccountIds: ['acc-02'] },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/groups', headers: authed(adminToken), payload });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('任一账号非 online → 422 ACCOUNT_NOT_ONLINE', async () => {
    await connectAccount('acc-01'); // creator online
    // acc-02 未 connect（idle）
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: authed(adminToken),
      payload: { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02'] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'ACCOUNT_NOT_ONLINE' } });
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM job');
    expect(rows[0]?.n).toBe(0); // 不产生 job
  });

  it('viewer 受理 → 403 FORBIDDEN（写操作矩阵）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: authed(viewerToken),
      payload: { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02'] },
    });
    expect(res.statusCode).toBe(403);
  });

  // ---------- 正常链 ----------

  it('202 {jobId} → create→invite→join(并行)→member_joined→promote→finished；creator=creator 行、member[0]=admin', async () => {
    await connectAccount('acc-01');
    const puid2 = await connectAccount('acc-02');
    const puid3 = await connectAccount('acc-03');

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: authed(adminToken),
      payload: { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02', 'acc-03'] },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    // 受理即刻：job running + group 行存在（creating，对外三态不含它）
    const { rows: g0 } = await db.pool.query(
      "SELECT status, gateway_group_id FROM \"group\" WHERE id = (SELECT group_id FROM job WHERE id=$1)",
      [jobId],
    );
    expect(g0[0]?.status).toBe('creating');

    // 等执行器推进到 waiting_joins（join 已发出、等 member_joined）
    const job0 = await waitJob(jobId, ['running', 'finished']);
    void job0;
    // 轮询 context：members 都 waiting 后投递 member_joined 帧
    const deadline = Date.now() + 15000;
    let gwGroupId = '';
    for (;;) {
      const { rows } = await db.pool.query<{ phase: string; context: { members?: Record<string, string> }; gateway: string | null }>(
        `SELECT j.phase, j.context, g.gateway_group_id AS gateway FROM job j JOIN "group" g ON g.id=j.group_id WHERE j.id=$1`,
        [jobId],
      );
      const r = rows[0];
      if (r?.phase === 'waiting_joins' && r.gateway !== null) {
        gwGroupId = r.gateway;
        break;
      }
      if (Date.now() > deadline) throw new Error('job never reached waiting_joins');
      await sleep(50);
    }
    // creator 行已在 create 事务写入（A3；无 member_joined）
    const { rows: creatorRow } = await db.pool.query(
      'SELECT role, left_at FROM group_member WHERE account_id=$1',
      ['acc-01'],
    );
    expect(creatorRow[0]?.role).toBe('creator');
    expect(creatorRow[0]?.left_at).toBeNull();

    // 伪造帧注入前必须等网关真实入群：member_joined 的事件序保证「发帧时网关已把成员
    // 加进 group.members」（mock 在 100–1500ms 定时器里 add+推帧）。测试绕过 SSE 手工投递，
    // 不先确认成员到位会出现 promote 先于真实入群的窗口：NOT_MEMBER_YET 重试 1s 仍不中 →
    // calls≥2 → job failed（并行负载下定时器延迟放大才踩中）。poll mock 自身状态消竞态。
    for (const puid of [puid2, puid3]) {
      await waitGatewayMember(gwGroupId, puid);
    }
    // 模拟网关推 member_joined（A3-2：事件路径写成员行 + job context）
    await deliverMemberJoined(gwGroupId, puid2);
    await deliverMemberJoined(gwGroupId, puid3);

    const done = await waitJob(jobId, ['finished', 'failed']);
    expect(done.status).toBe('finished');
    expect(done.errors).toEqual([]);

    const { rows: members } = await db.pool.query(
      'SELECT account_id, role, left_at FROM group_member ORDER BY account_id',
    );
    const byAcc = new Map(members.map((m) => [m.account_id, m]));
    expect(byAcc.get('acc-01')?.role).toBe('creator');
    expect(byAcc.get('acc-02')?.role).toBe('admin'); // memberAccountIds[0]
    expect(byAcc.get('acc-03')?.role).toBe('member');
    expect([...byAcc.values()].every((m) => m.left_at === null)).toBe(true);

    const { rows: grp } = await db.pool.query('SELECT status FROM "group" WHERE gateway_group_id=$1', [gwGroupId]);
    expect(grp[0]?.status).toBe('active');

    // ws_event：job finished 帧（{jobId,status}）
    const { rows: evs } = await db.pool.query(
      "SELECT type, payload FROM ws_event WHERE type='job'",
    );
    expect(evs.at(-1)?.payload).toMatchObject({ jobId, status: 'finished' });
  });

  it('GET /api/jobs/:jobId 不存在 → 404 JOB_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/00000000-0000-0000-0000-000000000000',
      headers: authed(adminToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'JOB_NOT_FOUND' } });
  });

  it('未认证 → 401；viewer 可读 job', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/jobs/x' });
    expect(anon.statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/00000000-0000-0000-0000-000000000000',
      headers: authed(viewerToken),
    });
    expect(res.statusCode).toBe(404); // viewer 可读（GET 非写操作）
  });
});
