// 账号域端点 + 五操作共享闸门（REQ §2.1 账号节；DES/14 §2 account 行）。
// 闸门是 send/join/promote/kick/leave 的共同前置（开关 17）：本文件提供机制，
// 端点本身随群域/消息域任务落地——届时逐个接入同一闸门，禁止各自重写判断。
import type { FastifyInstance } from 'fastify';
import type { GatewayAnyErrorCode } from '@kapibala/contract';
import { ensureAccount, type GatewayState } from './state.js';

/** 闸门拒绝结果：路由层直接 `reply.code(statusCode).send(body)`（扁平错误体，契约形状） */
export interface AccountGateError {
  statusCode: number;
  body: { code: GatewayAnyErrorCode; message: string };
}

/**
 * 五操作（send/join/promote/kick/leave）账号闸门（REQ §2.1）。
 * 判定顺序即契约优先级：终态（suspended 403 / sessionExpired 401）先于离线 409——
 * 终态账号「所有请求回同码」，含这五个操作；离线账号只在五操作上被拒（connect 正是解法）。
 * 通过返回 null。
 */
export function assertAccountOperationAllowed(
  state: GatewayState,
  accountId: string,
): AccountGateError | null {
  const account = state.accounts.get(accountId);
  if (account?.suspended) {
    return { statusCode: 403, body: { code: 'ACCOUNT_SUSPENDED', message: 'account suspended' } };
  }
  if (account?.sessionExpired) {
    return { statusCode: 401, body: { code: 'SESSION_EXPIRED', message: 'account session expired' } };
  }
  if (account === undefined || !account.online) {
    // 未 connect / 已 disconnect 视同离线（开关 17）
    return { statusCode: 409, body: { code: 'ACCOUNT_OFFLINE', message: 'account not connected' } };
  }
  return null;
}

/** connect 的终态前置：终态账号连 connect 也回同码（REQ §2.1「之后该账号的所有请求」） */
export function assertConnectAllowed(state: GatewayState, accountId: string): AccountGateError | null {
  const account = state.accounts.get(accountId);
  if (account?.suspended) {
    return { statusCode: 403, body: { code: 'ACCOUNT_SUSPENDED', message: 'account suspended' } };
  }
  if (account?.sessionExpired) {
    return { statusCode: 401, body: { code: 'SESSION_EXPIRED', message: 'account session expired' } };
  }
  return null;
}

export function registerAccountRoutes(app: FastifyInstance, state: GatewayState): void {
  // POST /accounts/:accountId/connect → { platformUserId }（REQ §2.1）
  // 幂等：重复 connect 返回同一确定性 puid，保持 online。
  app.post('/accounts/:accountId/connect', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const gate = assertConnectAllowed(state, accountId);
    if (gate) {
      return reply.code(gate.statusCode).send(gate.body);
    }
    const account = ensureAccount(state, accountId);
    account.online = true;
    return reply.send({ platformUserId: account.platformUserId });
  });

  // POST /accounts/:accountId/disconnect → 账号离线（REQ §2.1）。
  // 终态优先：suspended / session_expired 账号连 disconnect 也回同码（「所有请求」）。
  app.post('/accounts/:accountId/disconnect', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const gate = assertConnectAllowed(state, accountId);
    if (gate) {
      return reply.code(gate.statusCode).send(gate.body);
    }
    const account = ensureAccount(state, accountId);
    account.online = false;
    return reply.send({});
  });
}
