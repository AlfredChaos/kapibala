// 终态统一入口 + 原子副作用（T-P2-06；DES/03 §4 六动作 mermaid + 细节 1/2/3，DES/02 §9 终态行）。
// 三来源汇聚：同步网关错误（connect.ts 的 403/401）/ account_status SSE 事件
// （events/handlers/account-status.ts）/ 操作员 transition（transition.ts）——全部走
// enterTerminal，结果完全一致（REQ A1「无论从哪个来源进入终态结果都一样」）。
// 幂等三分支（§4 判定表逐字）：entered / already_same（静默忽略）/ already_other（记日志不中断）。
// 事务边界在调用方（tx()）：本文件所有写只经传入 client，事件路径天然与账本/游标同事务。
import type { AccountStatus, AccountTerminalStatus } from '@kapibala/contract';
import type { PoolClient } from 'pg';
import { UNKNOWN_SETTLE_MS } from '../../constants.js';
import { AppError } from '../../http/plugins/errors.js';
import { isTerminal } from './transitions.js';

export type TerminalOutcome =
  /** 首次进入：状态写命中，六动作副作用已同事务执行 */
  | 'entered'
  /** 已是同一终态 → 静默忽略（A1：不重放副作用、不影响后续事件） */
  | 'already_same'
  /** 已是另一终态 → 终态间无转移边；事件路径吞掉并记日志（ILLEGAL 语义不抛错） */
  | 'already_other'
  /** 当前非终态但 ≠ expectedFrom（仅带 expectedFrom 的调用可命中）→ CAS_CONFLICT */
  | 'conflict';

export interface EnterTerminalOptions {
  /** 操作员 transition 路径传入：把「当前状态不符」判为 CAS_CONFLICT（而非 already_*） */
  expectedFrom?: AccountStatus;
  /** 终态副作用扩展点（跨模块回调经 TxContext，DES/03 §7）；缺省 = 本文件的六动作默认体 */
  onEntered?: (client: PoolClient, accountId: string, from: AccountStatus) => Promise<void>;
}

// ---------- 默认副作用体：DES/03 §4 动作 2–5（动作 1 状态写 + 动作 6 ws_event 在 enterTerminal） ----------

interface CancelledMessage {
  client_msg_id: string;
  group_id: string;
}

/**
 * 动作 2–5（不含 ws_event）：
 * 2) group_member 该账号全部活跃行（left_at IS NULL）置 left_at=now() —— 「从所有群的成员表中移除」；
 * 3a) delivery_status='queued' AND first_attempt_at IS NULL → cancelled(fail_code=ACCOUNT_TERMINAL)
 *     （细节 1/D1-2：只取消从未交给网关的排队发送）；
 * 3b) queued AND first_attempt_at NOT NULL（send 在途）→ unknown + unknown_since=now()
 *     + unknown_deadline_at=now()+5s（交判定器按网关真相落定；不置 cancelled 防 I1/I3 破坏）；
 * 4) sequence_run_step：client_msg_id ∈ 被取消集合的未发出步骤 → skipped（skipped_at=now()，
 *    sent_at=跳过时刻做排期锚点，迁移注释 §8.3）；
 * 5) 链推进（B1）：每个受影响 run 里 max(skipped index) 之后最早的 pending 步骤
 *    → scheduled_at = now() + 该步 delay_seconds。
 */
