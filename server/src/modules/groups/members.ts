// 成员拓扑投影（T-P2-09；DES/04 §4 逐字；DES/02 §4.2）。
// 唯一事件写入源（除三个非事件例外：creator 建群 / promote / ALREADY_MEMBER job UPSERT）。
// 规则核心：活跃性只随 event_id 单调推进（last_event_id 记录最近改变活跃性的事件）；
// member_left 无行建墓碑而非跳过；member_joined 的 INSERT/复活分支对称地先查 terminal_at
// （R-A：终态账号永不复活为活跃成员）。外部成员（puid ∉ 服务账号集合）不建行（DES/04 §4 首段）。
import type { PoolClient } from 'pg';
import { markMemberJoinedInJobContext } from './create-job.js';

/** 成员事件最小形状（投递层已确认 type；缺字段由 handler 层先拦） */
export interface MemberEventInput {
  groupId: string; // 网关群 id（gateway_group_id）
  platformUserId: string;
  eventId: number;
}

interface MemberRowSnapshot {
  id: number;
  left_at: Date | null;
  joined_at: Date | null;
  last_event_id: string; // bigint → string
}

async function findLocalGroupId(client: PoolClient, gatewayGroupId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM "group" WHERE gateway_group_id = $1',
    [gatewayGroupId],
  );
  return rows[0]?.id ?? null;
}

async function findServiceAccount(
  client: PoolClient,
  puid: string,
): Promise<{ id: string; terminal_at: Date | null } | null> {
  const { rows } = await client.query<{ id: string; terminal_at: Date | null }>(
    'SELECT id, terminal_at FROM account WHERE platform_user_id = $1',
    [puid],
  );
  return rows[0] ?? null;
}

async function findMemberRow(
  client: PoolClient,
  groupId: string,
  puid: string,
): Promise<MemberRowSnapshot | null> {
  const { rows } = await client.query<MemberRowSnapshot>(
    `SELECT id, left_at, joined_at, last_event_id FROM group_member
     WHERE group_id = $1 AND platform_user_id = $2 FOR UPDATE`,
    [groupId, puid],
  );
  return rows[0] ?? null;
}

/**
 * member_joined 投影（DES/04 §4 MJ 支路逐字）：
 * OWNF（外部成员不建行）→ MJORD（E > last_event_id 才许改活跃性）→
 * R1 三分支（无行 INSERT / 墓碑行复活 / 活跃行幂等），INSERT 与复活对称先查 terminal_at（R-A）。
 */
export async function projectMemberJoined(client: PoolClient, ev: MemberEventInput): Promise<void> {
  const account = await findServiceAccount(client, ev.platformUserId);
  if (account === null) return; // OWNF 否：外部成员不建行（账本行在上游消费层）
  const groupId = await findLocalGroupId(client, ev.groupId);
  if (groupId === null) return; // 群映射缺失（orphan 分流已先处理；防御性兜底）

  const row = await findMemberRow(client, groupId, ev.platformUserId);
  const lastEventId = BigInt(row?.last_event_id ?? '0');
  if (BigInt(ev.eventId) <= lastEventId) {
    // MJORD 否：迟到的旧 joined —— STALE，只补 joined_at（取较早值=该时刻），不复活不回退
    if (row !== null && row.joined_at === null) {
      await client.query('UPDATE group_member SET joined_at = now() WHERE id = $1', [row.id]);
    }
    return;
  }

  const terminal = account.terminal_at !== null;
  if (row === null) {
    // R1 无行：终态 → INSERT 即墓碑（join 在途时账号已终态的乱序防线）；否则活跃行
    await client.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, left_at, last_event_id)
       VALUES ($1, $2, $3, 'member', now(), ${terminal ? 'now()' : 'NULL'}, $4)
       ON CONFLICT (group_id, platform_user_id) DO NOTHING`,
      [groupId, account.id, ev.platformUserId, ev.eventId],
    );
    if (!terminal) await markMemberJoinedInJobContext(client, groupId, account.id);
    return;
  }
  if (row.left_at !== null) {
    // R1 墓碑行：终态 → STALE（只补 joined_at，不复活）；非终态 → 复活（E 已 > 离开事件 id）
    if (terminal) {
      if (row.joined_at === null) {
        await client.query('UPDATE group_member SET joined_at = now() WHERE id = $1', [row.id]);
      }
      return;
    }
    await client.query(
      `UPDATE group_member SET left_at = NULL,
                              joined_at = COALESCE(joined_at, now()),
                              last_event_id = $2
       WHERE id = $1`,
      [row.id, ev.eventId],
    );
    await markMemberJoinedInJobContext(client, groupId, account.id);
    return;
  }
  // R1 活跃行：幂等跳过（S2 重复推送吸收），仅 last_event_id 单调推进
  await client.query(
    'UPDATE group_member SET last_event_id = GREATEST(last_event_id, $2) WHERE id = $1',
    [row.id, ev.eventId],
  );
  await markMemberJoinedInJobContext(client, groupId, account.id);
}

/**
 * member_left 投影（DES/04 §4 ML 支路逐字）：
 * 外部成员跳过 → 活跃行（且 E > last_event_id）置 left_at →
 * 无命中建墓碑（ON CONFLICT DO UPDATE GREATEST——双 leave 循环下迟到 joined 无法越过）。
 */
export async function projectMemberLeft(client: PoolClient, ev: MemberEventInput): Promise<void> {
  const account = await findServiceAccount(client, ev.platformUserId);
  if (account === null) return; // R2 否：外部成员无行不建
  const groupId = await findLocalGroupId(client, ev.groupId);
  if (groupId === null) return;

  // U2：活跃行且事件更新 → left_at=now()（单调守卫对称：迟到的旧 left 不改活跃性）
  const updated = await client.query(
    `UPDATE group_member SET left_at = now(), last_event_id = $3
     WHERE group_id = $1 AND platform_user_id = $2 AND left_at IS NULL AND last_event_id < $3`,
    [groupId, ev.platformUserId, ev.eventId],
  );
  if ((updated.rowCount ?? 0) > 0) return;

  const row = await findMemberRow(client, groupId, ev.platformUserId);
  if (row !== null) {
    // 行存在但未命中 U2：活跃行撞上 stale left（E ≤ last_event_id）或已是墓碑/非活跃——
    // 幂等吸收，只单调推进 last_event_id（GREATEST；左行上重复 left 的防线）
    await client.query(
      'UPDATE group_member SET last_event_id = GREATEST(last_event_id, $2) WHERE id = $1',
      [row.id, ev.eventId],
    );
    return;
  }
  // TOMB：无行插墓碑；冲突（并发窗口）时 GREATEST 单调推进——同一事务第二道防线
  await client.query(
    `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, left_at, last_event_id)
     VALUES ($1, $2, $3, 'member', NULL, now(), $4)
     ON CONFLICT (group_id, platform_user_id) DO UPDATE
       SET last_event_id = GREATEST(group_member.last_event_id, EXCLUDED.last_event_id)`,
    [groupId, account.id, ev.platformUserId, ev.eventId],
  );
}
