// 预检成功弹窗（T-P6-07；DES/15 §2 页面 5「预检成功弹窗」逐字）。
// 内容：复用该 run steps 的 resolvedVars/varSources 逐步展示——每步列出每个 key 的
// 最终取值与来源（default 或 step:<i>）。数据来自 GET /api/sequence-runs/:id 的
// 启动快照（§8 设计取舍：原样透出）。
import { X } from 'lucide-react';
import type { SequenceStepView } from '../lib/api-types.js';
import { Button, Modal } from '../ui/primitives.js';

export function PreflightModal(props: {
  /** 已启动 run 的步快照（resolvedVars/varSources）；null → 不渲染 */
  readonly run: { readonly id: string; readonly steps: readonly SequenceStepView[] } | null;
  readonly onClose: () => void;
}): JSX.Element | null {
  const run = props.run;
  if (run === null) return null;
  return (
    <Modal
      title={`预检结果（run ${run.id}）`}
      data-testid="preflight-modal"
      footer={
        <button
          type="button"
          data-testid="preflight-close"
          onClick={props.onClose}
          className="inline-flex cursor-pointer items-center gap-1 rounded-sm px-2 py-1 text-xs text-ink-subtle transition-colors duration-150 hover:text-ink"
        >
          <X size={12} aria-hidden />
          关闭
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {run.steps.map((s) => (
          <div key={s.index} data-testid={`preflight-step-${s.index}`}>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 font-mono text-[10px] text-ink-subtle">
                {s.index}
              </span>
              <strong className="text-xs font-medium text-ink-muted">步骤 {s.index}</strong>
            </div>
            {Object.keys(s.resolvedVars).length === 0 ? (
              <div className="text-xs text-ink-tertiary">（无占位符）</div>
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-hairline text-left text-ink-tertiary">
                    <th className="px-2 py-1.5 font-medium">key</th>
                    <th className="px-2 py-1.5 font-medium">值</th>
                    <th className="px-2 py-1.5 font-medium">来源</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(s.resolvedVars).map((k) => (
                    <tr
                      key={k}
                      data-testid={`preflight-var-${s.index}-${k}`}
                      className="border-b border-hairline/50 last:border-b-0"
                    >
                      <td className="px-2 py-1.5 font-mono text-info">{`{${k}}`}</td>
                      <td className="px-2 py-1.5 text-ink-muted">{s.resolvedVars[k] ?? ''}</td>
                      <td className="px-2 py-1.5 font-mono text-ink-subtle">
                        {s.varSources[k] ?? 'default'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        <div className="flex justify-end">
          <Button variant="primary" onClick={props.onClose}>
            确认启动
          </Button>
        </div>
      </div>
    </Modal>
  );
}
