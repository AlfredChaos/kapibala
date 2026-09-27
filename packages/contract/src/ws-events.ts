// WS 网关帧形状（REQ §2.3 WS 行；DES/08 §2.1 连接协议、§2.3 事件类型表）。
// seq 全局单调递增；sinceSeq 补发为独占语义（seq > sinceSeq）——数值常量不进本包（任务卡 d 项）。
import type {
  AccountStatus,
  AccountTerminalStatus,
  AgentRunEndReason,
  AgentRunStatus,
  GroupStatus,
  JobStatus,
  MessageDeliveryStatus,
  SequenceRunStatus,
} from './api-errors.js';

// ---------- 连接协议（REQ §2.3；DES/08 §2.1 时序图） ----------

/** 客户端 → 服务端：连接后第一帧；带 sinceSeq 时从该 seq 之后补发（B4，可选） */
export interface WsAuthRequest {
  type: 'auth';
  accessToken: string;
  sinceSeq?: number;
}

/** 服务端 → 客户端：success=false 时随即关闭（DES/08 §2.1） */
export interface WsAuthResponse {
  type: 'auth';
  success: boolean;
}

// ---------- 事件帧（REQ §2.3 六类 + DES/08 §2.3 扩展两类） ----------

/** 每次账号状态转移成功（DES/08 §2.3） */
export interface WsAccountStatusChangedEvent {
  seq: number;
  type: 'account_status_changed';
  payload: { accountId: string; from: AccountStatus; to: AccountStatus };
}

/** 终态事务（DES/08 §2.3；status ∈ suspended | session_expired） */
export interface WsAccountTerminalEvent {
  seq: number;
  type: 'account_terminal';
  payload: { accountId: string; status: AccountTerminalStatus };
}

/**
 * 对账/死信类告警。kind 取值（DES/08 §1.2/§1.4/§2.2 + DES/04 §3.3）：
 * db_write_failed / unknown_group_event / dead_letter_stuck / member_mismatch / ws_backlog_expired
 */
export interface WsInconsistencyEvent {
  seq: number;
  type: 'inconsistency';
  payload: {
    kind:
      | 'db_write_failed'
      | 'unknown_group_event'
      | 'dead_letter_stuck'
      | 'member_mismatch'
      | 'ws_backlog_expired';
    ref: string;
    message: string;
  };
}

/**
 * 新消息插入与 own 消息投递状态流转（DES/08 §2.3）：
 * msgId 在 queued/accepted 阶段为 null（网关尚未分配，D3-3）；
 * clientMsgId / deliveryStatus 仅 own 消息携带（REQ §2.3 最低字段 + 设计增补）。
 */
export interface WsMessageEvent {
  seq: number;
  type: 'message';
  payload: {
    groupId: string;
    msgId: string | null;
    isOwn: boolean;
    clientMsgId?: string;
    deliveryStatus?: MessageDeliveryStatus;
  };
}

/** run 创建与每次状态变化（DES/08 §2.3）；endReason 无值恒 null（宪法 §3-6） */
export interface WsAgentRunEvent {
  seq: number;
  type: 'agent_run';
  payload: {
    runId: string;
    groupId: string;
    status: AgentRunStatus;
    endReason: AgentRunEndReason | null;
  };
}

/** run 创建、步骤推进、终结（DES/08 §2.3） */
export interface WsSequenceRunEvent {
  seq: number;
  type: 'sequence_run';
  payload: {
    runId: string;
    groupId: string;
    status: SequenceRunStatus;
    currentStepIndex: number;
  };
}

/** DES/08 §2.3 扩展：PATCH 开关后推送，前端就地更新开关显示（DES/15 §2 页面 3） */
export interface WsGroupUpdatedEvent {
  seq: number;
  type: 'group_updated';
  payload: {
    groupId: string;
    status: GroupStatus;
    agentEnabled: boolean;
    autoKickEnabled: boolean;
  };
}

/** DES/08 §2.3 扩展：建群/退群 job 进度（GET /api/jobs/:jobId 的 WS 增量） */
export interface WsJobEvent {
  seq: number;
  type: 'job';
  payload: {
    jobId: string;
    status: JobStatus;
  };
}

export type WsEventFrame =
  | WsAccountStatusChangedEvent
  | WsAccountTerminalEvent
  | WsInconsistencyEvent
  | WsMessageEvent
  | WsAgentRunEvent
  | WsSequenceRunEvent
  | WsGroupUpdatedEvent
  | WsJobEvent;

/** 服务端可能下发的全部帧（事件帧之外只有 auth 应答——DES/08 §2.1） */
export type WsServerFrame = WsAuthResponse | WsEventFrame;

/** 客户端可能上行的全部帧（当前仅 auth 一种——REQ §2.3 WS 行） */
export type WsClientFrame = WsAuthRequest;
