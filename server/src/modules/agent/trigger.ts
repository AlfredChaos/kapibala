// agent 触发域共享原语（T-P4-04；DES/06 §2 全文逐字 + DES/05 §4.4 守卫同判 + R-B 修订）。
// 三处共用一个守卫与一个「积压→新 run」构造器，保证 END2/SWEEP/入站触发语义完全同源：
//   - groupAgentContext()：守卫 + trigger_context 素材一次取回（status/agent_enabled/auto_kick_enabled）；
//   - createRunFromBacklog()：END2 第 3 步与 SWEEP 共用的补建体——DELETE 积压行 +
//     INSERT agent_run（triggerMessages=全部积压、按 sentAt 升序）+ ws_event(running)，同事务；
//   - startAgentRun()：executor 拾取占位缝（T-P4-05 接管 advisory lock/租约/并发闸）。
// R-B 定稿：守卫不过 → 积压行保留不删、不补建 run；agentEnabled 重新打开后由 SWEEP 补建
// （README 解释声明 #26「重新启用后补处理」的唯一实现点）。
import type { PoolClient } from 'pg';
import { AGENT_WALL_CLOCK_MS } from '../../constants.js';

/** executor 拾取占位（T-P4-05 接管：advisory lock + 并发闸 + 租约，§2.1） */
export interface AgentRunStarter {
  startRun(runId: string): void;
}

let starter: AgentRunStarter | undefined;

/** boot 接线（index.ts）；占位实现仅记日志，T-P4-05 换真 executor */
export function setAgentRunStarter(next: AgentRunStarter | undefined): void {
  starter = next;
}

/** run 创建成功后调用（END2/SWEEP/入口触发同缝）；未接线 = 静默占位 */
export function startAgentRun(runId: string): void {
  starter?.startRun(runId);
}

export interface AgentGroupRow {
  readonly status: string;
  readonly agent_enabled: boolean;
  readonly auto_kick_enabled: boolean;
}

/**
 * 守卫素材一次取回（END2 第 3 步 / SWEEP / 补建前复查共用）。
 * 守卫判据逐字：group.status='active' AND agent_enabled=true（与入站触发 05 §4.4 同判）。
 */
export async function fetchGroupAgentContext(
  client: PoolClient,
  groupId: string,
): Promise<AgentGroupRow | undefined> {
  const { rows } = await client.query<AgentGroupRow>(
    `SELECT status, agent_enabled, auto_kick_enabled FROM "group" WHERE id=$1`,
    [groupId],
  );
  return rows[0];
}

export function guardPasses(group: AgentGroupRow | undefined): boolean {
  return group !== undefined && group.status === 'active' && group.agent_enabled;
}

interface BacklogRow {
  readonly message_id: string;
  readonly msg_id: string | null;
  readonly sender_platform_user_id: string;
  readonly text: string;
  readonly sent_at: Date;
}

/**
 * 积压 → 新 run（END2 第 3 步「守卫过」分支与 SWEEP 共用；调用方已保证守卫过且在同一事务内）。
 * triggerMessages=全部积压消息按 sentAt 升序（A5-1「立即创建下一次 run…全部放进」）；
 * 返回新 runId；积压为空返回 undefined（不删不建，调用方据此跳过 ws_event×2 的第二帧）。
 */
export async function createRunFromBacklog(
  client: PoolClient,
  group: { id: string; auto_kick_enabled: boolean },
): Promise<string | undefined> {
  const { rows: backlog } = await client.query<BacklogRow>(
    `SELECT q.message_id, m.msg_id, m.sender_platform_user_id, m.text, m.sent_at
     FROM agent_trigger_queue q JOIN message m ON m.id = q.message_id
     WHERE q.group_id=$1
     ORDER BY m.sent_at ASC, q.id ASC`, // sentAt 升序逐字；同毫秒按入队序稳定
    [group.id],
  );
  if (backlog.length === 0) {
    return undefined;
  }
  const puids = await client.query<{ platform_user_id: string }>(
    'SELECT platform_user_id FROM account WHERE platform_user_id IS NOT NULL',
  );
  const triggerContext = {
    groupId: group.id,
    triggerMessages: backlog.map((b) => ({
      msgId: b.msg_id,
      senderPlatformUserId: b.sender_platform_user_id,
      text: b.text,
      sentAt: (b.sent_at as Date).toISOString(),
    })),
    policy: { autoKickEnabled: group.auto_kick_enabled },
    ownPlatformUserIds: puids.rows.map((r) => r.platform_user_id),
  };
  // 先建 run 后删积压：极端并发下 DO NOTHING 命中冲突时返回 undefined，积压行原样保留
  const run = await client.query<{ id: string }>(
    `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
     VALUES (gen_random_uuid(), $1, 'running', $2::jsonb, now() + $3 * interval '1 millisecond')
     ON CONFLICT (group_id) WHERE status = 'running' DO NOTHING
     RETURNING id`,
    [group.id, JSON.stringify(triggerContext), AGENT_WALL_CLOCK_MS],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) {
    return undefined;
  }
  await client.query('DELETE FROM agent_trigger_queue WHERE group_id=$1', [group.id]);
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('agent_run', $1::jsonb)", [
    JSON.stringify({ runId, groupId: group.id, status: 'running', endReason: null }),
  ]);
  return runId;
}
