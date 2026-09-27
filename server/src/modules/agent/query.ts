// agent-runs 查询（T-P4-13；REQ §2.3 两行逐字 + DES/06 §11）。
// 映射规约（逐字）：
//   run 字段：{id, groupId, status, endReason, summary} + 时间列 ISO 8601 UTC；
//     endReason 仅 status≠'running' 时非 null（列约束直接映射——DB CHECK 已保证，
//     但 running 行强制再盖 null，防直写绕过）。
//   steps[] 按 seq：{kind, toolUseId, name, input, resultSummary, isError, errorCode,
//     auditVerdict, rawResponse}——协议错误步的 toolUseId/name/input 为 null（DB 即 null，
//     查询层原样透出）；rawResponse ≤2KB 与 resultSummary ≤200 字由写路径保证，
//     查询层不再截断。
//   列表：GET /api/groups/:id/agent-runs → ORDER BY created_at DESC LIMIT 20，不含 steps。
// 时间：timestamptz → ISO 8601 UTC 串（pg Date → toISOString）；无值 → null。
import type { Pool } from 'pg';

export interface AgentRunStepView {
  readonly seq: number;
  readonly kind: string;
  readonly toolUseId: string | null;
  readonly name: string | null;
  readonly input: unknown;
  readonly resultSummary: string | null;
  readonly isError: boolean;
  readonly errorCode: string | null;
  readonly auditVerdict: string | null;
  readonly rawResponse: string | null;
}

export interface AgentRunView {
  readonly id: string;
  readonly groupId: string;
  readonly status: string;
  readonly endReason: string | null;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface AgentRunDetailView extends AgentRunView {
  readonly steps: AgentRunStepView[];
}

interface RunRow {
  readonly id: string;
  readonly group_id: string;
  readonly status: string;
  readonly end_reason: string | null;
  readonly summary: string | null;
  readonly created_at: Date;
  readonly ended_at: Date | null;
}

interface StepRow {
  readonly seq: number;
  readonly kind: string;
  readonly tool_use_id: string | null;
  readonly name: string | null;
  readonly input: unknown;
  readonly result_summary: string | null;
  readonly is_error: boolean;
  readonly error_code: string | null;
  readonly audit_verdict: string | null;
  readonly raw_response: string | null;
}

function toRunView(row: RunRow): AgentRunView {
  return {
    id: row.id,
    groupId: row.group_id,
    status: row.status,
    // 「仅 status ≠ running 时有值」逐字：running 行强制 null（防列直写绕过语义）
    endReason: row.status === 'running' ? null : row.end_reason,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

/** GET /api/agent-runs/:id：run + steps[]（seq 升序）；不存在 → undefined（路由层 404） */
export async function fetchAgentRun(pool: Pool, runId: string): Promise<AgentRunDetailView | undefined> {
  const { rows: runs } = await pool.query<RunRow>(
    `SELECT id, group_id, status, end_reason, summary, created_at, ended_at
     FROM agent_run WHERE id=$1`,
    [runId],
  );
  const run = runs[0];
  if (run === undefined) return undefined;
  const { rows: steps } = await pool.query<StepRow>(
    `SELECT seq, kind, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response
     FROM agent_run_step WHERE run_id=$1 ORDER BY seq ASC`,
    [runId],
  );
  return {
    ...toRunView(run),
    steps: steps.map((s) => ({
      seq: s.seq,
      kind: s.kind,
      toolUseId: s.tool_use_id,
      name: s.name,
      input: s.input,
      resultSummary: s.result_summary,
      isError: s.is_error,
      errorCode: s.error_code,
      auditVerdict: s.audit_verdict,
      rawResponse: s.raw_response,
    })),
  };
}

/** GET /api/groups/:id/agent-runs：最近 20 条（ORDER BY created_at DESC LIMIT 20），不含 steps */
export async function listAgentRuns(pool: Pool, groupId: string): Promise<AgentRunView[]> {
  const { rows } = await pool.query<RunRow>(
    `SELECT id, group_id, status, end_reason, summary, created_at, ended_at
     FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [groupId],
  );
  return rows.map(toRunView);
}
