// kick_user 工具（T-P4-10；DES/06 §8.4 门槛顺序 + §8.5 执行流程图逐字 + X-1 码表封闭 + REQ A5-6）。
// 门槛顺序（§8.4 逐字）：
//   1) auto_kick_enabled=true，否则 POLICY_DENIED（is_error tool_result，不进协议错误、不审计——
//      门槛在审计前，executor 的 kickPreAudit 钩承载）；
//   2) 审计门禁（executor 上游统一跑，见 T-P4-07）；
//   3) GATE1：群 status='active'，否则 GROUP_UNREACHABLE；
//   4) 选账号：活跃群成员 ∧ online ∧ role∈{creator,admin}，account_id 字典序第一；
//      无 → NO_AVAILABLE_ACCOUNT。
// 执行（§8.5 逐字）：step tool_dispatched + kick_target 落库 → POST kick
//   - 200 → {kicked:true}（member_left 事件随后更新成员表，§04 §4——本层不直改成员表）
//   - 409 OWNER_LEFT / 403 NO_PERMISSION → 同名透传（A2，两码都在 X-1 表内）
//   - 504 NETWORK_TIMEOUT → 等 2s（KICK_CONVERGE_MS，网关保证收敛）→ GET members：
//       目标不在 → {kicked:true}；仍在 → SEND_FAILED + message 'kick unresolved after
//       gateway 504: target still member'（X-1 逐字串）
//   - 其他网关错（ACCOUNT_OFFLINE 等表外码）→ SEND_FAILED + message 带网关原始码（X-1）
// 恢复语义（E5/§9.1）：kick 不重发——崩溃后按 kick_target 查成员列表判定。
// X-1 断言：本文件产出的 code 必在 AGENT_ERROR_CODES 表内（编程期 assert，违约即炸）。
import { AGENT_ERROR_CODES } from '@kapibala/contract';
import type { Pool, PoolClient } from 'pg';
import { KICK_CONVERGE_MS } from '../../../constants.js';
import { GatewayError } from '../../../gateway/errors.js';
import type { GatewayClient } from '../../../gateway/client.js';
import type { ToolOutcome } from '../executor.js';

const KICK_504_MESSAGE = 'kick unresolved after gateway 504: target still member'; // X-1 逐字

interface ToolErrorContent {
  code: string;
  message: string;
  hint?: string;
}

/** X-1 封闭性：tool_result 的 code 只许在 13 码表内（AGENT_ERROR_CODES 逐字常量） */
function assertClosedCode(code: string): asserts code is (typeof AGENT_ERROR_CODES)[number] {
  if (!(AGENT_ERROR_CODES as readonly string[]).includes(code)) {
    throw new Error(`tool_result code outside X-1 table: ${code}`);
  }
}

function errResult(code: string, message: string): ToolOutcome {
  assertClosedCode(code);
  const body: ToolErrorContent = { code, message };
  return { type: 'result', content: JSON.stringify(body), isError: true, resultSummary: `${code}`.slice(0, 200) };
}

function kickedResult(): ToolOutcome {
  return { type: 'result', content: JSON.stringify({ kicked: true }), resultSummary: 'kicked' };
}

/** 门槛 1（§8.4 顺序逐字）：auto_kick_enabled=false → POLICY_DENIED；在审计前执行 */
export async function kickPreAudit(client: PoolClient, groupId: string): Promise<ToolOutcome | undefined> {
  const { rows } = await client.query<{ auto_kick_enabled: boolean }>(
    `SELECT auto_kick_enabled FROM "group" WHERE id=$1`,
    [groupId],
  );
  if (rows[0]?.auto_kick_enabled === true) return undefined;
  return errResult('POLICY_DENIED', 'auto_kick_enabled is false');
}

interface GroupRow {
  readonly status: string;
  readonly gateway_group_id: string | null;
}

interface KickDeps {
  readonly gateway: GatewayClient;
  readonly pool: Pool;
  /** 504 后 2s 收敛等待的注入缝（默认真 sleep；测试注入即时） */
  readonly convergeWait?: () => Promise<void>;
}

