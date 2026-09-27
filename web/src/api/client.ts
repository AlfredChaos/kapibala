// fetch 封装（T-P5-01；DES/15 §4、DES/09 §3.4、B3 前端半边）。
// 契约逐字：任一请求 401 → 若无进行中的刷新则 POST /api/auth/refresh（共享同一个 promise，
// 并发 401 只发一次）→ 成功后用新 accessToken 重放原请求；refresh 也 401 → 会话失效，
// 回调清空会话并跳 /login（回调注入：本模块是框架无感的数据层，不直接碰路由/DOM）。
// R-E：refresh token 由 HttpOnly cookie 承载——本文件从不读它；refresh 请求
// credentials:'include' 让浏览器自行带 cookie（同源 dev 下等价，属性保留契约语义）。
// token 来源注入（getAccessToken）：auth Context 是唯一持有者——client 不私存 token。

export interface SessionSnapshot {
  readonly accessToken: string;
  readonly user: { id: string; username: string; role: 'admin' | 'viewer' };
}

export interface ApiError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export function isApiError(err: unknown): err is ApiError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as ApiError).status === 'number' &&
    typeof (err as ApiError).code === 'string'
  );
}

export interface ClientDeps {
  /** 当前 access token（null = 未登录）；401 重放时重新读取（token 可能已轮换） */
  readonly getAccessToken: () => string | null;
  /** refresh 成功后的新会话（只含 accessToken；refresh 响应不回 user——沿用旧 user） */
  readonly onRefreshed: (accessToken: string) => void;
  /** refresh 401（复用作废/登出）→ 会话失效：清空 + 跳 /login（由 auth Context 接线） */
  readonly onSessionExpired: () => void;
  /** 测试缝：默认全局 fetch */
  readonly fetchFn?: typeof fetch;
}

export interface ApiClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  /** 仅供测试/调试：当前是否有进行中的 refresh（单飞观测点） */
  refreshInFlight(): boolean;
}

function toApiError(status: number, body: unknown): ApiError {
  // server 错误包络 {error:{code,message,requestId}}（errors.ts 统一映射）；
  // 非包络形状兜底成可显示的对象——调用方按 code 分流，message 兜底
  if (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: { code?: unknown } }).error?.code === 'string'
  ) {
    const err = (body as { error: { code: string; message?: unknown } }).error;
    return {
      status,
      code: err.code,
      message: typeof err.message === 'string' ? err.message : String(status),
    };
  }
  return { status, code: `HTTP_${status}`, message: `request failed with status ${status}` };
}

export function createApiClient(deps: ClientDeps): ApiClient {
  const fetchFn = deps.fetchFn ?? fetch;
  // 全局单飞：所有并发 401 共享同一 promise——第二/第 N 个 401 不新发 refresh
  let refreshing: Promise<string> | null = null;

  async function doRefresh(): Promise<string> {
    const res = await fetchFn('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include', // refresh token 只在 HttpOnly cookie（R-E）；此句是契约断言点
    });
    if (res.status === 401) {
      deps.onSessionExpired();
      throw toApiError(401, null);
    }
    if (!res.ok) {
      // 非 401 的失败（网络 5xx 等）：会话不失效——下一次请求会重试 refresh
      throw toApiError(res.status, await res.json().catch(() => null));
    }
    const body = (await res.json()) as { accessToken: string };
    deps.onRefreshed(body.accessToken);
    return body.accessToken;
  }

  function refreshOnce(): Promise<string> {
    if (refreshing === null) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function send(path: string, init: RequestInit, token: string | null): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token !== null && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${token}`);
    }
    if (init.body !== undefined && init.body !== null && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetchFn(path, { ...init, headers, credentials: 'include' });
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // 认证端点的 401 是业务结果（登录失败 = UNAUTHORIZED，不是会话过期）——
    // 它们不走单飞通道：login 的 401 要原样抛给页面按 code 显示；refresh 自身 401 即终局
    if (path.startsWith('/api/auth/')) {
      const res = await send(path, init, deps.getAccessToken());
      if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    let res = await send(path, init, deps.getAccessToken());
    if (res.status === 401) {
      const newToken = await refreshOnce(); // 401 → 单飞 refresh（失败把原错误/401 抛给调用方）
      res = await send(path, init, newToken); // 成功后原样重放
    }
    if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    request,
    refreshInFlight: () => refreshing !== null,
  };
}
