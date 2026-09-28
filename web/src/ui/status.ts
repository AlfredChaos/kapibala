// 状态 → 语义色映射（附录「颜色语义扩展」逐字落地）。
// 查表即可：`ACCOUNT_TONE[status] ?? 'neutral'`；未知状态一律 neutral。
import type { Tone } from './primitives.js';

export const ACCOUNT_TONE: Record<string, Tone> = {
  online: 'ok',
  idle: 'neutral',
  disconnected: 'neutral',
  rate_limited: 'warn',
  suspended: 'danger',
  session_expired: 'info',
};

export const RUN_TONE: Record<string, Tone> = {
  running: 'warn',
  finished: 'ok',
  failed: 'danger',
  blocked: 'danger',
  cancelled: 'neutral',
  pending: 'neutral',
};

export const DELIVERY_TONE: Record<string, Tone> = {
  queued: 'warn',
  accepted: 'info',
  sent: 'ok',
  failed: 'danger',
  cancelled: 'danger',
};

export const STEP_TONE: Record<string, Tone> = {
  pending: 'neutral',
  running: 'warn',
  sent: 'ok',
  done: 'ok',
  failed: 'danger',
  skipped: 'neutral',
};

export const GROUP_TONE: Record<string, Tone> = {
  active: 'ok',
  creating: 'warn',
  archived: 'neutral',
};

export const toneOf = (table: Record<string, Tone>, status: string): Tone =>
  table[status] ?? 'neutral';
