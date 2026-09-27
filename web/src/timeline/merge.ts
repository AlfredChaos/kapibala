// 时间线合并纯函数（T-P5-05；DES/15 §5 逐字、DES/05 §5.2 两通道职责分离、REQ A4）。
// 契约逐字：
// - items: Map<行键, Row>；行键 = msgId ?? clientMsgId（queued 阶段 msgId=null 用 clientMsgId；
//   msgId 回填后行键迁到 msgId——「沿用同一行、原地更新键值、不插入新行」：Map 保序重建
//   同位替换，行位置不动）；
// - WS message 事件：按 msgId ?? clientMsgId 定位 → 原地 patch（deliveryStatus 只前进不倒退、
//   sentAt 等字段照常更新——sentAt 上移的行留在原位仅更新字段，排序以服务端为准不重排）；
// - 查无此键 → unknownKey（事件载荷无 text/sentAt 等完整行字段，不能凭空建行——
//   由调用方重拉首屏窗口；落在更早区间的补投行等翻页自然出现，DES/05 §5.2(b)）；
// - 翻页：mergePage 双向——'top'（首屏/顶部重拉：新键按服务端序前置）与 'bottom'
//   （加载更早：新键按序后置）；已存在键一律原地 patch，跨页重复行不产生第二行。
import type { MessageDeliveryStatus } from '@kapibala/contract';
import type { TimelineItem } from '../lib/api-types.js';

/** 时间线行 = 服务端 TimelineItem 形状逐字（DES/05 §5.3） */
export type TimelineRow = TimelineItem;
export type TimelineItems = Map<string, TimelineRow>;

/** WS message 事件载荷（DES/08 §2.3）：msgId 在 queued/accepted 阶段可 null */
export interface TimelineEventPayload {
  readonly groupId: string;
  readonly msgId: string | null;
  readonly isOwn: boolean;
  readonly clientMsgId?: string;
  readonly deliveryStatus?: MessageDeliveryStatus;
}

/** 行键：msgId ?? clientMsgId（§5 逐字）；两者皆空 = 不可定位行（返回 null 丢弃） */
export function rowKeyOf(x: { msgId: string | null; clientMsgId?: string | null }): string | null {
  return x.msgId ?? x.clientMsgId ?? null;
}

/**
 * deliveryStatus 前进秩（§5「只前进不倒退」+ §6 表「unknown→sent 更新」）：
 * queued < accepted < unknown < sent < failed/cancelled。
 * unknown 语义 =「受理后发往网关结果未知」——accepted→unknown 允许（确定回退为存疑是前进方向）；
 * unknown→sent/failed 允许（存疑被消解为定论）；定论态之间互不倒退（sent→failed 不可能发生）。
 */
const DELIVERY_RANK: Record<MessageDeliveryStatus, number> = {
  queued: 0,
  accepted: 1,
  unknown: 2,
  sent: 3,
  failed: 4,
  cancelled: 4,
};

/** 只前进不倒退；from 为空（入站/非 own 行无 deliveryStatus）→ 任何值都算前进 */
export function canAdvanceDelivery(from: string | null | undefined, to: string): boolean {
  if (from === null || from === undefined) return true;
  const a = DELIVERY_RANK[from as MessageDeliveryStatus];
  const b = DELIVERY_RANK[to as MessageDeliveryStatus];
  if (b === undefined) return false; // 未认识新值 → 不推进（防御：拒绝未知状态写入）
  if (a === undefined) return true; // 未认识旧值 → 放行新值（防御）
  return b > a;
}

export interface MergeResult {
  readonly items: TimelineItems;
  /** 是否有行被改/键迁移/新键插入（渲染优化 + 测试断言点） */
  readonly changed: boolean;
  /** true = 事件键未命中任何持有行：调用方应重拉首屏窗口（事件载荷不足以建行） */
  readonly unknownKey: boolean;
}

/**
 * mergeTimelineItem（DES/15 §6 测试表逐字签名）。
 * 命中行 → 原地 patch（键迁移时保序重建）；未命中 → 原样返回 + unknownKey=true。
 */
