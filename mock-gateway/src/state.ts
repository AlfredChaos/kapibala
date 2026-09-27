// 内存状态模型（DES/14 §2 全表）+ 事件账本 + eventId 分配器。
// 无 DB、无持久化：`/_test/reset` 一键清空（DES/14 §1）——mock 的可重置性就是它的测试价值。
import { GATEWAY_EVENT_TYPES, type GatewayEventType } from '@kapibala/contract';

/** 账号域状态（DES/14 §2 account 行）：suspended / sessionExpired 后所有请求回同码（REQ §2.1） */
export interface MockAccountState {
  /** 确定性派生：同 accountId 恒同值（REQ §2.1）；不随 reset 漂移（纯函数） */
  platformUserId: string;
  online: boolean;
  suspended: boolean;
  sessionExpired: boolean;
  /** epoch ms；限流到期时刻（send 域使用，本任务只建字段） */
  rateLimitedUntil?: number;
}

/** invite 链接状态（DES/14 §2 group 行；readyAfterMs / 过期由开关驱动，本任务只建形状） */
export interface MockInvite {
  link: string;
  /** epoch ms，就绪时刻；就绪前 join → 409 INVITE_NOT_READY */
  readyAt: number;
  expireAt?: number;
}

export interface MockGroupState {
  /** 群主的 platformUserId（建群即成员，REQ §2.1） */
  creator: string;
  /** platformUserId 集合；网关视角的当前成员 */
  members: Set<string>;
  /** 解散/禁言开关（开关 14） */
  writeForbidden: boolean;
  invite?: MockInvite;
}

/** 单条落地消息（DES/14 §2 message 行）：网关不按 clientMsgId 去重，同 id 多条各占一项 */
export interface MockMessageRecord {
  groupId: string;
  senderPuid: string;
  msgId: string;
  text: string;
  /** ISO 8601 UTC（宪法 §3-6） */
  sentAt: string;
  landed: boolean;
}

/**
 * 账本帧（DES/14 §2 账本行）：append-only；每条推送给任何消费者的帧都先入账本。
 * data 里同时带 eventId 与 type（REQ §2.1 SSE 契约），故 data 类型 = 契约事件形状。
 */
export interface LedgerFrame {
  eventId: number;
  type: GatewayEventType;
  data: {
    eventId: number;
    type: GatewayEventType;
    [field: string]: unknown;
  };
  /** epoch ms，仅 mock 内部观测用 */
  emittedAt: number;
}

/** 开关状态：switch → 配置；同一开关重复调用 = 覆盖参数（DES/14 §4） */
export interface SwitchConfig {
  params?: Record<string, unknown>;
  target?: Record<string, unknown>;
}

/** 验收断言真值来源（DES/14 §4 counters 行；增量接线随各域任务落地） */
export interface GatewayCounters {
  /** S4：限流期内 = 0 */
  sendCallsByAccount: Map<string, number>;
  /** S5：恰好 1 */
  sendCallsByClientMsgId: Map<string, number>;
  /** S8：0 */
  landedMessages: number;
  kickCalls: number;
  framesEmitted: number;
}

export interface GatewayState {
  accounts: Map<string, MockAccountState>;
  groups: Map<string, MockGroupState>;
  /** clientMsgId → 有序落地列表（落地序） */
  messages: Map<string, MockMessageRecord[]>;
  ledger: LedgerFrame[];
  /**
   * eventId 分配器：进程生命周期单调、跨 reset 不复用（DES/14 §1 关键坑）。
   * 回退会让新事件携带小 id，与 server 侧 gateway_event PK / 连续前缀游标相撞，
   * 测试静默失真——所以 reset 只能抬高（startEventId），不能降低。
   */
  eventIdCounter: number;
  /** 自造 id 序列：网关群 `gw-<seq>` / 外部用户 `ext-<seq>`（DES/14 §2 末行） */
  gwSeq: number;
  extSeq: number;
  msgSeq: number;
  counters: GatewayCounters;
  /**
   * 账本订阅者（SSE 推送器注册；T-P1-02）。「先入账后投递」的投帧 seam：
   * appendLedger 在帧落账之后才逐个通知——订阅侧永远看到已提交的账（DES/14 §1）。
   * 属传输层而非业务状态：reset 不清（连接不断，账本内容清空）。
   */
  ledgerListeners: Set<(frame: LedgerFrame) => void>;
  /** 创建时的种子清单：reset 恢复到此全集（DES/14 §6 GATEWAY_SEED_ACCOUNTS） */
  seedAccountIds: readonly string[];
  switches: Map<string, SwitchConfig>;
}

