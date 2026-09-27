// 时间线 keyset 游标分页（T-P2-11；DES/05 §5.1–§5.3、REQ §2.3 messages 行、QR §1 50 行、A4）。
// 游标 = base64(sent_at_epoch_ms + '.' + sort_key)，sort_key = COALESCE(msg_id, client_msg_id)；
// 边界唯一：(sent_at, sort_key) < cursor 复合比较——不用到达顺序、不用字符串比较时间（卡片 d）。
// 并发语义（§5.2）：新行/更早补投行都以 cursor 为唯一边界，不重复不遗漏；own 消息 sentAt
// 上移（accepted→sent）后不再满足 < cursor，天然不重复出现在后页。
// 字段与 null 语义（§5.3 逐字）：msgId/clientMsgId/deliveryStatus/failCode 无值 → null。
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../http/plugins/errors.js';
import { TIMELINE_PAGE_SIZE } from '../../constants.js';

export interface TimelineCursor {
  readonly sentAtMs: number;
  readonly sortKey: string;
}

export function encodeCursor(sentAtMs: number, sortKey: string): string {
  return Buffer.from(`${sentAtMs}.${sortKey}`, 'utf8').toString('base64');
}

/** 解码失败 → 400（VALIDATION_ERROR）；sort_key 可含 '.'（msgId 不受限）→ 只在首个 '.' 切 */
export function decodeCursor(raw: string): TimelineCursor {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new AppError('VALIDATION_ERROR', 'before cursor is not valid base64');
  }
  const dot = text.indexOf('.');
  if (dot <= 0 || dot === text.length - 1) {
    throw new AppError('VALIDATION_ERROR', 'malformed before cursor (expected "<epochMs>.<sortKey>")');
  }
  const sentAtMs = Number(text.slice(0, dot));
  const sortKey = text.slice(dot + 1);
  if (!Number.isFinite(sentAtMs) || sentAtMs < 0) {
    throw new AppError('VALIDATION_ERROR', 'before cursor has non-numeric epoch prefix');
  }
  return { sentAtMs, sortKey };
}

export interface TimelineItem {
  readonly msgId: string | null;
  readonly clientMsgId: string | null;
  readonly senderPlatformUserId: string;
  readonly isOwn: boolean;
  readonly text: string;
  readonly sentAt: string;
  readonly deliveryStatus: string | null;
  readonly failCode: string | null;
}

export interface TimelinePage {
  readonly items: TimelineItem[];
  readonly nextCursor: string | null;
}

interface Row {
  msg_id: string | null;
  client_msg_id: string | null;
  sender_platform_user_id: string;
  is_own: boolean;
  text: string;
  sent_at: Date;
  delivery_status: string | null;
  fail_code: string | null;
  sort_key: string;
}

/**
 * GET /api/groups/:id/messages 的读路径（卡片 owned）。
 * limit 缺省/上限 = TIMELINE_PAGE_SIZE=50（QR §1）；groupId 即内部 id（控制台 API 口径）。
 */
export async function listTimeline(
  deps: { pool: Pool | PoolClient },
  groupId: string,
  options: { before?: string; limit?: number } = {},
): Promise<TimelinePage> {
  const limit = options.limit ?? TIMELINE_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit <= 0 || limit > TIMELINE_PAGE_SIZE) {
    throw new AppError('VALIDATION_ERROR', `limit must be an integer in 1..${TIMELINE_PAGE_SIZE}`);
  }
  const cursor = options.before !== undefined ? decodeCursor(options.before) : undefined;

  // 群存在性先行（404 GROUP_NOT_FOUND 明确语义）。路径参数是字符串——非 uuid 形状
  // 的 id 永远不可能命中（uuid 列），提前 404 而不是让 PG 抛 22P02 落到 500。
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(groupId)) {
    throw new AppError('GROUP_NOT_FOUND', `group not found: ${groupId}`);
  }
  const groupRes = await deps.pool.query('SELECT 1 FROM "group" WHERE id = $1', [groupId]);
  if (groupRes.rowCount === 0) {
    throw new AppError('GROUP_NOT_FOUND', `group not found: ${groupId}`);
  }

  const params: unknown[] = [groupId, limit + 1]; // 多取一行判定 nextCursor
  let where = 'group_id = $1';
  if (cursor !== undefined) {
    where += ' AND (sent_at, sort_key) < (to_timestamp($3::numeric/1000), $4)';
    params.push(cursor.sentAtMs, cursor.sortKey);
  }
  const { rows } = await deps.pool.query<Row>(
    `SELECT msg_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at,
            delivery_status, fail_code, sort_key
       FROM message WHERE ${where}
       ORDER BY sent_at DESC, sort_key DESC
       LIMIT $2`,
    params,
  );
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const items: TimelineItem[] = pageRows.map((r) => ({
    msgId: r.msg_id,
    clientMsgId: r.client_msg_id,
    senderPlatformUserId: r.sender_platform_user_id,
    isOwn: r.is_own,
    text: r.text,
    sentAt: r.sent_at.toISOString(),
    deliveryStatus: r.delivery_status,
    failCode: r.fail_code,
  }));
  const last = pageRows.at(-1);
  const nextCursor = hasMore && last !== undefined
    ? encodeCursor(last.sent_at.getTime(), last.sort_key)
    : null;
  return { items, nextCursor };
}
