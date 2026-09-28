// @vitest-environment happy-dom
// 群列表页 + AppShell（DES/15 §1/§2、DES/04 §2.1/§7、REQ §4）。
// 断言：
//   列表：GET /api/groups 行渲染（短 id/gatewayGroupId/status/成员数/开关）；行点击 → /groups/:id；
//   建群：POST /api/groups body 逐字 {creatorAccountId, memberAccountIds} → 202 {jobId} →
//     轮询 GET /api/jobs/:jobId（{status,errors}；终态 finished/failed）→ finished 重拉列表 +
//     新群链接（差集定位）；failed → errors[{step,code}] 逐字展示；viewer 不渲染表单；
//   AppShell：RequireAuth 守卫（未登录 → /login）、导航三项 + 登出（→ 会话清空 + /login）、
//     `*` → NotFoundPage；inconsistency 帧 → 琥珀条（可关）；ws_backlog_expired → 红条 + 重新加载。
// 层位：第 2 层组件测试——happy-dom + act + fakeFetch + FakeSocket（同 accounts-page.test.tsx 工装）。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthState } from '../src/auth/AuthProvider.js';
import { GroupsPage } from '../src/pages/GroupsPage.js';
import { NotFoundPage } from '../src/pages/NotFoundPage.js';
import { RequireAuth } from '../src/router.js';
import { getWsClient, initWsClient, resetWsClient } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';
import type { GroupView } from '../src/lib/api-types.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing element');
  return v;
}

// ---------- 假 fetch / 假 socket（与 accounts-page.test.tsx 同一形状） ----------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchCall {
  readonly path: string;
  readonly init: RequestInit;
}

function fakeFetch(
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
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

// ---------- 工装 ----------

const ACCOUNTS = [
  { id: 'a-1', status: 'online', platformUserId: 'pu-1', rateLimitedUntil: null },
  { id: 'a-2', status: 'online', platformUserId: 'pu-2', rateLimitedUntil: null },
  { id: 'a-3', status: 'idle', platformUserId: 'pu-3', rateLimitedUntil: null }, // 非 online 不进建群选项
];

const GROUP_G1: GroupView = {
  id: 'g-1',
  gatewayGroupId: 'room-1',
  status: 'active',
  creatorAccountId: 'a-1',
  agentEnabled: true,
  autoKickEnabled: false,
  members: [
    { accountId: 'a-1', platformUserId: 'pu-1', role: 'creator' },
    { accountId: 'a-2', platformUserId: 'pu-2', role: 'member' },
  ],
  activeSequenceRunId: null,
  activeAgentRunId: null,
};

const GROUP_G2: GroupView = {
  ...GROUP_G1,
  id: 'g-2',
  gatewayGroupId: 'room-2',
  agentEnabled: false,
  autoKickEnabled: true,
  members: [],
};

const GROUP_NEW: GroupView = { ...GROUP_G1, id: 'g-new', gatewayGroupId: 'room-new' };

/** 可变服务端态：groups 列表、job 轮询序列（shift 消耗，耗尽恒 finished）、job errors 原样透出 */
const state = {
  groups: [] as GroupView[],
  jobStatuses: [] as string[],
  jobErrors: null as unknown,
};

function installFetch(role: 'admin' | 'viewer'): { calls: FetchCall[] } {
  const { fn, calls } = fakeFetch((path, init) => {
    if (path === '/api/auth/login') {
      return jsonResponse(200, {
        accessToken: `t-${role}`,
        expiresAt: 'x',
        user: { id: 'u-1', username: role, role },
      });
    }
    if (path === '/api/auth/logout') return jsonResponse(204, null);
    if (path === '/api/accounts') return jsonResponse(200, ACCOUNTS);
    if (path === '/api/groups' && init.method === 'POST') {
      return jsonResponse(202, { jobId: 'job-1' });
    }
    if (path === '/api/groups') return jsonResponse(200, state.groups);
    if (path === '/api/jobs/job-1') {
      return jsonResponse(200, {
        status: state.jobStatuses.shift() ?? 'finished',
        errors: state.jobErrors,
      });
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

/** location 断言探针：渲染一个 span 暴露 pathname（MemoryRouter 内任意位置可用） */
function Probe(): JSX.Element {
  const loc = useLocation();
  return <span data-testid="loc" data-path={loc.pathname} />;
}

/** 跳转探针：模拟守卫回跳后再撞未知路径 */
function GotoNope(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="goto-nope" onClick={() => navigate('/nope')}>
      go
    </button>
  );
}

/** macrotask 冲刷：0ms 定时器串行 N 次（建群轮询全链 = sleep→fetch→…） */
async function flushTurns(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
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
          createElement(
            MemoryRouter,
            null,
            createElement(Probe),
            createElement(GroupsPage, { jobPollMs: 0 }),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await auth.current?.login(role, role);
  });
  return { container, root, auth };
}

/** 生产路由同构：RequireAuth 包 AppShell + Outlet 下挂子路由（含 `*` → NotFoundPage） */
async function renderShellAt(path: string): Promise<{
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
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(Probe),
            createElement(GotoNope),
            createElement(
              Routes,
              null,
              createElement(
                Route,
                { element: createElement(RequireAuth) },
                createElement(Route, { path: '/', element: createElement('p', null, 'home') }),
                createElement(Route, { path: '*', element: createElement(NotFoundPage) }),
              ),
            ),
          ),
        ),
      ),
    );
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

