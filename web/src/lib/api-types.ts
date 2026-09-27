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
