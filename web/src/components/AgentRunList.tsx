// Agent run 区块（T-P5-04；DES/15 §2 页面 3 逐字「agent run blocked 醒目提示——
// 顶部横幅 + run 区块标红，A5 audit_blocked 可操作员可见」）。
// 本组件只渲染列表 + 行级标红；「顶部横幅」由 GroupDetailPage 在有 blocked run 时渲染
// （横幅是页面级警示，不是列表行级装饰）。标红 = data-blocked 标记 + 左边条/底色。
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AgentRunView } from '../lib/api-types.js';
import { cx } from '../ui/cx.js';
import { EmptyState, StatusBadge } from '../ui/primitives.js';
import { RUN_TONE, toneOf } from '../ui/status.js';

export interface AgentRunListProps {
  readonly runs: AgentRunView[];
}

export function AgentRunList(props: AgentRunListProps): JSX.Element {
  if (props.runs.length === 0) {
    return <EmptyState data-testid="runs-empty">暂无 agent run</EmptyState>;
  }
  return (
    <ul data-testid="agent-run-list" className="divide-y divide-hairline/60">
      {props.runs.map((run) => {
        const blocked = run.status === 'blocked';
        return (
          <li
            key={run.id}
            data-testid={`agent-run-${run.id}`}
            data-blocked={blocked ? 'true' : undefined}
            className={cx(
              'group flex items-center gap-3 py-2.5 pr-1 transition-colors duration-150',
              // blocked 醒目（页面 3 逐字）：红底色 + 红左边条
              blocked && '-ml-2 border-l-2 border-danger bg-danger/10 pl-2',
            )}
          >
            <Link
              to={`/agent-runs/${run.id}`}
              className="shrink-0 font-mono text-xs font-medium text-info hover:text-primary-hover hover:underline"
            >
              {run.id}
            </Link>
            <StatusBadge tone={toneOf(RUN_TONE, run.status)}>{run.status}</StatusBadge>
            {run.endReason !== null && (
              <span
                className={cx(
                  'font-mono text-[11px]',
                  blocked ? 'text-danger' : 'text-ink-subtle',
                )}
              >
                {run.endReason}
              </span>
            )}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-tertiary">
              {run.createdAt}
            </span>
            <ChevronRight
              size={14}
              className="shrink-0 text-ink-tertiary transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink-subtle"
              aria-hidden
            />
          </li>
        );
      })}
    </ul>
  );
}
