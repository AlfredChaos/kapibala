// 建群 job 执行器 + 受理域逻辑（T-P3-05；DES/04 §2.1–§2.3 逐字、DES/02 §6.1 outbox）。
// 形态：进程内执行器（受理后异步启动 / 恢复器同入口）；advisory lock `job:<jobId>` 会话级
// 抢占（宪法 §3-5）；每个外部调用前意图先写 phase/context（E1–E4：崩溃窗口按 phase 续传）。
// 主链：create → invite → joining(并行 join) → waiting_joins → promote → finished。
// B2 三分支（INVITE_NOT_READY 无上限重试 / INVITE_EXPIRED 重申一次 / ALREADY_MEMBER UPSERT）、
// JOIN_TIMEOUT 超时定位与调度器扫描体：归 create-job-branches.ts（T-P3-06）。
// §2.4 崩溃续传：phase/context 断点恢复——waiting/joined 成员不重发 join、pending 正常发；
// join_deadline_at 持久化不重置；promoteCalls 计数持久化累计（A2 总调用 ≤2）。
import type { Pool, PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, type GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { AppError } from '../../http/plugins/errors.js';
import { tx } from '../../db/tx.js';
import { JOIN_TIMEOUT_MS, PROMOTE_RETRY_WAIT_MS } from '../../constants.js';
import {
  escapeJsonbKey,
  failJob,
  firstMissingMember,
  gatewayGroupId,
  joinMemberWithBranches,
  platformUserIdOf,
  readJob,
  type JobRow,
} from './create-job-branches.js';

/** waiting_joins 轮询节拍【设计值】（≤ member_joined 正常延迟下限，保证到齐尽快推进） */
const WAITING_POLL_MS = 100;

export interface CreateGroupInput {
  creatorAccountId: string;
  memberAccountIds: string[];
}

export interface JobDeps {
  pool: Pool;
  gateway: Pick<GatewayClient, 'createGroup' | 'invite' | 'join' | 'promote'>;
  logger?: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
}

// ---------- 受理（DES/04 §2.1） ----------

/** 参数校验 → 422/400 → 202 事务（group creating + job + ws_event）；返回 jobId */
export async function acceptCreateGroup(pool: Pool, input: unknown): Promise<{ jobId: string }> {
  if (!isRecord(input)) throw new AppError('VALIDATION_ERROR', 'body must be an object');
  const creator = input['creatorAccountId'];
  const members = input['memberAccountIds'];
  if (
    typeof creator !== 'string' ||
    creator === '' ||
    !Array.isArray(members) ||
    members.length === 0 ||
    members.some((m) => typeof m !== 'string') ||
    members.includes(creator) ||
    new Set(members).size !== members.length
  ) {
    throw new AppError('VALIDATION_ERROR', 'creatorAccountId required; memberAccountIds ≥1, no dup, excludes creator');
  }
  const accountIds = [creator, ...(members as string[])];
  // online 校验在受理事务外（读路径），写事务本身只建意图行
  const { rows } = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM account WHERE id = ANY($1::text[])',
    [accountIds],
  );
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  const offline = accountIds.find((id) => byId.get(id) !== 'online');
  if (offline !== undefined) {
    throw new AppError('ACCOUNT_NOT_ONLINE', `account ${offline} is not online`);
  }
  return tx(pool, async (client) => {
    const { rows: g } = await client.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status) VALUES (gen_random_uuid(), $1, 'creating') RETURNING id`,
      [creator],
    );
    const groupId = g[0]?.id;
    if (groupId === undefined) throw new AppError('INTERNAL', 'group insert failed');
    const { rows: j } = await client.query<{ id: string }>(
      `INSERT INTO job (id, type, group_id, payload, phase, context)
       VALUES (gen_random_uuid(), 'create_group', $1, $2::jsonb, 'create', $3::jsonb) RETURNING id`,
      [
        groupId,
        JSON.stringify({ creatorAccountId: creator, memberAccountIds: members }),
        JSON.stringify({ members: Object.fromEntries((members as string[]).map((m) => [m, 'pending'])) }),
      ],
    );
    const jobId = j[0]?.id;
    if (jobId === undefined) throw new AppError('INTERNAL', 'job insert failed');
    await client.query("INSERT INTO ws_event (type, payload) VALUES ('job', $1::jsonb)", [
      JSON.stringify({ jobId, status: 'running' }),
    ]);
    return { jobId };
  });
}

// ---------- 执行器 ----------

/** waiting_joins 到齐判定：context.members 全 'joined'（事件路径写）则推进 */
function allJoined(job: JobRow): boolean {
  const members = job.context.members ?? {};
  return job.payload.memberAccountIds.every((id) => members[id] === 'joined');
}

/**
 * 执行器主循环。调用方先拿 advisory lock（pool.connect 会话级，finally 释放）。
 * 每相位 = 意图落库 tx → 外呼 → 结果落库 tx；waiting_joins 为轮询循环（到齐/超时/失败出环）。
 */
export async function runCreateGroupJob(deps: JobDeps, jobId: string): Promise<void> {
  const conn = await deps.pool.connect();
  try {
    const { rows: lock } = await conn.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [`job:${jobId}`],
    );
    if (lock[0]?.locked !== true) return; // 另一执行器/恢复器持有——单飞
    try {
      await drive(deps, conn, jobId);
    } finally {
      await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${jobId}`]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

/** 相位机：每次循环读 job 最新行（各自事务内），按 phase 分派 */
async function drive(deps: JobDeps, conn: PoolClient, jobId: string): Promise<void> {
  void conn; // lock 持有期间驱动；相位事务走 pool（锁与会话解耦，断连即自然释放锁）
  for (;;) {
    const job = await tx(deps.pool, (c) => readJob(c, jobId));
    if (job === null || job.status !== 'running') return;
    const payload = job.payload;
    switch (job.phase) {
      case 'create': {
        let groupId: string;
        try {
          groupId = (await deps.gateway.createGroup({ creatorAccountId: payload.creatorAccountId })).groupId;
        } catch (err) {
          await tx(deps.pool, (c) =>
            failJob(c, jobId, 'create', err instanceof GatewayError ? err.code : 'INTERNAL'),
          );
          return;
        }
        // 建群成功事务：回填 gateway id + creator 成员行（A3：无 member_joined 事件）+ phase=invite
        const puid = await platformUserIdOf(deps.pool, payload.creatorAccountId);
        await tx(deps.pool, async (c) => {
          await c.query('UPDATE "group" SET gateway_group_id=$2, updated_at=now() WHERE id=$1', [
            job.group_id,
            groupId,
          ]);
          await c.query(
            `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, last_event_id)
             VALUES ($1, $2, $3, 'creator', now(), 0)
             ON CONFLICT (group_id, platform_user_id) DO NOTHING`,
            [job.group_id, payload.creatorAccountId, puid],
          );
          await c.query("UPDATE job SET phase='invite', updated_at=now() WHERE id=$1", [jobId]);
        });
        break;
      }
      case 'invite': {
        const groupGw = await gatewayGroupId(deps.pool, job.group_id);
        if (groupGw === null) return; // 群行缺映射——不应到达（create 已回填）
        let result: { inviteLink: string; readyAfterMs: number };
        try {
          result = await deps.gateway.invite(groupGw);
        } catch (err) {
          await tx(deps.pool, (c) =>
            failJob(c, jobId, 'invite', err instanceof GatewayError ? err.code : 'INTERNAL'),
          );
          return;
        }
        // 意图先行：inviteLink + inviteReadyAt 落库后转 joining（join 早于 readyAt -> INVITE_NOT_READY）
        await tx(deps.pool, (c) =>
          c.query(
            `UPDATE job SET phase='joining', context = context || $2::jsonb, updated_at=now() WHERE id=$1`,
            [
              jobId,
              JSON.stringify({
                inviteLink: result.inviteLink,
                inviteReadyAt: Date.now() + result.readyAfterMs,
              }),
            ],
          ),
        );
        break;
      }
      case 'joining': {
        // §2.4 续传语义：waiting/joined 不重发 join（申请可能已受理）；pending/joining 正常发。
        const members = job.context.members ?? {};
        const groupGw = await gatewayGroupId(deps.pool, job.group_id);
        if (groupGw === null) return; // 群行缺映射——不应到达（create 已回填）
        const results = await Promise.all(
          payload.memberAccountIds.map(async (accountId) => {
            const state = members[accountId] ?? 'pending';
            if (state === 'waiting' || state === 'joined') {
              return { accountId, ok: true as const };
            }
            // 意图先行：context.members[x]='joining' 落库后才外呼 join（E3）
            await tx(deps.pool, (c) =>
              c.query(
                `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"joining"'), updated_at=now()
                 WHERE id=$1 AND status='running'`,
                [jobId],
              ),
            );
            const outcome = await joinMemberWithBranches(
              { pool: deps.pool, gateway: deps.gateway },
              jobId,
              job.group_id ?? '',
              groupGw,
              accountId,
              job.context.inviteLink ?? '',
              job.context.inviteReadyAt ?? 0,
            );
            if (outcome.ok) return { accountId, ok: true as const };
            return { accountId, ok: false as const, step: outcome.step, code: outcome.code };
          }),
        );
        const failed = results.find((r) => !r.ok);
        if (failed !== undefined) {
          // CANCELLED：job 已被外部终止（不再写终态——终态已存在）
          if (failed.code === 'CANCELLED') return;
          await tx(deps.pool, (c) =>
            failJob(c, jobId, failed.step ?? `join:${failed.accountId}`, failed.code ?? 'INTERNAL'),
          );
          return;
        }
        // 全 waiting/joined → 进入等待相位（deadline 锚点落库；续传不重置——§2.4）
        await tx(deps.pool, (c) =>
          c.query(
            `UPDATE job SET phase='waiting_joins', join_deadline_at=now() + $2 * interval '1 millisecond', updated_at=now()
             WHERE id=$1 AND status='running' AND phase='joining'`,
            [jobId, JOIN_TIMEOUT_MS],
          ),
        );
        break;
      }
      case 'waiting_joins': {
        if (allJoined(job)) {
          await tx(deps.pool, (c) =>
            c.query("UPDATE job SET phase='promote', updated_at=now() WHERE id=$1", [jobId]),
          );
          break;
        }
        // A2：join_deadline_at 持久化即超时窗口（恢复不重置：原值已过即立即到点，
        // 等价 §2.4 的 max(原值,now) 重建——执行器内不再改写该字段）
        if (job.join_deadline_at !== null && job.join_deadline_at.getTime() <= Date.now()) {
          await tx(deps.pool, (c) =>
            failJob(c, jobId, `join:${firstMissingMember(job)}`, 'JOIN_TIMEOUT'),
          );
          return;
        }
        await sleep(WAITING_POLL_MS);
        break;
      }
      case 'promote': {
        const target = payload.memberAccountIds[0];
        if (target === undefined) return;
        // 意图先行：调用计数持久化后再外呼（A2 总调用 ≤2 靠崩溃续传累计）
        const calls = (job.context.promoteCalls ?? 0) + 1;
        await tx(deps.pool, (c) =>
          c.query(
            `UPDATE job SET context = jsonb_set(context, '{promoteCalls}', $2::text::jsonb), updated_at=now()
             WHERE id=$1`,
            [jobId, String(calls)],
          ),
        );
        const groupGw = await gatewayGroupId(deps.pool, job.group_id);
        if (groupGw === null) return;
        try {
          await deps.gateway.promote(groupGw, { byAccountId: payload.creatorAccountId, accountId: target });
        } catch (err) {
          const code = err instanceof GatewayError ? err.code : 'INTERNAL';
          if (code === 'NOT_MEMBER_YET' && calls < 2) {
            await sleep(PROMOTE_RETRY_WAIT_MS); // A2：等 1s 重试（调用总数 ≤2 由计数落库保证）
            break;
          }
          await tx(deps.pool, (c) => failJob(c, jobId, 'promote', code));
          return;
        }
        // 成功事务：UPSERT role=admin（D2-2 兜底缺行）+ group active + finished
        const puid = await platformUserIdOf(deps.pool, target);
        await tx(deps.pool, async (c) => {
          await c.query(
            `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, last_event_id)
             VALUES ($1, $2, $3, 'admin', now(), 0)
             ON CONFLICT (group_id, platform_user_id) DO UPDATE SET role='admin'`,
            [job.group_id, target, puid],
          );
          await c.query(`UPDATE "group" SET status='active', updated_at=now() WHERE id=$1`, [job.group_id]);
          await c.query(
            `UPDATE job SET status='finished', phase='done', finished_at=now(), updated_at=now() WHERE id=$1`,
            [jobId],
          );
          await c.query("INSERT INTO ws_event (type, payload) VALUES ('job', $1::jsonb)", [
            JSON.stringify({ jobId, status: 'finished' }),
          ]);
        });
        return;
      }
      default:
        return; // done/未知相位：退出
    }
  }
}

/** waiting_joins 的事件路径写源：member_joined 事件落成员行同时把 job.context 对应成员置 joined（同事务） */
export async function markMemberJoinedInJobContext(
  client: PoolClient,
  groupId: string,
  accountId: string,
): Promise<void> {
  await client.query(
    `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"joined"'), updated_at=now()
     WHERE group_id=$1 AND type='create_group' AND status='running'
       AND phase IN ('joining','waiting_joins','promote')
       AND (context->'members'->>$2) IS DISTINCT FROM 'joined'`,
    [groupId, accountId],
  );
}
