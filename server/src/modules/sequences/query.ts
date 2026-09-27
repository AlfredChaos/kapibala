// 序列 run 查询（T-P6-05；REQ §2.3 GET /api/sequence-runs/:id 行 + DES/07 §6 响应组装逐字）。
// 组装：{ status, currentStepIndex, steps: [{ index, status, scheduledAt, sentAt, clientMsgId,
//   resolvedVars, varSources }] }——时间字段 ISO 8601 UTC、无值 null（未排期 scheduledAt=null、
//   未发出 sentAt=null）。resolvedVars/varSources 为启动时快照原样透出（§8 设计取舍）。
import type { Pool } from 'pg';

export interface SequenceStepView {
  readonly index: number;
  readonly status: string;
  readonly scheduledAt: string | null;
  readonly sentAt: string | null;
  readonly clientMsgId: string | null;
  readonly resolvedVars: Record<string, string>;
  readonly varSources: Record<string, string>;
}

export interface SequenceRunView {
  readonly id: string;
  readonly groupId: string;
  readonly status: string;
  readonly currentStepIndex: number;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly steps: SequenceStepView[];
}

interface RunRow {
  readonly id: string;
  readonly group_id: string;
  readonly status: string;
  readonly current_step_index: number;
  readonly created_at: Date;
  readonly ended_at: Date | null;
}

interface StepRow {
  readonly index: number;
  readonly status: string;
  readonly scheduled_at: Date | null;
  readonly sent_at: Date | null;
  readonly client_msg_id: string | null;
  readonly resolved_vars: Record<string, string>;
  readonly var_sources: Record<string, string>;
}

/** GET /api/sequence-runs/:id；不存在 → undefined（路由层 404） */
export async function fetchSequenceRun(pool: Pool, runId: string): Promise<SequenceRunView | undefined> {
  const { rows: runs } = await pool.query<RunRow>(
    `SELECT id, group_id, status, current_step_index, created_at, ended_at
     FROM sequence_run WHERE id=$1`,
    [runId],
  );
  const run = runs[0];
  if (run === undefined) return undefined;
  const { rows: steps } = await pool.query<StepRow>(
    `SELECT "index", status, scheduled_at, sent_at, client_msg_id, resolved_vars, var_sources
     FROM sequence_run_step WHERE run_id=$1 ORDER BY "index" ASC`,
    [runId],
  );
  return {
    id: run.id,
    groupId: run.group_id,
    status: run.status,
    currentStepIndex: run.current_step_index,
    createdAt: run.created_at.toISOString(),
    endedAt: run.ended_at?.toISOString() ?? null,
    steps: steps.map((s) => ({
      index: s.index,
      status: s.status,
      scheduledAt: s.scheduled_at?.toISOString() ?? null,
      sentAt: s.sent_at?.toISOString() ?? null,
      clientMsgId: s.client_msg_id,
      resolvedVars: s.resolved_vars,
      varSources: s.var_sources,
    })),
  };
}
