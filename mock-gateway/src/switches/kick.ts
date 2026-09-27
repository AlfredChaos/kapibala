// kick 生命周期开关（T-P4-14）：gw-24 `kick_slow`/`kick_504`、gw-25 `owner_left_on_kick`/`kick_no_permission`。
// 契约出处：DES/14 §5 行 24/25、§3 kick 行；REQ §2.1 kick 行；QR §1（1–5s、2s 收敛）。
// 分工约定：本文件只做判定与参数读取（延迟、504、收敛真值、强制错误）；HTTP 响应与
// 成员列表写留在路由层（messaging.ts）。
import type { GatewayState } from '../state.js';
import {
  activeSwitch,
  randomBetween,
  readBooleanParam,
  readNumberParam,
  type SwitchTarget,
} from '../switches.js';

/** kick 响应延迟的契约区间（REQ §2.1「1–5s」，QR §1） */
export const KICK_LATENCY_MIN_MS = 1000;
export const KICK_LATENCY_MAX_MS = 5000;

/** gw-25 `owner_left_on_kick`：强制 409 OWNER_LEFT（与自然「群主已退」同码） */
export function isOwnerLeftOnKick(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'owner_left_on_kick', target) !== undefined;
}

/** gw-25 `kick_no_permission`：强制 403 NO_PERMISSION（与自然「非群主未 promote」同码） */
export function isKickNoPermission(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'kick_no_permission', target) !== undefined;
}

/** gw-24 `kick_504`：命中即回 504 NETWORK_TIMEOUT（结果未知） */
export function kick504Config(state: GatewayState, target: SwitchTarget) {
  return activeSwitch(state, 'kick_504', target);
}

/**
 * gw-24 响应延迟：kick_slow 钉值优先；kick_504 也可自带钉值（504 同样可能慢回）；
 * 都未钉 → 契约区间 1–5s 随机。
 */
export function resolveKickDelayMs(
  state: GatewayState,
  target: SwitchTarget,
  timeoutConfig = kick504Config(state, target),
): number {
  return (
    readNumberParam(activeSwitch(state, 'kick_slow', target), 'delayMs') ??
    readNumberParam(timeoutConfig, 'delayMs') ??
    randomBetween(KICK_LATENCY_MIN_MS, KICK_LATENCY_MAX_MS)
  );
}

/**
 * 504 后成员列表收敛真值（DES/14 §3：「收敛=无论响应如何，2s 后成员列表反映真值」；
 * kicked 独立可配——与响应解耦是后端判定路径的测试根基）。非 504 分支恒真。
 */
export function resolveKickConvergedKicked(timeoutConfig: ReturnType<typeof kick504Config>): boolean {
  if (timeoutConfig === undefined) return true;
  return readBooleanParam(timeoutConfig, 'kicked', true);
}
