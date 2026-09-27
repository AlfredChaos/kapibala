// 场景环境装配（T-P3-11；REQ §2.4 S1–S4、DES/14 §8、analysis/09 §1）。
// 一条命令起「真 PG + in-process mock-gateway + mock-agent + 真实 server（boot() 全管线：
// SSE 消费循环、dispatcher、adjudicator、调度器、HTTP）」，场景测试与 scripts/demo 共用同一工厂。
// 断言纪律（DES/14 §4）：行为真值走 GET /_test/counters + REST 读面，不以日志为准。
// 清理：env.close() 顺序停 server → 两个 mock → DROP 测试库；每文件一库（helpers/db.ts 模板克隆）。
import type { Pool, PoolClient } from 'pg';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { pino } from 'pino';
import { createGatewayApp, type GatewayApp } from 'mock-gateway/src/app.js';
import { createAgentApp, type AgentApp } from 'mock-agent/src/app.js';
import { getTestDb, type TestDbHandle } from './db.js';
import { seed } from '../../src/db/seed.js';
import { loadConfig, type AppConfig } from '../../src/config/index.js';
import { boot, type BootHandle } from '../../src/index.js';
import { tx } from '../../src/db/tx.js';

export interface TimelineItem {
  readonly msgId: string | null;
  readonly clientMsgId: string | null;
  readonly senderPlatformUserId: string;
  readonly isOwn: boolean;
  readonly text: string;
  readonly sentAt: string;
  readonly deliveryStatus: string | null;
  readonly failCode: string | null;
}

export interface ScenarioEnv {
  readonly pool: Pool;
  /** server 实际监听基地址（http://127.0.0.1:PORT） */
  readonly serverUrl: string;
  readonly gateway: GatewayApp;
  readonly gatewayUrl: string;
  readonly agent: AgentApp;
  readonly agentUrl: string;
  readonly db: TestDbHandle;
  /** admin bearer token（写端点 auth:'write'） */
  readonly token: string;
  /** 停止一切：server → mock ×2 → DROP 库。幂等。 */
  close(): Promise<void>;
}

