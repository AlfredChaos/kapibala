// 序列域只读查询：run 视图（T-P6-05；REQ §2.3 GET /api/sequence-runs/:id 行 + DES/07 §6 响应组装逐字）
// 与定义列表（GET /api/sequences，见本文件末节 + 解释声明 #27）。
// 组装：{ status, currentStepIndex, steps: [{ index, status, scheduledAt, sentAt, clientMsgId,
//   resolvedVars, varSources }] }——时间字段 ISO 8601 UTC、无值 null（未排期 scheduledAt=null、
//   未发出 sentAt=null）。resolvedVars/varSources 为启动时快照原样透出（§8 设计取舍）。
import type { Pool } from 'pg';
import type { SequenceStepDef } from './define.js';

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

// 序列定义列表（GET /api/sequences；design/15 §2 页面 5 数据源行「GET（定义列表）」——QR §1 端点表
// 未列，按契约空隙补全，见 design/README 解释声明 #27）。形状基准 = DES/02 §8.1 sequence 表
// （id / name / steps jsonb / created_at）；steps 为定义时原样入库的快照（DES/07 §1），
// 不重排不复校验。createdAt 对外 ISO 8601 UTC（宪法 §3-6）。
export interface SequenceListItem {
  readonly id: string;
  readonly name: string;
  readonly steps: SequenceStepDef[];
  readonly createdAt: string;
}

interface SequenceRow {
  readonly id: string;
  readonly name: string;
  readonly steps: SequenceStepDef[];
  readonly created_at: Date;
}

/**
 * GET /api/sequences 的域查询：全部定义。
 * 排序 created_at ASC, id ASC——created_at 同刻（同事务批量写入）时按 id 兜底，顺序对
 * 插入次序无关，前端页面 5 的列表位置稳定。
 */
export async function listSequences(pool: Pool): Promise<SequenceListItem[]> {
  const { rows } = await pool.query<SequenceRow>(
    `SELECT id, name, steps, created_at FROM "sequence" ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    steps: row.steps,
    createdAt: row.created_at.toISOString(),
  }));
}
