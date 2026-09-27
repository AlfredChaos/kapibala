// @vitest-environment happy-dom
// 账号列表页（T-P5-03；DES/15 §2 页面 2 + §6 测试表行、DES/03 §1/§3、REQ §4 页面 2/A1/D3-4）。
// 断言逐字：
//   转移表同源：web 镜像 LEGAL_TRANSITIONS_WEB === server LEGAL_TRANSITIONS（直接 import 对照，
//     卡片 d「静态转移表与 server transitions.ts 语义一致」）；
//   Given online → 面板目标 = idle/rate_limited/disconnected/suspended/session_expired（A1 表逐字）；
//     非法目标（online/自身）不出现在 UI——ILLEGAL_TRANSITION 留给并发；
//   Given to=rate_limited 缺 rateLimitedUntil → 提交禁用；填未来时间 → 解禁（D3-4）；
//   Given idle/disconnected → 「重连」可见；online → 不出现（CONNECT_FROM 前置）；
//   Given viewer → 写按钮一律不渲染；直接调接口 → 403（服务端权威，FORBIDDEN）；
//   WS account_status_changed / account_terminal → 徽标原地更新（不重拉列表）；
//   rateLimitedUntil → 倒计时文案（rateLimitCountdownText 纯函数 + 页面渲染）。
// 层位：第 2 层组件测试——happy-dom + act + fakeFetch + FakeSocket 驱动 WS 事件。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthState } from '../src/auth/AuthProvider.js';
import { AccountsPage, rateLimitCountdownText } from '../src/pages/AccountsPage.js';
import {
  CONNECT_FROM_WEB,
  LEGAL_TRANSITIONS_WEB,
  canConnect,
  legalTargets,
} from '../src/lib/account-transitions.js';
// 同源校验不 import 服务端模块图（transitions.ts → db/tx.js → crash.ts 会把兄弟 WIP
// 拉进 web typecheck）——改为文本抽取 server 源文件里的字面边表，真值仍是同一文件。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __testdir = dirname(fileURLToPath(import.meta.url));
const serverTransitionsSrc = readFileSync(
  resolve(__testdir, '../../server/src/modules/accounts/transitions.ts'),
  'utf8',
);

function extractPairs(src: string): Set<string> {
  // 只取 LEGAL_TRANSITIONS 数组块内的 [from,to] 对（CONNECT_FROM 的 ['idle','disconnected']
  // 是单列数组不成对，但块外可能还有别的二元字面量——先把范围收窄到表块）
  const block = src.match(/LEGAL_TRANSITIONS[^=]*=\s*new Set\(\s*\(\s*\[([\s\S]*?)\]\s*as const/);
  const set = new Set<string>();
  if (block === null || block[1] === undefined) return set;
  for (const m of block[1].matchAll(/\['([a-z_]+)',\s*'([a-z_]+)'\]/g)) {
    set.add(`${m[1] ?? ''}->${m[2] ?? ''}`);
  }
  return set;
}
function extractConnectFrom(src: string): string[] {
  const m = src.match(/CONNECT_FROM = \[([^\]]+)\]/);
  if (m === null || m[1] === undefined) return [];
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1] ?? '');
}
const SERVER_LEGAL_TRANSITIONS = extractPairs(serverTransitionsSrc);
const SERVER_CONNECT_FROM = extractConnectFrom(serverTransitionsSrc);
import { getWsClient, initWsClient, resetWsClient } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';
import { isApiError } from '../src/api/client.js';
import type { AccountStatus } from '@kapibala/contract';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------- 假 fetch / 假 socket ----------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
): { fn: typeof fetch; calls: Array<{ path: string; init: RequestInit }> } {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    calls.push({ path, init: init ?? {} });
    return handler(path, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  simulateOpen(): void {
    this.onopen?.({});
  }
  simulateMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

// ---------- 页面渲染工装 ----------

const ACCOUNTS_FIXTURE = [
  {
    id: 'a-online',
    status: 'online',
    platformUserId: 'pu-1',
    rateLimitedUntil: null,
  },
  {
    id: 'a-idle',
    status: 'idle',
    platformUserId: null,
    rateLimitedUntil: null,
  },
  {
    id: 'a-rl',
    status: 'rate_limited',
    platformUserId: 'pu-3',
    rateLimitedUntil: new Date(Date.now() + 30_000).toISOString(),
  },
];

function installFetch(role: 'admin' | 'viewer'): { calls: Array<{ path: string; init: RequestInit }> } {
  const { fn, calls } = fakeFetch((path) => {
    if (path === '/api/auth/login') {
      return jsonResponse(200, {
        accessToken: `t-${role}`,
        expiresAt: 'x',
        user: { id: 'u-1', username: role, role },
      });
    }
    if (path === '/api/accounts') return jsonResponse(200, ACCOUNTS_FIXTURE);
    if (path.endsWith('/transition') || path.endsWith('/connect')) {
      // 服务端权威：viewer 写操作 403（auth:'write' 配置，REQ §4 页面 2 逐字）
      if (role === 'viewer') {
        return jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'viewer cannot write' } });
      }
      return jsonResponse(200, { status: 'ok' });
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

async function renderPage(role: 'admin' | 'viewer'): Promise<{
  container: HTMLDivElement;
  root: Root;
  auth: { current: AuthState | null };
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const auth: { current: AuthState | null } = { current: null };
  function Grab(): null {
    auth.current = useAuth();
    return null;
  }
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          AuthProvider,
          null,
          createElement(Grab),
          createElement(MemoryRouter, null, createElement(AccountsPage)),
        ),
      ),
    );
  });
  await act(async () => {
    await auth.current?.login(role, role);
  });
  return { container, root, auth };
}