export interface ArmTarget {
  readonly groupId?: string;
  readonly accountId?: string;
  readonly clientMsgId?: string;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function listen(app: { listen(opts: { port: number; host: string }): Promise<unknown> }): Promise<string> {
  const port = await freePort();
  await app.listen({ port, host: '127.0.0.1' });
  return `http://127.0.0.1:${port}`;
}

/**
 * 起完整场景环境：建库（模板克隆已含迁移）→ seed → mock-gateway + mock-agent listen →
 * boot(config)（版本门 + 恢复扫描登记 + SSE 消费 + 调度器 + 监听）→ admin 登录拿 token。
 * （boot 不做 seed——seed 是 CLI 职责；场景环境显式调用，避免把测试基建偷渡进生产路径）
 */
export async function startScenarioEnv(): Promise<ScenarioEnv> {
  const db = await getTestDb();
  await seed(db.pool); // 预置 admin/viewer + 四个服务账号（boot 不做 seed——CLI 职责，REQ §2.1）
  const gateway = createGatewayApp({ logger: false });
  const agent = createAgentApp({ logger: false, mode: 'scripted' });
  const gatewayUrl = await listen(gateway);
  const agentUrl = await listen(agent);

  const config: AppConfig = loadConfig({
    PORT: String(await freePort()),
    DATABASE_URL: db.connectionString,
    GATEWAY_URL: gatewayUrl,
    AGENT_URL: agentUrl,
  });
  const handle: BootHandle = await boot({ config, logger: pino({ level: 'silent' }) });
  // boot() 已监听（listen 是启动序列最后一步）；从 app 实例读真实地址
  const server = (handle.app.server as Server).address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${server.port}`;

  const token = await login(serverUrl);

  let closed = false;
  return {
    pool: db.pool,
    serverUrl,
    gateway,
    gatewayUrl,
    agent,
    agentUrl,
    db,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await handle.stop().catch(() => undefined);
      await gateway.close().catch(() => undefined);
      await agent.close().catch(() => undefined);
      await db.close();
    },
  };
}

async function login(serverUrl: string): Promise<string> {
  const res = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

// ---------- REST 便捷封装（断言走读面；写操作走契约端点，不直达 DB） ----------

export function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/** 条件轮询（真实 I/O：连真 PG + 真 mock + 真 server，不 fake 时钟） */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 连接服务账号到 mock（/api/accounts/:id/connect → status=online） */
export async function connectAccount(env: ScenarioEnv, accountId: string): Promise<void> {
  const res = await fetch(`${env.serverUrl}/api/accounts/${accountId}/connect`, {
    method: 'POST',
    headers: authed(env.token),
    body: '{}', // content-type=json + 空 body 会被 Fastify 拒（VALIDATION_ERROR）
  });
  if (!res.ok) throw new Error(`connect ${accountId}: ${res.status} ${await res.text()}`);
}

export interface SetupGroupResult {
  readonly dbGroupId: string;
  readonly gwGroupId: string;
  readonly jobId: string;
}

/** 建群到 active：connect 所有账号 → POST /api/groups → 轮询 job finished → 读群详情拿 gatewayGroupId */
export async function setupGroup(
  env: ScenarioEnv,
  accounts: { creator: string; members: string[] },
): Promise<SetupGroupResult> {
  for (const id of [accounts.creator, ...accounts.members]) await connectAccount(env, id);
  const res = await fetch(`${env.serverUrl}/api/groups`, {
    method: 'POST',
    headers: authed(env.token),
    body: JSON.stringify({ creatorAccountId: accounts.creator, memberAccountIds: accounts.members }),
  });
  if (!res.ok) throw new Error(`POST /api/groups: ${res.status} ${await res.text()}`);
  const { jobId } = (await res.json()) as { jobId: string };
  const done = await waitJob(env, jobId, ['finished', 'failed']);
  if (done.status !== 'finished') {
    throw new Error(`create-group job ${jobId} ended ${done.status}: ${JSON.stringify(done.errors)}`);
  }
  // job 响应契约只暴露 {status, errors}——group_id 不是对外字段，走库读（内部一致性断言）
  const { rows: jr } = await env.pool.query<{ group_id: string }>(
    'SELECT group_id FROM job WHERE id=$1',
    [jobId],
  );
  const dbGroupId = jr[0]?.group_id;
  if (dbGroupId === undefined) throw new Error(`job ${jobId} has no group_id`);
  const group = await getGroup(env, dbGroupId);
  if (group.gatewayGroupId === null) throw new Error(`group ${dbGroupId} has no gatewayGroupId after finished job`);
  return { dbGroupId, gwGroupId: group.gatewayGroupId, jobId };
}

export async function getGroup(
  env: ScenarioEnv,
  groupId: string,
): Promise<{ id: string; gatewayGroupId: string | null; status: string; agentEnabled: boolean }> {
  const res = await fetch(`${env.serverUrl}/api/groups/${groupId}`, { headers: authed(env.token) });
  if (!res.ok) throw new Error(`GET /api/groups/${groupId}: ${res.status}`);
  return (await res.json()) as { id: string; gatewayGroupId: string | null; status: string; agentEnabled: boolean };
}

export async function patchGroup(
  env: ScenarioEnv,
  groupId: string,
  patch: { agentEnabled?: boolean; autoKickEnabled?: boolean },
): Promise<void> {
  const res = await fetch(`${env.serverUrl}/api/groups/${groupId}`, {
    method: 'PATCH',
    headers: authed(env.token),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PATCH /api/groups/${groupId}: ${res.status}`);
}

export interface JobState {
  readonly id: string;
  readonly status: string;
  readonly errors: Array<{ step: string; code: string }>;
  readonly groupId: string;
}

export async function getJob(env: ScenarioEnv, jobId: string): Promise<JobState> {
  const res = await fetch(`${env.serverUrl}/api/jobs/${jobId}`, { headers: authed(env.token) });
  if (!res.ok) throw new Error(`GET /api/jobs/${jobId}: ${res.status}`);
  return (await res.json()) as JobState;
}

