// POST /api/accounts/:id/transition 的域逻辑（DES/03 §3 三段式 + QR §4 码序）。
// 判定顺序（卡片 b 逐字）：参数非法 → 400 VALIDATION_ERROR；账号不存在 → 404 ACCOUNT_NOT_FOUND；
// expectedFrom→to 不在 A1 表 → 409 ILLEGAL_TRANSITION（纯静态判定）；条件 UPDATE rowcount=0
// → 409 CAS_CONFLICT；成功 → 200。终态目标走 enterTerminal（expectedFrom 参与 CAS 判定）；
// to ∈ {disconnected,idle} 先落库后补调网关 disconnect（幂等；崩溃窗口由 accounts 恢复扫描补调）。
import type { Pool } from 'pg';
import { tx } from '../../db/tx.js';
import type { GatewayClient } from '../../gateway/client.js';
import { AppError } from '../../http/plugins/errors.js';
import {
  enterTerminal,
  isAccountStatus,
  isLegalTransition,
  isTerminal,
  type AccountStatusValue,
} from './transitions.js';

export interface TransitionDeps {
  pool: Pool;
  gateway: Pick<GatewayClient, 'disconnect'>;
  /** 补偿调用失败只记日志（状态已是本地真值，恢复扫描兜底重试） */
  logger: { warn(obj: unknown, msg?: string): void };
}

export interface TransitionInput {
  to?: unknown;
  expectedFrom?: unknown;
  rateLimitedUntil?: unknown;
}

export interface TransitionResult {
  status: AccountStatusValue;
}

function requireStatusField(value: unknown, field: string): AccountStatusValue {
  if (!isAccountStatus(value)) {
    throw new AppError('VALIDATION_ERROR', `${field} must be one of the 6 account statuses`);
  }
  return value;
}

function requireFutureIsoInstant(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new AppError('VALIDATION_ERROR', 'to=rate_limited requires rateLimitedUntil (ISO 8601 UTC, future)');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= Date.now()) {
    throw new AppError('VALIDATION_ERROR', 'rateLimitedUntil must be a future ISO 8601 instant');
  }
  return new Date(ms).toISOString();
}

export async function applyTransition(
  deps: TransitionDeps,
  accountId: string,
  input: TransitionInput,
): Promise<TransitionResult> {
  const to = requireStatusField(input.to, 'to');
  const expectedFrom = requireStatusField(input.expectedFrom, 'expectedFrom');

  // 存在性先于转移表判定（DES/03 §3 顺序：SELECT → 404 先于 ILLEGAL）
  const { rows } = await deps.pool.query<{ status: AccountStatusValue }>(
    'SELECT status FROM account WHERE id = $1',
    [accountId],
  );
  if (rows[0]?.status === undefined) {
    throw new AppError('ACCOUNT_NOT_FOUND', `unknown account: ${accountId}`);
  }
  if (!isLegalTransition(expectedFrom, to)) {
    throw new AppError('ILLEGAL_TRANSITION', `${expectedFrom} -> ${to} is not in the A1 table`);
  }

  // D3-4：rateLimitedUntil 校验隶属 rate_limited 目标分支（§3 mermaid 顺序：enum → 404 →
  // 转移表 → 本项 400 → 分支 UPDATE）；非 rate_limited 目标上的该字段被忽略（A1「不算转移」）。
  const rateLimitedUntil = to === 'rate_limited' ? requireFutureIsoInstant(input.rateLimitedUntil) : null;

  if (isTerminal(to)) {
    // 终态目标：enterTerminal 的 expectedFrom 模式把「当前态不符」判成 conflict；
    // already_same/already_other 意味着当前已是终态——而 expectedFrom 经合法性检查后必为非终态
    // （终态无出边），故同样落在「当前态 ≠ expectedFrom」→ CAS_CONFLICT（§3 判定序）。
    const outcome = await tx(deps.pool, (client) =>
      enterTerminal(client, accountId, to, { expectedFrom }),
    );
    if (outcome.outcome !== 'entered') {
      throw new AppError('CAS_CONFLICT', `account ${accountId} is ${outcome.from}, not ${expectedFrom}`);
    }
    return { status: to };
  }

  const updated = await tx(deps.pool, async (client) => {
    const result =
      to === 'rate_limited'
        ? await client.query(
            `UPDATE account SET status='rate_limited', rate_limited_until=$3::timestamptz, updated_at=now()
             WHERE id=$1 AND status=$2`,
            [accountId, expectedFrom, rateLimitedUntil],
          )
        : await client.query(
            `UPDATE account SET status=$3, rate_limited_until=NULL, updated_at=now()
             WHERE id=$1 AND status=$2`,
            [accountId, expectedFrom, to],
          );
    if (result.rowCount === 0) {
      return false;
    }
    await client.query("INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)", [
      JSON.stringify({ accountId, from: expectedFrom, to }),
    ]);
    return true;
  });
  if (!updated) {
    throw new AppError('CAS_CONFLICT', `account ${accountId} status is no longer ${expectedFrom}`);
  }

  // to ∈ {disconnected,idle} → 补调网关 disconnect（先落库后调外部；幂等，恢复扫描兜底 E10）
  if (to === 'disconnected' || to === 'idle') {
    await deps.gateway.disconnect(accountId).catch((err: unknown) => {
      deps.logger.warn({ err, accountId }, 'gateway disconnect compensation failed; recovery scan will retry');
    });
  }
  return { status: to };
}
