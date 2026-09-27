// auth API 封装（T-P5-01；DES/09 §2.3 端点表 + DES/15 §2 页面 1）。
// 登录/登出/刷新的请求形状在此收口——页面不直接 fetch。
// login/refresh 的 refresh token 由 Set-Cookie(HttpOnly) 下发，响应体只含 accessToken。
import type { ApiClient, SessionSnapshot } from './client.js';

export interface LoginSuccess {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly user: { id: string; username: string; role: 'admin' | 'viewer' };
}

export async function login(client: ApiClient, username: string, password: string): Promise<LoginSuccess> {
  return client.request<LoginSuccess>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** 登出（204）；调用方负责本地会话清理（先本地清、网络失败也不留伪登录态） */
export async function logout(client: ApiClient): Promise<void> {
  await client.request('/api/auth/logout', { method: 'POST' });
}

/** 会话本地持久化载体：sessionStorage（关页即清；R-E 只管 refresh——它从不进 JS） */
export function persistSession(session: SessionSnapshot): void {
  sessionStorage.setItem('kapibala.session', JSON.stringify(session));
}

export function restoreSession(): SessionSnapshot | null {
  const raw = sessionStorage.getItem('kapibala.session');
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SessionSnapshot;
    return typeof parsed.accessToken === 'string' && typeof parsed.user?.role === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  sessionStorage.removeItem('kapibala.session');
}
