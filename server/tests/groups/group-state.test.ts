// 群查询/PATCH/GWF 级联测试（T-P3-08 c 项，先红后绿）。
// 契约出处：REQ §2.3 群行（响应形状逐字）；DES/04 §1（状态机：creating 隐藏、unreachable 不回转）、
// §5（查询组装 + PATCH 语义 + GWF 单事务级联表）；A2 GWF 行；DES/02 §7.1/§8.2（单飞行索引）。
// 形态：HTTP 面走真 buildApp+真 mock 网关；级联函数（applyGroupUnreachableCascade）直接 tx 内调用——
// 同步错误路径已由 T-P3-02 dispatcher 接它（本任务收敛为唯一 canonical 点）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import { tx } from '../../src/db/tx.js';
import { applyGroupUnreachableCascade } from '../../src/modules/groups/state.js';

interface GroupView {
  id: string;
  gatewayGroupId: string | null;
  status: string;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: Array<{ accountId: string; platformUserId: string; role: string }>;
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
}

describe('群查询 + PATCH + GWF 级联（DES/04 §1/§5、A2）', () => {
  let db: TestDbHandle;
  let app: App;
  let mockApp: GatewayApp;
  let adminToken: string;
  let viewerToken: string;

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
      `TRUNCATE gateway_event, group_member, "group", job, ws_event, account,
               sequence_run, sequence, agent_run, agent_run_step RESTART IDENTITY CASCADE`,
    );
    await mockApp.inject({ method: 'POST', url: '/_test/reset' });
    await mockApp.inject({ method: 'POST', url: '/_test/scenario/clear' });
    await seed(db.pool);
  });

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  async function seedAccount(id: string, puid: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ($1, 'online', $2) ON CONFLICT (id) DO NOTHING`,
      [id, puid],
    );
  }

  /** 造群 + 成员（active 态、网关 id 已关联） */
  async function makeGroup(opts: {
    status?: string;
    members?: Array<{ accountId: string; puid: string; role: string }>;
    agentEnabled?: boolean;
    autoKickEnabled?: boolean;
  }): Promise<string> {
    await seedAccount('acc-01', 'puid-01');
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id, agent_enabled, auto_kick_enabled)
       VALUES (gen_random_uuid(), 'acc-01', $1, 'gw-1', $2, $3) RETURNING id`,
      [opts.status ?? 'active', opts.agentEnabled ?? false, opts.autoKickEnabled ?? false],
    );
    const groupId = g[0]?.id ?? '';
    for (const m of opts.members ?? []) {
      if (m.accountId !== 'acc-01') await seedAccount(m.accountId, m.puid);
      await db.pool.query(
        `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, left_at, last_event_id)
         VALUES ($1, $2, $3, $4, now(), NULL, 0)`,
        [groupId, m.accountId, m.puid, m.role],
      );
    }
    return groupId;
  }

  async function getView(id: string): Promise<GroupView> {
    const res = await app.inject({ method: 'GET', url: `/api/groups/${id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    return res.json() as GroupView;
  }

  // ---------- 响应组装 ----------

  it('GET /api/groups/:id 全字段组装：members role 排序、active*RunId 仅 running 非空', async () => {
    const groupId = await makeGroup({
      members: [
        { accountId: 'acc-01', puid: 'puid-01', role: 'creator' },
        { accountId: 'acc-02', puid: 'puid-02', role: 'member' },
        { accountId: 'acc-03', puid: 'puid-03', role: 'admin' },
        { accountId: 'acc-04', puid: 'puid-04', role: 'member' },
      ],
    });
    // running 序列 + running agent run（部分唯一索引语义；runId/activeRunId 应非空）
    const { rows: seq } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence (id, name, steps) VALUES (gen_random_uuid(), 's1', '[]'::jsonb) RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status) VALUES (gen_random_uuid(), $1, $2, 'running')`,
      [groupId, seq[0]?.id ?? ''],
    );
    await db.pool.query(
      `INSERT INTO agent_run (id, group_id, status, trigger_context) VALUES (gen_random_uuid(), $1, 'running', '{}')`,
      [groupId],
    );

    const view = await getView(groupId);
    expect(view.id).toBe(groupId);
    expect(view.gatewayGroupId).toBe('gw-1');
    expect(view.status).toBe('active');
    expect(view.creatorAccountId).toBe('acc-01');
    expect(view.agentEnabled).toBe(false);
    expect(view.autoKickEnabled).toBe(false);
    // 只含活跃服务账号成员，role 序 creator → admin → member
    expect(view.members.map((m) => [m.accountId, m.role])).toEqual([
      ['acc-01', 'creator'],
      ['acc-03', 'admin'],
      ['acc-02', 'member'],
      ['acc-04', 'member'],
    ]);
    expect(view.members.every((m) => typeof m.platformUserId === 'string')).toBe(true);
    expect(view.activeSequenceRunId).not.toBeNull();
    expect(view.activeAgentRunId).not.toBeNull();
  });

  it('GET /api/groups 列表：creating 群隐藏、left/unreachable 在列', async () => {
    await makeGroup({ status: 'creating' });
    const active = await makeGroup({ status: 'active' });
    const left = await makeGroup({ status: 'left', members: [{ accountId: 'acc-01', puid: 'puid-01', role: 'creator' }] });
    await makeGroup({ status: 'unreachable' });
    const res = await app.inject({ method: 'GET', url: '/api/groups', headers: auth() });
    expect(res.statusCode).toBe(200);
    const list = res.json() as GroupView[];
    const byStatus = new Map(list.map((g) => [g.status, g]));
    expect(byStatus.has('creating')).toBe(false); // 内部态不出现在列表（§1）
    expect(byStatus.get('active')?.id).toBe(active);
    // left 群 members=[]（leave-all 完成语义，即便 DB 行还在也是历史行——视图给空表）
    const leftView = byStatus.get('left');
    expect(leftView?.id).toBe(left);
    expect(leftView?.members).toEqual([]);
    expect(byStatus.get('unreachable')?.status).toBe('unreachable');
    // viewer 可读（GET 非写操作）
    const viewerRes = await app.inject({
      method: 'GET',
      url: '/api/groups',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerRes.statusCode).toBe(200);
  });

  it('GET /api/groups/:id：不存在/creating → 404 GROUP_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/groups/00000000-0000-0000-0000-000000000000',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'GROUP_NOT_FOUND' } });
    const creating = await makeGroup({ status: 'creating' });
    const res2 = await app.inject({ method: 'GET', url: `/api/groups/${creating}`, headers: auth() });
    expect(res2.statusCode).toBe(404); // creating 内部态对外不可见
  });

  it('非 running 的 run 不占 active*RunId', async () => {
    const groupId = await makeGroup({});
    const { rows: seq } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence (id, name, steps) VALUES (gen_random_uuid(), 's', '[]'::jsonb) RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status) VALUES (gen_random_uuid(), $1, $2, 'finished')`,
      [groupId, seq[0]?.id ?? ''],
    );
    await db.pool.query(
      `INSERT INTO agent_run (id, group_id, status, end_reason, trigger_context) VALUES (gen_random_uuid(), $1, 'cancelled', 'cancelled', '{}')`,
      [groupId],
    );
    const view = await getView(groupId);
    expect(view.activeSequenceRunId).toBeNull();
    expect(view.activeAgentRunId).toBeNull();
  });

  // ---------- PATCH ----------

  it('PATCH 开关更新 + ws_event(group_updated)；viewer 403；关闭 agentEnabled 不改 run 状态', async () => {
    const groupId = await makeGroup({});
    const { rows: run } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context) VALUES (gen_random_uuid(), $1, 'running', '{}') RETURNING id`,
      [groupId],
    );
    const runId = run[0]?.id ?? '';

    const viewerRes = await app.inject({
      method: 'PATCH',
      url: `/api/groups/${groupId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { agentEnabled: true },
    });
    expect(viewerRes.statusCode).toBe(403);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/groups/${groupId}`,
      headers: auth(),
      payload: { agentEnabled: true, autoKickEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    const view = res.json() as GroupView;
    expect(view.agentEnabled).toBe(true);
    expect(view.autoKickEnabled).toBe(true);
    const { rows: ev } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='group_updated'",
    );
    expect(ev.at(-1)?.payload).toMatchObject({ groupId });

    // 关闭 agentEnabled：run 状态不变（A5-10「当前这一步结束后」——取消标志=列本身，
    // executor 步结束检查点读库收口；此事务绝不改 run.status）
    const res2 = await app.inject({
      method: 'PATCH',
      url: `/api/groups/${groupId}`,
      headers: auth(),
      payload: { agentEnabled: false },
    });
    expect(res2.statusCode).toBe(200);
    const { rows: r } = await db.pool.query('SELECT status FROM agent_run WHERE id=$1', [runId]);
    expect(r[0]?.status).toBe('running'); // 不被 PATCH 事务打断（X-2 语义前置）
    const { rows: g } = await db.pool.query('SELECT agent_enabled FROM "group" WHERE id=$1', [groupId]);
    expect(g[0]?.agent_enabled).toBe(false); // 取消请求标志 = 列本身
  });

  it('PATCH 类型错误 → 400 VALIDATION_ERROR；不存在 → 404', async () => {
    const groupId = await makeGroup({});
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/groups/${groupId}`,
      headers: auth(),
      payload: { agentEnabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const nf = await app.inject({
      method: 'PATCH',
      url: '/api/groups/00000000-0000-0000-0000-000000000000',
      headers: auth(),
      payload: { agentEnabled: true },
    });
    expect(nf.statusCode).toBe(404);
  });

  // ---------- GWF 级联（applyGroupUnreachableCascade，A2 单事务逐字） ----------

  it('GROUP_WRITE_FORBIDDEN 级联：群 unreachable 幂等 + running 序列 stopped + 账号不动 + 不回转', async () => {
    const groupId = await makeGroup({
      members: [{ accountId: 'acc-01', puid: 'puid-01', role: 'creator' }],
    });
    const { rows: seq } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence (id, name, steps) VALUES (gen_random_uuid(), 's1', '[]'::jsonb) RETURNING id`,
    );
    const { rows: sr } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status, current_step_index)
       VALUES (gen_random_uuid(), $1, $2, 'running', 3) RETURNING id`,
      [groupId, seq[0]?.id ?? ''],
    );
    const runId = sr[0]?.id ?? '';
    // running agent run：级联不触碰（取消请求 = 群态，executor 步末检查——X-2）
    await db.pool.query(
      `INSERT INTO agent_run (id, group_id, status, trigger_context) VALUES (gen_random_uuid(), $1, 'running', '{}')`,
      [groupId],
    );
    const accBefore = (await db.pool.query('SELECT status FROM account WHERE id=$1', ['acc-01'])).rows[0]?.status;

    const cascade = await tx(db.pool, (c) => applyGroupUnreachableCascade(c, groupId));
    expect(cascade.becameUnreachable).toBe(true);
    expect(cascade.stoppedRuns.map((r) => r.id)).toEqual([runId]);
    expect(cascade.stoppedRuns[0]?.current_step_index).toBe(3);

    const { rows: g } = await db.pool.query('SELECT status FROM "group" WHERE id=$1', [groupId]);
    expect(g[0]?.status).toBe('unreachable');
    const { rows: s } = await db.pool.query('SELECT status, ended_at FROM sequence_run WHERE id=$1', [runId]);
    expect(s[0]?.status).toBe('stopped');
    expect(s[0]?.ended_at).not.toBeNull();
    const { rows: a } = await db.pool.query('SELECT status FROM agent_run WHERE group_id=$1', [groupId]);
    expect(a[0]?.status).toBe('running'); // 不写取消状态——标志=群 unreachable（步末检查）
    const accAfter = (await db.pool.query('SELECT status FROM account WHERE id=$1', ['acc-01'])).rows[0]?.status;
    expect(accAfter).toBe(accBefore); // A2 逐字：账号状态不变

    // 幂等：重复触发不再级联（条件更新 WHERE status='active' 命中 0 行）
    const again = await tx(db.pool, (c) => applyGroupUnreachableCascade(c, groupId));
    expect(again.becameUnreachable).toBe(false);
    expect(again.stoppedRuns).toEqual([]);

    // unreachable 不回转（解读 #2）：PATCH 只能动开关列，status 永远保持 unreachable
    await app.inject({
      method: 'PATCH',
      url: `/api/groups/${groupId}`,
      headers: auth(),
      payload: { autoKickEnabled: true },
    });
    const { rows: g2 } = await db.pool.query('SELECT status FROM "group" WHERE id=$1', [groupId]);
    expect(g2[0]?.status).toBe('unreachable');
  });
});
