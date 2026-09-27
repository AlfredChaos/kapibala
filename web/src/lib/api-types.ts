// API DTO 镜像（T-P5-04；字段名与 server 模块输出逐字一致——只读视图，不做运行时校验）。
// 出处：server/src/modules/groups/query.ts GroupView、server/src/modules/agent/query.ts AgentRunView。
import type { AgentRunStatus, AgentRunEndReason } from '@kapibala/contract';

export interface GroupMemberView {
  readonly accountId: string;
  readonly platformUserId: string;
  readonly role: 'creator' | 'admin' | 'member';
}

export interface GroupView {
  readonly id: string;
  readonly gatewayGroupId: string | null;
  readonly status: string;
  readonly creatorAccountId: string;
  readonly agentEnabled: boolean;
  readonly autoKickEnabled: boolean;
  readonly members: GroupMemberView[];
  readonly activeSequenceRunId: string | null;
  readonly activeAgentRunId: string | null;
}

export interface AgentRunView {
  readonly id: string;
  readonly groupId: string;
  readonly status: AgentRunStatus;
  readonly endReason: AgentRunEndReason | null;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

/** GET /api/groups/:id/messages 行（DES/05 §5.3 逐字） */
export interface TimelineItem {
  readonly msgId: string | null;
  readonly clientMsgId: string | null;
  readonly senderPlatformUserId: string;
  readonly isOwn: boolean;
  readonly text: string;
  readonly sentAt: string;
  readonly deliveryStatus: string | null;
  readonly failCode: string | null;
}

export interface TimelinePage {
  readonly items: TimelineItem[];
  readonly nextCursor: string | null;
}

/** GET /api/agent-runs/:id 步行（DES/06 §7 + server query.ts AgentRunStepView 逐字） */
export interface AgentRunStepView {
  readonly seq: number;
  readonly kind: string; // tool_use | protocol_error | final
  readonly toolUseId: string | null;
  readonly name: string | null;
  readonly input: unknown;
  readonly resultSummary: string | null;
  readonly isError: boolean;
  readonly errorCode: string | null;
  readonly auditVerdict: string | null;
  readonly rawResponse: string | null; // ≤2KB 已由后端截断——直接渲染
}

export interface AgentRunDetailView extends AgentRunView {
  readonly steps: AgentRunStepView[];
}

/** 序列定义步（DES/07 §1、server modules/sequences/define.ts SequenceStepDef 逐字） */
export interface SequenceStepDef {
  readonly index: number;
  readonly accountRole: 'admin' | 'member';
  readonly text: string;
  readonly delaySeconds: number;
}

/** GET /api/sequence-runs/:id 步视图（server query.ts SequenceStepView 逐字） */
export interface SequenceStepView {
  readonly index: number;
  readonly status: string;
  readonly scheduledAt: string | null;
  readonly sentAt: string | null;
  readonly clientMsgId: string | null;
  readonly resolvedVars: Record<string, string>;
  readonly varSources: Record<string, string>;
}

export interface SequenceRunView {
  readonly id: string;
  readonly groupId: string;
  readonly status: string;
  readonly currentStepIndex: number;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly steps: SequenceStepView[];
}
