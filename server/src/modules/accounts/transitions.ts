// 账号状态机（T-P2-05）：A1 转移表集中定义 + accounts 恢复扫描。
// 契约出处：REQ A1 转移表逐格（API 表 16 条合法边——disconnected→online 也允许，
// 此前按「connect 专属」收窄已被回拨对齐字面；表外含同态→同态一律 ILLEGAL_TRANSITION；
// rateLimitedUntil 刷新不算转移；并发至多一个成功）；
// DES/03 §1、§5.3 + E10（accounts 恢复扫描两段）；QR §4（错误码）。
// enterTerminal（终态入口 + 六动作副作用）在 terminal.ts（T-P2-06）。
import type { Pool } from 'pg';
import type { AccountStatus, AccountTerminalStatus } from '@kapibala/contract';
import { tx } from '../../db/tx.js';
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
 * A1 合法边集合（from→to，16 条 = applyTransition/transition API 的判定表，REQ A1 网格
 * 逐格对齐——含 disconnected→online；终态两列无出边）。
 * 说明：transition 是纯标记操作（REQ §2.3「操作员手动标记状态」）——标回 online 不调网关
 * connect，与 idle→online 行为对称；要建立真实网关会话走 POST /connect（CONNECT_FROM）。
 * 同态→同态与其余表外组合一律 ILLEGAL_TRANSITION（REQ A1 逐字）。
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
      ['disconnected', 'online'],
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

// enterTerminal（终态唯一入口 + 六动作副作用）已迁至 terminal.ts（T-P2-06）——
// 本文件只留转移表 / 前置常量 / 恢复扫描。
export interface AccountRow {
  id: string;
  status: AccountStatusValue;
  platform_user_id: string | null;
  rate_limited_until: Date | null;
  terminal_at: Date | null;
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
