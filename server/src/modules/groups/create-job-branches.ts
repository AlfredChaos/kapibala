// 建群 job 异常分支（T-P3-06；DES/04 §2.2 要点逐字、§2.4 崩溃恢复、REQ B2 第 1 条、A2）。
// 归属约定：joining/waiting_joins/promote 三相位的外呼分支判定 + 超时扫描体在此；
// 主链相位机/受理仍归 create-job.ts（本文件函数由它分派调用，不反向依赖）。
//
// B2 三分支（逐字）：
// - INVITE_NOT_READY：等 readyAfterMs 后重试；重试次数不设限（链接就绪是网关保证的必然事件），
//   但每次重试前检查 job 仍 running（外部 fail/cancel 须能终止等待）。
// - INVITE_EXPIRED：重新申请链接后重试一次（job 级一次：context.reinviteUsed 原子认领，
//   未领到即已用尽 → 直接失败）；重申请本身失败 → step=invite；重试再失败（含再次 EXPIRED）
//   → step=join:<accountId>。
// - ALREADY_MEMBER：视为成功（B2）；网关此时不推 member_joined（§2.1），成员行由 job 事务
//   UPSERT(role=member) 兜底（§4 例外 3、D2-2）——不写则 promote 的 role 更新命中 0 行。
// A2：member_joined 10s 未到 → JOIN_TIMEOUT，step 精确到未达成员；promote 总调用 ≤2
// （context.promoteCalls 持久化，崩溃续传累计——见 create-job.ts promote 相位）。
// §2.4：joining 崩溃续传——waiting/joined 不重发 join，pending/joining 正常发；
// waiting_joins 恢复时 join_deadline_at 取 max(原值, now())（不重置窗口）。
import type { Pool, PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRecord, type GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { tx } from '../../db/tx.js';

/** INVITE_NOT_READY 重试节拍【设计值】：响应带剩余 readyAfterMs 时优先用它，否则按此轮询 */
const NOT_READY_POLL_MS = 100;

// ---------- 共享行类型与低层工具（create-job.ts 与本文件共用） ----------

export interface JobRow {
  id: string;
  status: string;
  phase: string;
  payload: { creatorAccountId: string; memberAccountIds: string[] };
  /** §7 形状的错误表（leave-all 判群主要不要退；create_group 用不到但同列共享） */
  errors: Array<{ step: string; code: string }>;
  context: {
    inviteLink?: string;
    /** invite 返回的就绪时刻（epoch ms）：join 不得早于此（INVITE_NOT_READY 自然路径） */
    inviteReadyAt?: number;
    /** B2：INVITE_EXPIRED 的「重申链接」机会已用（job 级仅一次） */
    reinviteUsed?: boolean;
    members?: Record<string, 'pending' | 'joining' | 'waiting' | 'joined'>;
    /** promote 网关调用累计（A2 ≤2；落库持久化，崩溃续传不丢计数） */
    promoteCalls?: number;
  };
  group_id: string | null;
  join_deadline_at: Date | null;
}

export async function readJob(client: PoolClient, jobId: string): Promise<JobRow | null> {
  const { rows } = await client.query<JobRow>(
    'SELECT id, status, phase, payload, context, group_id, join_deadline_at, errors FROM job WHERE id=$1 FOR UPDATE',
    [jobId],
  );
  return rows[0] ?? null;
}

/** job 终态事务：errors 追加 {step,code} + ws_event(failed)（DES/04 §7 形状） */
export async function failJob(client: PoolClient, jobId: string, step: string, code: string): Promise<void> {
  await client.query(
    `UPDATE job SET status='failed', errors = errors || $2::jsonb, finished_at=now(), updated_at=now()
     WHERE id=$1`,
    [jobId, JSON.stringify([{ step, code }])],
  );
  await client.query("INSERT INTO ws_event (type, payload) VALUES ('job', $1::jsonb)", [
    JSON.stringify({ jobId, status: 'failed' }),
  ]);
}

/** jsonb_set 键名净化：accountId 仅允许安全字符（防注入路径段） */
export function escapeJsonbKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '');
}

export async function gatewayGroupId(pool: Pool, groupId: string | null): Promise<string | null> {
  if (groupId === null) return null;
  const { rows } = await pool.query<{ gateway_group_id: string | null }>(
    'SELECT gateway_group_id FROM "group" WHERE id=$1',
    [groupId],
  );
  return rows[0]?.gateway_group_id ?? null;
}

export async function platformUserIdOf(pool: Pool, accountId: string): Promise<string> {
  const { rows } = await pool.query<{ platform_user_id: string | null }>(
    'SELECT platform_user_id FROM account WHERE id=$1',
    [accountId],
  );
  return rows[0]?.platform_user_id ?? '';
}

