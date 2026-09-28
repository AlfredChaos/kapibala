// 群详情页骨架（T-P5-04；DES/15 §2 页面 3、DES/04 §5、REQ §4 页面 3）。
// 数据流：GET /api/groups/:id + GET /api/groups/:id/agent-runs 首屏；
// WS group_updated → 重拉群详情（开关成员同步）；agent_run → 重拉 run 列表（含新建）；
// message/sequence_run 等时间线事件归 T-P5-05（本页骨架不含时间线区）。
// 开关 PATCH /api/groups/:id（admin 可写；viewer 只读 disabled——服务端仍 403 权威）。
// blocked run → 顶部横幅 + 行标红（页面 3 逐字「醒目提示」；A5 audit_blocked 可见）。
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isApiError, useAuth, canWrite } from '../auth/AuthProvider.js';
import { AgentRunList } from '../components/AgentRunList.js';
import { GroupMembers } from '../components/GroupMembers.js';
import { SendForm } from '../components/SendForm.js';
import { Timeline } from '../components/Timeline.js';
import type { AgentRunView, GroupView } from '../lib/api-types.js';
import { Card, StatusBadge } from '../ui/primitives.js';
import { GROUP_TONE, toneOf } from '../ui/status.js';
import { useWsEvent } from '../ws/useWsEvent.js';

function errorText(err: unknown): string {
  if (isApiError(err)) return `${err.code}：${err.message}`;
  return '请求失败（网络错误）';
}