export function mergeTimelineItem(
  items: ReadonlyMap<string, TimelineRow>,
  ev: TimelineEventPayload,
): MergeResult {
  // 定位键：msgId 优先，其次 clientMsgId（两个键都可能命中同一逻辑行——先 msgId 键后 clientMsgId 键）
  const keyByMsg = ev.msgId !== null ? ev.msgId : null;
  const keyByClient = ev.clientMsgId ?? null;
  let hitKey =
    keyByMsg !== null && items.has(keyByMsg)
      ? keyByMsg
      : keyByClient !== null && items.has(keyByClient)
        ? keyByClient
        : null;
  // 键已迁到 msgId 的行仍要能按 clientMsgId 命中（回填后 queued→accepted 事件只带 clientMsgId）
  if (hitKey === null && keyByClient !== null) {
    for (const [k, v] of items) {
      if (v.clientMsgId === keyByClient) {
        hitKey = k;
        break;
      }
    }
  }
  if (hitKey === null) return { items: new Map(items), changed: false, unknownKey: true };

  const existing = items.get(hitKey);
  if (existing === undefined) return { items: new Map(items), changed: false, unknownKey: true };

  // 新行字段：WS 事件只携带 {msgId,isOwn,clientMsgId?,deliveryStatus?}——其余沿用旧值
  const nextStatus =
    ev.deliveryStatus !== undefined &&
    canAdvanceDelivery(existing.deliveryStatus, ev.deliveryStatus)
      ? ev.deliveryStatus
      : existing.deliveryStatus;
  const merged: TimelineRow = {
    ...existing,
    msgId: ev.msgId ?? existing.msgId,
    isOwn: ev.isOwn || existing.isOwn,
    clientMsgId: existing.clientMsgId ?? ev.clientMsgId ?? null,
    deliveryStatus: nextStatus,
    // failCode：status 未到 failed/cancelled 时保留旧值；WS 事件不携带 failCode——
    // 需要 failCode 的行由随后的重拉/翻页补齐（事件是「指针」不是全量行）
  };

  // 行键迁移：hitKey(clientMsgId) → msgId 键。「沿用同一行」= 同位替换，行序不动
  const nextKey = keyByMsg ?? hitKey;
  if (nextKey === hitKey) {
    const next = new Map(items);
    next.set(hitKey, merged);
    return { items: next, changed: true, unknownKey: false };
  }
  const next: TimelineItems = new Map();
  for (const [k, v] of items) {
    next.set(k === hitKey ? nextKey : k, k === hitKey ? merged : v);
  }
  return { items: next, changed: true, unknownKey: false };
}

export type MergePosition = 'top' | 'bottom';

/**
 * 翻页/首屏合并：page 项按服务端返回序与持有 map 融合——
 * 已存在键原地 patch；新键 'top' 前置（保序）、'bottom' 后置（保序）。
 * 跨页重复（翻页边界/重拉与 WS 交叠）由行键去重：不产生第二行、不丢字段更新。
 */
export function mergeTimelinePage(
  items: ReadonlyMap<string, TimelineRow>,
  page: readonly TimelineRow[],
  position: MergePosition,
): TimelineItems {
  // 先 patch 已存在键（原地）
  const next: TimelineItems = new Map(items);
  const fresh: Array<[string, TimelineRow]> = [];
  for (const row of page) {
    const key = rowKeyOf(row);
    if (key === null) continue;
    if (next.has(key)) {
      const prev = next.get(key);
      if (prev !== undefined) {
        next.set(key, {
          ...row,
          // 防御：服务端行是全量真值；仅当新值非空且回退时才守住旧值（快照竞态不倒退）
          deliveryStatus:
            row.deliveryStatus !== null &&
            !canAdvanceDelivery(prev.deliveryStatus, row.deliveryStatus)
              ? prev.deliveryStatus
              : row.deliveryStatus,
        });
      }
    } else {
      fresh.push([key, row]);
    }
  }
  if (fresh.length === 0) return next;
  // 'top'：新键块按序插到最前（首屏上方新消息）；'bottom'：追加到尾部（更早页）
  const merged: TimelineItems = new Map();
  if (position === 'top') {
    for (const [k, v] of fresh) merged.set(k, v);
    for (const [k, v] of next) merged.set(k, v);
  } else {
    for (const [k, v] of next) merged.set(k, v);
    for (const [k, v] of fresh) merged.set(k, v);
  }
  return merged;
}