export async function waitJob(env: ScenarioEnv, jobId: string, statuses: string[]): Promise<JobState> {
  let last: JobState | undefined;
  await waitFor(async () => {
    last = await getJob(env, jobId);
    return statuses.includes(last.status);
  });
  return last as JobState;
}

/** 操作员 send：POST /api/groups/:id/send → 202 {clientMsgId} */
export async function sendMessage(
  env: ScenarioEnv,
  groupId: string,
  args: { accountId: string; text: string },
): Promise<string> {
  const res = await fetch(`${env.serverUrl}/api/groups/${groupId}/send`, {
    method: 'POST',
    headers: authed(env.token),
    body: JSON.stringify({ accountId: args.accountId, text: args.text }),
  });
  if (!res.ok) throw new Error(`send: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { clientMsgId: string }).clientMsgId;
}

export async function timeline(env: ScenarioEnv, groupId: string): Promise<TimelineItem[]> {
  const res = await fetch(`${env.serverUrl}/api/groups/${groupId}/messages?limit=50`, {
    headers: authed(env.token),
  });
  if (!res.ok) throw new Error(`timeline: ${res.status}`);
  return ((await res.json()) as { items: TimelineItem[] }).items;
}

export async function getAccount(
  env: ScenarioEnv,
  accountId: string,
): Promise<{ id: string; status: string; platformUserId: string | null; rateLimitedUntil: string | null }> {
  // 契约只有列表端点（GET /api/accounts，无 :id 读面）——从列表里取目标行
  const res = await fetch(`${env.serverUrl}/api/accounts`, { headers: authed(env.token) });
  if (!res.ok) throw new Error(`GET /api/accounts: ${res.status}`);
  const items = (await res.json()) as Array<{
    id: string;
    status: string;
    platformUserId: string | null;
    rateLimitedUntil: string | null;
  }>;
  const row = items.find((i) => i.id === accountId);
  if (row === undefined) throw new Error(`account ${accountId} not in list`);
  return row;
}

// ---------- mock-gateway /_test 面（开关、counters、emit） ----------

export async function armSwitch(env: ScenarioEnv, name: string, target?: ArmTarget, params?: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${env.gatewayUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ switch: name, ...(target === undefined ? {} : { target }), ...(params === undefined ? {} : { params }) }),
  });
  if (!res.ok) throw new Error(`arm ${name}: ${res.status} ${await res.text()}`);
}

export async function clearSwitch(env: ScenarioEnv, name?: string): Promise<void> {
  const res = await fetch(`${env.gatewayUrl}/_test/scenario/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(name === undefined ? {} : { switch: name }),
  });
  if (!res.ok) throw new Error(`clear switch: ${res.status}`);
}

export interface GatewayCounters {
  readonly sendCallsByAccount: Record<string, number>;
  readonly sendCallsByClientMsgId: Record<string, number>;
  readonly landedMessages: number;
  readonly kickCalls: number;
  readonly framesEmitted: number;
}

export async function gatewayCounters(env: ScenarioEnv): Promise<GatewayCounters> {
  const res = await fetch(`${env.gatewayUrl}/_test/counters`);
  if (!res.ok) throw new Error(`counters: ${res.status}`);
  return (await res.json()) as GatewayCounters;
}

/** 手动注入契约事件（入账本走正常 SSE 投放；dup_push_all 打开时同样双推） */
export async function emitEvent(
  env: ScenarioEnv,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${env.gatewayUrl}/_test/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, data }),
  });
  if (!res.ok) throw new Error(`emit ${type}: ${res.status} ${await res.text()}`);
}

// ---------- DB 断言辅（真值在库；只用于时间线 REST 读不到的列/表） ----------

export async function countRows(pool: Pool, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export async function queryRows<T>(pool: Pool, sql: string, params: unknown[]): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

export { tx };
export type { PoolClient };