export async function execKickUser(
  ctx: { client: PoolClient; runId: string; groupId: string; stepSeq: number; input: unknown },
  deps: KickDeps,
): Promise<ToolOutcome> {
  const input = (typeof ctx.input === 'object' && ctx.input !== null ? ctx.input : {}) as Record<string, unknown>;
  const target = input['platform_user_id'];
  if (typeof target !== 'string') {
    return errResult('INVALID_INPUT', 'platform_user_id required');
  }

  // 门槛 3 GATE1 + 门槛 4 选账号（role∈{creator,admin} 是 kick 专属收窄）
  const { rows: g } = await ctx.client.query<GroupRow>(
    `SELECT status, gateway_group_id FROM "group" WHERE id=$1`, [ctx.groupId]);
  const group = g[0];
  if (group?.status !== 'active') {
    return errResult('GROUP_UNREACHABLE', 'group is unreachable');
  }
  const { rows: pick } = await ctx.client.query<{ account_id: string }>(
    `SELECT gm.account_id FROM group_member gm
     JOIN account a ON a.id = gm.account_id
     WHERE gm.group_id=$1 AND gm.left_at IS NULL AND a.status='online'
       AND gm.role IN ('creator','admin')
     ORDER BY gm.account_id ASC LIMIT 1`,
    [ctx.groupId],
  );
  const accountId = pick[0]?.account_id;
  if (accountId === undefined) {
    return errResult('NO_AVAILABLE_ACCOUNT', 'no online creator/admin member account');
  }
  if (group.gateway_group_id === null) {
    // 群未在网关侧建成却标 active 的不可能态——按 X-1 收敛 SEND_FAILED
    return errResult('SEND_FAILED', 'group has no gateway id');
  }

  // PRE 事务（§8.5）：step tool_dispatched + kick_target（E5 恢复凭据）——审计 pass 已在上游
  await ctx.client.query(
    `UPDATE agent_run_step SET status='tool_dispatched', audit_verdict='pass',
            kick_target=$3, updated_at=now()
     WHERE run_id=$1 AND seq=$2`,
    [ctx.runId, ctx.stepSeq, target],
  );

  // 网关调用（kick 响应可能 1–5s，client 层 timeout=6s 已带余量）；
  // reason 不传给网关——网关 kick API 只有 byAccountId/targetPlatformUserId（契约形状），
  // reason 的用途是送审文本（auditTextForTool）与审计日志
  try {
    await deps.gateway.kick(group.gateway_group_id, {
      byAccountId: accountId,
      targetPlatformUserId: target,
    });
    return kickedResult(); // 200 {kicked:true}
  } catch (err) {
    if (!(err instanceof GatewayError)) {
      return errResult('SEND_FAILED', `kick failed: ${String(err)}`);
    }
    if (err.status === 409 && err.code === 'OWNER_LEFT') {
      return errResult('OWNER_LEFT', 'owner already left the group');
    }
    if (err.status === 403 && err.code === 'NO_PERMISSION') {
      return errResult('NO_PERMISSION', 'operator lacks kick permission');
    }
    if (err.status === 504 || err.code === 'NETWORK_TIMEOUT' || err.code === 'TIMEOUT') {
      // 结果未知：等 2s 收敛 → 查成员列表（§8.5 K504 框逐字）
      await (deps.convergeWait ?? (() => new Promise<void>((r) => setTimeout(r, KICK_CONVERGE_MS))))();
      const members = await deps.gateway.members(group.gateway_group_id).catch(() => []);
      const stillThere = members.some((m) => m.platformUserId === target);
      return stillThere ? errResult('SEND_FAILED', KICK_504_MESSAGE) : kickedResult();
    }
    // 其他网关错（ACCOUNT_OFFLINE/RATE_LIMITED/UNAVAILABLE/…）→ SEND_FAILED + 原码进 message（X-1）
    return errResult('SEND_FAILED', `gateway ${err.code} (HTTP ${err.status})`);
  }
}

/**
 * T-P4-11 恢复用（§9.2 kick_user 行逐字）：崩溃于 tool_dispatched 时按 kick_target 反查
 * 成员列表——目标不在 -> {kicked:true}；在 -> 失败 tool_result。「不重放不记失败」（A5-8）。
 * 同 §8.5 RECHECK：先等 2s 收敛窗再查列表（成员列表读「任意时刻」）。
 */
export async function recoverKickOutcome(
  opts: { groupId: string; kickTarget: string },
  deps: KickDeps,
): Promise<ToolOutcome> {
  await (deps.convergeWait ?? (() => new Promise<void>((r) => setTimeout(r, KICK_CONVERGE_MS))))();
  const { rows } = await deps.pool.query<{ gateway_group_id: string | null }>(
    `SELECT gateway_group_id FROM "group" WHERE id=$1`, [opts.groupId]);
  const gwGroupId = rows[0]?.gateway_group_id;
  if (gwGroupId === null || gwGroupId === undefined) {
    return errResult('SEND_FAILED', 'group has no gateway id');
  }
  const members = await deps.gateway.members(gwGroupId).catch(() => [] as { platformUserId: string }[]);
  const stillMember = members.some((m) => m.platformUserId === opts.kickTarget);
  return stillMember ? errResult('SEND_FAILED', KICK_504_MESSAGE) : kickedResult();
}