function locOf(container: HTMLDivElement): string {
  return must(container.querySelector('[data-testid="loc"]')).getAttribute('data-path') ?? '';
}

function selectOption(sel: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(sel, value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

async function openAuthedSocket(): Promise<FakeSocket> {
  const sock = lastSocket();
  await act(async () => {
    sock.simulateOpen();
    sock.simulateMessage({ type: 'auth', success: true });
  });
  return sock;
}

beforeEach(() => {
  FakeSocket.instances = [];
  state.groups = [];
  state.jobStatuses = [];
  state.jobErrors = null;
  sessionStorage.clear(); // 隔离：先前用例的登录态不泄漏进守卫/AuthProvider.restoreSession
  seedWs();
});
afterEach(() => {
  getWsClient()?.disconnect();
  resetWsClient();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------- L2 页面 ----------

describe('群列表页', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(role: 'admin' | 'viewer'): Promise<void> {
    const r = await renderPage(role);
    container = r.container;
    root = r.root;
  }

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });

  it('列表渲染：短 id + gatewayGroupId + 状态徽标 + 成员数 + 开关；行点击 → /groups/:id', async () => {
    state.groups = [GROUP_G1, GROUP_G2];
    installFetch('admin');
    await mount('admin');

    expect(container.querySelector('[data-testid="group-row-g-1"]')).not.toBeNull();
    const row1 = must(container.querySelector('[data-testid="group-row-g-1"]'));
    expect(row1.textContent).toContain('g-1'); // slice(0,8) 对短 id 为原值
    expect(row1.textContent).toContain('room-1');
    expect(row1.querySelector('[data-testid="group-status-g-1"]')?.textContent).toBe('active');
    expect(row1.textContent).toContain('2'); // 成员数
    expect(row1.querySelector('a[href="/groups/g-1"]')).not.toBeNull();
    const row2 = must(container.querySelector('[data-testid="group-row-g-2"]'));
    expect(row2.textContent).toContain('—'); // gatewayGroupId 外其余 '—' 列也存在；粗断言行有 '—'

    // 行点击导航（td 上 click → tr onClick 冒泡）
    const cell = must(row2.querySelectorAll('td')[1]);
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(locOf(container)).toBe('/groups/g-2');
  });

  it('建群成功：POST body 逐字 → 轮询至 finished → 列表重拉 + 新群链接', async () => {
    state.groups = [GROUP_G1];
    state.jobStatuses = ['running', 'finished'];
    const { calls } = installFetch('admin');
    await mount('admin');
    // finished 后的重拉必须能看到新行（diff 定位新群 id）——在轮询结束前改列表
    state.groups = [GROUP_G1, GROUP_NEW];

    // 选群主 + 勾成员（idle 账号 a-3 不在选项里）
    expect(container.querySelector('[data-testid="create-member-a-3"]')).toBeNull();
    const creatorSel = must(
      container.querySelector<HTMLSelectElement>('[data-testid="create-creator"]'),
    );
    await act(async () => selectOption(creatorSel, 'a-1'));
    const memberBox = must(
      container.querySelector<HTMLInputElement>('[data-testid="create-member-a-2"]'),
    );
    await act(async () => {
      memberBox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      must(container.querySelector<HTMLElement>('[data-testid="create-submit"]')).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    // 202 → jobId 进度行出现；轮询链冲刷
    expect(container.querySelector('[data-testid="create-progress"]')?.textContent).toContain(
      'job-1',
    );
    await act(async () => {
      await flushTurns();
    });

    const post = calls.find((c) => c.path === '/api/groups' && c.init.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.init.body))).toEqual({
      creatorAccountId: 'a-1',
      memberAccountIds: ['a-2'],
    });
    expect(calls.filter((c) => c.path === '/api/jobs/job-1').length).toBe(2); // running + finished
    const groupsGetCount = calls.filter(
      (c) => c.path === '/api/groups' && c.init.method !== 'POST',
    ).length;
    expect(groupsGetCount).toBeGreaterThanOrEqual(2); // 首屏 + finished 后重拉

    const done = must(container.querySelector('[data-testid="create-done"]'));
    expect(done.textContent).toContain('建群完成');
    expect(done.querySelector('a[href="/groups/g-new"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="group-row-g-new"]')).not.toBeNull();
  });

  it('建群失败：job failed → errors[{step,code}] 逐字展示', async () => {
    state.groups = [GROUP_G1];
    state.jobStatuses = ['failed'];
    // errors 逐字透出（INVITE_NOT_READY 类失败码不转译——DES/04 §7 {step,code} 形状）
    state.jobErrors = [{ step: 'invite', code: 'INVITE_NOT_READY' }];
    installFetch('admin');
    await mount('admin');

    const creatorSel = must(
      container.querySelector<HTMLSelectElement>('[data-testid="create-creator"]'),
    );
    await act(async () => selectOption(creatorSel, 'a-1'));
    const memberBox = must(
      container.querySelector<HTMLInputElement>('[data-testid="create-member-a-2"]'),
    );
    await act(async () => {
      memberBox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      must(container.querySelector<HTMLElement>('[data-testid="create-submit"]')).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await flushTurns();
    });
    const errEl = must(container.querySelector('[data-testid="create-error"]'));
    expect(errEl.textContent).toContain('invite:INVITE_NOT_READY');
    expect(container.querySelector('[data-testid="create-done"]')).toBeNull();
  });

  it('viewer：建群表单不渲染（只读门 canWrite 收口）', async () => {
    state.groups = [GROUP_G1];
    installFetch('viewer');
    await mount('viewer');
    expect(container.querySelector('[data-testid="create-group-form"]')).toBeNull();
    expect(container.textContent).not.toContain('建群');
  });
});

// ---------- AppShell / 守卫 / 404 / 实时横幅 ----------

describe('AppShell（导航壳）', () => {
  let container: HTMLDivElement;
  let root: Root;
  let auth: { current: AuthState | null } = { current: null };

  async function mountShell(path = '/'): Promise<void> {
    const r = await renderShellAt(path);
    container = r.container;
    root = r.root;
    auth = r.auth;
  }

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });

  it('未登录 → /login（守卫逐字）；登录后导航三项 + 用户 + 登出', async () => {
    installFetch('admin');
    await mountShell('/');
    expect(locOf(container)).toBe('/login'); // 守卫 replace 导回
    expect(container.querySelector('nav')).toBeNull(); // 未登录无壳

    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    const nav = must(container.querySelector('nav'));
    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/accounts', '/groups', '/sequences']);
    expect(nav.textContent).toBe('账号群序列');
    expect(container.querySelector('[data-testid="session-user"]')?.textContent).toContain(
      'admin（admin）',
    );
  });

  it('登出 → 会话清空 + 跳 /login', async () => {
    installFetch('admin');
    await mountShell('/');
    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '登出');
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(auth.current?.session).toBeNull();
    expect(locOf(container)).toBe('/login');
  });

  it('未知路径 → NotFoundPage（壳内 `*` 兜底，不再静默重定向）', async () => {
    installFetch('admin');
    await mountShell('/');
    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    await act(async () => {
      container.querySelector('[data-testid="goto-nope"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(locOf(container)).toBe('/nope');
    expect(container.textContent).toContain('404');
    expect(container.querySelector('nav')).not.toBeNull(); // 404 也在壳内
  });

  it('inconsistency 帧 → 琥珀条（可关）；ws_backlog_expired → 常驻红条 + 重新加载', async () => {
    installFetch('admin');
    await mountShell('/');
    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    const sock = await openAuthedSocket();

    await act(async () => {
      sock.simulateMessage({
        seq: 1,
        type: 'inconsistency',
        payload: { kind: 'dead_letter_stuck', ref: 'm-1', message: 'dead letter stuck 3' },
      });
    });
    const amber = must(container.querySelector('[data-testid="ws-inconsistency-banner"]'));
    expect(amber.textContent).toContain('dead_letter_stuck');
    expect(amber.textContent).toContain('dead letter stuck 3');
    // 可关闭
    await act(async () => {
      amber.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="ws-inconsistency-banner"]')).toBeNull();

    // ws_backlog_expired = inconsistency kind，不是独立帧类型（contract ws-events.ts 逐字）
    await act(async () => {
      sock.simulateMessage({
        seq: 2,
        type: 'inconsistency',
        payload: { kind: 'ws_backlog_expired', ref: 'ws', message: 'backlog expired' },
      });
    });
    const red = must(container.querySelector('[data-testid="ws-backlog-expired-banner"]'));
    expect(red.textContent).toContain('连接积压已过期，数据可能不完整');
    expect(red.textContent).toContain('重新加载');
    // backlog 帧不再落琥珀条（kind 分流逐字）
    expect(container.querySelector('[data-testid="ws-inconsistency-banner"]')).toBeNull();
  });
});
