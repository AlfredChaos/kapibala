// leave-all job（T-P3-07；DES/04 §3 全文逐字 + REQ §2.3 leave-all 行 + B2 第 2/3 条）。
// 编排（§3.1/§3.2 逐字）：
// - 受理快照活跃服务账号 → context.order = 非群主按 accountId 序 + 群主最后；
// - 串行逐成员：意图先行（context.current + states[x]='in-flight'）→ 网关 leave →
//   member_left 事件确认（默认 5s 设计值；超时查 GET /members 核对，在=失败路径/不在=确认）；
// - 非群主失败 → errors += {step:'leave:<id>', code:'LEAVE_FAILED'}（【解读】契约未给码名，
//   取 LEAVE_FAILED），其余继续退；**群主不退**；
// - 群主成功 → group.status='left' + members=[] + job finished；终局 GET /members 对账
//   （DB 活跃服务账号 puid 集合 vs 网关列表），不一致 → inconsistency(member_mismatch)；
// - 崩溃续传（§3.3/E6）：states[x]='in-flight' 已落意图未确认 → 查网关成员列表定结果
//   （仍在=没退成→失败路径；不在=已退→确认路径），**绝不重发 leave**。
import type { Pool, PoolClient } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { AppError } from '../../http/plugins/errors.js';
import { tx } from '../../db/tx.js';
import { readJob, type JobRow } from './create-job-branches.js';

/** member_left 事件确认窗口（§3.2 注：契约只说「随后推事件」，5s 核对为设计值） */
const LEAVE_CONFIRM_TIMEOUT_MS = 5000;
/** 确认轮询节拍【设计值】 */
const CONFIRM_POLL_MS = 100;

type MemberState = 'pending' | 'in-flight' | 'left' | 'failed' | 'skipped';

interface LeaveAllContext {
  /** 处理序：非群主 accountId 升序，群主最后（§3.1） */
  order: string[];
  /** 每账号状态机：pending → in-flight（意图已落、外呼在途）→ left/failed；群主失败跳过 → skipped */
  states: Record<string, MemberState>;
  /** 当前在途成员（意图指针；§3.3 崩溃判定锚点） */
  current?: string;
  /** 群主账号（排序与失败跳过判定） */
  owner: string;
}

interface LeaveAllJobRow extends Omit<JobRow, 'context'> {
  context: LeaveAllContext;
}

export interface LeaveAllDeps {
  pool: Pool;
  gateway: Pick<GatewayClient, 'leave' | 'members'>;
  logger?: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  /** 测试缝：member_left 确认窗（缺省 5s 设计值） */
  confirmTimeoutMs?: number;
  /** 测试缝：确认轮询节拍（缺省 100ms） */
  confirmPollMs?: number;
}

// ---------- 受理（§3.2 INIT） ----------

/**
 * POST /api/groups/:id/leave-all 的域入口：校验群存在且非 left → 快照活跃成员排序 →
 * 事务（job leaving + ws_event running）→ 202 {jobId}。
 */
