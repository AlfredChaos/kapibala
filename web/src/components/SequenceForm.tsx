// 序列定义表单（T-P6-07；DES/15 §2 页面 5「定义表单 steps 编辑」、DES/07 §1）。
// steps 编辑：逐行 index/accountRole/text/delaySeconds，可增删行；客户端校验逐字对齐
// server/modules/sequences/define.ts（index 正整数唯一、accountRole∈{admin,member}、
// text 1..TEXT_MAX_LENGTH、delaySeconds 非负整数）——前端先行拦截，服务端仍真值。
// 预检失败 422（stepIndex/key）由页面回调 onPrecheckError 定位行（页面 5 逐字「高亮出错步骤行」）。
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { TEXT_MAX_LENGTH } from '../lib/text-limits.js';
import type { SequenceStepDef } from '../lib/api-types.js';
import { Button, Field, Input, Select, Textarea } from '../ui/primitives.js';
import { cx } from '../ui/cx.js';

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
    <section
      data-testid="sequence-form"
      className="rounded-lg border border-hairline bg-surface-1 p-5"
    >
      <h3 className="mb-4 text-sm font-medium text-ink-muted">序列定义</h3>
      <Field label="name" className="mb-4 max-w-sm">
        <Input
          data-testid="seq-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => {
          const highlighted =
            props.highlightStepIndex !== null && s.index === props.highlightStepIndex;
          return (
            <li
              key={i}
              data-testid={`step-editor-${s.index}`}
              className={cx(
                'rounded-md border p-3 transition-colors duration-150',
                highlighted
                  ? 'border-danger/60 bg-danger/10'
                  : 'border-hairline bg-surface-2/40',
              )}
            >
              <div className="flex flex-wrap items-end gap-3">
                <Field label="index">
                  <Input
                    data-testid={`step-index-${i}`}
                    type="number"
                    className="w-20"
                    value={s.index}
                    onChange={(e) => updateStep(i, { index: Number(e.target.value) })}
                  />
                </Field>
                <Field label="role">
                  <Select
                    data-testid={`step-role-${i}`}
                    className="w-28"
                    value={s.accountRole}
                    onChange={(e) =>
                      updateStep(i, {
                        accountRole: e.target.value === 'admin' ? 'admin' : 'member',
                      })
                    }
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </Select>
                </Field>
                <Field label="delaySeconds">
                  <Input
                    data-testid={`step-delay-${i}`}
                    type="number"
                    className="w-24"
                    value={s.delaySeconds}
                    onChange={(e) => updateStep(i, { delaySeconds: Number(e.target.value) })}
                  />
                </Field>
                <button
                  type="button"
                  data-testid={`step-del-${i}`}
                  onClick={() => removeStep(i)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-danger/40 px-2 py-1.5 text-xs text-danger transition-colors duration-150 hover:bg-danger/10"
                >
                  <Trash2 size={12} aria-hidden />
                  删
                </button>
              </div>
              <div className="mt-2.5">
                <Textarea
                  data-testid={`step-text-${i}`}
                  rows={2}
                  placeholder="text（{key} 占位符由启动参数解析）"
                  value={s.text}
                  onChange={(e) => updateStep(i, { text: e.target.value })}
                />
              </div>
              {highlighted && (
                <div
                  data-testid={`step-precheck-hit-${s.index}`}
                  className="mt-2 rounded-sm bg-danger/15 px-2 py-1 text-xs text-danger"
                >
                  预检未通过的占位符：
                  {props.highlightKey !== null ? `{${props.highlightKey}}` : '?'}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" data-testid="step-add" onClick={addStep}>
          <Plus size={13} aria-hidden />
          加步骤
        </Button>
      </div>
      {localError !== null && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {localError}
        </p>
      )}
      <div className="mt-4">
        <Button
          variant="primary"
          data-testid="seq-submit"
          disabled={busy}
          onClick={() => void submit()}
        >
          保存序列定义
        </Button>
      </div>
    </section>
  );
}