/** 默认种子账号（DES/14 §6：与 server seed 对齐） */
export const DEFAULT_SEED_ACCOUNTS: readonly string[] = ['acc-01', 'acc-02', 'acc-03', 'acc-04'];

/** FNV-1a 32 位：无依赖的确定性派生，同 accountId 恒同 platformUserId（REQ §2.1） */
export function derivePlatformUserId(accountId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < accountId.length; i++) {
    hash ^= accountId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `puid-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function freshAccount(accountId: string): MockAccountState {
  return {
    platformUserId: derivePlatformUserId(accountId),
    online: false,
    suspended: false,
    sessionExpired: false,
  };
}

/** 新建状态：种子账号全部初始 offline（REQ §2.1 账号由我方预置、初始未连接） */
export function createGatewayState(seedAccountIds: readonly string[] = DEFAULT_SEED_ACCOUNTS): GatewayState {
  const accounts = new Map<string, MockAccountState>();
  for (const id of seedAccountIds) {
    accounts.set(id, freshAccount(id));
  }
  return {
    accounts,
    groups: new Map(),
    messages: new Map(),
    ledger: [],
    eventIdCounter: 0,
    gwSeq: 0,
    extSeq: 0,
    msgSeq: 0,
    counters: {
      sendCallsByAccount: new Map(),
      sendCallsByClientMsgId: new Map(),
      landedMessages: 0,
      kickCalls: 0,
      framesEmitted: 0,
    },
    seedAccountIds,
    switches: new Map(),
    ledgerListeners: new Set(),
  };
}

/**
 * `/_test/reset` 语义（DES/14 §1/§4）：清空业务状态 + 账本 + 计数器，恢复种子账号；
 * eventId 计数器**不回退**，`startEventId` 只抬高（取 max）。
 * 开关（switches）是 arrange 配置而非业务状态，归 `/_test/scenario/clear` 管——reset 不动它。
 */
export function resetGatewayState(state: GatewayState, startEventId?: number): number {
  state.accounts.clear();
  for (const id of state.seedAccountIds) {
    state.accounts.set(id, freshAccount(id));
  }
  state.groups.clear();
  state.messages.clear();
  state.ledger = [];
  state.counters.sendCallsByAccount.clear();
  state.counters.sendCallsByClientMsgId.clear();
  state.counters.landedMessages = 0;
  state.counters.kickCalls = 0;
  state.counters.framesEmitted = 0;
  if (startEventId !== undefined && startEventId > state.eventIdCounter) {
    state.eventIdCounter = startEventId;
  }
  return state.eventIdCounter;
}

/**
 * 账本追加（append-only）：分配 eventId、入账、计数。
 * SSE 推送器（T-P1-02）从这里回放；本函数是「帧产生」的唯一入口（含 /_test/emit）。
 */
export function appendLedger(
  state: GatewayState,
  type: GatewayEventType,
  data: Record<string, unknown>,
): LedgerFrame {
  const eventId = ++state.eventIdCounter;
  const frame: LedgerFrame = {
    eventId,
    type,
    data: { ...data, eventId, type },
    emittedAt: Date.now(),
  };
  state.ledger.push(frame);
  // 先入账后投递（DES/14 §1）：订阅者在帧已落账后才被通知；订阅者异常不阻断账本（无静默丢帧的另一半）
  for (const listener of state.ledgerListeners) {
    listener(frame);
  }
  state.counters.framesEmitted += 1;
  return frame;
}

/** 是否契约六类事件之一（/_test/emit 的入参校验用） */
export function isGatewayEventType(value: unknown): value is GatewayEventType {
  return typeof value === 'string' && (GATEWAY_EVENT_TYPES as readonly string[]).includes(value);
}

/** 保证账号条目存在（connect 首见账号时自建；puid 派生确定，不依赖预置清单） */
export function ensureAccount(state: GatewayState, accountId: string): MockAccountState {
  const existing = state.accounts.get(accountId);
  if (existing) {
    return existing;
  }
  const created = freshAccount(accountId);
  state.accounts.set(accountId, created);
  return created;
}
