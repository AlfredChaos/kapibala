// 账号终态类开关（T-P3-09）：gw-11 `account_suspended_403` / gw-12 `session_expired_401` /
// gw-13 `account_status_event`。契约出处：REQ §2.1 同步错误表——403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED
// 「之后该账号的**所有请求（含 connect）**都返回同样错误」、「账号进入这两种状态后，网关会**自动把它移出
// 所有群**并推 `member_left`」、「网关也可能（不保证）再推一条 `account_status`」；DES/14 §5 行 11/12/13。
// 分工约定：终态**标志**由本文件在 arm/clear 时置/撤，判定（回哪个码）在 accounts.ts 的共享闸门里。
import { appendLedger, type GatewayState, type SwitchConfig } from '../state.js';
import { readStringParam, readTargetString } from '../switches.js';

/** `account_status` 事件的 status 闭集（REQ §2.1：只有这两种终态） */
export const TERMINAL_STATUSES = ['suspended', 'session_expired'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

function isTerminalStatus(value: unknown): value is TerminalStatus {
  return typeof value === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(value);
}

/**
 * gw-11/12/13 的 arm/clear 接线（test-plane 的 armSwitch / disarmSwitch 调用）。
 * 返回非 null = arrange 失败（调用方 400 且开关不登记）。
 * clear 只撤终态标志：gw-13 已推的 `account_status` / `member_left` 帧与已发生的「移出所有群」
 * 不可撤回（账本 append-only，成员变更也是既成事实）。
 */
export function applyTerminalSwitch(
  state: GatewayState,
  switchName: string,
  config: SwitchConfig,
  enabling: boolean,
): string | null {
  if (switchName === 'account_suspended_403') {
    return applyTerminalFlag(state, 'suspended', config, enabling);
  }
  if (switchName === 'session_expired_401') {
    return applyTerminalFlag(state, 'session_expired', config, enabling);
  }
  if (switchName === 'account_status_event') {
    return enabling ? armAccountStatusEvent(state, config) : clearAccountStatusEvent(state, config);
  }
  return null;
}

/**
 * gw-11/12：置/撤终态标志。未给 `target.accountId` 时不做接线（开关仍登记成功——T-P1-01 既有行为：
 * 全局 arrange 的语义留给账号闸门按自然状态判定）。clear 路径对已消失的账号宽容
 * （reset 恢复种子后再 clear 旧开关是合法时序）。
 */
function applyTerminalFlag(
  state: GatewayState,
  status: TerminalStatus,
  config: SwitchConfig,
  enabling: boolean,
): string | null {
  const accountId = readTargetString(config, 'accountId');
  if (accountId === undefined) {
    return null;
  }
  const account = state.accounts.get(accountId);
  if (account === undefined) {
    return enabling ? `unknown target account: ${accountId}` : null;
  }
  setTerminalFlag(account, status, enabling);
  return null;
}

/**
 * gw-13 `account_status_event`：推 `account_status {accountId, status}` + **自动移出所有群**并逐群推
 * `member_left`（REQ §2.1 逐字）。同时置终态标志——终态与事件是同一次状态转移的两面：只推事件而账号
 * 仍能 send，会与「之后该账号的所有请求都返回同样错误」自相矛盾。
 * `params.status` 必填且 ∈ 闭集：缺失/拼错 → arrange 400，不默认成 suspended 而悄悄测错分支。
 */
function armAccountStatusEvent(state: GatewayState, config: SwitchConfig): string | null {
  const accountId = readTargetString(config, 'accountId');
  if (accountId === undefined) {
    return 'account_status_event requires target.accountId';
  }
  const account = state.accounts.get(accountId);
  if (account === undefined) {
    return `unknown target account: ${accountId}`;
  }
  const status = readStringParam(config, 'status');
  if (!isTerminalStatus(status)) {
    return `account_status_event requires params.status ∈ suspended | session_expired, got: ${JSON.stringify(status)}`;
  }
  setTerminalFlag(account, status, true);
  appendLedger(state, 'account_status', { accountId, status });
  // 自动移出所有群并逐群推 member_left（只在确实是成员时推，与 kick/leave 的 removed 判定一致）
  for (const [groupId, group] of state.groups) {
    if (group.members.delete(account.platformUserId)) {
      appendLedger(state, 'member_left', { groupId, platformUserId: account.platformUserId });
    }
  }
  return null;
}

/** gw-13 的 clear：撤终态标志（事件与移出群不撤回） */
function clearAccountStatusEvent(state: GatewayState, config: SwitchConfig): string | null {
  const accountId = readTargetString(config, 'accountId');
  const account = accountId === undefined ? undefined : state.accounts.get(accountId);
  if (account === undefined) {
    return null;
  }
  setTerminalFlag(account, readStringParam(config, 'status') === 'session_expired' ? 'session_expired' : 'suspended', false);
  return null;
}

function setTerminalFlag(
  account: { suspended: boolean; sessionExpired: boolean },
  status: TerminalStatus,
  value: boolean,
): void {
  if (status === 'suspended') {
    account.suspended = value;
  } else {
    account.sessionExpired = value;
  }
}
