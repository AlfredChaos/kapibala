// 自有 API 的错误码、统一错误响应形状，以及对外暴露的状态机联合类型。
// 码表来源：QR §4 全表（13）+ 设计值（JOB_NOT_FOUND / LEAVE_FAILED / GROUP_NOT_FOUND / GROUP_UNREACHABLE / INTERNAL）。
// 状态联合来源：REQ §2.3 各行 + design/02-data-model.md 的 CHECK 约束（逐字）。
import type { GatewayErrorCode } from './gateway-errors.js';

// ---------- 错误码 ----------

export const API_ERROR_CODES = [
  // QR §4 全表
  'UNAUTHORIZED', // 401
  'FORBIDDEN', // 403（viewer 写操作）
  'VALIDATION_ERROR', // 400
  'ACCOUNT_NOT_FOUND', // 404
  'ILLEGAL_TRANSITION', // 409
  'CAS_CONFLICT', // 409
  'ACCOUNT_NOT_IN_GROUP', // 409
  'ACCOUNT_UNAVAILABLE', // 409
  'SEQUENCE_ALREADY_RUNNING', // 409
  'UNRESOLVED_PLACEHOLDER', // 422（带 stepIndex / key）
  'ACCOUNT_NOT_ONLINE', // 422
  'JOIN_TIMEOUT', // job error（member_joined 10s 未到）
  'TOOLS_INVALID', // 400（对 Agent 服务的请求）
  // 设计值（不在 QR §4 表内，设计文档补充）
  'JOB_NOT_FOUND',
  'AGENT_RUN_NOT_FOUND', // 404（T-P4-13 查询端点设计值，同 JOB_NOT_FOUND 先例）
  'LEAVE_FAILED',
  'GROUP_NOT_FOUND',
  'GROUP_UNREACHABLE',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * 统一错误体（REQ §2.3 字段约定）：`{ error: { code, message, requestId, ...业务字段 } }`。
 * `...业务字段` 里当前已知的只有 UNRESOLVED_PLACEHOLDER 的 stepIndex / key（REQ §2.3）。
 */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  requestId: string;
  /** 仅 UNRESOLVED_PLACEHOLDER（REQ §2.3：定位到出错步骤） */
  stepIndex?: number;
  /** 仅 UNRESOLVED_PLACEHOLDER：解析不了的占位符名 */
  key?: string;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

// ---------- 状态机联合（design/02 CHECK 约束逐字；QR §6 一览） ----------

/** 账号状态机（design/02 §2 account.status CHECK；终态 = suspended / session_expired） */
export type AccountStatus =
  | 'idle'
  | 'online'
  | 'rate_limited'
  | 'disconnected'
  | 'suspended'
  | 'session_expired';

export type AccountTerminalStatus = 'suspended' | 'session_expired';

/** 操作台用户角色（design/02 §2 app_user.role CHECK；viewer 写操作 403） */
export type AppUserRole = 'admin' | 'viewer';

/** 群状态（design/02 §3 `group`.status CHECK；leave-all 完成 → left 且 members=[]） */
export type GroupStatus = 'active' | 'unreachable' | 'left';

/** 群内服务账号角色（design/02 §3 group_member.role CHECK；REQ §2.3 groups 行） */
export type GroupMemberRole = 'creator' | 'admin' | 'member';

/**
 * 消息投递状态（REQ §2.3 messages 行；design/02 §5 CHECK）：
 * 仅对自己发的消息有意义；unknown 5s 内落定，重发至多一次（QR §6）。
 */
export type MessageDeliveryStatus =
  | 'queued'
  | 'accepted'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/**
 * 失败/取消码（QR §5）：网关错误码，或 ACCOUNT_TERMINAL（终态取消排队）/ GROUP_UNREACHABLE。
 * failed / cancelled 时必填。
 */
export type MessageFailCode = GatewayErrorCode | 'ACCOUNT_TERMINAL' | 'GROUP_UNREACHABLE';

/** agent run 状态（design/02 §6 CHECK；REQ §2.3 agent-runs 行） */
export type AgentRunStatus = 'running' | 'finished' | 'failed' | 'blocked' | 'cancelled';

/** endReason 仅 status ≠ running 时有值（REQ §2.3；无值恒 null——宪法 §3-6） */
export type AgentRunEndReason =
  | 'final'
  | 'budget_exhausted'
  | 'wall_clock'
  | 'protocol_errors'
  | 'audit_blocked'
  | 'cancelled';

/** 步骤 kind（design/02 §6 agent_run_step.kind CHECK；协议错误步 toolUseId/name/input 为 null） */
export type AgentRunStepKind = 'tool_use' | 'final' | 'protocol_error';

/** 审计结论（design/02 §6 audit_verdict CHECK；unresolved = 审计最终未能给出结论） */
export type AuditVerdict = 'pass' | 'fail' | 'unresolved';

/** 序列 run 状态（design/02 §7 CHECK；stopped = 群 unreachable） */
export type SequenceRunStatus = 'running' | 'finished' | 'failed' | 'stopped';

/** 序列步骤状态（design/02 §7 CHECK；skipped 视为在跳过时刻「发出」） */
export type SequenceStepStatus = 'pending' | 'accepted' | 'sent' | 'skipped' | 'failed';

/** job 状态（design/02 §4 CHECK；errors 非空即 failed） */
export type JobStatus = 'running' | 'finished' | 'failed';

/** job 类型（design/02 §4 CHECK） */
export type JobType = 'create_group' | 'leave_all';

/**
 * job 错误的 step 名（REQ §2.3 jobs 行）：`create | invite | join:<accountId> | promote | leave:<accountId>`。
 * 联合类型只收 base 名，带 id 的复合形式由消费方拼字符串（本包不持有账号 id 集合）。
 */
export type JobStepName = 'create' | 'invite' | 'join' | 'promote' | 'leave';

/** job errors 数组元素（REQ §2.3） */
export interface JobError {
  step: string;
  code: string;
}