/** context.members[accountId] 状态落库（joining/waiting/joined 单向推进；只在 running 时生效） */
export async function setContextMember(
  pool: Pool,
  jobId: string,
  accountId: string,
  state: 'pending' | 'joining' | 'waiting' | 'joined',
): Promise<void> {
  await tx(pool, (c) =>
    c.query(
      `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"${state}"'), updated_at=now()
       WHERE id=$1 AND status='running'`,
      [jobId],
    ),
  );
}

/** D2-2/§4 例外 3：ALREADY_MEMBER 时 job 事务 UPSERT 成员行（role=member 兜底，不覆盖已有角色） */
async function upsertMemberRow(
  client: PoolClient,
  groupId: string,
  accountId: string,
  platformUserId: string,
  role: 'member' | 'admin',
): Promise<void> {
  await client.query(
    `INSERT INTO group_member (group_id, account_id, platform_user_id, role, joined_at, last_event_id)
     VALUES ($1, $2, $3, $4, now(), 0)
     ON CONFLICT (group_id, platform_user_id) DO UPDATE SET role = EXCLUDED.role`,
    [groupId, accountId, platformUserId, role],
  );
}

// ---------- B2 join 分支 ----------

interface GatewayJoinDeps {
  pool: Pool;
  gateway: Pick<GatewayClient, 'invite' | 'join'>;
}

/** 从 GatewayError 体取剩余等待（mock 409 体带 readyAfterMs 字段；缺省回落轮询节拍） */
function readyAfterMsOf(err: GatewayError): number {
  if (isRecord(err.body)) {
    const v = err.body['readyAfterMs'];
    if (typeof v === 'number' && v > 0) return v;
  }
  return NOT_READY_POLL_MS;
}

/** job 是否仍 running（INVITE_NOT_READY 无上限等待每轮必检——终止路径的唯一出口） */
async function jobStillRunning(pool: Pool, jobId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM job WHERE id=$1 AND status='running') AS ok",
    [jobId],
  );
  return rows[0]?.ok === true;
}

