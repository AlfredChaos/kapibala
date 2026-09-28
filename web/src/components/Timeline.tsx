// 时间线组件（T-P5-05；DES/15 §5 + DES/05 §5.2/§5.3 + REQ §4 页面 3 时间线）。
// 形态逐字：items Map<msgId ?? clientMsgId, Row>；WS message 经 mergeTimelineItem 原地 patch；
// 「加载更早」before 游标栈只向前翻页；WS 未知键 → 重拉首屏窗口 mergeTimelinePage 'top'；
// sentAt 上移不重排（排序以服务端为准）；own 消息徽标 deliveryStatus（failed/cancelled 含 failCode）。
import { History, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { isApiError } from '../api/client.js';
import type { TimelineItem, TimelinePage } from '../lib/api-types.js';
import {
  mergeTimelineItem,
  mergeTimelinePage,
  rowKeyOf,
  type TimelineItems,
} from '../timeline/merge.js';
import { EmptyState } from '../ui/primitives.js';
import { DELIVERY_TONE } from '../ui/status.js';
import { useWsEvent } from '../ws/useWsEvent.js';

const PAGE_SIZE = 50;

export interface OptimisticRow {
  readonly clientMsgId: string;
  readonly senderPlatformUserId: string;
  readonly text: string;
  readonly nonce: number; // 同 clientMsgId 重复发送也触发插入
}

export interface TimelineProps {
  readonly groupId: string;
  readonly client: ApiClient;
  /** 发送受理后的 queued 占位行（操作员消息先显示 queued——WS message 回填 msgId 沿用同行） */
  readonly optimistic?: OptimisticRow | null;
}

function statusBadge(row: TimelineItem): string {
  if (!row.isOwn) return '';
  if (row.deliveryStatus === null) return 'queued';
  const s = row.deliveryStatus;
  if ((s === 'failed' || s === 'cancelled') && row.failCode !== null) {
    return `${s}(${row.failCode})`;
  }
  return s;
}

export function Timeline(props: TimelineProps): JSX.Element {
  const { groupId, client } = props;
  const [items, setItems] = useState<TimelineItems>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null); // 更早页游标（nextCursor）
  const [loading, setLoading] = useState(false);
  // 发言人/内容关键词过滤：纯客户端对已加载行生效（REQ §2.1 消息接口无 q 参数——
  // 不动对外契约，§3.2；未加载的更早行不参与匹配，翻页后自动纳入）
  const [query, setQuery] = useState('');
  // StrictMode/并发下 ref 读最新 items——useWsEvent handler 经 ref 转发拿到本渲染闭包
  const itemsRef = useRef(items);
  itemsRef.current = items;


  const loadPage = useCallback(
    async (before: string | undefined, position: 'top' | 'bottom'): Promise<string | null> => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before !== undefined) qs.set('before', before);
      const page = await client.request<TimelinePage>(
        `/api/groups/${groupId}/messages?${qs.toString()}`,
      );
      setItems((prev) => mergeTimelinePage(prev, page.items, position));
      return page.nextCursor;
    },
    [client, groupId],
  );

  // 首屏加载
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadPage(undefined, 'top')
      .then((next) => {
        if (!cancelled) setCursor(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(isApiError(err) ? `${err.code}：${err.message}` : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadPage]);

  // 发送受理 → queued 占位行（nonce 驱动：同 clientMsgId 重复发送也插；WS 回填沿用同一行键）
  useEffect(() => {
    const o = props.optimistic;
    if (o === null || o === undefined) return;
    setItems((prev) => {
      if (prev.has(o.clientMsgId)) return prev; // 幂等（StrictMode 双调 effect/updater 安全）
      const row: TimelineItem = {
        msgId: null,
        clientMsgId: o.clientMsgId,
        senderPlatformUserId: o.senderPlatformUserId,
        isOwn: true,
        text: o.text,
        sentAt: new Date().toISOString(), // 受理时刻占位（DES/05 §5.3：sentAt 先用受理时刻）
        deliveryStatus: 'queued',
        failCode: null,
      };
      // 占位行进顶部（最新）：mergeTimelinePage 'top' 的语义复用
      return mergeTimelinePage(prev, [row], 'top');
    });
  }, [props.optimistic]);
  // WS message → 原地 patch；未知键 → 重拉首屏窗口（「首屏上方新消息 → 插入顶部」由重拉实现：
  // 事件载荷无 text/sentAt，凭空建行会撒谎——重拉是拿完整行的唯一正确通道）
  useWsEvent('message', (f) => {
    if (f.payload.groupId !== groupId) return;
    setItems((prev) => {
      const r = mergeTimelineItem(prev, f.payload);
      return r.items;
    });
    // 未知键判定用 ref 读最新（setItems updater 是双调区——副作用必须在 updater 外）
    const hit =
      (f.payload.msgId !== null && itemsRef.current.has(f.payload.msgId)) ||
      (f.payload.clientMsgId !== undefined && itemsRef.current.has(f.payload.clientMsgId));
    if (!hit) {
      void loadPage(undefined, 'top').catch(() => undefined);
    }
  });

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (cursor === null || loading) return;
    setLoading(true);
    try {
      const next = await loadPage(cursor, 'bottom'); // before=cursor：只向前翻页
      setCursor(next);
    } catch (err) {
      setError(isApiError(err) ? `${err.code}：${err.message}` : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, loadPage]);

  const needle = query.trim().toLowerCase();
  const visibleRows = useMemo(
    () => {
      const all = [...items.values()];
      return needle === ''
        ? all
        : all.filter(
            (r) =>
              r.text.toLowerCase().includes(needle) ||
              r.senderPlatformUserId.toLowerCase().includes(needle),
          );
    },
    [items, needle],
  );

  return (
    <section data-testid="timeline">
      {error !== null && (
        <p
          role="alert"
          data-testid="timeline-error"
          className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {/* 搜索框：匹配 text 或 senderPlatformUserId（小写包含匹配，仅作用于已加载行） */}
      <div className="mb-3 flex items-center gap-2 rounded-md border border-hairline bg-surface-1 px-2.5 py-1.5 focus-within:border-hairline-strong">
        <Search size={13} className="shrink-0 text-ink-tertiary" aria-hidden />
        <input
          type="search"
          data-testid="timeline-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索发言人或消息内容…"
          aria-label="搜索时间线消息"
          className="min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-ink-tertiary focus:outline-none"
        />
      </div>
      {visibleRows.length === 0 && !loading ? (
        needle === '' ? (
          <EmptyState data-testid="timeline-empty" icon={<History size={20} aria-hidden />}>
            暂无消息
          </EmptyState>
        ) : (
          <EmptyState data-testid="timeline-no-match" icon={<Search size={20} aria-hidden />}>
            无匹配消息（搜索仅覆盖已加载的行——「加载更早」可纳入更多历史）
          </EmptyState>
        )
      ) : (
        /* 固定视口 + 内部滚动：卡片高度不再随行数无限延展（用户要求 2026-09-28）。
           「加载更早」留在视口底部——滚动到底即见翻页入口 */
        <div
          data-testid="timeline-viewport"
          className="max-h-[28rem] overflow-y-auto overscroll-contain"
        >
          <ul className="divide-y divide-hairline/60">
            {visibleRows.map((row) => {
              const key = rowKeyOf(row);
              const badge = statusBadge(row);
              const badgeTone =
                row.deliveryStatus !== null
                  ? (DELIVERY_TONE[row.deliveryStatus] ?? 'neutral')
                  : 'warn';
              return (
                <li
                  key={key ?? row.clientMsgId ?? row.msgId ?? `${row.senderPlatformUserId}:${row.sentAt}`}
                  data-testid={key !== null ? `tl-${key}` : undefined}
                  className="flex items-baseline gap-2 py-2"
                >
                  <span className="shrink-0 font-mono text-xs text-info">
                    {row.senderPlatformUserId}
                  </span>
                  {row.isOwn && badge !== '' && (
                    <span
                      data-testid={key !== null ? `tl-badge-${key}` : undefined}
                      className={`shrink-0 font-mono text-[11px] ${
                        badgeTone === 'danger'
                          ? 'text-danger'
                          : badgeTone === 'ok'
                            ? 'text-ok'
                            : badgeTone === 'info'
                              ? 'text-info'
                              : badgeTone === 'warn'
                                ? 'text-warn'
                                : 'text-ink-subtle'
                      }`}
                    >
                      [{badge}]
                    </span>
                  )}
                  <span className="min-w-0 flex-1 break-words text-sm text-ink-muted">
                    {row.text}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                    {row.sentAt}
                  </span>
                </li>
              );
            })}
          </ul>
          {cursor !== null && (
            <div className="flex justify-center py-2">
              <button
                type="button"
                onClick={() => void loadEarlier()}
                disabled={loading}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-hairline bg-surface-1 px-3 py-1.5 text-xs text-ink-muted transition-colors duration-150 hover:border-hairline-strong hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading && <Loader2 size={12} className="animate-spin" aria-hidden />}
                {loading ? '加载中…' : '加载更早'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
