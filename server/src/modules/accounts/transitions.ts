// 账号状态机（T-P2-05）：A1 转移表集中定义 + enterTerminal 幂等入口（薄版）+ accounts 恢复扫描。
// 契约出处：REQ A1 转移表逐格（16 条合法边；表外含同态→同态一律 ILLEGAL_TRANSITION；
// rateLimitedUntil 刷新不算转移；并发至多一个成功）；DES/03 §1（表、mermaid 逐字）、
// §4（终态统一入口幂等三分支）、§5.3 + E10（accounts 恢复扫描两段）；QR §4（错误码）。
// 终态副作用六动作（成员移除 / queued 取消 / 在途转 unknown / 步骤 skipped / ws_event 全量）
// 归 T-P2-06 的本文件 enterTerminal 加宽——此处先落状态+terminal_at+两类 ws_event 的核心三写。
import type { Pool, PoolClient } from 'pg';
import type { AccountStatus, AccountTerminalStatus } from '@kapibala/contract';
import { tx } from '../../db/tx.js';
import { AppError } from '../../http/plugins/errors.js';

/** 账号状态值（= contract AccountStatus；模块内别名避免域内外类型名漂移） */
export type AccountStatusValue = AccountStatus;

export const ACCOUNT_STATUSES = [
  'idle',
  'online',
  'rate_limited',
  'disconnected',
  'suspended',
  'session_expired',
] as const;

export const TERMINAL_STATUSES = ['suspended', 'session_expired'] as const;

/** connect 前置集合（§2.3 从严解读 #1：rate_limited 不在列——临时态、物理会话仍在） */
export const CONNECT_FROM = ['idle', 'disconnected'] as const;

/**
 * A1 合法边集合（from→to，15 条 = applyTransition/transition API 的判定表，逐字 DES/03 §1
 * 「合法转移 15 条」+ REQ A1 表格扣除 connect 专属边）。REQ A1 网格 16 ✔ 中，
 * disconnected→online 标的是「connect 成功」（DES/03 §1 mermaid + §2 connect 前置
 * {idle,disconnected}）——操作员 transition 不可标记 online（§3 disconnect 补偿只挂
 * to∈{disconnected,idle}）。connect 自己的 online 转移走 connect.ts 的前置+幂等路径，
 * 不查本表。同态→同态与其余表外组合一律 ILLEGAL_TRANSITION（REQ A1 逐字）。
 */
export const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set(
  (
    [
      ['idle', 'online'],
      ['idle', 'suspended'],
      ['idle', 'session_expired'],
      ['online', 'idle'],
      ['online', 'rate_limited'],
      ['online', 'disconnected'],
      ['online', 'suspended'],
      ['online', 'session_expired'],
      ['rate_limited', 'online'],
      ['rate_limited', 'disconnected'],
      ['rate_limited', 'suspended'],
      ['rate_limited', 'session_expired'],
      ['disconnected', 'idle'],
      ['disconnected', 'suspended'],
      ['disconnected', 'session_expired'],
    ] as const
  ).map(([from, to]) => `${from}->${to}`),
);

export function isAccountStatus(value: unknown): value is AccountStatusValue {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: AccountStatusValue): status is AccountTerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isLegalTransition(from: AccountStatusValue, to: AccountStatusValue): boolean {
  return LEGAL_TRANSITIONS.has(`${from}->${to}`);
}

export interface AccountRow {
  id: string;
  status: AccountStatusValue;
  platform_user_id: string | null;
  rate_limited_until: Date | null;
  terminal_at: Date | null;
}

// ---------- enterTerminal 幂等入口（DES/03 §1 尾段 + §4 判定表） ----------

export type TerminalOutcome =
  /** 首次进入：条件 UPDATE 命中，副作用已随同事务 */
  | 'entered'
  /** rowcount=0 且已是同一终态 → 静默忽略（A1：不重放副作用） */
  | 'already_same'
  /** rowcount=0 且已是另一终态 → 终态间无转移边；事件路径吞掉并记日志（ILLEGAL 语义） */
  | 'already_other'
  /** rowcount=0 但当前是非终态且 ≠ expectedFrom（仅带 expectedFrom 的调用可命中）→ CAS_CONFLICT */
  | 'conflict';

