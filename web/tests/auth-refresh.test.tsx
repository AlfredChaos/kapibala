// @vitest-environment happy-dom
// 401 单飞续期 + 登录页（T-P5-01；DES/15 §4/§2 页面 1、DES/09 §3.4、REQ §4、B3 前端半边、R-E）。
// 断言逐字：
//   并发两请求同时 401 → POST /api/auth/refresh 恰好调用一次、两请求均重放成功（新 Bearer）；
//   refresh 请求带 credentials:'include'（refresh token 只在 HttpOnly cookie，JS 不读）；
//   refresh 也 401 → 清空会话（onSessionExpired）——守卫随之把渲染导到 /login；
//   viewer 会话 → canWrite=false（写操作按钮不渲染的判定收口）；登录错误按 error.code 显示。
// 层位：client 用注入式假 fetch（零网络）；组件渲染用 happy-dom + act（无 testing-library）。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, isApiError } from '../src/api/client.js';
import { AuthProvider, canWrite, useAuth, type AuthState } from '../src/auth/AuthProvider.js';
import { LoginPage } from '../src/pages/LoginPage.js';
import { RequireAuth } from '../src/router.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------- 假 fetch：按 path 分派、记录调用 ----------

interface Call {
  path: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 建假 fetch：handler(path, init, calls) 决定响应；calls 记录所有请求 */
function fakeFetch(
  handler: (path: string, init: RequestInit, calls: Call[]) => Response | Promise<Response>,
): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const call: Call = { path, init: init ?? {} };
    calls.push(call);
    return handler(path, init ?? {}, calls);
  }) as typeof fetch;
  return { fn, calls };
}

describe('401 单飞续期（DES/15 §4 逐字）', () => {
  it('并发两请求同时 401 → refresh 恰好一次、两请求以新 token 重放成功', async () => {
    let token: string | null = 't-old';
    const refreshed: string[] = [];
    const expired: string[] = [];

    const { fn, calls } = fakeFetch((path, init) => {
      if (path === '/api/auth/refresh') {
        return jsonResponse(200, { accessToken: 't-new', expiresAt: '2026-09-28T00:00:00Z' });
      }
      const auth = new Headers(init.headers).get('authorization');
      // 旧 token → 401；新 token → 200（重放成功 = 携带新凭证）
      return auth === 'Bearer t-new'
        ? jsonResponse(200, { ok: true, path })
        : jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
    });

    const client = createApiClient({
      getAccessToken: () => token,
      onRefreshed: (t) => {
        token = t;
        refreshed.push(t);
      },
      onSessionExpired: () => expired.push('x'),
      fetchFn: fn,
    });

    const [a, b] = await Promise.all([
      client.request<{ ok: boolean }>('/api/accounts'),
      client.request<{ ok: boolean }>('/api/groups'),
    ]);
    expect(a.ok && b.ok).toBe(true);

    const refreshCalls = calls.filter((c) => c.path === '/api/auth/refresh');
    expect(refreshCalls.length).toBe(1); // 单飞：并发 401 只发一次
    expect(refreshed).toEqual(['t-new']);
    expect(expired.length).toBe(0);

    // 重放的两次原请求都带新 Bearer（顺序：原发各一次 + 重放各一次 = 每路两call）
    const replaysA = calls.filter(
      (c) => c.path === '/api/accounts' && new Headers(c.init.headers).get('authorization') === 'Bearer t-new',
    );
    const replaysB = calls.filter(
      (c) => c.path === '/api/groups' && new Headers(c.init.headers).get('authorization') === 'Bearer t-new',
    );
    expect(replaysA.length).toBe(1);
    expect(replaysB.length).toBe(1);
  });

  it('refresh 请求带 credentials:"include"（HttpOnly cookie 承载 refresh，JS 不读）', async () => {
    const { fn, calls } = fakeFetch((path) =>
      path === '/api/auth/refresh'
        ? jsonResponse(200, { accessToken: 't-new', expiresAt: 'x' })
        : jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }),
    );
    const client = createApiClient({
      getAccessToken: () => 't-old',
      onRefreshed: () => {},
      onSessionExpired: () => {},
      fetchFn: fn,
    });
    await client.request('/api/accounts').catch(() => undefined);
    const refreshCall = calls.find((c) => c.path === '/api/auth/refresh');
    expect(refreshCall?.init.credentials).toBe('include');
    // 业务请求同样带 include（同源 dev 下一致；cookie 属性 Path=/api/auth 由服务端限域）
    const first = calls.find((c) => c.path === '/api/accounts');
    expect(first?.init.credentials).toBe('include');
  });

  it('refresh 也 401 → 会话失效回调恰好一次 + 两请求都收 401', async () => {
    const expired: string[] = [];
    const { fn, calls } = fakeFetch((_path) =>
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'reused' } }),
    );
    const client = createApiClient({
      getAccessToken: () => 't-old',
      onRefreshed: () => {},
      onSessionExpired: () => expired.push('x'),
      fetchFn: fn,
    });
    const results = await Promise.allSettled([
      client.request('/api/accounts'),
      client.request('/api/groups'),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(isApiError(r.reason) && r.reason.status).toBe(401);
      }
    }
    expect(calls.filter((c) => c.path === '/api/auth/refresh').length).toBe(1);
    expect(expired.length).toBe(1); // 会话失效单次触发（调用方清空 + 守卫跳 /login）
  });

  it('非 401 错误不触发 refresh、不重放', async () => {
    const { fn, calls } = fakeFetch(() =>
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'viewer' } }),
    );
    const client = createApiClient({
      getAccessToken: () => 't',
      onRefreshed: () => {},
      onSessionExpired: () => {},
      fetchFn: fn,
    });
    await expect(client.request('/api/accounts')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.path).toBe('/api/accounts');
  });
});

