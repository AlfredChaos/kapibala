// 形状锁定测试（T-P0-02 c 项）：类型存在性 / 穷尽性编译断言 + 常量数组的运行时断言。
// 期望值全部逐字取自出处：QR §3 / QR §4 / REQ §2.2 —— 改契约必须先改文档，再改这里。
import { describe, expect, it } from 'vitest';
import {
  AGENT_ERROR_CODES,
  AGENT_TOOLS,
  API_ERROR_CODES,
  GATEWAY_ERROR_CODES,
  GATEWAY_EVENT_TYPES,
  type AgentErrorCode,
  type ApiErrorCode,
  type GatewayErrorCode,
  type MessageDeliveryStatus,
  type WsEventFrame,
} from '../index.js';

// ---------- 编译期穷尽性断言（少一个 key 或多一个 key 都无法编译） ----------

// QR §3 的 13 个 agent 工具错误码（REQ §2.2 逐字）
const _agentCodesExact: Record<AgentErrorCode, true> = {
  UNKNOWN_TOOL: true,
  INVALID_INPUT: true,
  DUPLICATE_TOOL_USE_ID: true,
  BAD_JSON: true,
  TURN_TIMEOUT: true,
  AUDIT_REJECTED: true,
  POLICY_DENIED: true,
  SEND_TIMEOUT: true,
  SEND_FAILED: true,
  NO_AVAILABLE_ACCOUNT: true,
  GROUP_UNREACHABLE: true,
  OWNER_LEFT: true,
  NO_PERMISSION: true,
};

// QR §4 全表 13 码 + 设计值 5 码（JOB_NOT_FOUND/LEAVE_FAILED/GROUP_NOT_FOUND/GROUP_UNREACHABLE/INTERNAL）
const _apiCodesExact: Record<ApiErrorCode, true> = {
  UNAUTHORIZED: true,
  FORBIDDEN: true,
  VALIDATION_ERROR: true,
  ACCOUNT_NOT_FOUND: true,
  ILLEGAL_TRANSITION: true,
  CAS_CONFLICT: true,
  ACCOUNT_NOT_IN_GROUP: true,
  ACCOUNT_UNAVAILABLE: true,
  SEQUENCE_ALREADY_RUNNING: true,
  UNRESOLVED_PLACEHOLDER: true,
  ACCOUNT_NOT_ONLINE: true,
  JOIN_TIMEOUT: true,
  TOOLS_INVALID: true,
  JOB_NOT_FOUND: true,
  LEAVE_FAILED: true,
  GROUP_NOT_FOUND: true,
  GROUP_UNREACHABLE: true,
  AGENT_RUN_NOT_FOUND: true, // 404（T-P4-13 设计值）
  SEQUENCE_RUN_NOT_FOUND: true, // 404（T-P6-05 设计值）
  INTERNAL: true,
};

// QR §2 的 13 个网关错误码（429/403/401/409/504/410 同步错误 + kick/leave 语义码）
const _gatewayCodesExact: Record<GatewayErrorCode, true> = {
  RATE_LIMITED: true,
  ACCOUNT_SUSPENDED: true,
  SESSION_EXPIRED: true,
  GROUP_WRITE_FORBIDDEN: true,
  SENDER_NOT_IN_GROUP: true,
  ACCOUNT_OFFLINE: true,
  NETWORK_TIMEOUT: true,
  INVITE_NOT_READY: true,
  INVITE_EXPIRED: true,
  ALREADY_MEMBER: true,
  NOT_MEMBER_YET: true,
  OWNER_LEFT: true,
  NO_PERMISSION: true,
};

// REQ §2.3 六类 WS 事件 + DES/08 §2.3 扩展（group_updated / job）
const _wsEventTypesExact: Record<WsEventFrame['type'], true> = {
  account_status_changed: true,
  account_terminal: true,
  inconsistency: true,
  message: true,
  agent_run: true,
  sequence_run: true,
  group_updated: true,
  job: true,
};

// 消息投递状态（REQ §2.3 messages 行，六值）
const _deliveryStatusExact: Record<MessageDeliveryStatus, true> = {
  queued: true,
  accepted: true,
  sent: true,
  failed: true,
  unknown: true,
  cancelled: true,
};

// ---------- 运行时断言 ----------

describe('agent protocol error codes (QR §3, REQ §2.2)', () => {
  it('is exactly the 13 contract codes, verbatim set', () => {
    expect([...AGENT_ERROR_CODES].sort()).toEqual(Object.keys(_agentCodesExact).sort());
    expect(AGENT_ERROR_CODES).toHaveLength(13);
  });
});

describe('own API error codes (QR §4 + design values)', () => {
  it('covers the full QR §4 table plus the 7 design values, nothing else', () => {
    expect([...API_ERROR_CODES].sort()).toEqual(Object.keys(_apiCodesExact).sort());
    expect(API_ERROR_CODES).toHaveLength(20);
  });
});

describe('gateway error codes and event types (QR §2, REQ §2.1)', () => {
  it('is exactly the 13 gateway codes', () => {
    expect([...GATEWAY_ERROR_CODES].sort()).toEqual(Object.keys(_gatewayCodesExact).sort());
    expect(GATEWAY_ERROR_CODES).toHaveLength(13);
  });

  it('event types are exactly the six contract types (REQ §2.1 SSE)', () => {
    expect([...GATEWAY_EVENT_TYPES].sort()).toEqual(
      ['account_status', 'member_joined', 'member_left', 'message', 'message_failed', 'message_sent'].sort(),
    );
  });
});

describe('agent tool definitions (REQ §2.2 tools table)', () => {
  it('has exactly the 4 fixed tools', () => {
    expect(AGENT_TOOLS).toHaveLength(4);
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(
      ['finish', 'get_recent_messages', 'kick_user', 'send_message'].sort(),
    );
  });

  it('input_schema.required covers every property (else TOOLS_INVALID per REQ §2.2)', () => {
    for (const tool of AGENT_TOOLS) {
      const schema = tool.input_schema;
      expect(schema.type).toBe('object');
      const props = Object.keys(schema.properties ?? {});
      const required = schema.required ?? [];
      expect([...required].sort()).toEqual([...props].sort());
    }
  });
});
