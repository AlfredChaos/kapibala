// 序列定义表单（T-P6-07；DES/15 §2 页面 5「定义表单 steps 编辑」、DES/07 §1）。
// steps 编辑：逐行 index/accountRole/text/delaySeconds，可增删行；客户端校验逐字对齐
// server/modules/sequences/define.ts（index 正整数唯一、accountRole∈{admin,member}、
// text 1..TEXT_MAX_LENGTH、delaySeconds 非负整数）——前端先行拦截，服务端仍真值。
// 预检失败 422（stepIndex/key）由页面回调 onPrecheckError 定位行（页面 5 逐字「高亮出错步骤行」）。
import { useState } from 'react';
import { TEXT_MAX_LENGTH } from '../lib/text-limits.js';
import type { SequenceStepDef } from '../lib/api-types.js';

export interface SequenceDraft {
  readonly name: string;
  readonly steps: SequenceStepDef[];
}

interface EditableStep {
  index: number;
  accountRole: 'admin' | 'member';
  text: string;
  delaySeconds: number;
}

/** 服务端 define.ts 同构校验（§1 四字段规则 + index 去重）。返回中文错误串或 null */
export function validateSequenceDraft(name: string, steps: SequenceStepDef[]): string | null {
  if (name.trim().length === 0) return 'name 不能为空';
  if (steps.length === 0) return 'steps 不能为空';
  const seen = new Set<number>();
  for (const s of steps) {
    if (!Number.isInteger(s.index) || s.index <= 0) return `步骤 index 必须是正整数（得 ${s.index}）`;
    if (s.accountRole !== 'admin' && s.accountRole !== 'member') {
      return `步骤 ${s.index}：accountRole 只能 admin|member`;
    }
    if (typeof s.text !== 'string' || s.text.length === 0) {
      return `步骤 ${s.index}：text 不能为空`;
    }
    if (s.text.length > TEXT_MAX_LENGTH) {
      return `步骤 ${s.index}：text 超长（${s.text.length}/${TEXT_MAX_LENGTH}）`;
    }
    if (!Number.isInteger(s.delaySeconds) || s.delaySeconds < 0) {
      return `步骤 ${s.index}：delaySeconds 必须是非负整数`;
    }
    if (seen.has(s.index)) return `步骤 index 重复：${s.index}`;
    seen.add(s.index);
  }
  return null;
}

export function SequenceForm(props: {
  /** 422 预检失败时被高亮的 stepIndex（页面回调传入）；null 清除 */
  readonly highlightStepIndex: number | null;
  readonly highlightKey: string | null;
  /** 定义提交（由页面 POST /api/sequences + 登记本地列表） */
  readonly onDefine: (draft: SequenceDraft) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<EditableStep[]>([
    { index: 1, accountRole: 'member', text: '', delaySeconds: 0 },
  ]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updateStep(i: number, patch: Partial<EditableStep>): void {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function addStep(): void {
    const nextIdx = steps.length === 0 ? 1 : Math.max(...steps.map((s) => s.index)) + 1;
    setSteps((prev) => [...prev, { index: nextIdx, accountRole: 'member', text: '', delaySeconds: 0 }]);
  }
  function removeStep(i: number): void {
    setSteps((prev) => prev.filter((_, j) => j !== i));
  }

  async function submit(): Promise<void> {
    const draftSteps: SequenceStepDef[] = steps.map((s) => ({
      index: s.index,
      accountRole: s.accountRole,
      text: s.text,
      delaySeconds: s.delaySeconds,
    }));
    const err = validateSequenceDraft(name, draftSteps);
    if (err !== null) {
      setLocalError(err);
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      await props.onDefine({ name, steps: draftSteps });
      setName('');
      setSteps([{ index: 1, accountRole: 'member', text: '', delaySeconds: 0 }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="sequence-form" style={{ border: '1px solid #ddd', padding: '0.8rem' }}>
      <h3>序列定义</h3>
      <label>
        name：
        <input
          data-testid="seq-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {steps.map((s, i) => {
          const highlighted = props.highlightStepIndex !== null && s.index === props.highlightStepIndex;
          return (
            <li
              key={i}
              data-testid={`step-editor-${s.index}`}
              style={{
                padding: '0.4rem',
                marginBottom: '0.3rem',
                border: highlighted ? '2px solid #c00' : '1px solid #eee',
                background: highlighted ? '#fdecec' : undefined,
              }}
            >
              <label>
                index：
                <input
                  data-testid={`step-index-${i}`}
                  type="number"
                  style={{ width: '4rem' }}
                  value={s.index}
                  onChange={(e) => updateStep(i, { index: Number(e.target.value) })}
                />
              </label>{' '}
              <label>
                role：
                <select
                  data-testid={`step-role-${i}`}
                  value={s.accountRole}
                  onChange={(e) =>
                    updateStep(i, { accountRole: e.target.value === 'admin' ? 'admin' : 'member' })
                  }
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </label>{' '}
              <label>
                delaySeconds：
                <input
                  data-testid={`step-delay-${i}`}
                  type="number"
                  style={{ width: '5rem' }}
                  value={s.delaySeconds}
                  onChange={(e) => updateStep(i, { delaySeconds: Number(e.target.value) })}
                />
              </label>{' '}
              <button type="button" data-testid={`step-del-${i}`} onClick={() => removeStep(i)}>
                删
              </button>
              <div style={{ marginTop: '0.3rem' }}>
                <textarea
                  data-testid={`step-text-${i}`}
                  rows={2}
                  style={{ width: '100%' }}
                  placeholder="text（{key} 占位符由启动参数解析）"
                  value={s.text}
                  onChange={(e) => updateStep(i, { text: e.target.value })}
                />
              </div>
              {highlighted && (
                <div data-testid={`step-precheck-hit-${s.index}`} style={{ color: '#c00' }}>
                  预检未通过的占位符：{props.highlightKey !== null ? `{${props.highlightKey}}` : '?'}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <button type="button" data-testid="step-add" onClick={addStep}>
        + 加步骤
      </button>
      {localError !== null && (
        <p role="alert" style={{ color: '#b00' }}>
          {localError}
        </p>
      )}
      <button data-testid="seq-submit" disabled={busy} onClick={() => void submit()}>
        保存序列定义
      </button>
    </section>
  );
}
