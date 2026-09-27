// 建群 / 成员生命周期类开关（T-P3-10）：gw-18 `member_joined_never`、gw-20 `invite_not_ready`、
// gw-21 `invite_expired`、gw-22 `already_member`、gw-23 `promote_not_member_yet`、gw-26 `leave_500`。
// 契约出处：REQ §2.1 群与成员节（readyAfterMs「可能是 0，也可能几秒」；链接任意时刻可能过期；
// 「已在群里的账号再 join → 409 ALREADY_MEMBER，此时**不会再推** member_joined」；promote 的
// 409 NOT_MEMBER_YET；leave「也可能返回 500（没退成）」）；DES/14 §5 行 18/20–23/26、§3 invite 行。
// QR §2：ALREADY_MEMBER「视为成功，直接 promote」、NOT_MEMBER_YET「promote 调用总数 ≤ 2」。
// 分工约定：本文件只做判定 + 契约要求的最小状态写（gw-22「视为已在群」、gw-23 的注入配额），
// HTTP 响应与事件推送留在路由层（groups.ts / messaging.ts）。
import type { GatewayState } from '../state.js';
import { activeSwitch, randomBetween, readNumberParam, type SwitchTarget } from '../switches.js';

/** gw-20：readyAfterMs 的「数秒」档在 mock 内部的默认区间（契约只说「0 或几秒」，具体秒数非契约数字） */
const INVITE_READY_SLOW_MIN_MS = 2000;
const INVITE_READY_SLOW_MAX_MS = 5000;

/** gw-23 未钉 `params.times` 时的注入次数（QR §2：server 的 promote 总调用 ≤2，故 1 次是现实档） */
const DEFAULT_PROMOTE_REJECTIONS = 1;

/** gw-18 `member_joined_never`：join 回 202 但 member_joined 永不到——此时账号**并未入群**（REQ §2.1） */
export function isMemberJoinedNever(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'member_joined_never', target) !== undefined;
}

/**
 * gw-20 `invite_not_ready`：invite 的 `readyAfterMs`——钉值优先（可为 0 = 立即就绪），
 * 否则按契约「可能是 0，也可能几秒」随机（数秒档取 mock 内部区间 2000–5000ms）。
 * 就绪前 join → 409 INVITE_NOT_READY（响应带剩余等待，QR §2「等 readyAfterMs 后重试」）。
 * 开关语义是「制造未就绪」：arm 而未钉时强制 >0（走数秒档），不能随机出 0 假绿（DES/14 §5 行 20）。
 */
export function resolveInviteReadyAfterMs(state: GatewayState, groupId: string): number {
  const config = activeSwitch(state, 'invite_not_ready', { groupId });
  const pinned = readNumberParam(config, 'readyAfterMs');
  if (pinned !== undefined) {
    return pinned;
  }
  if (config !== undefined) {
    return randomBetween(INVITE_READY_SLOW_MIN_MS, INVITE_READY_SLOW_MAX_MS);
  }
  return Math.random() < 0.5 ? 0 : randomBetween(INVITE_READY_SLOW_MIN_MS, INVITE_READY_SLOW_MAX_MS);
}

/** gw-21 `invite_expired`：join → 410 INVITE_EXPIRED（链接任意时刻可过期；无参数，arm 即生效） */
export function isInviteExpired(state: GatewayState, groupId: string): boolean {
  return activeSwitch(state, 'invite_expired', { groupId }) !== undefined;
}

/**
 * gw-22 `already_member`：**强制**「已在群」→ join 409 ALREADY_MEMBER 且不推事件。
 * 自然路径（账号确实在群里）由路由的 `members.has` 判定覆盖；本函数只负责强制注入那一半
 * ——即使账号并不在群，也要给出 409（server 侧 D2-2 的成员行 UPSERT 依赖这条契约明文行为）。
 * 强制路径同时把账号补进成员集（见 groups.ts）：QR §2「视为成功，直接 promote」要求随后的 promote 能成。
 */
export function isAlreadyMemberForced(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'already_member', target) !== undefined;
}

/**
 * gw-23 `promote_not_member_yet`：前 N 次 promote → 409 NOT_MEMBER_YET，之后放行到自然判定。
 * N = `params.times`（缺省 1）；计数按 (groupId, accountId) 作用域分开，存在开关配置的 `runtime` 里，
 * 故**重新 arm（覆盖参数）或 clear 都会归零**（DES/14 §4），不同被提升账号互不干扰。
 * 返回 true = 本次调用应拒绝（并已消耗一次配额）。
 */
export function consumePromoteNotMemberYet(state: GatewayState, target: SwitchTarget): boolean {
  const config = activeSwitch(state, 'promote_not_member_yet', target);
  if (config === undefined) {
    return false;
  }
  const scope = `${target.groupId ?? ''}\u0000${target.accountId ?? ''}`;
  const runtime = (config.runtime ??= {});
  const remaining = runtime[scope] ?? readNumberParam(config, 'times') ?? DEFAULT_PROMOTE_REJECTIONS;
  if (remaining <= 0) {
    return false;
  }
  runtime[scope] = remaining - 1;
  return true;
}

/** gw-26 `leave_500`：leave → 500（没退成：成员保留、不推 member_left；QR §2 leave-all 记 errors[]） */
export function isLeaveForced500(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'leave_500', target) !== undefined;
}
