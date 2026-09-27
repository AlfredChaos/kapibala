// agent run 崩溃恢复（T-P4-11；DES/06 §9.1 四分支逐字 + §9.3 兜底 + REQ A5-8）。
// 恢复 = 步状态注入级（kill -9 级归 T-P7-03）：扫描 agent_run WHERE status='running'，
// 对每个 run：墙钟按剩余预算重锚（wall_deadline_at = now() + (60000 - wall_consumed_ms)，
// 停机不计——resumedWallDeadline 承担 §5 公式逐字）→ 交 executor.startRun 续传。
// 断点分支在 executor turnLoop 内（resume 段）：最后 step 的 status 决定动作——
//   done/无 → 预算预检后开新轮；
//   turn_dispatched → 用 dispatch_payload 快照重发同轮（同 runId，§12 无状态全量历史语义）；
//   turn_received → 从 raw_response 续推进（校验结果已落库）；
//   tool_dispatched → 反查外部现状绝不重放：send_message 按 client_msg_id 查 message；
//   kick_user 按 kick_target 查成员列表（E5/§9.2 逐字）。
// 互斥：executor 的 advisory lock 抢不到 = 别实例在跑 → 跳过（§9.3）；lease 由 executor 自管。
import type { Pool } from 'pg';
import { resumedWallDeadline } from './budget.js';
import { startAgentRun } from './trigger.js';

export interface AgentRecoveryDeps {
  readonly pool: Pool;
}

/**
 * 恢复扫描体（RECOVERY_SCANS 'agent-runs' 的实现）：重锚墙钟 + 续传排队。
 * 返回接管的 run 数（观测用）。
 */
export async function recoverAgentRuns(deps: AgentRecoveryDeps): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string; wall_consumed_ms: string }>(
    `SELECT id, wall_consumed_ms FROM agent_run WHERE status='running'`,
  );
  let taken = 0;
  for (const run of rows) {
    // 墙钟重锚（停机不计）：剩余 = 60000 - consumed；恢复时刻为锚点（§9.4 同公式）
    const deadline = resumedWallDeadline(Number(run.wall_consumed_ms), new Date());
    await deps.pool.query(
      `UPDATE agent_run SET wall_deadline_at=$2, resume_at=now(), updated_at=now()
       WHERE id=$1 AND status='running'`,
      [run.id, deadline],
    );
    // executor.startRun 内部 advisory lock 抢不到即跳过（§9.3 互斥逐字——无需预检锁）
    startAgentRun(run.id);
    taken += 1;
  }
  return taken;
}
