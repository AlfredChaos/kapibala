// Agent run steps 时间线（T-P6-06；DES/15 §2 页面 4 逐字、DES/06 §7）。
// 行内容逐字：kind / 工具名(name) / input / resultSummary / isError+errorCode /
// auditVerdict / rawResponse（折叠）。协议错误步：toolUseId/name/input 为 null →
// 渲染 null 语义（「—」）+ errorCode 醒目；rawResponse <details> 折叠
// （后端已 ≤2KB 截断，直接渲染——卡片 d 逐字）。
import type { AgentRunStepView } from '../lib/api-types.js';

/** input 折叠渲染（对象 → JSON 文本；null → 「—」占位） */
function renderInput(input: unknown): string {
  if (input === null || input === undefined) return '—';
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function StepRow(props: { step: AgentRunStepView }): JSX.Element {
  const s = props.step;
  const isProtocolError = s.kind === 'protocol_error' || s.errorCode !== null;
  return (
    <li
      data-testid={`step-${s.seq}`}
      data-kind={s.kind}
      data-error={s.isError || isProtocolError ? 'true' : undefined}
      style={{
        padding: '0.5rem 0.6rem',
        borderBottom: '1px solid #eee',
        borderLeft: isProtocolError || s.isError ? '4px solid #c00' : undefined,
        background: isProtocolError ? '#fdecec' : undefined,
      }}
    >
      <div>
        <strong>#{s.seq}</strong>
        <span style={{ marginLeft: '0.5rem' }} data-testid={`step-kind-${s.seq}`}>
          {s.kind}
        </span>
        {s.name !== null && (
          <span style={{ marginLeft: '0.5rem', fontFamily: 'monospace' }}>{s.name}</span>
        )}
        {s.isError && (
          <span style={{ marginLeft: '0.5rem', color: '#c00' }}>isError</span>
        )}
        {s.errorCode !== null && (
          <span
            data-testid={`step-errorcode-${s.seq}`}
            style={{ marginLeft: '0.5rem', color: '#c00', fontWeight: 'bold' }}
          >
            {s.errorCode}
          </span>
        )}
        {s.auditVerdict !== null && (
          <span data-testid={`step-audit-${s.seq}`} style={{ marginLeft: '0.5rem', color: '#a60' }}>
            audit:{s.auditVerdict}
          </span>
        )}
      </div>
      {/* 协议错误步逐字：toolUseId/name/input = null 的呈现 */}
      <div style={{ fontSize: '0.85em', color: '#666' }}>
        toolUseId={s.toolUseId ?? 'null'} · input={renderInput(s.input)}
      </div>
      {s.resultSummary !== null && (
        <div style={{ fontSize: '0.9em', marginTop: '0.2rem' }}>{s.resultSummary}</div>
      )}
      {s.rawResponse !== null && (
        <details data-testid={`step-raw-${s.seq}`}>
          <summary>rawResponse</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8em', margin: '0.3rem 0' }}>
            {s.rawResponse}
          </pre>
        </details>
      )}
    </li>
  );
}

export function StepList(props: { steps: AgentRunStepView[] }): JSX.Element {
  if (props.steps.length === 0) {
    return <p data-testid="steps-empty">暂无步骤</p>;
  }
  return (
    <ol data-testid="step-list" style={{ listStyle: 'none', padding: 0 }}>
      {props.steps.map((s) => (
        <StepRow key={s.seq} step={s} />
      ))}
    </ol>
  );
}
