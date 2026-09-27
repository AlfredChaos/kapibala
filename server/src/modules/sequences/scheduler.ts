// 序列链式排期与步骤推进（T-P6-03；DES/07 §3.1–§3.3、§4、§6 逐字 + B1 + 解读 #19）。
// 扫描：sequence_run_step status='pending' AND scheduled_at<=now()（按 run 分组、链头唯一——
// 同一时刻至多一个步骤有排期，其余 NULL 等前步发出）。
// 每步（run running ∧ group active 守卫，§3.2 GRP 框）→ 选账号（§3.3）：
//   候选 = 活跃群成员(left_at IS NULL) ∧ account.status ∈ {online, rate_limited}
//   admin 步：候选 ∩ role∈{admin} 优先；无 admin 则 creator——同优先级内 online 先于
//     rate_limited，再 account_id 字典序第一（解读 #19：同级有 online 取 online）
//   member 步：role='member' 候选同上排序
//   候选空 → skipped（skipped_at=now()、sent_at=skipped_at——跳过时刻视为发出，
//     下一步 scheduled_at=now()+delay，进度照常推进；若是末步 → run finished）
//   选中 rate_limited → 顺延 scheduled_at=max(now, rate_limited_until)，不 skipped（B1 逐字）
//   选中 online → 事务{INSERT message(queued, source='sequence', 文本已替换 resolved_vars)
//     + step.client_msg_id 关联 + ws_event(message)} → 唤醒 dispatcher
// 落定联动（别处同事务）：202 → step accepted（dispatcher.markAccepted）；
//   message_sent → step sent + 下一步排期 + current_step_index 推进 + 末步 run finished
//   （finalize-sent.ts）；message_failed → step failed + run failed 即停（dispatcher.markFailed）。
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { tx } from '../../db/tx.js';

export interface SequenceSchedulerDeps {
  readonly pool: Pool;
  /** 出站唤醒缝（accept.onAccepted 同源；缺省 = DB 扫描兜底） */
  readonly wakeDispatcher?: (accountId: string) => void;
}

interface DueStep {
  readonly id: number;
  readonly run_id: string;
  readonly index: number;
  readonly account_role: string;
  readonly text_template: string;
  readonly delay_seconds: number;
  readonly resolved_vars: Record<string, string>;
  readonly group_id: string;
}

interface AccountCandidate {
  readonly account_id: string;
  readonly platform_user_id: string | null;
  readonly status: string;
  readonly role: string;
  readonly rate_limited_until: Date | null;
}

/** 文本替换：发送时只做字符串替换（§2.1「值在启动时全部确定」逐字） */
function renderText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (raw, key: string) => vars[key] ?? raw);
}

/** §3.3 选账号：优先级序（admin 步: admin>creator；member 步: member），同级 online>rate_limited，再字典序 */
function pickAccount(step: DueStep, candidates: AccountCandidate[]): AccountCandidate | undefined {
  const roleRank = (c: AccountCandidate): number => {
    if (step.account_role === 'admin') return c.role === 'admin' ? 0 : c.role === 'creator' ? 1 : 2;
    return c.role === 'member' ? 0 : 2;
  };
  const statusRank = (c: AccountCandidate): number => (c.status === 'online' ? 0 : 1);
  return candidates
    .filter((c) => roleRank(c) < 2 && c.platform_user_id !== null)
    .sort((a, b) => roleRank(a) - roleRank(b) || statusRank(a) - statusRank(b) || a.account_id.localeCompare(b.account_id))[0];
}

/** 事务内推进链的公共收尾：current_step_index 推进；无后续 pending → run finished（§6） */
async function finishAdvance(client: PoolClient, runId: string, afterIndex: number): Promise<void> {
  await client.query(
    `UPDATE sequence_run SET status='finished', ended_at=now(), current_step_index=$2, updated_at=now()
     WHERE id=$1 AND status='running'`,
    [runId, afterIndex],
  );
}

/** skipped 步之后：跳过时刻视为发出 → 下一步 scheduled_at = now() + 其 delay（B1 逐字） */
async function advanceAfterSkip(client: PoolClient, runId: string, afterIndex: number): Promise<void> {
  const next = await client.query(
    `UPDATE sequence_run_step SET scheduled_at = now() + delay_seconds * interval '1 second', updated_at=now()
     WHERE id = (
       SELECT id FROM sequence_run_step
       WHERE run_id=$1 AND status='pending' AND "index">$2 ORDER BY "index" LIMIT 1
     ) RETURNING id`,
    [runId, afterIndex],
  );
  if (next.rowCount === 0) {
    await finishAdvance(client, runId, afterIndex);
    return;
  }
  await client.query(
    `UPDATE sequence_run SET current_step_index=$2, updated_at=now() WHERE id=$1`,
    [runId, afterIndex],
  );
}

