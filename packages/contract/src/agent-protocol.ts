// Agent 服务协议形状（REQ §2.2 逐字；DES/12 §2 的「workspace 共享类型」框）。
// server 的 agentclient 与 mock-agent 的两个 provider 共用本文件，
// 「一个块 / stop_reason 与块类型一致 / tool_result 在 user 消息」在编译期锁定（DES/06 §12 风险 1）。
// 注意：本包零契约数字（任务卡 d 项）——limit 上限、截断字数等数值常量只在 server/src/constants.ts。
import type { MessageDeliveryStatus } from './api-errors.js';

/** 会话角色：tool_result 只出现在 `user` 消息里（REQ §2.2） */
export type AgentMessageRole = 'user' | 'assistant';

/** stop_reason 与块类型一致：tool_use ↔ tool_use 块；end_turn ↔ text 块（REQ §2.2） */
export type StopReason = 'tool_use' | 'end_turn';

export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * 工具调用块。`name` 故意放宽为 string：Agent 服务可能调用不在 tools 里的
 * 未知工具（REQ §2.2「Agent 服务可能出现的行为」），那要按 UNKNOWN_TOOL 处理，
 * 不能在类型层吞掉。`input` 形状由各工具的 input 约束类型单独描述。
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** tool_result 块；`is_error` 可省略，省略视为 false（REQ §2.2） */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface AgentMessage {
  role: AgentMessageRole;
  content: ContentBlock[];
}

// ---------- JSON Schema（tools[].input_schema） ----------

/**
 * 最小结构化 JSON Schema 形状：只描述我们要编程访问的关键字，
 * 其余关键字原样透传（索引签名）。required 必须覆盖全部入参（REQ §2.2，否则 400 TOOLS_INVALID）。
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  description?: string;
  readonly [keyword: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

// ---------- 固定的 4 个工具（REQ §2.2 工具表） ----------

export const AGENT_TOOL_NAMES = [
  'get_recent_messages',
  'send_message',
  'kick_user',
  'finish',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface GetRecentMessagesInput {
  limit: number;
}

export interface SendMessageInput {
  text: string;
  idempotency_key: string;
}

export interface KickUserInput {
  platform_user_id: string;
  reason: string;
}

export interface FinishInput {
  summary: string;
}

/**
 * 我方发给 /agent/turn 的 tools 数组（REQ §2.2：必须恰好是这 4 个）。
 * schema 只锁形状与 required 全覆盖；数值界限（limit 上限等）不进本包。
 */
export const AGENT_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_recent_messages',
    description: 'Fetch recent group messages in ascending sentAt order.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max number of messages to fetch.' } },
      required: ['limit'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a text message to the group as the service account.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send.' },
        idempotency_key: { type: 'string', description: 'Idempotency key; reuse retries the same send.' },
      },
      required: ['text', 'idempotency_key'],
    },
  },
  {
    name: 'kick_user',
    description: 'Kick a member out of the group.',
    input_schema: {
      type: 'object',
      properties: {
        platform_user_id: { type: 'string', description: 'Platform user id of the member to kick.' },
        reason: { type: 'string', description: 'Human-readable reason for the kick.' },
      },
      required: ['platform_user_id', 'reason'],
    },
  },
  {
    name: 'finish',
    description: 'End the run with a summary; no further turns will be requested.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Final summary stored on the run.' } },
      required: ['summary'],
    },
  },
] as const;

// ---------- 错误 tool_result（REQ §2.2 码表 = QR §3，13 个） ----------

export const AGENT_ERROR_CODES = [
  'UNKNOWN_TOOL',
  'INVALID_INPUT',
  'DUPLICATE_TOOL_USE_ID',
  'BAD_JSON',
  'TURN_TIMEOUT',
  'AUDIT_REJECTED',
  'POLICY_DENIED',
  'SEND_TIMEOUT',
  'SEND_FAILED',
  'NO_AVAILABLE_ACCOUNT',
  'GROUP_UNREACHABLE',
  'OWNER_LEFT',
  'NO_PERMISSION',
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/** 错误 tool_result 的 content（JSON 串的反序列化形状）；hint 可选（REQ §2.2） */
export interface AgentToolErrorContent {
  code: AgentErrorCode;
  message: string;
  hint?: string;
}

// ---------- 请求 / 响应 ----------

export interface TurnRequest {
  /** 我方生成，与 GET /api/agent-runs/:id 的 id 相同；同 run 必须同 runId（REQ §2.2） */
  runId: string;
  tools: readonly ToolDefinition[];
  messages: readonly AgentMessage[];
}

/**
 * 合法响应每轮**恰好一个块**（REQ §2.2）——用单元组类型把「块数 = 1」锁进编译期。
 * stop_reason 与块类型的一致性由消费方校验（BAD_JSON 分支）。
 */
export interface TurnResponse {
  stop_reason: StopReason;
  content: [ContentBlock];
}

export interface AuditRequest {
  text: string;
  groupId: string;
}

export interface AuditResponse {
  verdict: 'pass' | 'fail';
  reason: string;
}

// ---------- 触发上下文（messages[0] 的 text，JSON 串；REQ §2.2） ----------

export interface TriggerMessage {
  msgId: string;
  senderPlatformUserId: string;
  text: string;
  /** ISO 8601 UTC 字符串（宪法 §3-6）；triggerMessages 按 sentAt 升序 */
  sentAt: string;
}

export interface AgentTriggerContext {
  groupId: string;
  /** 按 sentAt 升序（REQ §2.2） */
  triggerMessages: readonly TriggerMessage[];
  policy: { autoKickEnabled: boolean };
  ownPlatformUserIds: readonly string[];
}

// ---------- 工具成功结果（tool_result content 的 JSON 串反序列化形状；REQ §2.2 工具表） ----------

export interface RecentMessageItem {
  msgId: string;
  senderPlatformUserId: string;
  isOwn: boolean;
  text: string;
  sentAt: string;
}

export interface GetRecentMessagesResult {
  /** 按 sentAt 升序，含触发消息本身与 run 期间新到的消息（REQ §2.2） */
  messages: readonly RecentMessageItem[];
  truncated: boolean;
}

export interface SendMessageResult {
  clientMsgId: string;
  deliveryStatus: MessageDeliveryStatus;
}

export interface KickUserResult {
  kicked: true;
}

export interface FinishResult {
  ok: true;
}