export async function acceptLeaveAll(pool: Pool, groupId: string): Promise<{ jobId: string }> {
  const { rows: groups } = await pool.query<{ id: string; status: string; creator_account_id: string }>(
    'SELECT id, status, creator_account_id FROM "group" WHERE id = $1',
    [groupId],
  );
  const group = groups[0];
  if (group === undefined) throw new AppError('GROUP_NOT_FOUND', `unknown group: ${groupId}`);
  if (group.status === 'left') throw new AppError('ILLEGAL_TRANSITION', `group ${groupId} already left`);

  // 活跃服务账号快照（left_at IS NULL）；序：非群主 accountId 升序 → 群主最后
  const { rows: members } = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM group_member
     WHERE group_id = $1 AND left_at IS NULL
     ORDER BY account_id`,
    [groupId],
  );
  const owner = group.creator_account_id;
  const order = [
    ...members.map((m) => m.account_id).filter((id) => id !== owner),
    ...(members.some((m) => m.account_id === owner) ? [owner] : []),
  ];

  return tx(pool, async (client) => {
    const { rows: j } = await client.query<{ id: string }>(
      `INSERT INTO job (id, type, group_id, payload, phase, context)
       VALUES (gen_random_uuid(), 'leave_all', $1, $2::jsonb, 'leaving', $3::jsonb) RETURNING id`,
      [
        groupId,
        JSON.stringify({ groupId }),
        JSON.stringify({
          order,
          owner,
          states: Object.fromEntries(order.map((id) => [id, 'pending' as const])),
        } satisfies LeaveAllContext),
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

async function readLeaveJob(client: PoolClient, jobId: string): Promise<LeaveAllJobRow | null> {
  const row = await readJob(client, jobId);
  return row === null ? null : (row as LeaveAllJobRow);
}

/** errors[] 追加 + 成员状态落库（同 tx；B2 失败记步语义） */
async function markMemberFailed(
  client: PoolClient,
  jobId: string,
  accountId: string,
  code: string,
): Promise<void> {
  await client.query(
    `UPDATE job SET errors = errors || $2::jsonb,
                    context = jsonb_set(context, '{states,${accountId}}', '"failed"'),
                    updated_at=now()
     WHERE id=$1 AND status='running'`,
    [jobId, JSON.stringify([{ step: `leave:${accountId}`, code }])],
  );
}

async function setMemberState(
  client: PoolClient,
  jobId: string,
  accountId: string,
  state: MemberState,
  clearCurrent = false,
): Promise<void> {
  await client.query(
    `UPDATE job SET context = jsonb_set(context, '{states,${accountId}}', '"${state}"')
                    ${clearCurrent ? `|| '{"current":null}'::jsonb` : ''},
                    updated_at=now()
     WHERE id=$1 AND status='running'`,
    [jobId],
  );
}

/** 网关成员列表（puid 集合）；调用失败返回 null（恢复扫描下一轮再定，不落终态） */
async function gatewayMemberPuids(
  deps: LeaveAllDeps,
  groupGw: string,
): Promise<Set<string> | null> {
  try {
    const list = await deps.gateway.members(groupGw);
    return new Set(list.map((m) => m.platformUserId));
  } catch {
    return null;
  }
}

/**
 * leave 成功后的确认（§3.2 NEXT/CONF/CONF2）：
 * 先等 member_left 事件把行置 left_at（事件路径唯一写入源）；超时查网关成员列表——
 * 不在 = 已退（本函数事务补 left_at，§3 内允许的核对确认通道）；在 = 没退成 = 失败路径。
 */
async function confirmMemberLeft(
  deps: LeaveAllDeps,
  jobId: string,
  groupId: string,
  groupGw: string,
  accountId: string,
): Promise<boolean> {
  const timeoutMs = deps.confirmTimeoutMs ?? LEAVE_CONFIRM_TIMEOUT_MS;
  const pollMs = deps.confirmPollMs ?? CONFIRM_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await deps.pool.query<{ left_at: Date | null }>(
      'SELECT left_at FROM group_member WHERE group_id=$1 AND account_id=$2',
      [groupId, accountId],
    );
    if (rows[0]?.left_at != null) return true; // member_left 事件已确认（§4 事件路径）
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  // 超时：查成员列表核对（设计值分支）
  const puid = await platformPuid(deps.pool, accountId);
  const list = await gatewayMemberPuids(deps, groupGw);
  if (list === null) return false; // 核对通道不可用 → 保守失败路径（下轮/重试再定）
  if (list.has(puid)) return false; // 仍在 = 没退成
  await tx(deps.pool, async (c) => {
    await c.query('UPDATE group_member SET left_at=now() WHERE group_id=$1 AND account_id=$2 AND left_at IS NULL', [
      groupId,
      accountId,
    ]);
  });
  return true;
}

async function platformPuid(pool: Pool, accountId: string): Promise<string> {
  const { rows } = await pool.query<{ platform_user_id: string | null }>(
    'SELECT platform_user_id FROM account WHERE id=$1',
    [accountId],
  );
  return rows[0]?.platform_user_id ?? '';
}

/** 终局对账（§3.3）：DB 活跃服务账号 puid 集合 vs 网关成员列表；不一致 → inconsistency */
async function reconcileMembers(
  deps: LeaveAllDeps,
  jobId: string,
  groupId: string,
  groupGw: string,
): Promise<void> {
  const gw = await gatewayMemberPuids(deps, groupGw);
  if (gw === null) return; // 网关不可达时对账无从谈起——本轮放弃（日志由 client 侧记录）
  const { rows } = await deps.pool.query<{ platform_user_id: string }>(
    'SELECT platform_user_id FROM group_member WHERE group_id=$1 AND left_at IS NULL',
    [groupId],
  );
  const dbSet = new Set(rows.map((r) => r.platform_user_id));
  // 对账范围 = 服务账号集合（§3.3 解读）：网关列表取与我方服务账号 puid 的交集
  const { rows: svc } = await deps.pool.query<{ platform_user_id: string }>(
    'SELECT platform_user_id FROM account WHERE platform_user_id IS NOT NULL',
  );
  const svcPuids = new Set(svc.map((r) => r.platform_user_id));
  const gwSvc = new Set([...gw].filter((p) => svcPuids.has(p)));
  const same = dbSet.size === gwSvc.size && [...dbSet].every((p) => gwSvc.has(p));
  if (!same) {
    await deps.pool.query("INSERT INTO ws_event (type, payload) VALUES ('inconsistency', $1::jsonb)", [
      JSON.stringify({
        kind: 'member_mismatch',
        ref: `job:${jobId}`,
        message: `leave-all reconcile mismatch: db=[${[...dbSet].join(',')}] gateway=[${[...gwSvc].join(',')}]`,
      }),
    ]);
  }
}

/**
 * leave-all 执行器（§3.2 LOOP/FINAL + §3.3 崩溃恢复）。
 * advisory lock 单飞同 create 执行器；串行成员处理，失败继续、群主门槛、终局对账。
 */
export async function runLeaveAllJob(deps: LeaveAllDeps, jobId: string): Promise<void> {
  const conn = await deps.pool.connect();
  try {
    const { rows: lock } = await conn.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [`job:${jobId}`],
    );
    if (lock[0]?.locked !== true) return;
    try {
      await driveLeave(deps, jobId);
    } finally {
      await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${jobId}`]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