export interface EnterTerminalOptions {
  /** 操作员 transition 路径传入：把「当前状态不符」判为 CAS_CONFLICT（而非 already_*） */
  expectedFrom?: AccountStatusValue;
  /** 终态副作用扩展点（T-P2-06 六动作）：首次进入时同事务回调；默认空实现 */
  onEntered?: (client: PoolClient, accountId: string, from: AccountStatusValue) => Promise<void>;
}

/**
 * 进入终态的统一入口（三来源汇聚：同步网关错误 / account_status 事件 / 操作员 transition）。
 * 单事务序列：SELECT ... FOR UPDATE（锁行、取转移前值）→ 幂等判定 → UPDATE →
 * ws_event 两帧（account_terminal + account_status_changed）→ onEntered 副作用回调。
 * 幂等三分支按 DES/03 §4 逐字；「后写不覆盖先写」由行锁 + expectedFrom 判定保证。
 */
export async function enterTerminal(
  client: PoolClient,
  accountId: string,
  target: AccountTerminalStatus,
  options: EnterTerminalOptions = {},
): Promise<{ outcome: TerminalOutcome; from?: AccountStatusValue }> {
  // 先锁行读当前态：终态幂等分支与 CAS 判定都要用到「此刻真值」
  const { rows } = await client.query<{ status: AccountStatusValue }>(
    'SELECT status FROM account WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  const current = rows[0]?.status;
  if (current === undefined) {
    throw new AppError('ACCOUNT_NOT_FOUND', `unknown account: ${accountId}`);
  }
  if (isTerminal(current)) {
    return { outcome: current === target ? 'already_same' : 'already_other', from: current };
  }
  if (options.expectedFrom !== undefined && current !== options.expectedFrom) {
    return { outcome: 'conflict', from: current };
  }
  await client.query(
    `UPDATE account SET status=$1, terminal_at=now(), updated_at=now() WHERE id=$2`,
    [target, accountId],
  );
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('account_terminal', $1::jsonb)", [
    JSON.stringify({ accountId, status: target }),
  ]);
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)", [
    JSON.stringify({ accountId, from: current, to: target }),
  ]);
  await options.onEntered?.(client, accountId, current);
  return { outcome: 'entered', from: current };
}

// ---------- accounts 恢复扫描（DES/10 §3 第 5 扫；DES/03 §5.3 + E10） ----------

export interface AccountsRecoveryDeps {
  /** 只需 disconnect（补调 E10）；网关侧幂等（离线再调无害） */
  disconnect(accountId: string): Promise<void>;
}

/**
 * 两段：a) rate_limited 到期未转移 → 条件 UPDATE 回 online（DES/03 §5.3 逐字：
 * 「到期时已不是 rate_limited 则不转移」）+ ws_event；b) status ∈ idle/disconnected
 * 的账号补调 gateway.disconnect（E10：transition 落库后崩溃、补调未发生的窗口在此收口）。
 * 幂等可重复触发（宪法 §3-5）：a 段单事务条件更新，b 段幂等外呼。返回处理的账号数。
 */
export async function runAccountsRecoveryScan(pool: Pool, deps: AccountsRecoveryDeps): Promise<number> {
  // a) 限流到期自动回 online：条件 UPDATE + ws_event 同事务（与 §5.3 调度器同一路径的实现体）
  const expired = await tx(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE account SET status='online', rate_limited_until=NULL, updated_at=now()
       WHERE status='rate_limited' AND rate_limited_until <= now()
       RETURNING id`,
    );
    for (const row of rows) {
      await client.query(
        "INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)",
        [JSON.stringify({ accountId: row.id, from: 'rate_limited', to: 'online' })],
      );
    }
    return rows.length;
  });
  // b) disconnect 补偿：本地 idle/disconnected = 意图已落库 → 补调幂等的网关 disconnect
  const { rows: offline } = await pool.query<{ id: string }>(
    `SELECT id FROM account WHERE status IN ('idle','disconnected')`,
  );
  for (const row of offline) {
    await deps.disconnect(row.id); // 网关幂等；失败则本轮抛错由外层恢复器重试
  }
  return expired + offline.length;
}