async function runTerminalSideEffects(
  client: PoolClient,
  accountId: string,
): Promise<CancelledMessage[]> {
  // 2) 成员移除
  await client.query(
    `UPDATE group_member SET left_at = now() WHERE account_id = $1 AND left_at IS NULL`,
    [accountId],
  );

  // 3a) 真正未发出的排队消息 → cancelled
  const cancelled = await client.query<CancelledMessage>(
    `UPDATE message SET delivery_status='cancelled', fail_code='ACCOUNT_TERMINAL', updated_at=now()
     WHERE account_id = $1 AND delivery_status = 'queued' AND first_attempt_at IS NULL
     RETURNING client_msg_id, group_id`,
    [accountId],
  );
  // 3b) 在途行 → unknown 判定（D1-2；细节 1 末尾：accepted/unknown/sent 同样不动）
  await client.query(
    `UPDATE message SET delivery_status='unknown',
                        unknown_since=now(),
                        unknown_deadline_at=now() + $2 * interval '1 millisecond',
                        updated_at=now()
     WHERE account_id = $1 AND delivery_status = 'queued' AND first_attempt_at IS NOT NULL`,
    [accountId, UNKNOWN_SETTLE_MS],
  );

  // 4) 关联步骤 skipped（细节 2：仅 client_msg_id 出现在取消集合的步骤；pending/accepted 都未发出）
  const cancelledIds = cancelled.rows.map((r) => r.client_msg_id).filter((id): id is string => id !== null);
  if (cancelledIds.length === 0) {
    return cancelled.rows;
  }
  const skipped = await client.query<{ run_id: string; index: number }>(
    `UPDATE sequence_run_step SET status='skipped', skipped_at=now(), sent_at=now(), updated_at=now()
     WHERE client_msg_id = ANY($1::text[]) AND status IN ('pending','accepted')
     RETURNING run_id, "index"`,
    [cancelledIds],
  );

  // 5) 链推进：按 run 取被跳过步骤的最大 index，其后的最早 pending 步排期
  const maxSkippedByRun = new Map<string, number>();
  for (const row of skipped.rows) {
    maxSkippedByRun.set(row.run_id, Math.max(maxSkippedByRun.get(row.run_id) ?? -1, row.index));
  }
  for (const [runId, maxIndex] of maxSkippedByRun) {
    await client.query(
      `UPDATE sequence_run_step s SET scheduled_at = now() + s.delay_seconds * interval '1 second', updated_at=now()
       WHERE s.id = (
         SELECT id FROM sequence_run_step
         WHERE run_id = $1 AND status = 'pending' AND "index" > $2
         ORDER BY "index" LIMIT 1
       )`,
      [runId, maxIndex],
    );
  }
  return cancelled.rows;
}

// ---------- enterTerminal：三来源唯一入口（T-P2-05 从 transitions.ts 迁入并加宽） ----------

/**
 * 进入终态的统一入口（单事务序列：SELECT FOR UPDATE 锁行取转移前值 → 幂等判定 →
 * UPDATE 状态+terminal_at → 默认/注入副作用体（动作 2–5）→ ws_event 两帧 + 每条 cancelled
 * 的 message 帧 → 返回）。「后写不覆盖先写」由行锁 + expectedFrom 判定保证（I5/A1-4）。
 */
export async function enterTerminal(
  client: PoolClient,
  accountId: string,
  target: AccountTerminalStatus,
  options: EnterTerminalOptions = {},
): Promise<{ outcome: TerminalOutcome; from?: AccountStatus }> {
  // 先锁行读当前态：终态幂等分支与 CAS 判定都要用到「此刻真值」
  const { rows } = await client.query<{ status: AccountStatus }>(
    'SELECT status FROM account WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  const current = rows[0]?.status;
  if (current === undefined) {
    throw new AppError('ACCOUNT_NOT_FOUND', `unknown account: ${accountId}`);
  }
  if (isTerminal(current)) {
    return { outcome: current === target ? 'already_same' : 'already_other', from: current };
  }
  if (options.expectedFrom !== undefined && current !== options.expectedFrom) {
    return { outcome: 'conflict', from: current };
  }

  // 动作 1：状态 + terminal_at
  await client.query(
    `UPDATE account SET status=$1, terminal_at=now(), updated_at=now() WHERE id=$2`,
    [target, accountId],
  );

  // 动作 2–5：默认体恒执行；onEntered 是追加扩展点（跨模块回调经 TxContext，DES/03 §7），
  // 不是替换——保证「无论从哪个来源进入终态结果都一样」（REQ A1）。
  const cancelled = await runTerminalSideEffects(client, accountId);
  await options.onEntered?.(client, accountId, current);

  // 动作 6：ws_event 三类（细节 4：事件与状态同事务——推给前端的必对应已保存状态）
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('account_terminal', $1::jsonb)", [
    JSON.stringify({ accountId, status: target }),
  ]);
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('account_status_changed', $1::jsonb)", [
    JSON.stringify({ accountId, from: current, to: target }),
  ]);
  for (const msg of cancelled) {
    await client.query("INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)", [
      JSON.stringify({
        groupId: msg.group_id,
        msgId: null, // cancelled 的是从未发出的行，msgId 恒 null（D3-3）
        isOwn: true,
        clientMsgId: msg.client_msg_id,
        deliveryStatus: 'cancelled',
      }),
    ]);
  }

  return { outcome: 'entered', from: current };
}
