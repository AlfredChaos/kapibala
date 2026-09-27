// POST /api/accounts/:id/connect 的域逻辑（DES/03 §2 逐字）。
// 前置 {idle,disconnected}（§2.3 从严解读 #1：rate_limited 不在列——它是临时态、物理会话仍在）；
// 先调网关 connect（幂等：同 accountId 同 platformUserId——先调外部崩溃重试安全）后落库；
// 落库 = 单事务 { 条件 UPDATE status∈前置 + INSERT ws_event }，rowcount=0 → CAS_CONFLICT。
// 网关 403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED → enterTerminal 终态流程后按原码抛回。
import type { Pool } from 'pg';
import { tx } from '../../db/tx.js';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { AppError } from '../../http/plugins/errors.js';
import { enterTerminal, CONNECT_FROM, type AccountStatusValue } from './transitions.js';

export interface ConnectDeps {
  pool: Pool;
  gateway: Pick<GatewayClient, 'connect'>;
}

export interface ConnectResult {
  status: 'online';
  platformUserId: string;
}

/** 把网关 connect 的终态码翻译成 enterTerminal + 原码错误抛出；其余错误原样上抛 */
async function connectViaGateway(deps: ConnectDeps, accountId: string): Promise<string> {
  try {
    const { platformUserId } = await deps.gateway.connect(accountId);
    return platformUserId;
  } catch (err) {
    const terminal =
      err instanceof GatewayError && err.code === 'ACCOUNT_SUSPENDED'
        ? ('suspended' as const)
        : err instanceof GatewayError && err.code === 'SESSION_EXPIRED'
          ? ('session_expired' as const)
          : undefined;
    if (terminal !== undefined) {
      // 同步错误来源（DES/03 §1 终态入口 1）：进终态同事务副作用，然后按原码透传
      await tx(deps.pool, (client) => enterTerminal(client, accountId, terminal));
      throw new AppError('INTERNAL', `gateway reports account ${terminal}`, {
        // 码与 HTTP 按网关原码透传（DES/03 §6「按错误原码返回」）；AppError 类型只认自有码表，
        // 故此处用状态码覆盖 + 消息携带原码，响应体由路由层补 code 字段。
        statusCode: terminal === 'suspended' ? 403 : 401,
        extra: { gatewayCode: terminal === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'SESSION_EXPIRED' },
      });
    }
    throw err;
  }
}

export async function connectAccount(deps: ConnectDeps, accountId: string): Promise<ConnectResult> {
  // 前置判定：不存在 → 404；状态不在 {idle,disconnected} → 409 ILLEGAL_TRANSITION
  const { rows } = await deps.pool.query<{ status: AccountStatusValue }>(
    'SELECT status FROM account WHERE id = $1',
    [accountId],
  );
  const current = rows[0]?.status;
  if (current === undefined) {
    throw new AppError('ACCOUNT_NOT_FOUND', `unknown account: ${accountId}`);
  }
  if (!(CONNECT_FROM as readonly string[]).includes(current)) {
    throw new AppError(
      'ILLEGAL_TRANSITION',
      `connect requires status ∈ ${CONNECT_FROM.join('|')}, current: ${current}`,
    );
  }

  // 先调网关（幂等），后落库：崩溃窗口由「重发 connect 结果不变」兜底（DES/03 §2 注）
  const platformUserId = await connectViaGateway(deps, accountId);

  // 条件 UPDATE：并发状态变化（operator transition / 终态事件）→ rowcount=0 → CAS_CONFLICT
  const updated = await tx(deps.pool, async (client) => {
    const result = await client.query(
      `UPDATE account SET status='online', platform_user_id=$2, updated_at=now()
       WHERE id=$1 AND status IN ('idle','disconnected')`,
      [accountId, platformUserId],
    );
    if (result.rowCount === 0) {
      return false;
    }
    await client.query("INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)", [
      JSON.stringify({ accountId, from: current, to: 'online' }),
    ]);
    return true;
  });
  if (!updated) {
    throw new AppError('CAS_CONFLICT', `account ${accountId} status changed concurrently`);
  }
  return { status: 'online', platformUserId };
}