function lastSocket(): FakeSocket {
  const s = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (s === undefined) throw new Error('no socket created');
  return s;
}

function seedWs(): void {
  resetWsClient();
  initWsClient({
    tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
    wsFactory: (url: string) => new FakeSocket(url),
    url: 'ws://test/ws',
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  seedWs();
});
afterEach(async () => {
  getWsClient()?.disconnect();
  resetWsClient();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------- 转移表同源（卡片 d 对照测试） ----------

describe('转移表同源校验（server LEGAL_TRANSITIONS === web 镜像）', () => {
  it('web 镜像与服务端表逐边一致 + CONNECT_FROM 一致', () => {
    expect(LEGAL_TRANSITIONS_WEB).toEqual(SERVER_LEGAL_TRANSITIONS);
    expect([...CONNECT_FROM_WEB]).toEqual(SERVER_CONNECT_FROM);
    // 抽取非空兜底：服务端文件结构变了会让对照集为空——此时断言自身也该红（防止误绿）
    expect(SERVER_LEGAL_TRANSITIONS.size).toBe(15);
  });
});

// ---------- L1 纯函数 ----------

describe('legalTargets / canConnect / 倒计时文案', () => {
  it('online → 目标恰为 idle/rate_limited/disconnected/suspended/session_expired', () => {
    expect(new Set(legalTargets('online'))).toEqual(
      new Set<AccountStatus>(['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired']),
    );
    // 非法目标不出现：online→online 不在 A1 表（同态一律 ILLEGAL_TRANSITION）
    expect(legalTargets('online')).not.toContain('online');
    // 终态无出边
    expect(legalTargets('suspended')).toEqual([]);
    expect(legalTargets('session_expired')).toEqual([]);
    // disconnected→online 属 connect 专属，不在操作员目标列（DES/03 §1 注释逐字）
    expect(legalTargets('disconnected')).not.toContain('online');
    expect(legalTargets('disconnected')).toContain('idle');
  });

  it('canConnect：仅 idle/disconnected（rate_limited 不在列——临时态物理会话仍在）', () => {
    expect(canConnect('idle')).toBe(true);
    expect(canConnect('disconnected')).toBe(true);
    expect(canConnect('online')).toBe(false);
    expect(canConnect('rate_limited')).toBe(false);
    expect(canConnect('suspended')).toBe(false);
  });

  it('rateLimitCountdownText：未到期「Ns 后恢复」；到期「已到期」', () => {
    const now = Date.now();
    expect(rateLimitCountdownText(new Date(now + 30_000).toISOString(), now)).toBe('30s 后恢复');
    expect(rateLimitCountdownText(new Date(now - 1).toISOString(), now)).toBe('已到期');
    expect(rateLimitCountdownText('not-a-date', now)).toBe('已到期');
  });
});

// ---------- L2 页面 ----------

describe('账号列表页渲染与转移面板', () => {
  let container: HTMLDivElement;
  let root: Root;
  let auth: { current: AuthState | null } = { current: null };

  async function mount(role: 'admin' | 'viewer'): Promise<void> {
    const r = await renderPage(role);
    container = r.container;
    root = r.root;
    auth = r.auth;
  }

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });

  it('行渲染：徽标 + platformUserId + 倒计时；重连仅 idle/disconnected 可见', async () => {
    installFetch('admin');
    await mount('admin');
    // 徽标 + platformUserId
    expect(container.querySelector('[data-testid="status-badge-a-online"]')?.textContent).toBe('online');
    expect(container.textContent).toContain('pu-1');
    expect(container.querySelector('[data-testid="status-badge-a-rl"]')?.textContent).toBe('rate_limited');
    // 倒计时文案渲染（30s 档）
    expect(container.textContent).toMatch(/\d+s 后恢复/);
    // 重连按钮：idle 行有，online/rate_limited 行无（逐字 CONNECT_FROM）
    const rows = container.querySelectorAll('tbody tr');
    const cell = (i: number) => rows[i]?.textContent ?? '';
    expect(cell(0)).toContain('pu-1'); // a-online
    expect(cell(0)).not.toContain('重连');
    expect(cell(1)).toContain('重连'); // a-idle
    expect(cell(2)).not.toContain('重连'); // a-rl（限流中不重连，从严解读）
  });

  it('面板：online 只列合法目标（无 online/自身）；rate_limited 缺时间 → 提交禁用', async () => {
    installFetch('admin');
    await mount('admin');
    // 打开 online 行的「调整状态…」
    const openBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '调整状态…');
    expect(openBtn).toBeDefined();
    await act(async () => {
      openBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const select = container.querySelector<HTMLSelectElement>('#transition-to');
    expect(select).not.toBeNull();
    const options = [...(select?.options ?? [])].map((o) => o.value).filter((v) => v !== '');
    expect(new Set(options)).toEqual(
      new Set(['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired']),
    );
    expect(options).not.toContain('online'); // 非法目标不出现在 UI
    expect(container.querySelector('[data-testid="panel-from"]')?.textContent).toBe('online');

    // D3-4：rate_limited 缺 rateLimitedUntil → 提交禁用
    const submit = [...container.querySelectorAll('button')].find((b) => b.textContent === '确认转移');
    // select 的受控值同样过 React 内部 tracker——原生 setter + change（React select 用 change）
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    await act(async () => {
      if (select && selectSetter) {
        selectSetter.call(select, 'rate_limited');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const submitBtn = submit as HTMLButtonElement | undefined;
    expect(submitBtn?.disabled).toBe(true); // D3-4：缺 rateLimitedUntil → 禁用
    // 填未来时间 → 解禁（React 18 input 受控 tracker：原生 setter + input 事件）
    const until = container.querySelector<HTMLInputElement>('#rate-limited-until');
    expect(until).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      if (until && setter) {
        setter.call(until, '2099-01-01T00:00');
        until.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    expect(submitBtn?.disabled).toBe(false);
  });

  it('viewer：写按钮一律不渲染；直接调 transition 接口 → 403', async () => {
    installFetch('viewer');
    await mount('viewer');
    const texts = container.textContent ?? '';
    expect(texts).not.toContain('重连');
    expect(texts).not.toContain('标记离线');
    expect(texts).not.toContain('释放账号');
    expect(texts).not.toContain('调整状态');
    // 「操作」列表头也不渲染（viewer 无写列）
    expect(texts).not.toContain('操作');

    // 直接调接口（同一 ApiClient——403 由服务端权威兜底，前端忠实透传 code/status）
    let caught: unknown;
    await act(async () => {
      try {
        await auth.current?.client.request('/api/accounts/a-online/transition', {
          method: 'POST',
          body: JSON.stringify({ to: 'idle', expectedFrom: 'online' }),
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(isApiError(caught)).toBe(true);
    if (isApiError(caught)) {
      expect(caught.status).toBe(403);
      expect(caught.code).toBe('FORBIDDEN');
    }
  });

  it('WS account_status_changed → 徽标原地更新；account_terminal 同理', async () => {
    installFetch('admin');
    await mount('admin');
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateMessage({ type: 'auth', success: true });
    });
    // 事件帧：a-online 被网关事件推进到 disconnected
    await act(async () => {
      sock.simulateMessage({
        seq: 1,
        type: 'account_status_changed',
        payload: { accountId: 'a-online', from: 'online', to: 'disconnected' },
      });
    });
    expect(container.querySelector('[data-testid="status-badge-a-online"]')?.textContent).toBe(
      'disconnected',
    );
    // account_terminal → 终态徽标
    await act(async () => {
      sock.simulateMessage({
        seq: 2,
        type: 'account_terminal',
        payload: { accountId: 'a-rl', status: 'suspended' },
      });
    });
    expect(container.querySelector('[data-testid="status-badge-a-rl"]')?.textContent).toBe(
      'suspended',
    );
    // 旧帧（seq<=lastSeq）不回退徽标（B4 去重路径在页面侧同样生效）
    await act(async () => {
      sock.simulateMessage({
        seq: 1,
        type: 'account_status_changed',
        payload: { accountId: 'a-online', from: 'x', to: 'online' },
      });
    });
    expect(container.querySelector('[data-testid="status-badge-a-online"]')?.textContent).toBe(
      'disconnected',
    );
  });
});
