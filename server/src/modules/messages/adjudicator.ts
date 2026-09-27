// unknown 判定器（T-P3-03；DES/05 §2.4 逐字、REQ A2 第 2 条、QR §1 的 5s/2s 行）。
// 形态：调度器扫描驱动（判定器轮询而非常驻 timer——DES/05 §8；漏拍由扫描兜底）。
//   每 tick 扫 delivery_status='unknown' AND unknown_deadline_at <= now() 的行，
//   逐行 pg_try_advisory_lock（消息粒度串行；多实例部署唯一性靠 DB，宪法 §3-5）后判定：
//
//   探测 GET by-client-id（§2.4 判定表逐字）：
//     200 {msgId,sentAt} → finalizeSent（§4.3 唯一收口；补投场景 M 行可能已存在 → 合并分支）
//     404              → now() > unknown_since+2s 才算「确认未发出」（2s 确认线；之前 404 不算数）
//                        ├ 确认未发出 ∧ resend_count=0 → 重发一次（同 clientMsgId，
//                        │   resend_count=1 + first_attempt_at=NULL → dispatcher 走 §2.1 全流程；
//                        │   重发后再 504 → unknown（deadline 重算）→ 本轮确认未发出即
//                        │   resend_count=1 → failed(NETWORK_TIMEOUT)，A2 逐字）
//                        ├ 确认未发出 ∧ resend_count=1 → failed(NETWORK_TIMEOUT)
//                        └ 未过 2s 线 → deadline 顺延 +500ms 再探（PROBE_BACKOFF_MS）
//     503/探测异常       → 保持 unknown + deadline 顺延 +500ms（「不可用期间保持 unknown，
//                          恢复后 2s 内确定」优先于 5s 落定；顺延量 = 探测节拍）
//
//   「确认前不得重发」（A2）：重发只在「过 2s 线且 404」判定后发生；此前任何分支都不碰。
//   ws_event 纪律：所有写回与帧同事务，COMMIT 后 notifyWsEventCommitted。
import type { Pool, PoolClient } from 'pg';
import { UNKNOWN_PROBE_BACKOFF_MS } from '../../constants.js';
import { tx } from '../../db/tx.js';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { finalizeSent } from './finalize-sent.js';
import { notifyWsEventCommitted } from '../../ws/notify.js';
import type { DispatcherLogger } from './dispatcher.js';

export type { DispatcherLogger as AdjudicatorLogger };

export interface AdjudicatorDeps {
  readonly pool: Pool;
  readonly gateway: GatewayClient;
  readonly logger: DispatcherLogger;
  /** 重发交接：UPDATE 回 queued 后唤醒 dispatcher（T-P3-02 泵）；缺省 = 等兜底扫描（1s 内拾取） */
  readonly wakeDispatcher?: (accountId: string) => void;
  /** 测试注入缝：now() 覆盖；缺省 Date.now */
  readonly nowMs?: () => number;
}

export interface UnknownAdjudicator {
  /**
   * 扫一批到期 unknown 行（unknown_deadline_at <= now）逐条判定；返回处理条数。
   * 调度器扫描体即调本函数；测试可直接驱动（墙钟断言不依赖节拍）。
   */
  sweep(): Promise<number>;
}

/** 到期行快照（bigint id → string；未知类时间戳都是 timestamptz） */
interface UnknownRow {
  readonly id: string;
  readonly client_msg_id: string;
  readonly group_id: string;
  readonly account_id: string;
  readonly resend_count: number;
  readonly unknown_since: Date;
  readonly gw_group_id: string | null; // "group".gateway_group_id（探测端点要用网关侧 id）
}

const UNKNOWN_CONFIRM_MS = 2000; // QR §1 ② 2s 确认线（速查表「unknown→sent 判定期限」；2s 内 404 不算数）

async function wsEvent(client: PoolClient, payload: unknown): Promise<void> {
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)", [
    JSON.stringify(payload),
  ]);
}

function frame(row: UnknownRow, status: string): Record<string, unknown> {
  return {
    groupId: row.group_id,
    msgId: null,
    isOwn: true,
    clientMsgId: row.client_msg_id,
    deliveryStatus: status,
  };
}

