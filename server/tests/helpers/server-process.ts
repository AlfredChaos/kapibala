// 崩溃测试子进程装配（T-P7-01；DES/10 §5 + DES/14 §7）。
// 每个用例：独立测试库（模板+随机后缀）+ in-process mock-gateway/mock-agent（互不串扰）+
// server 子进程（node --import tsx，随机端口）。可 kill（exit 9）→ restart（同库同 mock）。
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGatewayApp } from 'mock-gateway/src/app.js';
import { createAgentApp } from 'mock-agent/src/app.js';
import { getTestDb, type TestDbHandle } from './db.js';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, 'crash-server-entry.ts');
const SERVER_ROOT = path.resolve(HERE, '..', '..');
export const CRASH_EXIT_CODE = 9;
const READY_TIMEOUT_MS = 30_000;

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function listen(app: { listen(o: { port: number; host: string }): Promise<unknown> }): Promise<string> {
  const port = await freePort();
  await app.listen({ port, host: '127.0.0.1' });
  return `http://127.0.0.1:${port}`;
}

export interface CrashServerHandle {
  /** server 基址（子进程本次生命周期的监听地址；restart 后可能变） */
  readonly baseUrl: string;
  readonly db: TestDbHandle;
  readonly gatewayUrl: string;
  readonly agentUrl: string;
  /** 等待子进程退出并返回退出码（注入崩溃 = 9；正常杀 = null+signal）。幂等。 */
  awaitExit(): Promise<number | null>;
  /** 已死进程按同库同 mock 重新拉起（端口换随机）；waitReady 含就绪等待。 */
  restart(): Promise<void>;
  /** 全停：kill 子进程（若在）+ 关 mock + DROP 库。幂等。 */
  stop(): Promise<void>;
  /** 登录拿 admin access token（复用入口形状） */
  login(): Promise<string>;
}

export interface CrashServerOptions {
  /** 预 arm 崩溃点（进程启动前就生效；运行时 arm 用 `/_test/crash` 控制端点） */
  readonly crashPoints?: readonly string[];
  readonly env?: Record<string, string>;
}

/**
 * 起一个「可注入崩溃」的完整环境。崩溃点经 CRASH_CONTROL=1 控制端点
 * `POST {baseUrl}/_test/crash { name, hit? }` 在运行时装配（或 spawn 时 crashPoints 预 arm）。
 */
export async function startCrashServer(options: CrashServerOptions = {}): Promise<CrashServerHandle> {
  const db = await getTestDb();
  const gateway = createGatewayApp({ logger: false });
  const agent = createAgentApp({ logger: false, mode: 'scripted' });
  const gatewayUrl = await listen(gateway);
  const agentUrl = await listen(agent);
  const port = await freePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: db.connectionString,
    GATEWAY_URL: gatewayUrl,
    AGENT_URL: agentUrl,
    CRASH_CONTROL: '1',
    ...(options.crashPoints !== undefined && options.crashPoints.length > 0
      ? { CRASH_POINTS: options.crashPoints.join(',') }
      : {}),
    ...options.env,
  };

  let child: ChildProcess | null = null;
  let exitPromise: Promise<number | null> = Promise.resolve(null);
  let stderrTail = '';
  let baseUrl = `http://127.0.0.1:${port}`;
  let stopped = false;

  const spawnChild = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      stderrTail = '';
      const c = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
        cwd: SERVER_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = c;
      let readySeen = false;
      const onTimeout = setTimeout(() => {
        c.kill('SIGKILL');
        reject(new Error(`crash child not ready in ${READY_TIMEOUT_MS}ms; stderr: ${stderrTail.slice(-500)}`));
      }, READY_TIMEOUT_MS);
      exitPromise = new Promise<number | null>((res) => {
        c.on('exit', (code, signal) => {
          res(signal === null ? code : null);
        });
      });
      c.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (text.includes('CRASH_CHILD_READY')) {
          readySeen = true;
          clearTimeout(onTimeout);
          resolve();
        }
      });
      c.stderr?.on('data', (chunk: Buffer) => {
        stderrTail += chunk.toString('utf8');
      });
      c.on('exit', () => {
        if (!readySeen) {
          clearTimeout(onTimeout);
          reject(new Error(`crash child exited before ready; stderr: ${stderrTail.slice(-500)}`));
        }
      });
      c.on('error', (err) => {
        clearTimeout(onTimeout);
        reject(err);
      });
    });
  };

  await spawnChild();

  const handle: CrashServerHandle = {
    get baseUrl() {
      return baseUrl;
    },
    db,
    gatewayUrl,
    agentUrl,
    awaitExit: () => exitPromise,
    async restart() {
      if (stopped) throw new Error('crash server stopped');
      const newPort = await freePort();
      env['PORT'] = String(newPort);
      baseUrl = `http://127.0.0.1:${newPort}`;
      await spawnChild();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child !== null && !child.killed) child.kill('SIGKILL');
      await exitPromise.catch(() => undefined);
      await gateway.close().catch(() => undefined);
      await agent.close().catch(() => undefined);
      await db.close();
    },
    async login() {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      });
      if (!res.ok) throw new Error(`login failed: ${res.status}`);
      const body = (await res.json()) as { accessToken: string };
      return body.accessToken;
    },
  };

  // 就绪复核（哨兵行外再探一次 /api/health——防「stdout 先到、listen 边界」边角）
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) break;
    } catch {
      // 未就绪继续等
    }
    if (Date.now() > deadline) throw new Error('crash child health check timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
  return handle;
}
