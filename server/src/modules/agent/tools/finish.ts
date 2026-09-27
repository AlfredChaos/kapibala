// finish 工具（T-P4-08；DES/06 §7.4 逐字 + REQ §2.2 结束节）。
// 逐字：不调 /agent/turn；step kind='final'、result_summary='ok'；
// run finished/final、summary=input.summary。
// executor 的 end_run 分支据此收束（同 turn 内 end_turn 的等效路径）。
import type { ToolOutcome } from '../executor.js';

export interface FinishInput {
  readonly summary: string;
}

export function execFinish(input: unknown): Extract<ToolOutcome, { type: 'end_run' }> {
  const summary = (input as Record<string, unknown> | undefined)?.['summary'];
  return {
    type: 'end_run',
    status: 'finished',
    endReason: 'final',
    summary: typeof summary === 'string' ? summary : '',
    resultSummary: 'ok', // §7.4：result_summary='ok' 逐字
    stepKind: 'final',
  };
}