describe('会话角色与登录页（REQ §4 页面 1）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  /** 在 AuthProvider 里挂一个探针组件：把 useAuth() 掏出来供断言 */
  function mountProbe(capture: { current: AuthState | null }): void {
    function Probe(): JSX.Element {
      capture.current = useAuth();
      return <div />;
    }
    root = createRoot(container);
    act(() => {
      root.render(
        <StrictMode>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </StrictMode>,
      );
    });
  }

  it('viewer 登录 → session.user.role=viewer → canWrite=false（写按钮不渲染的判定源）', async () => {
    const { fn } = fakeFetch((path) => {
      if (path === '/api/auth/login') {
        return jsonResponse(200, {
          accessToken: 't-viewer',
          expiresAt: 'x',
          user: { id: 'u-1', username: 'viewer', role: 'viewer' },
        });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', fn);

    const capture: { current: AuthState | null } = { current: null };
    mountProbe(capture);
    expect(capture.current?.session).toBeNull(); // 未登录

    await act(async () => {
      await capture.current?.login('viewer', 'viewer');
    });
    const session = capture.current?.session;
    expect(session?.user.role).toBe('viewer');
    expect(canWrite(session ?? null)).toBe(false);
    // 对照组：admin 角色可写（同一收口的正反两侧都钉死）
    expect(canWrite({ accessToken: 't', user: { id: 'u', username: 'a', role: 'admin' } })).toBe(true);
  });

  it('登录失败 → 按 error.code 显示（UNAUTHORIZED → 用户名或密码错误）', async () => {
    const { fn } = fakeFetch((path) => {
      if (path === '/api/auth/login') {
        return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'invalid username or password' } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal('fetch', fn);

    root = createRoot(container);
    act(() => {
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <LoginPage />
          </AuthProvider>
        </MemoryRouter>,
      );
    });

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    // 触发表单提交（React 18 委托监听 submit；happy-dom 下 dispatch 冒泡即驱动 onSubmit）
    const username = container.querySelector<HTMLInputElement>('#login-username');
    const password = container.querySelector<HTMLInputElement>('#login-password');
    if (username) username.value = 'admin';
    if (password) password.value = 'wrong';
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('用户名或密码错误');
  });
});

describe('会话失效 → 守卫跳 /login（DES/15 §4 第三句 + §1 守卫规则）', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('业务 401 → refresh 也 401 → session 清空 → 守卫把受保护路由弹回登录页', async () => {
    // 一个 fetch 桩服务全链：login 200(viewer)；业务与 refresh 均 401
    const { fn, calls } = fakeFetch((path) => {
      if (path === '/api/auth/login') {
        return jsonResponse(200, {
          accessToken: 't-v',
          expiresAt: 'x',
          user: { id: 'u', username: 'viewer', role: 'viewer' },
        });
      }
      return jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'gone' } });
    });
    vi.stubGlobal('fetch', fn);

    // ref 对象规避 TS 闭包收窄（let 标注 null 后外层的属性访问会被窄成 never）
    const cap: { current: AuthState | null } = { current: null };
    function Grab(): JSX.Element | null {
      cap.current = useAuth();
      return null;
    }
    const router = createMemoryRouter(
      [
        { path: '/login', element: <p id="login-marker">LOGIN</p> },
        {
          element: <RequireAuth />,
          children: [{ path: '/accounts', element: <p id="protected">SECRET</p> }],
        },
      ],
      { initialEntries: ['/accounts'] },
    );

    root = createRoot(container);
    await act(async () => {
      root.render(
        <AuthProvider>
          <Grab />
          <RouterProvider router={router} />
        </AuthProvider>,
      );
    });
    // 守卫规则前半句：无会话进受保护路由 → 直接渲染 /login
    expect(container.querySelector('#login-marker')).not.toBeNull();
    expect(container.querySelector('#protected')).toBeNull();

    // 登录建立会话 → 导航回 /accounts → 守卫放行
    await act(async () => {
      await cap.current?.login('viewer', 'viewer');
    });
    await act(async () => {
      await router.navigate('/accounts');
    });
    expect(container.querySelector('#protected')).not.toBeNull();

    // 逐字链：业务请求 401 → 单飞 refresh 也 401 → expireSession 清空会话
    // → React 状态更新触发守卫重渲染 → 被弹回 /login
    await act(async () => {
      await cap.current?.client.request('/api/accounts').catch(() => undefined);
    });
    expect(cap.current?.session).toBeNull();
    expect(calls.filter((c) => c.path === '/api/auth/refresh').length).toBe(1);
    expect(container.querySelector('#login-marker')).not.toBeNull();
    expect(container.querySelector('#protected')).toBeNull();
  });
});
