// 序列启动（T-P6-02；DES/07 §2.4 启动事务逐字 + §2.4 群前置 + REQ §2.3 + S7/S8）。
// 事务时序（逐字）：
//   0. 群前置：group.status 仅 'active' 可启动；unreachable/left → 409 GROUP_UNREACHABLE（解读 #3）；
//      群不存在 → 404 GROUP_NOT_FOUND。
//   1. 预检（纯计算无写——resolveSequenceSteps 在**任何 INSERT 之前**跑完）；
//   2. INSERT sequence_run（ON CONFLICT 部分唯一索引空转 → 409 SEQUENCE_ALREADY_RUNNING，S7：
//      并发恰好一个 201 一个 409——DB 仲裁，多实例成立，不用进程内锁）；
//   3. INSERT 全部 sequence_run_step（resolved_vars/var_sources 快照；
//      第 1 步 scheduled_at = now() + delaySeconds——其余步骤 NULL，等前步发出再排 §3.1）；
//   4. INSERT ws_event(sequence_run)。
// → 201 { runId }。预检失败抛 AppError 在事务外先行，零 INSERT（S8：之后可正常启动）。
import type { Pool } from 'pg';
import { tx } from '../../db/tx.js';
import { AppError } from '../../http/plugins/errors.js';
import { resolveSequenceSteps } from './resolve.js';
import type { SequenceStepDef } from './define.js';

export interface StartSequenceRunInput {
  readonly sequenceId: string;
  readonly vars: Record<string, string>;
  readonly stepVars: Record<string, Record<string, string>>;
}

function asStringMap(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function asStepVars(v: unknown): Record<string, Record<string, string>> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'object' && val !== null) out[k] = asStringMap(val);
  }
  return out;
}

export async function startSequenceRun(
  pool: Pool,
  groupId: string,
  body: unknown,
): Promise<{ runId: string }> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const sequenceId = b['sequenceId'];
  if (typeof sequenceId !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'sequenceId is required');
  }
  const vars = asStringMap(b['vars']);
  const stepVars = asStepVars(b['stepVars']);

  // 群前置（§2.4 逐字 + 解读 #3）：仅 active 可启动
  const { rows: groups } = await pool.query<{ status: string }>(
    `SELECT status FROM "group" WHERE id=$1`, [groupId]);
  const group = groups[0];
  if (group === undefined) {
    throw new AppError('GROUP_NOT_FOUND', `unknown group: ${groupId}`);
  }
  if (group.status !== 'active') {
    throw new AppError('GROUP_UNREACHABLE', `group ${groupId} is ${group.status}; sequence cannot start`, {
      statusCode: 409,
    });
  }

  // 序列定义取回（快照源；不存在 → VALIDATION_ERROR）
  const { rows: seqs } = await pool.query<{ steps: SequenceStepDef[] }>(
    `SELECT steps FROM "sequence" WHERE id=$1`, [sequenceId]);
  const seq = seqs[0];
  if (seq === undefined) {
    throw new AppError('VALIDATION_ERROR', `unknown sequence: ${sequenceId}`);
  }

  // 步骤 1：预检——纯计算无写，在任何 INSERT 之前（§2.4 逐字）。失败抛 422 直接出事务。
  const resolved = resolveSequenceSteps({ steps: seq.steps, vars, stepVars });

  // 步骤 2–4：单事务落 run + 全部 step 快照 + ws_event
  const runId = await tx(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status, vars, step_vars)
       VALUES (gen_random_uuid(), $1, $2, 'running', $3::jsonb, $4::jsonb)
       ON CONFLICT (group_id) WHERE status = 'running' DO NOTHING
       RETURNING id`,
      [groupId, sequenceId, JSON.stringify(vars), JSON.stringify(stepVars)],
    );
    const id = rows[0]?.id;
    if (id === undefined) {
      // S7：并发启动——部分唯一索引仲裁，多实例成立
      throw new AppError('SEQUENCE_ALREADY_RUNNING', `group ${groupId} already has a running sequence`);
    }
    for (const [i, step] of resolved.entries()) {
      await client.query(
        `INSERT INTO sequence_run_step
           (run_id, "index", status, account_role, text_template, delay_seconds,
            scheduled_at, resolved_vars, var_sources)
         VALUES ($1, $2, 'pending', $3, $4, $5,
                 CASE WHEN $6 = 0 THEN now() + $5::int * interval '1 second' ELSE NULL END,
                 $7::jsonb, $8::jsonb)`,
        [
          id, step.index, step.accountRole, step.textTemplate, step.delaySeconds,
          i, // 第 1 步（i=0）唯一排期
          JSON.stringify(step.resolvedVars), JSON.stringify(step.varSources),
        ],
      );
    }
    await client.query(`INSERT INTO ws_event (type, payload) VALUES ('sequence_run', $1::jsonb)`, [
      JSON.stringify({ runId: id, groupId, status: 'running', currentStepIndex: 0 }),
    ]);
    return id;
  });
  return { runId };
}
