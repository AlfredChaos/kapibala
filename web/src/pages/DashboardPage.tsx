// 工作台仪表盘（新首页；web/DESIGN.md 附录「工作台仪表盘」指标选型）。
// 数据流：
//   快照 — GET /api/accounts + /api/groups（状态分布/在线率/群数/活跃 run 指针）；
//   agent run 明细 — 逐群 GET /api/groups/:id/agent-runs（与群详情同端点，收敛排序在前端）；
//   实时 — useWsAll 一钩收全部帧：feed 追加、消息时间戳入桶、风险计数即时更新；
//   group_updated/account 帧 → 重拉对应快照（详情页同一策略）。
// viewer 只读可用：全部读接口 auth:'required'，无写路径。
import {
  Activity,
  Bot,
  CircleAlert,
  ListOrdered,
  MessageSquare,
  Radio,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError, useAuth } from '../auth/AuthProvider.js';
import type { AccountListItem } from './AccountsPage.js';
import type { AgentRunView, GroupView } from '../lib/api-types.js';
import { bucketize, countAccounts, countGroups, feedEntryOf, type FeedEntry } from '../dashboard/metrics.js';
import { cx } from '../ui/cx.js';
import { BarsChart, MeterRow, StatCard } from '../ui/charts.js';
import { Card, EmptyState, StatusBadge } from '../ui/primitives.js';
import { RUN_TONE, toneOf } from '../ui/status.js';
import { useWsAll } from '../ws/useWsEvent.js';

const FEED_MAX = 24;
const MSG_TS_MAX = 400;
const BUCKETS = 30;
const RUN_LIST_MAX = 6;
/** 需要运营处理的 run 终态（blocked = 审计拦截最优先） */
const RUN_ATTENTION = ['blocked', 'failed'] as const;
const RUN_LIVE = ['running', 'pending'] as const;

function errorText(err: unknown): string {
  if (isApiError(err)) return `${err.code}：${err.message}`;
  return '加载失败（网络错误）';
}

