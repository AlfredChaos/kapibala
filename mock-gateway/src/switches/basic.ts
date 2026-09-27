// S1/S2 驱动开关 gw-1/2/3 的语义归宿（T-P1-05）。
// 契约出处：DES/14 §5 开关表行 1/2/3（开关名逐字照抄，不自创）、§3 时序引擎（默认区间随机、
// scenario 可钉死为定值）、§4（同一开关重复调用 = 覆盖参数——覆盖语义由 state.switches.set 天然成立）。
// 红线（宪法 §3-8）：这里的钉值与双推是 S1/S2 的验收驱动，禁止为了让测试变绿而弱化。
import type { FrameDelivery, FrameSink } from '../sse.js';
import type { GatewayState, LedgerFrame } from '../state.js';
import { activeSwitch, randomBetween, readNumberParam, type SwitchTarget } from '../switches.js';

// —— 契约时序区间（QR §1 / REQ §2.1）：mock 自持，不依赖 server 的 constants.ts ——
/** gw-1：send 的 202 本身可能 1–2s（REQ §2.1） */
const SEND_ACCEPT_MIN_MS = 1000;
const SEND_ACCEPT_MAX_MS = 2000;
/** gw-2：message_sent 通常 50–2000ms 后到达（REQ §2.1；QR §1） */
const MESSAGE_SENT_MIN_MS = 50;
const MESSAGE_SENT_MAX_MS = 2000;

/**
 * gw-1 `send_accept_slow`：send 的 202 延迟（DES/14 §5 行 1）。
 * 钉值（`params.delayMs`，可为 0）优先于契约区间随机——钉 0 即「202 立回」，
 * 用于把 gw-2 的落地时刻单独观测出来（S1 编排：两段延迟各自钉死）。
 */
export function resolveSendAcceptDelayMs(state: GatewayState, target: SwitchTarget): number {
  return (
    readNumberParam(activeSwitch(state, 'send_accept_slow', target), 'delayMs') ??
    randomBetween(SEND_ACCEPT_MIN_MS, SEND_ACCEPT_MAX_MS)
  );
}

/**
 * gw-2 `message_sent_delay`：message_sent 的推送延迟（DES/14 §5 行 2）。
 * 计时起点是 202 之后（两段独立计时，DES/14 §3），钉值优先于 50–2000ms 区间随机。
 */
export function resolveMessageSentDelayMs(state: GatewayState, target: SwitchTarget): number {
  return (
    readNumberParam(activeSwitch(state, 'message_sent_delay', target), 'delayMs') ??
    randomBetween(MESSAGE_SENT_MIN_MS, MESSAGE_SENT_MAX_MS)
  );
}

/**
 * gw-3 `dup_push_all`：**每个事件帧投递两次**（DES/14 §5 行 3）。
 * 双推是投递层复制，不是造两条事件——账本仍只有一行、eventId 不重复分配、
 * `framesEmitted`（账本产出计数）不增；server 侧靠 `gateway_event` PK / `(groupId,msgId)` 唯一 /
 * agent 触发幂等吸收（S2 的后端防御分支）。
 * 开关在每次投帧时读取：连接建立后再打开/关闭都即时生效（arrange 顺序无关）。
 * 全局开关（不按 target 收窄）：契约措辞是「每个事件推两次」。
 * 位于投递链**内层**（最贴近 socket）：gw-4 先定序、本层再复制，双推的两份因此始终相邻。
 */
export function createDupDelivery(state: GatewayState, sink: FrameSink): FrameDelivery {
  return {
    push: (frame: LedgerFrame): void => {
      sink(frame);
      if (activeSwitch(state, 'dup_push_all') !== undefined) {
        sink(frame); // 同一帧再投一次（同 eventId、同 data；at-least-once 的极端形态）
      }
    },
  };
}