export function GroupDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { client, session } = useAuth();
  const writable = canWrite(session);
  const [group, setGroup] = useState<GroupView | null>(null);
  // 发送乐观行（queued 占位；nonce 驱动 Timeline 的插入 effect——WS 回填沿用同一行键）
  const [optimistic, setOptimistic] = useState<{
    clientMsgId: string;
    senderPlatformUserId: string;
    text: string;
    nonce: number;
  } | null>(null);
  const [runs, setRuns] = useState<AgentRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  // 404/GROUP_NOT_FOUND 终态标识：区别于瞬时错误——不再渲染「加载中…」，改「群不存在」
  const [notFound, setNotFound] = useState(false);

  const reloadGroup = useCallback(async (): Promise<void> => {
    if (id === undefined) return;
    try {
      setGroup(await client.request<GroupView>(`/api/groups/${id}`));
      setError(null);
      setNotFound(false); // 同页换 id 重进（组件复用）时清掉旧的 404 终态
    } catch (err) {
      if (isApiError(err) && (err.code === 'GROUP_NOT_FOUND' || err.status === 404)) {
        setNotFound(true);
        setError(null); // 「群不存在」区块即错误呈现——不再叠通用 alert
      } else {
        setError(errorText(err));
      }
    }
  }, [client, id]);

  const reloadRuns = useCallback(async (): Promise<void> => {
    if (id === undefined) return;
    try {
      setRuns(await client.request<AgentRunView[]>(`/api/groups/${id}/agent-runs`));
    } catch {
      // run 列表失败不盖主页错误（首屏并行时群详情优先）
    }
  }, [client, id]);

  useEffect(() => {
    // 同页 A→B 换 id（组件实例复用）：拉取前先复位读态——
    // 不带这步，in-flight 期间会挂着 A 的「群不存在」/旧详情渲染 B（review 实锤假阳性）。
    // 复位只在 id 切换路径（本 effect），不放 reloadGroup 内部：toggle 后重拉要保留详情显示。
    setGroup(null);
    setRuns(null);
    setError(null);
    setNotFound(false);
    void reloadGroup();
    void reloadRuns();
  }, [reloadGroup, reloadRuns]);

  // WS 驱动刷新（DES/15 §2：group_updated → 群详情；agent_run → run 列表）
  // WS 驱动（DES/15 §2 + DES/08 §2.3）：
  // group_updated → 就地更新开关/status（事件携带新值，无需重拉——§2.3 注释逐字）
  useWsEvent('group_updated', (f) => {
    if (f.payload.groupId !== id) return;
    setGroup((prev) =>
      prev === null || prev.id !== f.payload.groupId
        ? prev
        : {
            ...prev,
            status: f.payload.status,
            agentEnabled: f.payload.agentEnabled,
            autoKickEnabled: f.payload.autoKickEnabled,
          },
    );
  });
  // agent_run → 就地 patch 已知行；未知 runId（新建）→ 重拉列表拿完整行。
  // 纪律：setState updater 必须纯——StrictMode 会双调 updater，副作用（重拉）放 updater 外。
  useWsEvent('agent_run', (f) => {
    if (f.payload.groupId !== id) return;
    const known = (runs ?? []).some((r) => r.id === f.payload.runId);
    if (!known) {
      void reloadRuns(); // 新 run：列表项形状（createdAt/summary）需服务端行
      return;
    }
    setRuns((prev) =>
      (prev ?? []).map((r) =>
        r.id === f.payload.runId
          ? { ...r, status: f.payload.status, endReason: f.payload.endReason }
          : r,
      ),
    );
  });

  const toggle = useCallback(
    async (key: 'agentEnabled' | 'autoKickEnabled', value: boolean) => {
      if (id === undefined || toggleBusy) return;
      setToggleBusy(true);
      try {
        await client.request(`/api/groups/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ [key]: value }),
        });
        // 服务端同事务推 group_updated——WS 就地更新；本地也立即重拉收敛（双保险）
        await reloadGroup();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setToggleBusy(false);
      }
    },
    [client, id, reloadGroup, toggleBusy],
  );

  const blockedRuns = (runs ?? []).filter((r) => r.status === 'blocked');

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">群详情</h1>
        <span className="font-mono text-xs text-ink-subtle">{id ?? ''}</span>
        {group !== null && (
          <StatusBadge tone={toneOf(GROUP_TONE, group.status)}>{group.status}</StatusBadge>
        )}
      </div>
      {/* 页面 3 逐字：blocked 的 run → 顶部横幅醒目提示 */}
      {blockedRuns.length > 0 && (
        <div
          role="alert"
          data-testid="blocked-banner"
          className="mb-4 flex items-center gap-2 rounded-md border border-danger/50 bg-danger/15 px-3 py-2.5 text-sm font-medium text-danger"
        >
          <TriangleAlert size={15} aria-hidden />⚠ {blockedRuns.length} 个 agent run
          被审计拦截（blocked）——请检查最近 run
        </div>
      )}
      {error !== null && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {notFound ? (
        <p
          role="alert"
          data-testid="group-not-found"
          className="rounded-md border border-danger/40 bg-danger/10 px-4 py-6 text-center text-sm text-danger"
        >
          群不存在（{id ?? ''}）
        </p>
      ) : group === null ? (
        error === null ? (
          <p className="py-10 text-center text-sm text-ink-subtle">加载中…</p>
        ) : null // 瞬时错误已有 alert——不叠加载假象
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]">
          <div className="flex min-w-0 flex-col gap-5">
            <Card title="状态">
              <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-ink-tertiary">gatewayGroupId</dt>
                <dd className="truncate font-mono text-ink-muted">
                  {group.gatewayGroupId ?? '—'}
                </dd>
                <dt className="text-ink-tertiary">creator</dt>
                <dd className="truncate font-mono text-ink-muted">{group.creatorAccountId}</dd>
              </dl>
              <div className="flex flex-col gap-3">
                <SwitchRow
                  label="agentEnabled"
                  hint="群消息触发 agent run"
                  testId="toggle-agentEnabled"
                  checked={group.agentEnabled}
                  disabled={!writable || toggleBusy}
                  onChange={(v) => void toggle('agentEnabled', v)}
                />
                <SwitchRow
                  label="autoKickEnabled"
                  hint="agent 可移除成员"
                  testId="toggle-autoKickEnabled"
                  checked={group.autoKickEnabled}
                  disabled={!writable || toggleBusy}
                  onChange={(v) => void toggle('autoKickEnabled', v)}
                />
              </div>
            </Card>
            <Card title={`成员（${group.members.length}）`}>
              <GroupMembers members={group.members} />
            </Card>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            {/* 布局定序（用户要求 2026-09-28）：发送 + Agent Run 固定在前，
                时间线（内部滚动的延展窗口）压轴——消息增多不挤压操作区 */}
            {writable && (
              <Card title="发送消息">
                <SendForm
                  groupId={group.id}
                  members={group.members}
                  client={client}
                  onSent={(res) => {
                    const member = group.members.find((m) => m.accountId === res.accountId);
                    setOptimistic({
                      clientMsgId: res.clientMsgId,
                      senderPlatformUserId: member?.platformUserId ?? res.accountId,
                      text: res.text,
                      nonce: Date.now(),
                    });
                  }}
                />
              </Card>
            )}
            <Card title="最近 agent run">
              {runs === null ? (
                <p className="py-4 text-center text-sm text-ink-subtle">加载中…</p>
              ) : (
                <AgentRunList runs={runs} />
              )}
            </Card>
            {/* 时间线（T-P5-05）：受理后经 optimistic prop 插 queued 占位行；
                WS message 回填 msgId 沿用同一行键原地更新（后端一行原则前端配合面）。
                组件内部限定视口高度自行滚动（Timeline max-height），卡片不再随行数无限长高 */}
            <Card title="时间线">
              <Timeline groupId={group.id} client={client} optimistic={optimistic} />
            </Card>
          </div>
        </div>
      )}
    </main>
  );
}

/** 开关行：checkbox 语义不变（测试按 input.checked + change 事件驱动），样式化为 switch */
function SwitchRow(props: {
  readonly label: string;
  readonly hint: string;
  readonly testId: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-md border border-hairline bg-surface-2/40 px-3 py-2 transition-colors duration-150 ${
        props.disabled ? 'opacity-60' : 'cursor-pointer hover:border-hairline-strong'
      }`}
    >
      <span className="min-w-0">
        <span className="block font-mono text-xs text-ink">{props.label}</span>
        <span className="block text-[11px] text-ink-tertiary">{props.hint}</span>
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <input
          type="checkbox"
          data-testid={props.testId}
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.checked)}
          className="peer h-5 w-9 cursor-pointer appearance-none rounded-full border border-hairline-strong bg-surface-3 transition-colors duration-150 checked:border-primary checked:bg-primary disabled:cursor-not-allowed"
        />
        <span className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-ink-subtle transition-transform duration-150 peer-checked:translate-x-4 peer-checked:bg-on-primary" />
      </span>
    </label>
  );
}
