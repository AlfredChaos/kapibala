// 建群 job 执行器 + 受理域逻辑（T-P3-05；DES/04 §2.1–§2.3 逐字、DES/02 §6.1 outbox）。
// 形态：进程内执行器（受理后异步启动 / 恢复器同入口）；advisory lock `job:<jobId>` 会话级
// 抢占（宪法 §3-5）；每个外部调用前意图先写 phase/context（E1–E4：崩溃窗口按 phase 续传）。
// 本任务主链：create → invite → joining(并行 join) → waiting_joins(轮询 context+成员表，
// 10s 死线由 T-P3-06 的调度器收口；此处骨架实现轮询循环) → promote → finished。
// 异常分支（INVITE_NOT_READY 等待 / INVITE_EXPIRED 重申一次 / ALREADY_MEMBER UPSERT /
// NOT_MEMBER_YET ≤2 / JOIN_TIMEOUT）的完整重试策略归 T-P3-06——本文件骨架按卡 b 落主路径 +
// 断点续传形状（phase 校验点），分支失败统一 failJob(step, code)。
import type { Pool, PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, type GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { AppError } from '../../http/plugins/errors.js';
import { tx } from '../../db/tx.js';
import { JOIN_TIMEOUT_MS } from '../../constants.js';
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

interface JobRow {
  id: string;
  status: string;
  phase: string;
  payload: { creatorAccountId: string; memberAccountIds: string[] };
  context: {
    inviteLink?: string;
    /** invite 返回的就绪时刻（epoch ms）：join 不得早于此（INVITE_NOT_READY 自然路径） */
    inviteReadyAt?: number;
    members?: Record<string, 'pending' | 'joining' | 'waiting' | 'joined'>;
    promoteCalls?: number;
    reinviteUsed?: boolean;
  };
  group_id: string | null;
  join_deadline_at: Date | null;
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

async function readJob(client: PoolClient, jobId: string): Promise<JobRow | null> {
  const { rows } = await client.query<JobRow>(
    'SELECT id, status, phase, payload, context, group_id, join_deadline_at FROM job WHERE id=$1 FOR UPDATE',
    [jobId],
  );
  return rows[0] ?? null;
}

async function failJob(client: PoolClient, jobId: string, step: string, code: string): Promise<void> {
  await client.query(
    `UPDATE job SET status='failed', errors = errors || $2::jsonb, finished_at=now(), updated_at=now()
     WHERE id=$1`,
    [jobId, JSON.stringify([{ step, code }])],
  );
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('job', $1::jsonb)", [
    JSON.stringify({ jobId, status: 'failed' }),
  ]);
}

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
        await tx(deps.pool, async (c) => {
          await c.query('UPDATE "group" SET gateway_group_id=$2, updated_at=now() WHERE id=$1', [
            job.group_id,
            groupId,
          ]);
          const puid = await puidOf(c, payload.creatorAccountId);
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
        // 意图先行：每个成员 context.members[x]='joining' 落库后才外呼 join（E3）
        const members = job.context.members ?? {};
        const groupGw = await gatewayGroupId(deps.pool, job.group_id);
        if (groupGw === null) return; // 群行缺映射——不应到达（create 已回填）
        // 等 invite 就绪（readyAfterMs 契约窗口；等待在 phase 内，不转相位）
        const readyAt = job.context.inviteReadyAt ?? 0;
        const wait = readyAt - Date.now();
        if (wait > 0) await sleep(wait + 10); // +10ms 时钟余量【设计值】
        const results = await Promise.all(
          payload.memberAccountIds.map(async (accountId) => {
            const state = members[accountId] ?? 'pending';
            if (state === 'waiting' || state === 'joined') return { accountId, ok: true as const };
            await tx(deps.pool, (c) =>
              c.query(
                `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"joining"'), updated_at=now()
                 WHERE id=$1 AND status='running'`,
                [jobId],
              ),
            );
            // join 外呼（INVITE_NOT_READY 有界重试——readyAt 是契约保证，重试只兜时钟偏差）
            for (let attempt = 0; ; attempt++) {
              try {
                await deps.gateway.join(groupGw, { accountId, inviteLink: job.context.inviteLink ?? '' });
                await tx(deps.pool, (c) =>
                  c.query(
                    `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"waiting"'), updated_at=now()
                     WHERE id=$1 AND status='running'`,
                    [jobId],
                  ),
                );
                return { accountId, ok: true as const };
              } catch (err) {
                const code = err instanceof GatewayError ? err.code : 'INTERNAL';
                if (code === 'INVITE_NOT_READY' && attempt < 3) {
                  await sleep(200); // 时钟偏差兜底【设计值】；完整分支策略归 T-P3-06
                  continue;
                }
                if (code === 'ALREADY_MEMBER') {
                  // B2：视为成功 + UPSERT 成员行（§4 例外 3，D2-2——网关不推 member_joined）
                  const puid = await puidOfPool(deps.pool, accountId);
                  await tx(deps.pool, async (c) => {
                    await c.query(
                      `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, last_event_id)
                       VALUES ($1, $2, $3, 'member', now(), 0)
                       ON CONFLICT (group_id, platform_user_id) DO NOTHING`,
                      [job.group_id, accountId, puid],
                    );
                    await c.query(
                      `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"joined"'), updated_at=now()
                       WHERE id=$1`,
                      [jobId],
                    );
                  });
                  return { accountId, ok: true as const };
                }
                return { accountId, ok: false as const, code };
              }
            }
          }),
        );
        const failed = results.find((r) => !r.ok);
        if (failed !== undefined) {
          await tx(deps.pool, (c) => failJob(c, jobId, `join:${failed.accountId}`, failed.code ?? 'INTERNAL'));
          return;
        }
        // 全 waiting/joined → 进入等待相位（deadline 锚点落库；已 joined 的不重置）
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
        if (job.join_deadline_at !== null && job.join_deadline_at.getTime() <= Date.now()) {
          // A2：精确到未到的那个成员
          const members = job.context.members ?? {};
          const missing = payload.memberAccountIds.find((id) => members[id] !== 'joined') ?? 'unknown';
          await tx(deps.pool, (c) => failJob(c, jobId, `join:${missing}`, 'JOIN_TIMEOUT'));
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
            await sleep(1000); // PROMOTE_RETRY_WAIT_MS；骨架档位（T-P3-06 收口完整策略）
            break;
          }
          await tx(deps.pool, (c) => failJob(c, jobId, 'promote', code));
          return;
        }
        // 成功事务：UPSERT role=admin（D2-2 兜底缺行）+ phase=done → finished
        const puid = await puidOfPool(deps.pool, target);
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

// ---------- 共享工具 ----------


function escapeJsonbKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '');
}

async function gatewayGroupId(pool: Pool, groupId: string | null): Promise<string | null> {
  if (groupId === null) return null;
  const { rows } = await pool.query<{ gateway_group_id: string | null }>(
    'SELECT gateway_group_id FROM "group" WHERE id=$1',
    [groupId],
  );
  return rows[0]?.gateway_group_id ?? null;
}

async function puidOf(client: PoolClient, accountId: string): Promise<string> {
  const { rows } = await client.query<{ platform_user_id: string | null }>(
    'SELECT platform_user_id FROM account WHERE id=$1',
    [accountId],
  );
  return rows[0]?.platform_user_id ?? '';
}

async function puidOfPool(pool: Pool, accountId: string): Promise<string> {
  const { rows } = await pool.query<{ platform_user_id: string | null }>(
    'SELECT platform_user_id FROM account WHERE id=$1',
    [accountId],
  );
  return rows[0]?.platform_user_id ?? '';
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
