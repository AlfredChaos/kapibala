// agent run 结束事务 END2（T-P4-04；DES/06 §2 END2 框四步逐字 + R-B 守卫 + A5-1）。
// 同一事务内四步：1) 旧 run 置终态（lease_until=NULL——§2.1 ENDLEASE）；
// 2) SELECT 积压；3) 非空时先查守卫 group.status='active' AND agent_enabled=true
//    （与入站触发 05 §4.4 同判）——守卫过：建新 run（triggerMessages=全部积压按 sentAt
//    升序）+ 删积压；守卫不过：积压保留不删、不补建（R-B：重新启用后由 SWEEP 补建，
//    避免 unreachable/开关关闭期间「出生即取消」的 run）；4) ws_event×2（旧终态帧恒发；
//    新 running 帧仅守卫过时）。事务提交后由调用方 startAgentRun 拾取新 run（占位缝）。
import type { PoolClient } from 'pg';
import { createRunFromBacklog, fetchGroupAgentContext, guardPasses } from './trigger.js';

export interface EndRunResult {
  /** 新补建 run 的 id（守卫过且积压非空）；调用方提交事务后据此拾取 */
  readonly nextRunId?: string;
  readonly hadBacklog: boolean;
  readonly guardPassed: boolean;
}

/**
 * END2 事务体（client 即事务载体——终态/积压/新 run/两帧同事务，A5-1 原子语义）。
 * 幂等：run 已终态则直接返回（重复结束不双重补建、不重发帧）。
 */
export async function endAgentRun(
  client: PoolClient,
  args: {
    runId: string;
    status: 'finished' | 'failed' | 'blocked' | 'cancelled';
    endReason: 'final' | 'budget_exhausted' | 'wall_clock' | 'protocol_errors' | 'audit_blocked' | 'cancelled';
    summary?: string;
  },
): Promise<EndRunResult> {
  // 1) 旧 run 终态 + 租约释放（FOR UPDATE 取 group_id 兼锁行，防并发重复结束）
  const { rows } = await client.query<{ group_id: string }>(
    `UPDATE agent_run SET status=$2, end_reason=$3, summary=$4, lease_until=NULL,
            ended_at=now(), updated_at=now()
     WHERE id=$1 AND status='running' RETURNING group_id`,
    [args.runId, args.status, args.endReason, args.summary ?? null],
  );
  const groupId = rows[0]?.group_id;
  if (groupId === undefined) {
    return { hadBacklog: false, guardPassed: false }; // 已终态/未知 run：幂等吸收
  }
  // 4a) 旧终态帧（恒发，DES/08：run 每次状态变化）
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('agent_run', $1::jsonb)", [
    JSON.stringify({ runId: args.runId, groupId, status: args.status, endReason: args.endReason }),
  ]);

  // 2) 积压探测（createRunFromBacklog 内重 SELECT；此处仅判「有无」驱动守卫与返回值）
  const backlog = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM agent_trigger_queue WHERE group_id=$1',
    [groupId],
  );
  const hadBacklog = (backlog.rows[0]?.n ?? 0) > 0;
  if (!hadBacklog) {
    return { hadBacklog: false, guardPassed: false };
  }

  // 3) R-B 守卫（END2 第 3 步必在）：不过 → 保留积压不删、不建 run
  const group = await fetchGroupAgentContext(client, groupId);
  if (!guardPasses(group)) {
    return { hadBacklog: true, guardPassed: false };
  }
  const nextRunId = await createRunFromBacklog(client, {
    id: groupId,
    auto_kick_enabled: group?.auto_kick_enabled ?? false,
  });
  return { hadBacklog: true, guardPassed: true, nextRunId };
}
