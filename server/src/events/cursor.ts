// 连续前缀游标（T-P2-03；DES/08 §1.3、DES/02 §1.2）。
// 语义：cursor = 「所有 eventId ≤ X 均已入库（gateway_event）」的最大 X——不是已见最大 id。
// eventId 全局单调【分配】，但相邻事件【到达】可乱序（QR §1 ≤1s 窗口）且补投不受窗口限制：
// 取 max 会把未到的更小 id 永久跳过（断线补拉 since=max 时丢失，违反 A2）。
// 纪律（卡片 d / 宪法 §3-1）：
// - 游标 UPDATE 只发生在事件处理事务内（advanceInTx 拿 tx 的 PoolClient，本模块不自己开事务）；
// - 内存状态（cursor + seen）只在事务 COMMIT 成功后跟进（commit()）——回滚绝不污染前缀；
// - boot 时 seen 从 gateway_event 表重建（崩溃在「入账后、推进前」的窗口由此闭合）；
// - UPDATE 带 last_event_id < $1 单调守卫：真值在 DB（宪法 §3-5），内存镜像落后时游标绝不回退。
import type { Pool, PoolClient } from 'pg';

/** pg 对 bigint（int8）返回字符串——边界处显式 Number()，内部比较用数值（宪法 §3-6 同源纪律） */
type Queryable = Pool | PoolClient;

export interface CursorTracker {
  /** 已提交的连续前缀（与 event_cursor.last_event_id 同步推进；事务回滚时不动） */
  readonly cursor: number;
  /**
   * 事务内调用：按「E 随本事务入库」计算新前缀，需要时 UPDATE event_cursor。
   * 不动内存状态——commit() 才是内存推进的唯一合法时机。
   */
  advanceInTx(eventId: number, client: PoolClient): Promise<void>;
  /** 事务 COMMIT 成功后调用：E 并入 seen，前缀推进到连续段末端（幂等：重复/已入账事件吸收） */
  commit(eventId: number): void;
}

/** 读持久化游标（单行表，迁移 001 已落行）。重连的 since 恒来自这里——从不用内存值（卡片 d）。 */
export async function readCursor(db: Queryable): Promise<number> {
  const res = await db.query<{ last_event_id: string }>(
    'SELECT last_event_id FROM event_cursor WHERE id = 1',
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('event_cursor singleton row missing (migration 001 inserts it)');
  return Number(row.last_event_id);
}

/** 「seen ∪ {extra} 中从 from 起的连续前缀末端」——纯函数，advanceInTx 与 commit 共用同一语义 */
function continuousPrefix(from: number, seen: ReadonlySet<number>, extra?: number): number {
  let end = from;
  while (seen.has(end + 1) || end + 1 === extra) end += 1;
  return end;
}

/**
 * boot 装载：读游标 + 从 gateway_event 重建 seen（> cursor 的已入库 id = 乱序窗口内等 gap 的账）。
 * 正常运行时 seen 只含 ≤1s 乱序窗口的少量 id（DES/08 §1.3）；重启后由本重建恢复同一状态。
 */
export async function loadCursorTracker(db: Queryable): Promise<CursorTracker> {
  let cursor = await readCursor(db);
  const seen = new Set<number>();
  const res = await db.query<{ event_id: string }>(
    'SELECT event_id FROM gateway_event WHERE event_id > $1',
    [cursor],
  );
  for (const row of res.rows) seen.add(Number(row.event_id));

  return {
    get cursor() {
      return cursor;
    },
    async advanceInTx(eventId, client) {
      const next = continuousPrefix(cursor, seen, eventId);
      if (next <= cursor) return; // 重复推送 / gap 未闭合：游标不动（「照常推进」= 事务照常提交）
      // 单调守卫 last_event_id < next：外部真值已把库推得更前时不回退（宪法 §3-5）
      await client.query(
        'UPDATE event_cursor SET last_event_id = $1, updated_at = now() WHERE id = 1 AND last_event_id < $1',
        [next],
      );
    },
    commit(eventId) {
      if (eventId <= cursor) return; // 已入账事件（重复推送，S2）：吸收，前缀不变
      seen.add(eventId);
      while (seen.has(cursor + 1)) {
        seen.delete(cursor + 1);
        cursor += 1;
      }
    },
  };
}
