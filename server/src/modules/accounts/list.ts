// GET /api/accounts 的域逻辑（REQ §2.3 行；DES/03 §6 形状逐字）。
// 输出字段：{ id, status, platformUserId, rateLimitedUntil }；时间 ISO 8601 UTC、无值 null（宪法 §3-6）。
import type { Pool } from 'pg';
import type { AccountRow } from './transitions.js';

export interface AccountListItem {
  id: string;
  status: AccountRow['status'];
  platformUserId: string | null;
  rateLimitedUntil: string | null;
}

export async function listAccounts(pool: Pool): Promise<AccountListItem[]> {
  const { rows } = await pool.query<AccountRow>(
    'SELECT id, status, platform_user_id, rate_limited_until, terminal_at FROM account ORDER BY id',
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    platformUserId: row.platform_user_id,
    rateLimitedUntil: row.rate_limited_until === null ? null : row.rate_limited_until.toISOString(),
  }));
}
