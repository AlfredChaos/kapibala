// auth guard 骨架（T-P0-04）：路由元数据 auth: 'public' | 'required' | 'write' + 注入式 verifyAccessToken。
// 认证模块（T-P0-07）落地前用 stub——stub 对一切 token 抛 401，保证守卫在接线前不可被绕过。
// 判定顺序（A0）：401（无 token / token 无效）先于 403（viewer 写操作）。
import type { App } from '../app.js';
import { AppError } from './errors.js';

export interface AuthContext {
  userId: string;
  role: 'admin' | 'viewer';
  sessionId: string;
}

/** T-P0-07 接线点：查 auth_token 校验 access token；有效返回会话上下文，无效抛 AppError('UNAUTHORIZED') */
export type VerifyAccessToken = (token: string) => Promise<AuthContext>;

export const stubVerifyAccessToken: VerifyAccessToken = async () => {
  throw new AppError('UNAUTHORIZED', 'authentication is not available yet');
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 路由认证元数据；缺省 = required（安全默认：漏标注的路由不会变成匿名可访问） */
    auth?: 'public' | 'required' | 'write';
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AuthGuardOptions {
  verifyAccessToken: VerifyAccessToken;
}

export async function applyAuthGuard(app: App, options: AuthGuardOptions): Promise<void> {
  // 装饰出 request.auth（默认 null），后代路由处理器统一从 request.auth 读会话上下文
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request) => {
    const mode = request.routeOptions.config?.auth ?? 'required';
    // 未匹配路由放行给 404 处理器（request.is404，Fastify ≥4.10）：认证判定只针对「存在且受保护」
    // 的路由；A0 的「401 先于 403」顺序不受影响。
    if (mode === 'public' || request.is404) return;
    const header = request.headers.authorization;
    const token = header !== undefined && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (token === '') {
      throw new AppError('UNAUTHORIZED', 'missing or malformed Authorization header');
    }
    request.auth = await options.verifyAccessToken(token);
    if (mode === 'write' && request.auth.role !== 'admin') {
      throw new AppError('FORBIDDEN', 'write operation requires admin role');
    }
  });
}
