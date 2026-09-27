// 取消检查点（T-P4-12；DES/06 §10 X-2 修订逐字 + REQ A5-10）。
// X-2 后唯一检查点：**每步循环开始前、发起本轮 turn 之前**（executor turnLoop 中
// turn_dispatched 重发 / 新步 dispatch 两条通路之前）：
//   SELECT status, agent_enabled FROM group WHERE id=?
//   IF status='unreachable' OR agent_enabled=false THEN
//     事务{run: status='cancelled', end_reason='cancelled'; ws_event(agent_run)}
// 此刻无进行中的步，无需补落 step——进行中的步（tool_dispatched 补 tool_result /
// turn_received 续推进）不属于「发起 turn」，先让它完整落库，下一轮顶部再取消
// （A5-10「当前这一步结束后终止」逐字；效果型工具执行前的第二检查点已删——
// unreachable 的发送拦截由 GATE1 以 GROUP_UNREACHABLE 错误 tool_result 收尾当前步，
// 保证会话历史无悬挂 tool_use）。
// 触发源（GROUP_WRITE_FORBIDDEN 级联 / PATCH 关闭开关）只改群状态，不直接动 run——
// 群状态是持久化真值，executor 检查点发现后自行终止，崩溃安全。
import type { PoolClient } from 'pg';
import { endAgentRun } from './end-run.js';

export interface CancelGateVerdict {
  readonly cancelled: boolean;
  /** cancelled 时有积压待办可能拉起的下一 run（同 endAgentRun 语义） */
  readonly nextRunId?: string;
}

/**
 * 循环顶部取消判定（调用方已持有事务 client；判据逐字 §10：
 * status='unreachable' OR agent_enabled=false → cancelled）。
 */
export async function agentCancelGate(
  client: PoolClient,
  runId: string,
  groupId: string,
): Promise<CancelGateVerdict> {
  const { rows } = await client.query<{ status: string; agent_enabled: boolean }>(
    `SELECT status, agent_enabled FROM "group" WHERE id=$1`,
    [groupId],
  );
  const group = rows[0];
  if (group === undefined || (group.status !== 'unreachable' && group.agent_enabled)) {
    return { cancelled: false };
  }
  const end = await endAgentRun(client, {
    runId,
    status: 'cancelled',
    endReason: 'cancelled',
  });
  return { cancelled: true, nextRunId: end.nextRunId };
}