/** B2：INVITE_EXPIRED 的「重申链接」机会原子认领（并发成员只有一个能领到） */
async function claimReinvite(pool: Pool, jobId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE job SET context = jsonb_set(context, '{reinviteUsed}', 'true'), updated_at=now()
     WHERE id=$1 AND status='running' AND (context->>'reinviteUsed') IS DISTINCT FROM 'true'`,
    [jobId],
  );
  return rowCount === 1;
}

/** 重申请链接（B2：只允许这一次）；成功把新 inviteLink/inviteReadyAt 落 context，返回新链接 */
async function reinviteOnce(
  deps: GatewayJoinDeps,
  jobId: string,
  groupGw: string,
): Promise<{ ok: true; link: string; readyAt: number } | { ok: false; code: string }> {
  try {
    const result = await deps.gateway.invite(groupGw);
    const readyAt = Date.now() + result.readyAfterMs;
    await tx(deps.pool, (c) =>
      c.query(
        `UPDATE job SET context = context || $2::jsonb, updated_at=now()
         WHERE id=$1 AND status='running'`,
        [jobId, JSON.stringify({ inviteLink: result.inviteLink, inviteReadyAt: readyAt })],
      ),
    );
    return { ok: true, link: result.inviteLink, readyAt };
  } catch (err) {
    return { ok: false, code: err instanceof GatewayError ? err.code : 'INTERNAL' };
  }
}

export type JoinOutcome =
  | { ok: true }
  /** 失败给出已解码的 A2/§7 step：重申请失败 → 'invite'；其余 → 'join:<accountId>' */
  | { ok: false; step: string; code: string };

/**
 * 单成员 join（B2 三分支逐字）。意图「joining」已由调用方落库。
 * 返回 ok 时 context.members[x] 已置 waiting/joined；false 返回 {step,code} 由调用方落 failed。
 */
export async function joinMemberWithBranches(
  deps: GatewayJoinDeps,
  jobId: string,
  groupId: string,
  groupGw: string,
  accountId: string,
  link: string,
  readyAt: number,
): Promise<JoinOutcome> {
  const joinStep = `join:${accountId}`;
  // 等 invite 就绪（readyAfterMs 契约窗口内 join 必 409；等待发生在相位内不转相位）
  for (;;) {
    const wait = readyAt - Date.now();
    if (wait <= 0) break;
    if (!(await jobStillRunning(deps.pool, jobId))) return { ok: false, step: joinStep, code: 'CANCELLED' };
    await sleep(Math.min(wait, NOT_READY_POLL_MS));
  }
  let currentLink = link;
  for (;;) {
    try {
      await deps.gateway.join(groupGw, { accountId, inviteLink: currentLink });
      await setContextMember(deps.pool, jobId, accountId, 'waiting');
      return { ok: true };
    } catch (err) {
      const code = err instanceof GatewayError ? err.code : 'INTERNAL';
      if (code === 'INVITE_NOT_READY') {
        // B2：等 readyAfterMs 重试、不设限；每轮检 running（外部终止可打断等待）
        if (!(await jobStillRunning(deps.pool, jobId))) {
          return { ok: false, step: joinStep, code: 'CANCELLED' };
        }
        await sleep(err instanceof GatewayError ? readyAfterMsOf(err) : NOT_READY_POLL_MS);
        continue;
      }
      if (code === 'INVITE_EXPIRED') {
        // B2：重申链接仅一次（job 级原子认领）；并发成员只有一个能领到
        const claimed = await claimReinvite(deps.pool, jobId);
        if (!claimed) return { ok: false, step: joinStep, code: 'INVITE_EXPIRED' };
        const re = await reinviteOnce(deps, jobId, groupGw);
        if (!re.ok) return { ok: false, step: 'invite', code: re.code };
        const wait = re.readyAt - Date.now();
        if (wait > 0) await sleep(wait + 10); // 新链接的 readyAfterMs（时钟余量【设计值】）
        currentLink = re.link;
        try {
          await deps.gateway.join(groupGw, { accountId, inviteLink: currentLink });
          await setContextMember(deps.pool, jobId, accountId, 'waiting');
          return { ok: true };
        } catch (retryErr) {
          // 重试再失败（含再次 EXPIRED）→ join:<accountId> 失败（B2 逐字）
          return {
            ok: false,
            step: joinStep,
            code: retryErr instanceof GatewayError ? retryErr.code : 'INTERNAL',
          };
        }
      }
      if (code === 'ALREADY_MEMBER') {
        // B2 视为成功 + D2-2 UPSERT 成员行（网关不推 member_joined，事件写入源等不到该行）
        const puid = await platformUserIdOf(deps.pool, accountId);
        await tx(deps.pool, async (c) => {
          await upsertMemberRow(c, groupId, accountId, puid, 'member');
          await c.query(
            `UPDATE job SET context = jsonb_set(context, '{members,${escapeJsonbKey(accountId)}}', '"joined"'), updated_at=now()
             WHERE id=$1`,
            [jobId],
          );
        });
        return { ok: true };
      }
      // B2 未定义处理（ACCOUNT_OFFLINE/网络等）→ 失败终止，错误码逐字透传
      return { ok: false, step: joinStep, code };
    }
  }
}

/** waiting_joins 超时成员定位（A2：精确到第一个未达成员） */
export function firstMissingMember(job: JobRow): string {
  const members = job.context.members ?? {};
  return job.payload.memberAccountIds.find((id) => members[id] !== 'joined') ?? 'unknown';
}

// ---------- join_deadline 超时扫描（DES/04 §2.2 TMO 支路：调度器侧收口） ----------

export const JOIN_TIMEOUT_SCAN_NAME = 'join-timeout';

export interface JoinTimeoutScanDeps {
  pool: Pool;
}

/**
 * 扫描体：waiting_joins 且 join_deadline_at 已过的 running job → failed(JOIN_TIMEOUT)。
 * 条件更新（status/phase 双守卫）：与执行器自身轮询并发时重复触发天然幂等（宪法 §3-5）。
 * 执行器在存活期间自行到点收口（更快）；本扫描承接执行器崩溃后的超时兜底。
 */
export async function runJoinTimeoutScan(deps: JoinTimeoutScanDeps): Promise<number> {
  const { rows } = await deps.pool.query<JobRow>(
    `SELECT id, status, phase, payload, context, group_id, join_deadline_at FROM job
     WHERE type='create_group' AND status='running' AND phase='waiting_joins'
       AND join_deadline_at IS NOT NULL AND join_deadline_at <= now()`,
  );
  let failed = 0;
  for (const job of rows) {
    const missing = firstMissingMember(job);
    const changed = await tx(deps.pool, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE job SET status='failed',
                        errors = errors || $2::jsonb,
                        finished_at=now(), updated_at=now()
         WHERE id=$1 AND status='running' AND phase='waiting_joins'`,
        [job.id, JSON.stringify([{ step: `join:${missing}`, code: 'JOIN_TIMEOUT' }])],
      );
      if (rowCount === 1) {
        await c.query("INSERT INTO ws_event (type, payload) VALUES ('job', $1::jsonb)", [
          JSON.stringify({ jobId: job.id, status: 'failed' }),
        ]);
      }
      return rowCount === 1;
    });
    if (changed) failed += 1;
  }
  return failed;
}
