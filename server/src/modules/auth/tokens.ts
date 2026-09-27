// 认证 token 与 cookie 的纯工具（T-P0-07；DES/09 §1/§2）：
// - opaque 随机串 256bit（crypto.randomBytes(32) → base64url），原文只回客户端，落库仅 SHA-256 哈希；
// - refresh 走 HttpOnly cookie `rt`（绝不进响应体，B3），手工解析 Set-Cookie/Cookie 头，不引 @fastify/cookie。
import { createHash, randomBytes } from 'node:crypto';

/** cookie 名（DES/09 §2：Set-Cookie: rt=<httpOnly>） */
export const REFRESH_COOKIE_NAME = 'rt';

/** 256bit 随机 opaque token（客户端可见的原文） */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 落库/查询用的 SHA-256 哈希（hex）——token 原文不落库（宪法 §5） */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 非 localhost 请求加 Secure（DES/09 §2「Secure(生产)」；本地 http 下加了 Secure 反而发不出 cookie） */
function isLocalHost(hostname: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostname);
}

/** 下发 refresh cookie；Max-Age 与 refresh 7d TTL 对齐【设计值：REFRESH_TOKEN_TTL_MS】 */
export function buildRefreshCookie(token: string, hostname: string, maxAgeSeconds: number): string {
  const attrs = [
    `${REFRESH_COOKIE_NAME}=${token}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (!isLocalHost(hostname)) attrs.push('Secure');
  return attrs.join('; ');
}

/** 从 Cookie 请求头解析 rt 值；缺失返回 null */
export function readRefreshCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${REFRESH_COOKIE_NAME}=`)) {
      const value = trimmed.slice(REFRESH_COOKIE_NAME.length + 1);
      return value === '' ? null : value;
    }
  }
  return null;
}