export function createUnknownAdjudicator(deps: AdjudicatorDeps): UnknownAdjudicator {
  const { pool, gateway, logger } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());

  /** 单条判定（advisory lock 串行化；返回 true = 处理了这条，无论结果） */
  async function adjudicate(row: UnknownRow): Promise<void> {
    const client = await pool.connect();
    try {
      const locked = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok',
        ['unknown-adjudicator', row.client_msg_id],
      );
      if (locked.rows[0]?.ok !== true) return;
      try {
        if (row.gw_group_id === null) {
          // 群无网关 id（creating 中断）：探测无从谈起——顺延等 dispatcher/恢复链补
          await pushDeadline(client, row);
          return;
        }
        let verdict: 'sent' | 'not_found' | 'unavailable';
        let landed: { msgId: string; sentAt: string } | undefined;
        try {
          const found = await gateway.getMessageByClientMsgId(row.gw_group_id, row.client_msg_id);
          verdict = 'sent';
          landed = found;
        } catch (err) {
          if (err instanceof GatewayError && err.code === 'NOT_FOUND') {
            verdict = 'not_found';
          } else if (err instanceof GatewayError && err.code === 'UNAVAILABLE') {
            verdict = 'unavailable';
          } else {
            // 探测自身异常（网络/TIMEOUT/INVALID_RESPONSE）：视同不可用——不推进判定
            verdict = 'unavailable';
            logger.warn({ err, clientMsgId: row.client_msg_id }, 'unknown probe failed; keep probing');
          }
        }
        switch (verdict) {
          case 'sent': {
            // finalizeSent 是事务内调用（§4.3：调用方持事务边界）
            const found = landed;
            if (found === undefined) return; // verdict 与 landed 同源——防御性短路
            await tx(pool, async (txc) => {
              await finalizeSent(txc, row.client_msg_id, found.msgId, found.sentAt);
            });
            notifyWsEventCommitted();
            return;
          }
          case 'unavailable': {
            await tx(pool, async (txc) => {
              await pushDeadline(txc, row);
            });
            return;
          }
          case 'not_found': {
            const sinceMs = row.unknown_since.getTime();
            const confirmed = nowMs() > sinceMs + UNKNOWN_CONFIRM_MS;
            if (!confirmed) {
              // 2s 确认线未到：404 不算数（消息可能正要落地）——500ms 后再探
              await tx(pool, async (txc) => {
                await pushDeadline(txc, row);
              });
              return;
            }
            if (row.resend_count === 0) {
              // 确认未发出 ∧ 可重发：resend_count=1 + 回到 §2.1 发送流程（同 clientMsgId）。
              // first_attempt_at 复位 NULL——dispatcher 的选择器拾取它并在发前重新落时间戳
              // （E7 语义保持：发前必落戳；「重发那一刻的时间戳」由 dispatcher 写）。
              await tx(pool, async (txc) => {
                const upd = await txc.query(
                  `UPDATE message SET delivery_status='queued', resend_count=1,
                                      first_attempt_at=NULL, last_attempt_at=NULL,
                                      unknown_since=NULL, unknown_deadline_at=NULL, updated_at=now()
                   WHERE id=$1 AND delivery_status='unknown' AND resend_count=0`,
                  [row.id],
                );
                if (upd.rowCount === 1) {
                  await wsEvent(txc, frame(row, 'queued'));
                }
              });
              notifyWsEventCommitted();
              deps.wakeDispatcher?.(row.account_id);
              return;
            }
            // resend_count=1：重发后确认仍未发出 → failed(NETWORK_TIMEOUT)（A2 逐字）
            await tx(pool, async (txc) => {
              const upd = await txc.query(
                `UPDATE message SET delivery_status='failed', fail_code='NETWORK_TIMEOUT',
                                    unknown_deadline_at=NULL, updated_at=now()
                 WHERE id=$1 AND delivery_status='unknown' AND resend_count=1`,
                [row.id],
              );
              if (upd.rowCount === 1) {
                await wsEvent(txc, frame(row, 'failed'));
              }
            });
            notifyWsEventCommitted();
            return;
          }
        }
      } finally {
        await client
          .query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
            'unknown-adjudicator',
            row.client_msg_id,
          ])
          .catch((err: unknown) => {
            logger.error({ err, clientMsgId: row.client_msg_id }, 'advisory unlock failed');
          });
      }
    } finally {
      client.release();
    }
  }

  /** 「再探/保持 unknown」：deadline 顺延一个探测节拍（500ms）；unknown_since 不动 */
  async function pushDeadline(client: PoolClient, row: UnknownRow): Promise<void> {
    await client.query(
      `UPDATE message SET unknown_deadline_at=now() + $2 * interval '1 millisecond', updated_at=now()
       WHERE id=$1 AND delivery_status='unknown'`,
      [row.id, UNKNOWN_PROBE_BACKOFF_MS],
    );
  }

  return {
    async sweep(): Promise<number> {
      const { rows } = await pool.query<UnknownRow>(
        `SELECT m.id, m.client_msg_id, m.group_id, m.account_id, m.resend_count,
                m.unknown_since, g.gateway_group_id AS gw_group_id
         FROM message m JOIN "group" g ON g.id = m.group_id
         WHERE m.delivery_status='unknown' AND m.unknown_deadline_at <= now()
         ORDER BY m.id ASC LIMIT 100`,
      );
      let done = 0;
      for (const row of rows) {
        try {
          await adjudicate(row);
          done += 1;
        } catch (err) {
          // 单行失败不拖垮扫描（漏拍由下一 tick 兜底；宪法 §3-4 的反向：扫描容错）
          logger.error({ err, clientMsgId: row.client_msg_id }, 'adjudicate failed; next tick retries');
        }
      }
      return done;
    },
  };
}
