// Agent run steps 时间线（T-P6-06；DES/15 §2 页面 4 逐字、DES/06 §7）。
// 行内容逐字：kind / 工具名(name) / input / resultSummary / isError+errorCode /
// auditVerdict / rawResponse（折叠）。协议错误步：toolUseId/name/input 为 null →
// 渲染 null 语义（「—」）+ errorCode 醒目；rawResponse <details> 折叠
// （后端已 ≤2KB 截断，直接渲染——卡片 d 逐字）。
import { ChevronRight } from 'lucide-react';
import type { AgentRunStepView } from '../lib/api-types.js';
import { cx } from '../ui/cx.js';
import { EmptyState, StatusBadge, Tag } from '../ui/primitives.js';

/** input 折叠渲染（对象 → JSON 文本；null → 「—」占位） */
function renderInput(input: unknown): string {
  if (input === null || input === undefined) return '—';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

const KIND_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  tool_use: 'info',
  final: 'ok',
  protocol_error: 'danger',
};

function StepRow(props: { step: AgentRunStepView }): JSX.Element {
  const s = props.step;
  const isProtocolError = s.kind === 'protocol_error' || s.errorCode !== null;
  const danger = isProtocolError || s.isError;
  return (
    <li
      data-testid={`step-${s.seq}`}
      data-kind={s.kind}
      data-error={danger ? 'true' : undefined}
      className={cx(
        'rounded-md border border-hairline bg-surface-2/40 px-3 py-2.5',
        danger && 'border-danger/50 bg-danger/10',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 font-mono text-[10px] text-ink-subtle">
          {s.seq}
        </span>
        <StatusBadge tone={KIND_TONE[s.kind] ?? 'neutral'} data-testid={`step-kind-${s.seq}`}>
          {s.kind}
        </StatusBadge>
        {s.name !== null && <Tag>{s.name}</Tag>}
        {s.isError && (
          <span className="rounded-sm bg-danger/15 px-1.5 py-0.5 text-[11px] font-medium text-danger">
            isError
          </span>
        )}
        {s.errorCode !== null && (
          <span
            data-testid={`step-errorcode-${s.seq}`}
            className="rounded-sm border border-danger/50 bg-danger/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-danger"
          >
            {s.errorCode}
          </span>
        )}
        {s.auditVerdict !== null && (
          <span
            data-testid={`step-audit-${s.seq}`}
            className={`rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${
              s.auditVerdict === 'pass' ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'
            }`}
          >
            audit:{s.auditVerdict}
          </span>
        )}
      </div>
      {/* 协议错误步逐字：toolUseId/name/input = null 的呈现 */}
      <div className="mt-1.5 break-all font-mono text-[11px] leading-5 text-ink-subtle">
        toolUseId={s.toolUseId ?? 'null'} · input={renderInput(s.input)}
      </div>
      {s.resultSummary !== null && (
        <div className="mt-1 text-xs text-ink-muted">{s.resultSummary}</div>
      )}
      {s.rawResponse !== null && (
        <details data-testid={`step-raw-${s.seq}`} className="group/raw mt-1.5">
          <summary className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-ink-subtle transition-colors duration-150 hover:text-ink">
            <ChevronRight
              size={12}
              className="transition-transform duration-150 group-open/raw:rotate-90"
              aria-hidden
            />
            rawResponse
          </summary>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-sm border border-hairline bg-canvas p-2 font-mono text-[11px] leading-5 text-ink-muted">
            {s.rawResponse}
          </pre>
        </details>
      )}
    </li>
  );
}

export function StepList(props: { steps: AgentRunStepView[] }): JSX.Element {
  if (props.steps.length === 0) {
    return <EmptyState data-testid="steps-empty">暂无步骤</EmptyState>;
  }
  return (
    <ol data-testid="step-list" className="flex flex-col gap-2">
      {props.steps.map((s) => (
        <StepRow key={s.seq} step={s} />
      ))}
    </ol>
  );
}
