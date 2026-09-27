// agent run 三重预算的判定原语（T-P4-05；DES/06 §5 逐字 + REQ A5-2 + QR §1）。
// 三闸逐字：
// - 步数 12（含结束步；审计重试不计步）——循环开始前判 step_count<12；
// - 墙钟 60s（含审计等待；停机不计——wall_consumed_ms 只累计进程活着的耗时）；
// - 连续 3 次协议错误（任一合法响应清零，路径 A 的 UNKNOWN_TOOL/INVALID_INPUT 也算合法响应）。
// 本文件只做判定/记账算术；写库时机在 executor（每步事务随同步累加，§3 固定结构第 5 条）。
import {
  AGENT_MAX_STEPS,
  AGENT_TURN_TIMEOUT_DEFAULT_MS,
  AGENT_WALL_CLOCK_MS,
  PROTOCOL_ERROR_STREAK_LIMIT,
} from '../../constants.js';

export { AGENT_MAX_STEPS, AGENT_WALL_CLOCK_MS, PROTOCOL_ERROR_STREAK_LIMIT };

/** turn 超时区间（REQ §2.2「10–15 秒（可配）」）——可配值越界时钳到区间内 */
const TURN_TIMEOUT_MIN_MS = 10_000;
const TURN_TIMEOUT_MAX_MS = 15_000;

export function clampTurnTimeoutMs(configured: number | undefined): number {
  const v = configured ?? AGENT_TURN_TIMEOUT_DEFAULT_MS;
  return Math.min(TURN_TIMEOUT_MAX_MS, Math.max(TURN_TIMEOUT_MIN_MS, v));
}

export interface BudgetState {
  readonly stepCount: number;
  readonly wallConsumedMs: number;
  readonly wallDeadlineAt: Date | null;
  readonly protocolErrorStreak: number;
}

export type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly endReason: 'budget_exhausted' | 'wall_clock' | 'protocol_errors' };

/** 每轮循环开始前的预算预检（§5 表「判定时机」逐字）；步数先判（第 12 步可以是合法步） */
export function checkBudget(b: BudgetState, now: Date): BudgetVerdict {
  if (b.stepCount >= AGENT_MAX_STEPS) return { ok: false, endReason: 'budget_exhausted' };
  if (b.wallDeadlineAt !== null && now.getTime() >= b.wallDeadlineAt.getTime()) {
    return { ok: false, endReason: 'wall_clock' };
  }
  if (b.protocolErrorStreak >= PROTOCOL_ERROR_STREAK_LIMIT) return { ok: false, endReason: 'protocol_errors' };
  return { ok: true };
}

/**
 * 恢复时刻重建 wall_deadline（§5 逐字）：wall_deadline_at = now() + (60000 - consumed)。
 * 停机时间不计——deadline 相对恢复时刻重锚。
 */
export function resumedWallDeadline(consumedMs: number, now: Date): Date {
  const remaining = Math.max(0, AGENT_WALL_CLOCK_MS - consumedMs);
  return new Date(now.getTime() + remaining);
}
