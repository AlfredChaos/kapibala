// Agent run 详情页（T-P6-06；DES/15 §2 页面 4、REQ §4 页面 4、B4-2）。
// 数据流：GET /api/agent-runs/:id → { run + steps }；WS agent_run(runId 匹配) →
// 终态（status 离开 running）重拉详情拿全量 steps——运行中不逐帧重拉（卡片 b：
// 「run 终态（WS agent_run）→ 重拉详情」逐字，running 更新只靠列表页）。
// blocked/failed 醒目：头部徽标 + 红底条；endReason 徽标同区展示。
import { ArrowLeft, OctagonAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError, useAuth } from '../auth/AuthProvider.js';
import { StepList } from '../components/StepList.js';
import type { AgentRunDetailView } from '../lib/api-types.js';
import { Card, StatusBadge } from '../ui/primitives.js';
import { RUN_TONE, toneOf } from '../ui/status.js';
import { useWsEvent } from '../ws/useWsEvent.js';

const TERMINAL_STATUSES: Record<string, true> = {
  finished: true,
  failed: true,
  blocked: true,
  cancelled: true,
};

export function AgentRunPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { client } = useAuth();
  const [detail, setDetail] = useState<AgentRunDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (id === undefined) return;
    try {
      setDetail(await client.request<AgentRunDetailView>(`/api/agent-runs/${id}`));
      setError(null);
    } catch (err) {
      setError(isApiError(err) ? `${err.code}：${err.message}` : '加载失败');
    }
  }, [client, id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 运行中轻量轮询（审计修复）：run.status 非终态时 3s 重拉 steps——
  // WS 终态帧是主通道（下方 useWsEvent），轮询补「帧丢/补发缺口/订阅窗口」的盲区；
  // 终态（finished|failed|blocked|cancelled）或卸载即清定时器。live 布尔作 dep：
  // running→running 的 status 翻动不重开表，running→终态精确收一次。
  const live = detail !== null && !(detail.status in TERMINAL_STATUSES);
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => {
      void reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [live, reload]);

  // 卡片 b 逐字：run 终态（WS agent_run）→ 重拉详情拿全量 steps
  useWsEvent('agent_run', (f) => {
    if (f.payload.runId !== id) return;
    if (f.payload.status in TERMINAL_STATUSES) void reload();
    else {
      // 非终态（running 心跳/推进）→ 只更新头部 status，不重拉 steps
      setDetail((prev) =>
        prev === null || prev.id !== id
          ? prev
          : { ...prev, status: f.payload.status },
      );
    }
  });

  const prominent = detail !== null && (detail.status === 'blocked' || detail.status === 'failed');

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-6">
      <p className="mb-3">
        {/* groupId 未知（加载失败/详情未回）→ 退回群列表，不产出 /groups/ 空尾巴链接 */}
        <Link
          to={detail?.groupId ? `/groups/${detail.groupId}` : '/groups'}
          className="inline-flex items-center gap-1 text-xs text-ink-subtle transition-colors duration-150 hover:text-ink"
        >
          <ArrowLeft size={12} aria-hidden />
          {detail?.groupId ? '返回群详情' : '返回群列表'}
        </Link>
      </p>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Agent Run</h1>
        <span className="font-mono text-xs text-ink-subtle">{id ?? ''}</span>
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {detail === null && error === null ? (
        <p className="py-10 text-center text-sm text-ink-subtle">加载中…</p>
      ) : detail === null ? null : ( // 已有错误 alert 在前——不再叠「加载中…」假象
        <div className="flex flex-col gap-5">
          {prominent && (
            <div
              role="alert"
              data-testid="run-prominent"
              className="flex items-center gap-2 rounded-md border border-danger/50 bg-danger/15 px-3 py-2.5 text-sm font-medium text-danger"
            >
              <OctagonAlert size={15} aria-hidden />
              run {detail.status}
              {detail.endReason !== null ? `（${detail.endReason}）` : ''}
            </div>
          )}
          <Card>
            <p className="flex items-center gap-2 text-sm text-ink-subtle">
              status=
              <StatusBadge
                tone={toneOf(RUN_TONE, detail.status)}
                data-testid="run-status"
              >
                {detail.status}
              </StatusBadge>
              {detail.endReason !== null && (
                <>
                  <span className="text-ink-tertiary">·</span>
                  endReason=
                  <span data-testid="run-endreason" className="font-mono font-medium text-ink">
                    {detail.endReason}
                  </span>
                </>
              )}
            </p>
            {detail.summary !== null && (
              <p className="mt-2 text-sm text-ink-muted">summary：{detail.summary}</p>
            )}
          </Card>
          <Card title={`Steps（${detail.steps.length}）`}>
            <StepList steps={detail.steps} />
          </Card>
        </div>
      )}
    </main>
  );
}