function fmtTime(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

export function DashboardPage(): JSX.Element {
  const { client } = useAuth();
  const [accounts, setAccounts] = useState<AccountListItem[] | null>(null);
  const [groups, setGroups] = useState<GroupView[] | null>(null);
  const [runs, setRuns] = useState<AgentRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 实时层（ws 帧驱动；不进 React state 的原始计数走 ref——渲染由 feed tick 顺带触发）
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const msgTs = useRef<number[]>([]);
  const [msgTimestamps, setMsgTimestamps] = useState<number>(0); // bump 触发 chart 重算
  // runsRef：WS 回调里读最新 runs（判定未知 run → 重拉），不靠渲染闭包
  const runsRef = useRef<AgentRunView[] | null>(null);
  runsRef.current = runs;

  const reloadSnapshots = useCallback(async (): Promise<void> => {
    try {
      const [a, g] = await Promise.all([
        client.request<AccountListItem[]>('/api/accounts'),
        client.request<GroupView[]>('/api/groups'),
      ]);
      setAccounts(a);
      setGroups(g);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [client]);

  const reloadRuns = useCallback(
    async (gs: readonly GroupView[]): Promise<void> => {
      // 各群 run 列表并行拉取后全局排序（按 createdAt 降序——服务端群内排序不在前端再裁决）
      try {
        const lists = await Promise.all(
          gs.map((g) => client.request<AgentRunView[]>(`/api/groups/${g.id}/agent-runs`)),
        );
        const all = lists.flat();
        all.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
        setRuns(all);
      } catch {
        /* run 列表失败不阻断仪表盘——feed 仍实时 */
      }
    },
    [client],
  );

  useEffect(() => {
    void (async () => {
      await reloadSnapshots();
    })();
  }, [reloadSnapshots]);

  // groups 就绪后才拉 run 明细（依赖快照而不是先拉——两次往返串行，省一轮空跑）
  useEffect(() => {
    if (groups !== null) void reloadRuns(groups);
  }, [groups, reloadRuns]);

  useWsAll((frame) => {
    const at = Date.now();
    if (frame.type === 'message') {
      msgTs.current.push(at);
      if (msgTs.current.length > MSG_TS_MAX) msgTs.current.shift();
      setMsgTimestamps((n) => n + 1);
    }
    setFeed((prev) => [feedEntryOf(frame, at), ...prev].slice(0, FEED_MAX));
    // 结构性帧 → 快照重拉（与详情页同一「事件驱动 invalidate」策略）
    if (
      frame.type === 'account_status_changed' ||
      frame.type === 'account_terminal' ||
      frame.type === 'group_updated' ||
      frame.type === 'job'
    ) {
      void reloadSnapshots();
    }
    if (frame.type === 'agent_run' || frame.type === 'sequence_run') {
      // 纪律：setState updater 必须纯（StrictMode 双调）——重拉判定放 updater 外，
      // 本地 patch 走 updater，副作用（refetch）在外层做一次。
      if (frame.type === 'agent_run') {
        const list = runsRef.current;
        if (list === null || !list.some((r) => r.id === frame.payload.runId)) {
          void reloadRuns(groups ?? []);
        }
        setRuns((prev) => {
          if (prev === null) return prev;
          const i = prev.findIndex((r) => r.id === frame.payload.runId);
          if (i === -1) return prev; // 未知 run：上面的 refetch 兜底
          const next = prev.slice();
          const row = next[i];
          if (row === undefined) return prev;
          next[i] = { ...row, status: frame.payload.status, endReason: frame.payload.endReason };
          return next;
        });
      }
      if (frame.type === 'sequence_run' && groups !== null) void reloadSnapshots();
    }
  });

  const acc = accounts !== null ? countAccounts(accounts) : null;
  const grp = groups !== null ? countGroups(groups) : null;
  const attentionRuns = (runs ?? [])
    .filter((r) => (RUN_ATTENTION as readonly string[]).includes(r.status))
    .slice(0, RUN_LIST_MAX);
  const liveRuns = (runs ?? []).filter((r) =>
    (RUN_LIVE as readonly string[]).includes(r.status),
  ).length;
  const chartValues = bucketize(msgTs.current, Date.now(), BUCKETS);
  const msgTotal = msgTs.current.length;
  void msgTimestamps; // bump 引用——chartValues 已即时重算

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">工作台</h1>
        <p className="mt-0.5 text-xs text-ink-subtle">
          平台健康总览 — 账号、群与运行的实时状态
        </p>
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {/* 指标卡行 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={<Users size={14} aria-hidden />}
          label="账号在线"
          value={acc === null ? '—' : `${acc.online}/${acc.total}`}
          tone={acc !== null && acc.online > 0 ? 'ok' : 'neutral'}
          hint={acc === null ? undefined : `idle ${acc.idle} · 离线 ${acc.disconnected}`}
        />
        <StatCard
          icon={<CircleAlert size={14} aria-hidden />}
          label="风险账号"
          value={acc === null ? '—' : acc.atRisk}
          tone={acc !== null && acc.atRisk > 0 ? 'warn' : 'neutral'}
          hint={
            acc === null
              ? undefined
              : `限流 ${acc.rateLimited} · 停用 ${acc.suspended} · 失效 ${acc.sessionExpired}`
          }
        />
        <StatCard
          icon={<MessageSquare size={14} aria-hidden />}
          label="群"
          value={grp === null ? '—' : grp.total}
          tone="ink"
          hint={grp === null ? undefined : `agent 启用 ${grp.agentEnabled}`}
        />
        <StatCard
          icon={<Bot size={14} aria-hidden />}
          label="活跃 agent run"
          value={grp === null ? '—' : grp.activeAgentRuns}
          tone={grp !== null && grp.activeAgentRuns > 0 ? 'info' : 'neutral'}
        />
        <StatCard
          icon={<ListOrdered size={14} aria-hidden />}
          label="活跃序列 run"
          value={grp === null ? '—' : grp.activeSequenceRuns}
          tone={grp !== null && grp.activeSequenceRuns > 0 ? 'info' : 'neutral'}
        />
        <StatCard
          icon={<Radio size={14} aria-hidden />}
          label="消息（本会话）"
          value={msgTotal}
          tone="ink"
          hint="WS 实时计数"
        />
      </div>

      {/* 图表区：消息活动 + 账号状态分布 */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <Card
          title="消息活动（近 30 分钟）"
          extra={
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-tertiary">
              <Activity size={12} aria-hidden />
              每分钟桶
            </span>
          }
        >
          <BarsChart values={chartValues} />
          <p className="mt-2 text-right font-mono text-[11px] text-ink-tertiary">
            本窗口合计 {msgTotal} 条
          </p>
        </Card>
        <Card title="账号状态分布">
          {acc === null ? (
            <p className="py-4 text-center text-sm text-ink-subtle">加载中…</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <MeterRow label="online" value={acc.online} total={acc.total} tone="ok" />
              <MeterRow label="idle" value={acc.idle} total={acc.total} tone="neutral" />
              <MeterRow
                label="rate_limited"
                value={acc.rateLimited}
                total={acc.total}
                tone="warn"
              />
              <MeterRow
                label="disconnected"
                value={acc.disconnected}
                total={acc.total}
                tone="neutral"
              />
              <MeterRow
                label="suspended"
                value={acc.suspended}
                total={acc.total}
                tone="danger"
              />
              <MeterRow
                label="session_expired"
                value={acc.sessionExpired}
                total={acc.total}
                tone="info"
              />
            </div>
          )}
        </Card>
      </div>

      {/* 需要注意的 run + 实时事件流 */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card
          title="需要注意的 run"
          extra={
            liveRuns > 0 ? (
              <span className="text-[11px] text-info">另有 {liveRuns} 个进行中</span>
            ) : undefined
          }
        >
          {runs === null ? (
            <p className="py-4 text-center text-sm text-ink-subtle">加载中…</p>
          ) : attentionRuns.length === 0 ? (
            <EmptyState icon={<TriangleAlert size={18} aria-hidden />}>
              没有 blocked / failed 的 run
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {attentionRuns.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/agent-runs/${r.id}`}
                    className={cx(
                      'flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors duration-150',
                      r.status === 'blocked'
                        ? 'border-danger/40 bg-danger/10 hover:bg-danger/15'
                        : 'border-hairline bg-surface-2/40 hover:bg-surface-2',
                    )}
                  >
                    <span className="font-mono text-info">{r.id.slice(0, 8)}</span>
                    <StatusBadge tone={toneOf(RUN_TONE, r.status)}>{r.status}</StatusBadge>
                    {r.endReason !== null && (
                      <span className="font-mono text-[11px] text-ink-subtle">
                        {r.endReason}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[11px] text-ink-tertiary">
                      {r.createdAt.slice(0, 19).replace('T', ' ')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="实时事件">
          {feed.length === 0 ? (
            <EmptyState icon={<Radio size={18} aria-hidden />}>
              等待 WS 事件…（消息/run/账号状态会实时出现在这里）
            </EmptyState>
          ) : (
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {feed.map((e) => (
                <li
                  key={e.key}
                  className="flex items-baseline gap-2 rounded-sm px-1.5 py-1 text-xs hover:bg-surface-2"
                >
                  <span
                    className={cx(
                      'h-1.5 w-1.5 shrink-0 self-center rounded-full',
                      e.tone === 'danger'
                        ? 'bg-danger'
                        : e.tone === 'warn'
                          ? 'bg-warn'
                          : e.tone === 'ok'
                            ? 'bg-ok'
                            : e.tone === 'info'
                              ? 'bg-info'
                              : 'bg-neutral',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-ink-muted">{e.text}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-tertiary">
                    {fmtTime(e.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
