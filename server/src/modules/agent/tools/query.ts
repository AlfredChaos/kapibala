// get_recent_messages 工具（T-P4-08；DES/06 §7.1 逐字 + REQ §2.2 + A5-9 + QR §1 数字行）。
// 语义钉死：
// - limit = min(limit,50)，>50 钳制不报错（§7.1 解读逐字）；非正数 → INVALID_INPUT（上游校验已拦）；
// - 「最近 N 条」：按 sent_at DESC, sort_key DESC 取头 N 再翻成升序回包
//   （时间线游标谓词同款排序键——DES/02 idx_message_timeline）；
// - 含触发消息本身与 run 期间新到消息（无时间过滤，查询时刻快照）；
// - 每条 { msgId, senderPlatformUserId, isOwn, text, sentAt }；单条 text >500 字截断置 truncated；
// - content 整体 ≤8KB（A5-9），超出按尾丢弃并置 truncated:true；
// - result_summary ≤200 字（REQ §2.3 行）。
import type { PoolClient } from 'pg';
import type { ToolOutcome } from '../executor.js';

const RECENT_LIMIT_CAP = 50; // QR §1
const TEXT_TRUNCATE_CHARS = 500; // QR §1
const CONTENT_MAX_BYTES = 8 * 1024; // A5-9
const RESULT_SUMMARY_MAX_CHARS = 200; // REQ §2.3

interface MsgRow {
  readonly msg_id: string | null;
  readonly client_msg_id: string | null;
  readonly sender_platform_user_id: string;
  readonly is_own: boolean;
  readonly text: string;
  readonly sent_at: Date;
}

export interface RecentMessageItem {
  msgId: string | null;
  senderPlatformUserId: string;
  isOwn: boolean;
  text: string;
  sentAt: string;
}

export async function queryRecentMessages(
  client: PoolClient,
  groupId: string,
  limit: number,
): Promise<{ content: string; truncated: boolean; count: number }> {
  const n = Math.min(limit, RECENT_LIMIT_CAP);
  const { rows } = await client.query<MsgRow>(
    `SELECT msg_id, client_msg_id, sender_platform_user_id, is_own, text, sent_at
     FROM message WHERE group_id=$1
     ORDER BY sent_at DESC, sort_key DESC
     LIMIT $2`,
    [groupId, n],
  );
  let truncated = false;
  const items: RecentMessageItem[] = rows
    .map((r) => {
      let text = r.text;
      if (text.length > TEXT_TRUNCATE_CHARS) {
        text = text.slice(0, TEXT_TRUNCATE_CHARS);
        truncated = true;
      }
      return {
        msgId: r.msg_id ?? r.client_msg_id, // 出站未落定行以 client_msg_id 充对外 id（网关 msgId 未分配）
        senderPlatformUserId: r.sender_platform_user_id,
        isOwn: r.is_own,
        text,
        sentAt: r.sent_at.toISOString(),
      };
    })
    .reverse(); // DESC 取最近 N → ASC 回包
  // 8KB 闸：JSON 整体超限时从尾丢弃（最新优先丢），置 truncated
  let payload = JSON.stringify({ messages: items, truncated });
  while (Buffer.byteLength(payload, 'utf8') > CONTENT_MAX_BYTES && items.length > 0) {
    items.pop();
    truncated = true;
    payload = JSON.stringify({ messages: items, truncated });
  }
  return { content: payload, truncated, count: items.length };
}

/** executor executeTool 缝的 get_recent_messages 实现 */
export async function execGetRecentMessages(
  client: PoolClient,
  args: { groupId: string; input: unknown },
): Promise<ToolOutcome> {
  const limit = (args.input as Record<string, unknown> | undefined)?.['limit'];
  const n = typeof limit === 'number' && Number.isInteger(limit) ? limit : RECENT_LIMIT_CAP;
  const res = await queryRecentMessages(client, args.groupId, n);
  const summary = `${res.count} messages${res.truncated ? ' (truncated)' : ''}`.slice(0, RESULT_SUMMARY_MAX_CHARS);
  return { type: 'result', content: res.content, resultSummary: summary };
}
