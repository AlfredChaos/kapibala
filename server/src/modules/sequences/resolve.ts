// 占位符解析与预检（T-P6-01；DES/07 §2.1–§2.4 逐字 + B1 + 解读 #15/#25）。
// 解析规则：扫描正则 /\{([A-Za-z0-9_]+)\}/g；不匹配字符集的花括号（{-}、{a b}）按字面量。
// 合并语义（§2.2 逐字）：
//   cur = vars（值为 "" 的键视为未提供，即删除）
//   for step in steps(index 升序):
//     stepVars[i] 中 value ≠ "" 的项 → cur[key]=value, source[key]="step:<i>"
//     stepVars[i] 中 value = "" 的项 → 不改（继承当前值与来源）
//     resolved_vars[i]/var_sources[i] = 该步快照
// ""双语义（DES/07 §8 风险 1）：vars 的 ""=未提供（可致预检失败）；stepVars 的 ""=不改（继承）。
// 预检是纯计算无写（§2.4 第 1 步逐字）：任一 {key} 解析不到 → UNRESOLVED_PLACEHOLDER(stepIndex, key)，
// 按 index 升序首个失败步骤返回（S8 对照）。
import { AppError } from '../../http/plugins/errors.js';
import type { SequenceStepDef } from './define.js';

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

export interface ResolvedStep {
  readonly index: number;
  readonly accountRole: 'admin' | 'member';
  readonly textTemplate: string;
  readonly delaySeconds: number;
  /** 该步的变量取值快照（启动时封闭，DES/07 §8「每步 resolved_vars 启动时快照」） */
  readonly resolvedVars: Record<string, string>;
  /** 每个 key 的最初给出者："default"（vars）或 "step:<index>"（§2.2：沿用不改写来源） */
  readonly varSources: Record<string, string>;
}

export interface ResolveInput {
  readonly steps: readonly SequenceStepDef[];
  readonly vars: Record<string, string>;
  readonly stepVars: Record<string, Record<string, string>>;
}

/**
 * 推演 + 预检（纯计算无写）：返回按 index 升序的每步快照；
 * 任一占位符无取值 → AppError('UNRESOLVED_PLACEHOLDER', extra={stepIndex,key})。
 */
export function resolveSequenceSteps(input: ResolveInput): ResolvedStep[] {
  // cur 初值：vars 中 "" 视为未提供（删除）；来源记 "default"
  const cur: Record<string, string> = {};
  const source: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.vars)) {
    if (v !== '') {
      cur[k] = v;
      source[k] = 'default';
    }
  }
  const ordered = [...input.steps].sort((a, b) => a.index - b.index);
  const out: ResolvedStep[] = [];
  for (const step of ordered) {
    const override = input.stepVars[String(step.index)] ?? {};
    for (const [k, v] of Object.entries(override)) {
      if (v !== '') {
        cur[k] = v;
        source[k] = `step:${step.index}`;
      }
      // value === ""：这一步不改——继承 cur 与 source（B1 双语义）
    }
    const resolvedVars = { ...cur };
    const varSources = { ...source };
    out.push({
      index: step.index,
      accountRole: step.accountRole,
      textTemplate: step.text,
      delaySeconds: step.delaySeconds,
      resolvedVars,
      varSources,
    });
    // 预检（§2.4 第 1 步）：本步文本的每个 {key} 必须已在 cur 中
    for (const m of step.text.matchAll(PLACEHOLDER_RE)) {
      const key = m[1];
      if (key !== undefined && !(key in resolvedVars)) {
        throw new AppError('UNRESOLVED_PLACEHOLDER', `unresolved placeholder {${key}} at step ${step.index}`, {
          extra: { stepIndex: step.index, key },
        });
      }
    }
  }
  return out;
}
