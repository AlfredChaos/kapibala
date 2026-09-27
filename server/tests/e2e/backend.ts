// C3 E2E 后端装配（T-P8-03；REQ C3「全栈环境」逐字：server+双 mock+PG）。
// 以子进程被 playwright webServer 拉起：真 PG 模板库 + mock-gateway + mock-agent +
// boot() 全管线 server 固定在 :3000（vite.config.ts 代理的逐字目标 localhost:3000）。
// 装配完数据（建群 active + agentEnabled + 一次已终态的 agent run）后写
// web/tests/e2e/.e2e-state.json 并打 E2E_READY；进程常驻直到 SIGTERM（Playwright 清理）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadConfig } from '../../src/config/index.js';
import { boot } from '../../src/index.js';
import { seed } from '../../src/db/seed.js';
import { getTestDb } from '../helpers/db.js';
import {
  authed,
  emitEvent,
  patchGroup,
  setupGroup,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';
import { createGatewayApp } from '../../../mock-gateway/src/app.js';
import { createAgentApp } from '../../../mock-agent/src/app.js';

const SERVER_PORT = 3000;
const STATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../web/tests/e2e/.e2e-state.json',
);

async function listen(app: { listen(o: { port: number; host: string }): Promise<unknown> }): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await srv.close();
  await app.listen({ port, host: '127.0.0.1' });
  return `http://127.0.0.1:${port}`;
}

function stage(name: string, extra: Record<string, string> = {}): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ stage: name, ...extra }));
  console.log(`[e2e] stage=${name}`);
}

async function main(): Promise<void> {
  rmSync(STATE_PATH, { force: true }); // 启动即清旧文件：此后存在⇒本轮所写
  stage('boot');
  const db = await getTestDb();
  stage('db');
  await seed(db.pool);
  const gateway = createGatewayApp({ logger: false });
  const agent = createAgentApp({ logger: false, mode: 'scripted' });
  const gatewayUrl = await listen(gateway);
  const agentUrl = await listen(agent);

  const config = loadConfig({
    PORT: String(SERVER_PORT),
    DATABASE_URL: db.connectionString,
    GATEWAY_URL: gatewayUrl,
    AGENT_URL: agentUrl,
  });
  // :3000 被占用时 retry listen（前一轮 Playwright webServer teardown 的 close 可能滞后）
  let handle: Awaited<ReturnType<typeof boot>> | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12 && handle === undefined; attempt++) {
    try {
      handle = await boot({ config, logger: pino({ level: 'silent' }) });
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code !== 'EADDRINUSE') throw err;
      console.error(`[e2e backend] :3000 busy (attempt ${attempt + 1}/12), retry in 1s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (handle === undefined) {
    throw new Error(`boot failed after retries: ${String(lastErr)}`);
  }
  const server = (handle.app.server as Server).address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${server.port}`;

  stage('server');
  const login = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const token = ((await login.json()) as { accessToken: string }).accessToken;

  // 复用场景 env 形态但不走 startScenarioEnv（要钉死 :3000 给 vite 代理）
  const env: ScenarioEnv = {
    pool: db.pool,
    serverUrl,
    gateway,
    gatewayUrl,
    agent,
    agentUrl,
    db,
    token,
    close: async () => {
      await handle.stop().catch(() => undefined);
      await gateway.close().catch(() => undefined);
      await agent.close().catch(() => undefined);
      await db.close().catch(() => undefined); // handle.stop() 可能已 end 同一 pool
    },
  };

  // 数据装配：群 active + agentEnabled + mock 剧本（send_message 一步 + finish）+ 入站触发
  stage('login');
  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  stage('group');
  await patchGroup(env, group.dbGroupId, { agentEnabled: true });
  const arm = await fetch(`${agentUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      switch: 'playbook',
      params: {
        steps: [
          { kind: 'tool_use', name: 'send_message', input: { text: 'c3 smoke reply' } },
          { kind: 'finish', summary: 'c3 smoke done' },
        ],
      },
      target: {},
    }),
  });
  if (!arm.ok) throw new Error(`arm playbook: ${arm.status} ${await arm.text()}`);
  await emitEvent(env, 'message', {
    groupId: group.gwGroupId,
    msgId: 'c3-trigger',
    senderPlatformUserId: 'puid-acc-02',
    text: 'c3 trigger',
    sentAt: new Date().toISOString(),
  });
  stage('armed');
  // 等首步行落库即可（不等到 run 终态——页面要的是「steps 可见」，首行 tool_use 即满足；
  // 并发测试负载下终态可能拖到分钟级，step 行在首轮响应写回时就已存在）
  try {
    await waitFor(async () => {
      const { rows } = await db.pool.query<{ n: number }>(
        `SELECT count(*) AS n FROM agent_run_step s
           JOIN agent_run r ON r.id=s.run_id WHERE r.group_id=$1`,
        [group.dbGroupId],
      );
      return Number(rows[0]?.n ?? 0) >= 1;
    }, 180000);
  } catch (err) {
    // 装配超时诊断：run 行/队列行/网关账本各数一次——超时分「没触发」还是「触发但步未落」
    const diag = async (q: string): Promise<number> => {
      const { rows } = await db.pool.query<{ n: number }>(q, [group.dbGroupId]);
      return Number(rows[0]?.n ?? 0);
    };
    console.error('[e2e] step wait timeout; diag:', {
      runs: await diag(`SELECT count(*) AS n FROM agent_run WHERE group_id=$1`),
      queued: await diag(`SELECT count(*) AS n FROM agent_trigger_queue WHERE group_id=$1`),
      steps: await diag(
        `SELECT count(*) AS n FROM agent_run_step s JOIN agent_run r ON r.id=s.run_id WHERE r.group_id=$1`,
      ),
    });
    throw err;
  }
  const { rows: runRows } = await db.pool.query<{ id: string }>(
    `SELECT id FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [group.dbGroupId],
  );
  stage('ready', {
    groupId: group.dbGroupId,
    runId: runRows[0]?.id ?? '',
    webUrl: 'http://127.0.0.1:5173',
  });
  console.log(`E2E_READY server=${serverUrl} group=${group.dbGroupId}`);

  const shutdown = async (): Promise<void> => {
    await env.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void main().catch((err) => {
  console.error('[e2e backend] fatal:', err);
  process.exit(1);
});
