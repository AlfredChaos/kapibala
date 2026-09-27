// 群状态写函数（T-P3-08；DES/04 §1 状态机 + §5 GWF 级联逐字、A2 GWF 行）。
// 唯一 canonical 级联点：GROUP_WRITE_FORBIDDEN（同步错误或 message_failed 事件）与各
// 调用方（出站 dispatcher、事件 handler）都经 applyGroupUnreachableCascade，单事务执行。
// 级联内容（§5 表逐字）：group active→unreachable（条件更新幂等）→ running 序列 stopped +
// ws_event(sequence_run)（每 run 一帧）→ running agent run 的「取消请求」= 群态本身
// （schema 无独立取消标志列；run executor 在步结束检查点读 group.status/agent_enabled 收口，
// X-2：不在此事务打断当前步）→ account 表不触碰（A2）。
// unreachable 不回转（§1 解读 #2）：无 active 恢复路径。
import type { PoolClient } from 'pg';

export interface GroupCascade {
  /** 本次是否发生 active→unreachable 跃迁（幂等：已 unreachable 时为 false） */
  readonly becameUnreachable: boolean;
  /** 被停下的 running 序列 run（供调用方生成 ws_event(sequence_run) 帧的 per-run 负载） */
  readonly stoppedRuns: ReadonlyArray<{ id: string; current_step_index: number }>;
}

/**
 * GROUP_WRITE_FORBIDDEN 单事务级联（DES/04 §5）。调用方在自身事务内调用。
 * agent run 不写状态：「取消请求」由 group.status='unreachable' 承载——
 * 执行器步结束检查点（DES/06 §9）读群态即视为取消请求（「当前这一步结束后终止」X-2）。
 */
export async function applyGroupUnreachableCascade(
  client: PoolClient,
  groupId: string,
): Promise<GroupCascade> {
  const g = await client.query(
    `UPDATE "group" SET status='unreachable', updated_at=now()
     WHERE id=$1 AND status='active'`,
    [groupId],
  );
  const stopped = await client.query<{ id: string; current_step_index: number }>(
    `UPDATE sequence_run SET status='stopped', ended_at=now(), updated_at=now()
     WHERE group_id=$1 AND status='running'
     RETURNING id, current_step_index`,
    [groupId],
  );
  return { becameUnreachable: g.rowCount !== 0, stoppedRuns: stopped.rows };
}
