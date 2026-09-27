// 序列 run 重启恢复（T-P6-04；DES/07 §5 流程图逐字 + B1 重启行 + I11）。
// 恢复扫描 sequence_run WHERE status='running'：对每个 run 重建链状态——
// 链头 = 按 index 升序最早未终态步骤（pending/accepted）。
// 链头四分支（§5 逐字）：
//   H1a 已创建消息且在途（message ∈ queued/accepted/unknown）→ 不重排，等落定
//       （sent→推进/failed→步骤 failed/cancelled→skipped，各有联动落点）；
//   H1b pending ∧ scheduled_at IS NULL（未排期，等前驱事件）→ 保持（正常链式）；
//   H1c pending ∧ scheduled_at <= now（已过期未创建消息）→ **只重排链头**：
//       scheduled_at = now() + 链头.delaySeconds，其后所有未终态步骤 scheduled_at=NULL
//       （B1「只重排最早一个过期步骤…不能一次性全部发出」逐字；now()+delay 语义 =
//       把「过期未发」当作「重启时刻才到期」重新排队，防重启风暴）；
//   H1d pending ∧ scheduled_at > now（未到期）→ 保持原排期。
// 条件更新吸收幂等：重跑扫描无事（H1c 重排后 scheduled_at 重新变未来 → H1d）。
import type { Pool } from 'pg';

export interface SequenceRecoveryDeps {
  readonly pool: Pool;
}

interface ChainHead {
  readonly id: number;
  readonly index: number;
  readonly status: string;
  readonly delay_seconds: number;
  readonly scheduled_at: Date | null;
  readonly client_msg_id: string | null;
}

/** 返回重排的 run 数（观测用）。 */
export async function recoverSequenceRuns(deps: SequenceRecoveryDeps): Promise<number> {
  const { rows: runs } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM sequence_run WHERE status='running'`,
  );
  let rescheduled = 0;
  for (const run of runs) {
    // 链头 = 最早未终态步骤（pending/accepted；sent/skipped/failed 已终态）
    const { rows: heads } = await deps.pool.query<ChainHead>(
      `SELECT id, "index", status, delay_seconds, scheduled_at, client_msg_id
       FROM sequence_run_step
       WHERE run_id=$1 AND status IN ('pending','accepted')
       ORDER BY "index" LIMIT 1`,
      [run.id],
    );
    const head = heads[0];
    if (head === undefined) continue; // 全终态（正常路径已 finished/failed；兜底跳过）

    // H1a：关联消息在途 → 等落定，不重排
    if (head.client_msg_id !== null) {
      const { rows: msg } = await deps.pool.query<{ inflight: boolean }>(
        `SELECT delivery_status IN ('queued','accepted','unknown') AS inflight
         FROM message WHERE client_msg_id=$1`,
        [head.client_msg_id],
      );
      if (msg[0]?.inflight === true) continue;
      // 消息已终态但步骤没落（丢失写）——由下一轮 tick 的终态联动兜底？不：终态联动靠
      // dispatcher/finalize 同事务，漏写即孤儿。消息终态时步骤应为终态；防御：跳过不处理。
      continue;
    }

    if (head.scheduled_at === null) continue; // H1b：未排期等前驱
    if (head.scheduled_at.getTime() > Date.now()) continue; // H1d：未到期保持

    // H1c：已过期未创建消息 → 只重排链头；其后所有未终态步骤 scheduled_at=NULL
    await deps.pool.query(
      `UPDATE sequence_run_step
       SET scheduled_at = CASE WHEN id=$2 THEN now() + delay_seconds * interval '1 second' ELSE NULL END,
           updated_at = now()
       WHERE run_id=$1 AND status='pending'`,
      [run.id, head.id],
    );
    rescheduled += 1;
  }
  return rescheduled;
}
