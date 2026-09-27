// 账号域路由（T-P2-05）：GET /api/accounts + connect + transition。
// 权限矩阵（DES/09 §4 / DES/03 §6）：GET 只需登录；connect / transition 是写操作 → auth:'write'
// （viewer 403）。判定顺序与错误码由 modules/accounts/* 承担；本文件只做 HTTP 装配与
// 网关原码透传（connect 的 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED 走 extra.gatewayCode）。
import { AppError } from '../plugins/errors.js';
import { connectAccount } from '../../modules/accounts/connect.js';
import { applyTransition } from '../../modules/accounts/transition.js';
import { listAccounts } from '../../modules/accounts/list.js';
import type { GatewayClient } from '../../gateway/client.js';
import type { RouteDeps } from './index.js';
import type { App } from '../app.js';

interface GatewayCodedError {
  statusCode: number;
  gatewayCode: string;
  message: string;
}

/** connect 的终态透传错误（connect.ts 打标）：码不在自有表内，响应体逐字按网关码返回 */
function asGatewayCodedError(err: unknown): GatewayCodedError | null {
  if (err instanceof AppError && typeof err.extra?.['gatewayCode'] === 'string') {
    return { statusCode: err.statusCode, gatewayCode: err.extra['gatewayCode'], message: err.message };
  }
  return null;
}

export async function registerAccountRoutes(app: App, deps: RouteDeps): Promise<void> {
  const gateway = deps.gateway as GatewayClient;

  app.get('/api/accounts', { config: { auth: 'required' } }, async () => {
    return listAccounts(deps.pool);
  });

  app.post('/api/accounts/:id/connect', { config: { auth: 'write' } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await connectAccount({ pool: deps.pool, gateway }, id);
    } catch (err) {
      const gw = asGatewayCodedError(err);
      if (gw !== null) {
        // 原码透传（DES/03 §6）：error.code = 网关码（ACCOUNT_SUSPENDED/SESSION_EXPIRED）
        return reply
          .status(gw.statusCode)
          .send({ error: { code: gw.gatewayCode, message: gw.message, requestId: String(request.id) } });
      }
      throw err;
    }
  });

  app.post('/api/accounts/:id/transition', { config: { auth: 'write' } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    return applyTransition(
      { pool: deps.pool, gateway, logger: request.log },
      id,
      { to: body['to'], expectedFrom: body['expectedFrom'], rateLimitedUntil: body['rateLimitedUntil'] },
    );
  });
}
