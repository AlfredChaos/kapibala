// 认证路由（T-P0-07；DES/09 §2 端点表、REQ §2.3/B3）。
// cookie 手工处理（不下发 @fastify/cookie 依赖）；refresh 绝不进响应体（B3）。
// 响应在 REQ §2.3 最小形状上补 expiresAt / user（前端续期与角色展示需要；【解读】超集不违约）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';
import { AppError } from '../plugins/errors.js';
import type { VerifyAccessToken } from '../plugins/auth-guard.js';
import { login, logout, refresh, verifyAccessToken } from '../../modules/auth/service.js';
import { buildRefreshCookie, readRefreshCookie } from '../../modules/auth/tokens.js';
import { REFRESH_TOKEN_TTL_MS } from '../../constants.js';

/** guard 接线（T-P0-04 预留注入点）：查表验证 access token，无效 → 401 */
export function createVerifyAccessToken(pool: RouteDeps['pool']): VerifyAccessToken {
  return async (token) => {
    const verified = await verifyAccessToken(pool, token);
    if (!verified) throw new AppError('UNAUTHORIZED', 'invalid or expired access token');
    return verified;
  };
}

interface LoginBody {
  username: string;
  password: string;
}

export async function registerAuthRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      config: { auth: 'public' },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          properties: { username: { type: 'string' }, password: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const result = await login(deps.pool, request.body);
      if (result.status === 'deny') {
        // 统一文案，不区分用户存在性（DES/09 §5）
        throw new AppError('UNAUTHORIZED', 'invalid username or password');
      }
      reply.header(
        'set-cookie',
        buildRefreshCookie(result.refreshToken, request.hostname, REFRESH_TOKEN_TTL_MS / 1000),
      );
      return {
        accessToken: result.accessToken,
        expiresAt: result.accessExpiresAt.toISOString(),
        user: result.user,
      };
    },
  );

  app.post(
    '/api/auth/refresh',
    { config: { auth: 'public' } },
    async (request, reply) => {
      const token = readRefreshCookie(request.headers.cookie);
      if (!token) throw new AppError('UNAUTHORIZED', 'missing refresh token');
      const result = await refresh(deps.pool, token);
      if (result.status === 'deny') {
        // 含复用检测路径：service 已在此前把整会话吊销（B3）
        throw new AppError('UNAUTHORIZED', 'invalid or reused refresh token');
      }
      reply.header(
        'set-cookie',
        buildRefreshCookie(result.refreshToken, request.hostname, REFRESH_TOKEN_TTL_MS / 1000),
      );
      return { accessToken: result.accessToken, expiresAt: result.accessExpiresAt.toISOString() };
    },
  );

  app.post(
    '/api/auth/logout',
    { config: { auth: 'required' } },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new AppError('UNAUTHORIZED', 'authentication required'); // 理论不可达：guard 已挡
      await logout(deps.pool, auth.sessionId);
      void reply.status(204).send();
    },
  );
}
