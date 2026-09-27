// 群查询组装（T-P3-08；DES/04 §5 逐字 + REQ §2.3 群行）。
// 输出形状（§5 逐字）：{ id, gatewayGroupId, status, creatorAccountId, agentEnabled,
// autoKickEnabled, members: [{accountId,platformUserId,role}], activeSequenceRunId,
// activeAgentRunId }。口径：members = 活跃服务账号成员（left_at IS NULL，§4 只投影服务账号），
// 按 role 排序输出（creator → admin → member）；status='left' → members=[]（leave-all 完成）；
// 'creating' 内部态不进列表（§1）；active*RunId 仅 running 时非空（部分唯一索引保证至多一行）。
import type { Pool } from 'pg';
import { AppError } from '../../http/plugins/errors.js';

export interface GroupMemberView {
  accountId: string;
  platformUserId: string;
  role: 'creator' | 'admin' | 'member';
}

export interface GroupView {
  id: string;
  gatewayGroupId: string | null;
  status: string;
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: GroupMemberView[];
  activeSequenceRunId: string | null;
  activeAgentRunId: string | null;
}

interface GroupRow {
  id: string;
  gateway_group_id: string | null;
  status: string;
  creator_account_id: string;
  agent_enabled: boolean;
  auto_kick_enabled: boolean;
}

/** role 排序权重（§5「按 role 排序输出」：creator → admin → member） */
const ROLE_ORDER: Record<string, number> = { creator: 0, admin: 1, member: 2 };

async function membersOf(pool: Pool, groupId: string, status: string): Promise<GroupMemberView[]> {
  if (status === 'left') return []; // leave-all 完成后 members=[]（§5/REQ §2.3）
  const { rows } = await pool.query<{ account_id: string; platform_user_id: string; role: string }>(
    `SELECT account_id, platform_user_id, role FROM group_member
     WHERE group_id=$1 AND left_at IS NULL`,
    [groupId],
  );
  return rows
    .map((r) => ({
      accountId: r.account_id,
      platformUserId: r.platform_user_id,
      role: r.role as GroupMemberView['role'],
    }))
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
}

async function activeRunId(pool: Pool, table: 'sequence_run' | 'agent_run', groupId: string): Promise<string | null> {
  // 表名来自内部常量白名单（非用户输入）；running 至多一行（部分唯一索引）
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE group_id=$1 AND status='running' LIMIT 1`,
    [groupId],
  );
  return rows[0]?.id ?? null;
}

function toView(row: GroupRow, members: GroupMemberView[], seqId: string | null, runId: string | null): GroupView {
  return {
    id: row.id,
    gatewayGroupId: row.gateway_group_id,
    status: row.status,
    creatorAccountId: row.creator_account_id,
    agentEnabled: row.agent_enabled,
    autoKickEnabled: row.auto_kick_enabled,
    members,
    activeSequenceRunId: seqId,
    activeAgentRunId: runId,
  };
}

/** GET /api/groups：不含 creating（内部态，§1 解读） */
export async function listGroups(pool: Pool): Promise<GroupView[]> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, gateway_group_id, status, creator_account_id, agent_enabled, auto_kick_enabled
     FROM "group" WHERE status <> 'creating' ORDER BY created_at`,
  );
  const views: GroupView[] = [];
  for (const row of rows) {
    views.push(
      toView(
        row,
        await membersOf(pool, row.id, row.status),
        await activeRunId(pool, 'sequence_run', row.id),
        await activeRunId(pool, 'agent_run', row.id),
      ),
    );
  }
  return views;
}

/** GET /api/groups/:id：creating 视为不存在（对外不可见内部态）→ 404 */
export async function getGroup(pool: Pool, id: string): Promise<GroupView> {
  const { rows } = await pool.query<GroupRow>(
    `SELECT id, gateway_group_id, status, creator_account_id, agent_enabled, auto_kick_enabled
     FROM "group" WHERE id=$1 AND status <> 'creating'`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new AppError('GROUP_NOT_FOUND', `unknown group: ${id}`);
  return toView(
    row,
    await membersOf(pool, row.id, row.status),
    await activeRunId(pool, 'sequence_run', row.id),
    await activeRunId(pool, 'agent_run', row.id),
  );
}
