// 网关（外部消息服务）错误码与 SSE 事件形状。
// 码表来源：REQ §2.1 同步错误 + QR §2 全表；事件 payload 来源：REQ §2.1 事件流一节。
// 本包零契约数字（任务卡 d 项）：retryAfterSeconds / readyAfterMs 是「值字段」，
// 只声明类型不声明数值；具体数字由 mock 场景与 server 常量持有。

// ---------- 错误码 ----------

/** 网关带名字的错误码（HTTP 状态仅是伴随信息，分类以 code 为准——DES/01 §6.5） */
export const GATEWAY_ERROR_CODES = [
  'RATE_LIMITED', // 429，带 retryAfterSeconds（REQ §2.1）
  'ACCOUNT_SUSPENDED', // 403，终态（REQ §2.1）
  'SESSION_EXPIRED', // 401，终态（REQ §2.1）
  'GROUP_WRITE_FORBIDDEN', // 403，群不可写（REQ §2.1）
  'SENDER_NOT_IN_GROUP', // 403（REQ §2.1）
  'ACCOUNT_OFFLINE', // 409（REQ §2.1）
  'NETWORK_TIMEOUT', // 504，结果未知（REQ §2.1 send / kick）
  'INVITE_NOT_READY', // 409，带 readyAfterMs（QR §2）
  'INVITE_EXPIRED', // 410，重申链接重试一次（QR §2）
  'ALREADY_MEMBER', // 409，视为成功直接 promote（QR §2）
  'NOT_MEMBER_YET', // 409，promote ≤2 次（QR §2）
  'OWNER_LEFT', // 409，kick 语义（REQ §2.1）
  'NO_PERMISSION', // 403，promote/kick 语义（REQ §2.1）
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/**
 * 传输层类别（无业务错误码的 HTTP 失败，DES/01 §6.5 分类）：
 * - 503 任何端点 → `UNAVAILABLE`（整体不可用、可重试类；by-client-id 不可用期间保持 unknown）
 * - 裸 500（如 leave 没退成，QR §2）→ `INTERNAL`
 */
export type GatewayTransportCode = 'UNAVAILABLE' | 'INTERNAL';

export type GatewayAnyErrorCode = GatewayErrorCode | GatewayTransportCode;

/** 网关错误响应体（扁平形状，mock 按此返回；字段随错误码出现） */
export interface GatewayErrorBody {
  code: GatewayAnyErrorCode;
  message?: string;
  /** 仅 RATE_LIMITED（REQ §2.1）；期内任何 send 再遇 429 计时重置 */
  retryAfterSeconds?: number;
  /** INVITE_NOT_READY 的等待提示（QR §2「等 readyAfterMs 后重试」；与 invite 响应字段同名） */
  readyAfterMs?: number;
}

// ---------- SSE 事件（GET /events?since=；REQ §2.1 事件流） ----------

export const GATEWAY_EVENT_TYPES = [
  'message',
  'message_sent',
  'message_failed',
  'member_joined',
  'member_left',
  'account_status',
] as const;

export type GatewayEventType = (typeof GATEWAY_EVENT_TYPES)[number];

/** SSE 帧的公共外壳：data 里同时带 eventId 与 type（REQ §2.1） */
export interface GatewayEventBase {
  /** 全局单调递增；since 为独占语义（eventId > since） */
  eventId: number;
}

/** 毫秒精度；同一毫秒可能多条（REQ §2.1）。ISO 8601 UTC 字符串（宪法 §3-6） */
export interface GatewayMessageEvent extends GatewayEventBase {
  type: 'message';
  groupId: string;
  msgId: string;
  senderPlatformUserId: string;
  text: string;
  sentAt: string;
  /** 可选；指向 GET /media/:id，过期后 404（REQ §2.1，C1） */
  mediaUrl?: string;
}

/** 自己发出的消息落地确认；msgId 与回流的 message 事件相同（REQ §2.1） */
export interface GatewayMessageSentEvent extends GatewayEventBase {
  type: 'message_sent';
  clientMsgId: string;
  msgId: string;
  sentAt: string;
}

/** code ∈ GROUP_WRITE_FORBIDDEN | ACCOUNT_SUSPENDED（REQ §2.1，闭集） */
export interface GatewayMessageFailedEvent extends GatewayEventBase {
  type: 'message_failed';
  clientMsgId: string;
  code: 'GROUP_WRITE_FORBIDDEN' | 'ACCOUNT_SUSPENDED';
}

/** 外部用户（非服务账号）进出群也会推（REQ §2.1） */
export interface GatewayMemberJoinedEvent extends GatewayEventBase {
  type: 'member_joined';
  groupId: string;
  platformUserId: string;
}

export interface GatewayMemberLeftEvent extends GatewayEventBase {
  type: 'member_left';
  groupId: string;
  platformUserId: string;
}

/** 网关主动推的账号终态；随后账号被移出所有群并推 member_left（REQ §2.1） */
export interface GatewayAccountStatusEvent extends GatewayEventBase {
  type: 'account_status';
  accountId: string;
  status: 'suspended' | 'session_expired';
}

export type GatewayEvent =
  | GatewayMessageEvent
  | GatewayMessageSentEvent
  | GatewayMessageFailedEvent
  | GatewayMemberJoinedEvent
  | GatewayMemberLeftEvent
  | GatewayAccountStatusEvent;
