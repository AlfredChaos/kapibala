// keyset 分页游标助手（T-P0-04 最小占位；消费方：时间线端点，T-P3 接口面）。
// 游标 = (sentAt, sortKey) 复合键——DES/02 §5.1：sent_at DESC + sort_key DESC 的稳定次序，
// sort_key 生成列保证 msg_id 未落定的 queued 行也可参与排序。
// 行比较 `(sent_at, sort_key) < ($1, $2)` 的语义 = sent_at 更早，或相等且 sort_key 更小——
// 恰好是 DESC,DESC 排序下「严格排在游标之前」的行集（PostgreSQL 行构造器比较）。

export interface TimelineCursor {
  /** ISO 8601 UTC 字符串（宪法 §3-6：对外字符串；比较运算交给 timestamptz） */
  sentAt: string;
  sortKey: string;
}

/** keyset WHERE 片段：配合游标参数 + LIMIT 使用（参数序：sentAt 在前、sortKey 在后） */
export const TIMELINE_KEYSET_PREDICATE = '(sent_at, sort_key) < ($1, $2)' as const;

function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'string')
  );
}

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify([cursor.sentAt, cursor.sortKey]), 'utf8').toString('base64url');
}

export function decodeTimelineCursor(raw: string | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!isStringPair(parsed)) return null;
    return { sentAt: parsed[0], sortKey: parsed[1] };
  } catch {
    return null; // 坏游标按「无游标」处理（回到首页），而不是 500
  }
}
