// 时序 / 投递修饰类开关（T-P2-12）：
// - gw-19 `member_joined_delay`：member_joined 的钉值延迟（DES/14 §5 行 19、§3「join → member_joined：
//   100–1500ms，或永不到」；gw-18 `member_joined_never` 的判定留在群域）。REQ §2.1：202 只表示受理，
//   真正入群以随后的 member_joined 事件为准。
// - gw-4 `reorder_1s`：投递层相邻帧交换，模拟「相邻事件乱序 ≤1s」（DES/14 §5 行 4、§3 乱序窗口行）。
import type { FrameDelivery, FrameSink } from '../sse.js';
import type { GatewayState, LedgerFrame } from '../state.js';
import { activeSwitch, randomBetween, readNumberParam, type SwitchTarget } from '../switches.js';

/** join 受理后 member_joined 通常 100–1500ms 到达（REQ §2.1；QR §1）——契约数字，禁止取整/改写 */
const MEMBER_JOINED_DELAY_MIN_MS = 100;
const MEMBER_JOINED_DELAY_MAX_MS = 1500;

/**
 * gw-19 `member_joined_delay`：member_joined 的推送延迟。
 * 钉值（`params.delayMs`，可为 0）优先；未钉则在契约区间内随机（DES/14 §3 默认贴近真实）。
 * 钉值可以落在区间之外（测试用 40ms 保确定性）——mock 按钉值执行，契约区间只是默认行为。
 */
export function resolveMemberJoinedDelayMs(state: GatewayState, target: SwitchTarget): number {
  return (
    readNumberParam(activeSwitch(state, 'member_joined_delay', target), 'delayMs') ??
    randomBetween(MEMBER_JOINED_DELAY_MIN_MS, MEMBER_JOINED_DELAY_MAX_MS)
  );
}

// —— gw-4 reorder_1s（DES/14 §5 行 4：相邻事件乱序 ≤1s，含 message 先于 message_sent）——
/** 契约乱序窗口上界：相邻事件乱序 **≤1s**（REQ §2.1；QR §1）——扣帧时长不得超过它（宪法 §3-2） */
const REORDER_WINDOW_MS = 1000;
/** 默认扣帧时长（mock 内部传输选择，非契约数字）：够同刻产出的相邻帧配上对，又拖不慢用例 */
const DEFAULT_REORDER_HOLD_MS = 200;

/**
 * gw-4：相邻两帧交换投递顺序。
 * 机制：扣住一帧；下一帧到达 → 先写新帧再写旧帧（成对交换）；没有下一帧 → 到 holdMs 冲刷尾帧（**不丢帧**）。
 * 乱序幅度 = 扣帧时长，故 holdMs 夹在 [0, 1s] 契约窗口内（钉值也不能突破窗口——数字不可改写）。
 * 落地消息的 message_sent + message 两帧同刻产出，因此本开关天然复现「message 先于 message_sent」
 * （server 侧 finalizeSent 合并 / 连续前缀游标的驱动场景，DES/05 §4.3、DES/08 §1.3）。
 * 开关在每帧到达时读取：关闭时先按原序冲刷已扣住的帧再直通（关开关不吞帧、不倒序）。
 * 位于投递链外层（gw-3 双推之内层复制之前）：先定序、再复制，双推的两份因此始终相邻。
 */
export function createReorderDelivery(state: GatewayState, sink: FrameSink): FrameDelivery {
  let held: LedgerFrame | undefined;
  let timer: NodeJS.Timeout | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const flushHeld = (): void => {
    clearTimer();
    const frame = held;
    held = undefined;
    if (frame !== undefined) {
      sink(frame);
    }
  };

  return {
    push: (frame: LedgerFrame): void => {
      if (activeSwitch(state, 'reorder_1s') === undefined) {
        flushHeld();
        sink(frame);
        return;
      }
      const previous = held;
      if (previous !== undefined) {
        clearTimer();
        held = undefined;
        sink(frame); // 相邻交换：新帧先写（eventId 更大）
        sink(previous); // 旧帧后写——sink 不做水位过滤，故不会被 `eventId > lastSentEventId` 丢掉
        return;
      }
      held = frame;
      timer = setTimeout(flushHeld, reorderHoldMs(state));
      timer.unref();
    },
    // 连接关闭：socket 已死，尾帧无处可投——只清定时器防泄漏（sse.ts 的 cleanup 调用）
    close: clearTimer,
  };
}

/** 扣帧时长：钉值 `params.holdMs` 夹进契约乱序窗口 [0, 1s]；未钉用 mock 默认 200ms */
function reorderHoldMs(state: GatewayState): number {
  const pinned = readNumberParam(activeSwitch(state, 'reorder_1s'), 'holdMs') ?? DEFAULT_REORDER_HOLD_MS;
  return Math.min(Math.max(pinned, 0), REORDER_WINDOW_MS);
}