async function driveLeave(deps: LeaveAllDeps, jobId: string): Promise<void> {
  for (;;) {
    const job = await tx(deps.pool, (c) => readLeaveJob(c, jobId));
    if (job === null || job.status !== 'running') return;
    if (job.phase !== 'leaving') return; // done/未知相位
    const ctx = job.context;
    const groupGw = await gatewayGroupIdOf(deps.pool, job.group_id);
    if (groupGw === null || job.group_id === null) return; // 群无网关映射——leave 无从发起

    // 下一个待处理成员（order 序；群主仅当无失败时处理）
    const next = ctx.order.find((id) => ctx.states[id] === 'pending' || ctx.states[id] === 'in-flight');
    if (next === undefined) {
      // 全部处理完：终局（对账 → finished/failed）
      await reconcileMembers(deps, jobId, job.group_id, groupGw);
      const failed = job.errors.length > 0;
      await tx(deps.pool, async (c) => {
        if (!failed) {
          await c.query(`UPDATE "group" SET status='left', updated_at=now() WHERE id=$1`, [job.group_id]);
        }
        await c.query(
          `UPDATE job SET status=$2, phase='done', finished_at=now(), updated_at=now() WHERE id=$1`,
          [jobId, failed ? 'failed' : 'finished'],
        );
        await c.query("INSERT INTO ws_event (type, payload) VALUES ('job', $1::jsonb)", [
          JSON.stringify({ jobId, status: failed ? 'failed' : 'finished' }),
        ]);
      });
      return;
    }

    const isOwner = next === ctx.owner;
    if (isOwner && job.errors.length > 0) {
      // B2：有非群主失败 → 群主不退（skip），直接收口失败
      await tx(deps.pool, (c) => setMemberState(c, jobId, next, 'skipped'));
      continue;
    }

    if (ctx.states[next] === 'in-flight') {
      // §3.3 崩溃恢复：意图已落结果未知 → 查网关成员列表定结果，绝不重发 leave
      const puid = await platformPuid(deps.pool, next);
      const list = await gatewayMemberPuids(deps, groupGw);
      if (list === null) return; // 核对不可用：本轮让位（下次执行/调度再续）
      if (list.has(puid)) {
        // 仍在 = 没退成 = 失败路径
        await tx(deps.pool, (c) => markMemberFailed(c, jobId, next, 'LEAVE_FAILED'));
      } else {
        // 不在 = 已退 = 确认路径：补 left_at + states='left'
        await tx(deps.pool, async (c) => {
          await c.query(
            'UPDATE group_member SET left_at=now() WHERE group_id=$1 AND account_id=$2 AND left_at IS NULL',
            [job.group_id, next],
          );
          await setMemberState(c, jobId, next, 'left', true);
        });
      }
      continue;
    }

    // pending → 意图先行（context.current + states='in-flight'）再外呼
    await tx(deps.pool, async (c) => {
      await c.query(
        `UPDATE job SET context = jsonb_set(context, '{states,${next}}', '"in-flight"')
                        || jsonb_build_object('current', $2::text), updated_at=now()
         WHERE id=$1 AND status='running'`,
        [jobId, next],
      );
    });
    try {
      await deps.gateway.leave(groupGw, { accountId: next });
    } catch (err) {
      // B2：500/409 等 → 记 LEAVE_FAILED（【解读】契约未给码名），其余成员继续
      const code = err instanceof GatewayError ? err.code : 'INTERNAL';
      deps.logger?.warn({ jobId, accountId: next, code }, 'leave-all member leave failed');
      await tx(deps.pool, (c) => markMemberFailed(c, jobId, next, 'LEAVE_FAILED'));
      continue;
    }
    // 200：等 member_left 确认 / 超时核对成员列表
    const confirmed = await confirmMemberLeft(deps, jobId, job.group_id, groupGw, next);
    if (confirmed) {
      await tx(deps.pool, (c) => setMemberState(c, jobId, next, 'left', true));
    } else {
      await tx(deps.pool, async (c) => {
        // 仍在网关列表 = 没退成（B2 失败路径）；核对失败同归失败（保守：不假设已退）
        await markMemberFailed(c, jobId, next, 'LEAVE_FAILED');
      });
    }
  }
}

async function gatewayGroupIdOf(pool: Pool, groupId: string | null): Promise<string | null> {
  if (groupId === null) return null;
  const { rows } = await pool.query<{ gateway_group_id: string | null }>(
    'SELECT gateway_group_id FROM "group" WHERE id=$1',
    [groupId],
  );
  return rows[0]?.gateway_group_id ?? null;
}