/** message_sent 之后（finalize-sent 同事务）：下一步 scheduled_at = sent_at + delay（§3.1/B1 逐字） */
export async function advanceAfterSent(
  client: PoolClient,
  runId: string,
  afterIndex: number,
  sentAt: Date,
): Promise<boolean> {
  const next = await client.query(
    `UPDATE sequence_run_step SET scheduled_at = $3::timestamptz + delay_seconds * interval '1 second', updated_at=now()
     WHERE id = (
       SELECT id FROM sequence_run_step
       WHERE run_id=$1 AND status='pending' AND "index">$2 ORDER BY "index" LIMIT 1
     ) RETURNING id`,
    [runId, afterIndex, sentAt.toISOString()],
  );
  if (next.rowCount === 0) {
    await finishAdvance(client, runId, afterIndex);
    return true; // 末步落定 → run finished
  }
  await client.query(
    `UPDATE sequence_run SET current_step_index=$2, updated_at=now() WHERE id=$1`,
    [runId, afterIndex],
  );
  return false;
}

/** skipped → 链推进 + ws_event（每步推进都发 sequence_run，前端进度可见） */
async function skipStep(client: PoolClient, step: DueStep): Promise<void> {
  await client.query(
    `UPDATE sequence_run_step SET status='skipped', skipped_at=now(), sent_at=now(), updated_at=now()
     WHERE id=$1 AND status='pending'`,
    [step.id],
  );
  await advanceAfterSkip(client, step.run_id, step.index);
  const { rows: run } = await client.query<{ status: string; current_step_index: number }>(
    `SELECT status, current_step_index FROM sequence_run WHERE id=$1`, [step.run_id]);
  await client.query(`INSERT INTO ws_event (type, payload) VALUES ('sequence_run', $1::jsonb)`, [
    JSON.stringify({
      runId: step.run_id, groupId: step.group_id,
      status: run[0]?.status ?? 'running', currentStepIndex: run[0]?.current_step_index ?? step.index,
    }),
  ]);
}

/**
 * 调度扫描体：一次处理全部到期链头（每步独立事务）。
 * 返回推进的步数（created/skipped/deferred 合计；观测用）。
 */
export async function runSequenceScheduler(deps: SequenceSchedulerDeps): Promise<number> {
  const { rows: due } = await deps.pool.query<DueStep>(
    `SELECT s.id, s.run_id, s."index", s.account_role, s.text_template, s.delay_seconds,
            s.resolved_vars, r.group_id
     FROM sequence_run_step s
     JOIN sequence_run r ON r.id = s.run_id AND r.status='running'
     JOIN "group" g ON g.id = r.group_id AND g.status='active'
     WHERE s.status='pending' AND s.scheduled_at IS NOT NULL AND s.scheduled_at <= now()
     ORDER BY s.run_id, s."index"`,
  );
  let advanced = 0;
  for (const step of due) {
    const outcome = await tx(deps.pool, async (client) => {
      // 行锁 + 状态复查（条件更新吸收重复触发）
      const { rows: lock } = await client.query<{ status: string }>(
        `SELECT status FROM sequence_run_step WHERE id=$1 FOR UPDATE`, [step.id]);
      if (lock[0]?.status !== 'pending') return 'stale';
      const { rows: cands } = await client.query<AccountCandidate>(
        `SELECT gm.account_id, a.platform_user_id, a.status, gm.role, a.rate_limited_until
         FROM group_member gm JOIN account a ON a.id = gm.account_id
         WHERE gm.group_id=$1 AND gm.left_at IS NULL AND a.status IN ('online','rate_limited')`,
        [step.group_id],
      );
      const pick = pickAccount(step, cands);
      if (pick === undefined) {
        await skipStep(client, step);
        return 'skipped';
      }
      if (pick.status === 'rate_limited') {
        // 顺延不跳过：max(now, rate_limited_until)（B1 逐字）
        await client.query(
          `UPDATE sequence_run_step SET scheduled_at = GREATEST(now(), $2), updated_at=now()
           WHERE id=$1 AND status='pending'`,
          [step.id, pick.rate_limited_until],
        );
        return 'deferred';
      }
      // online：建消息（文本已替换快照）+ step 关联，仍 pending（accepted 由 dispatcher 落定）
      const clientMsgId = `cm-${randomUUID()}`;
      const text = renderText(step.text_template, step.resolved_vars);
      await client.query(
        `INSERT INTO message
           (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source, text,
            sent_at, delivery_status, account_id)
         VALUES ($1, NULL, $2, $3, true, 'sequence', $4, now(), 'queued', $5)`,
        [step.group_id, clientMsgId, pick.platform_user_id, text, pick.account_id],
      );
      await client.query(
        `UPDATE sequence_run_step SET client_msg_id=$2, updated_at=now()
         WHERE id=$1 AND status='pending'`,
        [step.id, clientMsgId],
      );
      await client.query(`INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)`, [
        JSON.stringify({ groupId: step.group_id, msgId: null, isOwn: true, clientMsgId, deliveryStatus: 'queued' }),
      ]);
      return pick.account_id;
    });
    if (outcome === 'stale') continue;
    advanced += 1;
    if (outcome !== 'skipped' && outcome !== 'deferred') deps.wakeDispatcher?.(outcome);
  }
  return advanced;
}
