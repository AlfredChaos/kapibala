// Auth Context（T-P5-01；DES/15 §1/§4、R-E、REQ §4 页面 1）。
// 唯一职责：持有会话（accessToken + user），装配 ApiClient 的接线
// （getAccessToken / onRefreshed / onSessionExpired），向页面暴露
// { session, login, logout, client }。
// R-E：refresh token 只活在 HttpOnly cookie——本模块无 refresh 字段、无 JS 可读路径。
// 会话持久化走 sessionStorage（关页即清）：刷新整页后经 refresh 单飞拿回新 access，
// user.role 沿持久化值（refresh 响应不带 user，§2.3 端点表逐字）。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createApiClient,
  isApiError,
  type ApiClient,
  type ApiError,
  type SessionSnapshot,
} from '../api/client.js';
import {
  clearSession,
  login as apiLogin,
  logout as apiLogout,
  persistSession,
  restoreSession,
} from '../api/auth.js';

export interface AuthState {
  /** null = 未登录/会话已失效 */
  readonly session: SessionSnapshot | null;
  readonly client: ApiClient;
  /** 登录（失败抛 ApiError——页面按 error.code 显示，DES/15 页面 1） */
  readonly login: (username: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  /** 会话失效（refresh 401）：本地清空 + 由守卫把后续渲染导到 /login */
  readonly expireSession: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** viewer 只读门（DES/15 §2 页面 2 注「viewer：写操作按钮不渲染」）：唯一判定收口，页面一律用它 */
export function canWrite(session: SessionSnapshot | null): boolean {
  return session?.user.role === 'admin';
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export function AuthProvider(props: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<SessionSnapshot | null>(() => restoreSession());
  // client 必须稳定单例（重建会丢进行中的单飞 promise）；getAccessToken 需读最新
  // session——ref 桥接（每次渲染同步 ref，回调不闭旧值）
  const sessionRef = useRef<SessionSnapshot | null>(session);
  sessionRef.current = session;

  const expireSession = useCallback(() => {
    clearSession();
    setSession(null); // 守卫随 session=null 把后续渲染导到 /login
  }, []);

  const client = useMemo<ApiClient>(
    () =>
      createApiClient({
        getAccessToken: () => sessionRef.current?.accessToken ?? null,
        onRefreshed: (accessToken) =>
          setSession((prev) => {
            if (prev === null) return null;
            const next = { ...prev, accessToken };
            persistSession(next);
            return next;
          }),
        onSessionExpired: expireSession,
      }),
    [expireSession],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await apiLogin(client, username, password);
      const next: SessionSnapshot = { accessToken: res.accessToken, user: res.user };
      persistSession(next);
      setSession(next);
    },
    [client],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout(client);
    } catch (err) {
      // 服务端 logout 失败（网络/已 401）不阻断本地登出——本地态先清（B3 前端半边）
      if (!isApiError(err) || err.status !== 401) throw err;
    } finally {
      clearSession();
      setSession(null);
    }
  }, [client]);

  const value = useMemo<AuthState>(
    () => ({ session, client, login, logout, expireSession }),
    [session, client, login, logout, expireSession],
  );

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}

export type { ApiError, SessionSnapshot };
export { isApiError };
