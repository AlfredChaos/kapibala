// 预检成功弹窗（T-P6-07；DES/15 §2 页面 5「预检成功弹窗」逐字）。
// 内容：复用该 run steps 的 resolvedVars/varSources 逐步展示——每步列出每个 key 的
// 最终取值与来源（default 或 step:<i>）。数据来自 GET /api/sequence-runs/:id 的
// 启动快照（§8 设计取舍：原样透出）。
// 美化是可裁剪装饰（卡片 d 明确）——保持纯表格 <dialog>/<div role=dialog> 结构。
import type { SequenceStepView } from '../lib/api-types.js';

export function PreflightModal(props: {
  /** 已启动 run 的步快照（resolvedVars/varSources）；null → 不渲染 */
  readonly run: { readonly id: string; readonly steps: readonly SequenceStepView[] } | null;
  readonly onClose: () => void;
}): JSX.Element | null {
  const run = props.run;
  if (run === null) return null;
  return (
    <div
      role="dialog"
      data-testid="preflight-modal"
      style={{ border: '2px solid #333', padding: '0.8rem', background: '#fff', marginTop: '1rem' }}
    >
      <h3>预检结果（run {run.id}）</h3>
      {run.steps.map((s) => (
        <div key={s.index} data-testid={`preflight-step-${s.index}`} style={{ marginBottom: '0.5rem' }}>
          <strong>步骤 {s.index}</strong>
          {Object.keys(s.resolvedVars).length === 0 ? (
            <div style={{ color: '#666' }}>（无占位符）</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', fontSize: '0.85em' }}>
              <thead>
                <tr>
                  <th style={{ border: '1px solid #ccc', padding: '0.15rem 0.5rem' }}>key</th>
                  <th style={{ border: '1px solid #ccc', padding: '0.15rem 0.5rem' }}>值</th>
                  <th style={{ border: '1px solid #ccc', padding: '0.15rem 0.5rem' }}>来源</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(s.resolvedVars).map((k) => (
                  <tr key={k} data-testid={`preflight-var-${s.index}-${k}`}>
                    <td style={{ border: '1px solid #ccc', padding: '0.15rem 0.5rem' }}>{`{${k}}`}</td>
                    <td style={{ border: '1px solid #ccc', padding: '0.15rem 0.5rem' }}>
                      {s.resolvedVars[k] ?? ''}
                    </td>
                    <td style={{ border: '1px solid #ccc', padding: '0.15rem 0.5rem' }}>
                      {s.varSources[k] ?? 'default'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      <button data-testid="preflight-close" onClick={props.onClose}>
        关闭
      </button>
    </div>
  );
}
