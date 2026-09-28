// 仪表盘指标纯函数层（页面零计算——计算都在这，可单测）。
// 指标选型依据见 web/DESIGN.md 附录「工作台仪表盘」节。
import type { WsEventFrame } from '@kapibala/contract';
import type { GroupView } from '../lib/api-types.js';
import type { AccountListItem } from '../pages/AccountsPage.js';
import type { Tone } from '../ui/primitives.js';

export interface AccountCounts {
  readonly total: number;
  readonly online: number;
  readonly idle: number;
  readonly disconnected: number;
  readonly rateLimited: number;
  readonly suspended: number;
  readonly sessionExpired: number;
  /** 需要运营介入：限流中 + 停用 + 会话失效 */
  readonly atRisk: number;
}

export function countAccounts(accounts: readonly AccountListItem[]): AccountCounts {
  let online = 0;
  let idle = 0;
  let disconnected = 0;
  let rateLimited = 0;
  let suspended = 0;
  let sessionExpired = 0;
  for (const a of accounts) {
    switch (a.status) {
      case 'online':
        online += 1;
        break;
      case 'idle':
        idle += 1;
        break;
      case 'disconnected':
        disconnected += 1;
        break;
      case 'rate_limited':
        rateLimited += 1;
        break;
      case 'suspended':
        suspended += 1;
        break;
      case 'session_expired':
        sessionExpired += 1;
        break;
      default:
        break;
    }
  }
  return {
    total: accounts.length,
    online,
    idle,
    disconnected,
    rateLimited,
    suspended,
    sessionExpired,
    atRisk: rateLimited + suspended + sessionExpired,
  };
}
export interface GroupCounts {
  readonly total: number;
  readonly agentEnabled: number;
  readonly activeAgentRuns: number;
  readonly activeSequenceRuns: number;
}

export function countGroups(groups: readonly GroupView[]): GroupCounts {
  return {
    total: groups.length,
    agentEnabled: groups.filter((g) => g.agentEnabled).length,
    activeAgentRuns: groups.filter((g) => g.activeAgentRunId !== null).length,
    activeSequenceRuns: groups.filter((g) => g.activeSequenceRunId !== null).length,
  };
}

/**
 * 消息活动桶化：timestamps（ms epoch）→ 每桶计数，旧→新排序。
 * 末桶对齐 nowMs 所在分钟左端点——保证「最新一分钟」实时可见。
 */
export function bucketize(
  timestamps: readonly number[],
  nowMs: number,
  buckets: number = 30,
  bucketMs: number = 60_000,
): number[] {
  const last = Math.floor(nowMs / bucketMs);
  const first = last - buckets + 1;
  const out = new Array<number>(buckets).fill(0);
  for (const t of timestamps) {
    const b = Math.floor(t / bucketMs);
    if (b >= first && b <= last) out[b - first] = (out[b - first] ?? 0) + 1;
  }
  return out;
}

export interface FeedEntry {
  readonly key: string;
  readonly text: string;
  readonly tone: Tone;
  readonly at: number;
}

const short = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

/** WS 帧 → feed 文案（逐字透出契约字段；tone 与状态语义表一致） */
export function feedEntryOf(frame: WsEventFrame, at: number): FeedEntry {
  const key = `${frame.seq}`;
  switch (frame.type) {
    case 'message':
      return {
        key,
        at,
        tone: 'info',
        text: `群 ${short(frame.payload.groupId)} 新消息${frame.payload.isOwn ? '（己方）' : ''}`,
      };
    case 'agent_run': {
      const { status, runId, groupId } = frame.payload;
      const tone =
        status === 'blocked' || status === 'failed'
          ? 'danger'
          : status === 'finished'
            ? 'ok'
            : status === 'running'
              ? 'warn'
              : 'neutral';
      return {
        key,
        at,
        tone,
        text: `agent run ${short(runId)}（群 ${short(groupId)}）→ ${status}`,
      };
    }
    case 'sequence_run':
      return {
        key,
        at,
        tone: frame.payload.status === 'failed' ? 'danger' : frame.payload.status === 'running' ? 'warn' : 'ok',
        text: `序列 run ${short(frame.payload.runId)} → ${frame.payload.status}（第 ${frame.payload.currentStepIndex} 步）`,
      };
    case 'account_status_changed':
      return {
        key,
        at,
        tone: 'info',
        text: `账号 ${frame.payload.accountId}：${frame.payload.from} → ${frame.payload.to}`,
      };
    case 'account_terminal':
      return {
        key,
        at,
        tone: 'danger',
        text: `账号 ${frame.payload.accountId} 进入终态 ${frame.payload.status}`,
      };
    case 'group_updated':
      // server 实际载荷只有 { groupId }（groups-patch.ts INSERT 逐字——contract 声明的
      // status/agentEnabled 是超集声明，服务端不发；渲染不碰缺省字段）
      return {
        key,
        at,
        tone: 'neutral',
        text: `群 ${short(frame.payload.groupId)} 配置更新`,
      };
    case 'job':
      return {
        key,
        at,
        tone: frame.payload.status === 'failed' ? 'danger' : 'neutral',
        text: `job ${short(frame.payload.jobId)} → ${frame.payload.status}`,
      };
    case 'inconsistency':
      return {
        key,
        at,
        tone: 'warn',
        text: `对账告警：${frame.payload.kind}`,
      };
  }
}
