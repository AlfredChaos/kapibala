// agent run executor：拾取（advisory lock + 并发闸）+ turn 循环骨架（T-P4-05；
// DES/06 §2.1/§3/§5/§6 逐字 + REQ A5-2 + QR §1）。
// 拾取：进程内计数信号量（AGENT_MAX_CONCURRENT_RUNS【设计值】只限拾取不限创建）→
//   pg_try_advisory_lock(hashtextextended('agent-run:'+runId,0)) 抢不到即退（多实例互斥）→
//   claimed_by + lease_until=now()+10s，每 2s 续租（DES/06 §2.1【设计值】）。
// turn 循环每步固定结构（§3，崩溃恢复基石）：
//   0) 预算预检（12 步含结束步 / 墙钟 60s 含审计停机不计 / 连续 3 协议错误——budget.ts）+
//      墙钟记账 wall_consumed_ms += now()-COALESCE(resume_at,created_at)、resume_at=now()；
//   1) INSERT step(seq=n, status='turn_dispatched', dispatch_payload=请求快照) → 才发 HTTP（E11）；
//   2) 响应/超时以条件更新 WHERE status='turn_dispatched' 写回——晚到响应 rowcount=0 即丢弃；
//   3) 合法 tool_use → 追加 assistant 块（重复 tool_use_id / 未知工具 / 入参不符走 §4 分流——
//      本文件先落最小判据，T-P4-06 归位 validation.ts/protocol-errors.ts 细化）；
//   4) 工具结果与 appended_blocks 同事务写回 → status='done'；
//   5) run 级 step_count/streak/wall_consumed_ms 随步事务累加；任一合法响应 streak 清零。
// 会话历史 100% 由 DB 重建：messages=[user(trigger_context JSON)] + 各 step appended_blocks
// 按 seq 拼接（§6 逐字，executor 无内存会话状态——A5-8 恢复前提）。
// 工具执行语义缝：executeTool 注入（finish 内置收束；其余工具默认 UNKNOWN_TOOL 路径 A，
// T-P4-07/08/09 接管 send_message/kick_user/get_recent_messages 与审计门禁）。
import type { Pool, PoolClient } from 'pg';
import {
  AGENT_LEASE_RENEW_MS,
  AGENT_LEASE_TTL_MS,
  AGENT_MAX_CONCURRENT_RUNS,
} from '../../constants.js';
import { tx } from '../../db/tx.js';
import type { AgentClient, AgentMessage, AgentTurnRequest, AgentTurnResponse } from '../../agentclient/index.js';
import { AgentClientError } from '../../agentclient/index.js';
import type { AgentRawResponse } from '../../agentclient/index.js';
import { checkBudget } from './budget.js';
import { auditTextForTool, isEffectTool, runAuditGate } from './audit.js';
import { endAgentRun } from './end-run.js';
import { AGENT_TOOLS, AGENT_TOOL_NAMES } from './tools-def.js';
import { validateTurnResponse, validateToolInput } from './validation.js';
import {
  appendToolErrorResult,
  clipRawResponse,
  recordProtocolErrorStep,
} from './protocol-errors.js';
import { startAgentRun } from './trigger.js';
import { execGetRecentMessages } from './tools/query.js';
import { execFinish } from './tools/finish.js';
import { execSendMessage, sendMessagePreAudit, recoverSendOutcome, type DeliveryWaiter } from './tools/send-message.js';
import { execKickUser, kickPreAudit, recoverKickOutcome } from './tools/kick.js';
import { agentCancelGate } from './cancel.js';
import type { GatewayClient } from '../../gateway/client.js';



export interface ExecutorLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** 工具执行语义缝（T-P4-07..09 接管）；executor 只负责把结果按 §3 结构落库 */
export type ToolOutcome =
  | {
      readonly type: 'result';
      /** tool_result content（JSON 串或纯文本——按 §7 各工具契约组装） */
      readonly content: string;
      readonly isError?: boolean;
      readonly resultSummary?: string;
    }
  | {
      readonly type: 'end_run';
      /** finish 等结束步的 step.kind（§7.4 'final'）；缺省 'tool_use' */
      readonly stepKind?: 'final';
      readonly status: 'finished' | 'failed' | 'blocked' | 'cancelled';
      readonly endReason: 'final' | 'budget_exhausted' | 'wall_clock' | 'protocol_errors' | 'audit_blocked' | 'cancelled';
      readonly summary?: string;
      /** 结束步仍可带 tool_result（如 AUDIT_REJECTED 前的 fail） */
      readonly toolResult?: { readonly content: string; readonly isError?: boolean };
      readonly resultSummary?: string;
    };

export interface ToolCallContext {
  readonly client: PoolClient;
  /** 工具调用上下文连接：普通池连接（autocommit），非事务——工具需要多写原子性的自起 tx()，
      长等待（send_message 5s / kick 收敛）不得包住未提交写，否则轮询方看不到行（SEND_TIMEOUT 回归） */
  readonly pool: Pool;
  readonly runId: string;
  readonly groupId: string;
  readonly stepSeq: number;
  readonly toolName: string;
  readonly input: unknown;
}

export type ToolExecutor = (ctx: ToolCallContext) => Promise<ToolOutcome>;

export interface AgentExecutorDeps {
  readonly pool: Pool;
  readonly agentClient: AgentClient;
  readonly logger: ExecutorLogger;
  /** claimed_by 取值（多实例区分） */
  readonly instanceId: string;
  readonly maxConcurrentRuns?: number;
  readonly executeTool?: ToolExecutor;
  /** send_message 的 5s 落定等待器注入缝（测试可替；默认轮询 message 表） */
  readonly deliveryWaiter?: DeliveryWaiter;
  /** kick_user 的网关通道（boot 注入真 GatewayClient；测试注入假实现） */
  readonly gateway?: GatewayClient;
  /** kick 504 后 2s 收敛等待注入缝（测试注入即时；默认 KICK_CONVERGE_MS 真等待） */
  readonly kickConvergeWait?: () => Promise<void>;
}

interface RunRow {
  readonly id: string;
  readonly group_id: string;
  readonly trigger_context: Record<string, unknown>;
  readonly step_count: number;
  readonly protocol_error_streak: number;
  readonly wall_consumed_ms: string; // bigint → pg 返回字符串
  readonly wall_deadline_at: Date | null;
}

interface StepRow {
  readonly seq: number;
  readonly appended_blocks: unknown;
}

/** 会话历史：messages[0]=trigger_context JSON 串 + 各 step appended_blocks 按 seq 顺序拼接（§6 逐字） */
async function rebuildMessages(client: PoolClient, run: RunRow): Promise<AgentMessage[]> {
  const { rows } = await client.query<StepRow>(
    'SELECT seq, appended_blocks FROM agent_run_step WHERE run_id=$1 ORDER BY seq',
    [run.id],
  );
  const messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: JSON.stringify(run.trigger_context) }] },
  ];
  for (const r of rows) {
    const blocks = r.appended_blocks;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (typeof b === 'object' && b !== null) messages.push(b as AgentMessage);
      }
    }
  }
  return messages;
}

export function createAgentExecutor(deps: AgentExecutorDeps): { startRun(runId: string): void } {
  const maxConcurrent = deps.maxConcurrentRuns ?? AGENT_MAX_CONCURRENT_RUNS;
  let active = 0;
  const pending: string[] = [];

  function pump(): void {
    while (active < maxConcurrent && pending.length > 0) {
      const runId = pending.shift();
      if (runId === undefined) break;
      active += 1;
      void executeRun(runId)
        .catch((err: unknown) => {
          deps.logger.error({ err, runId }, 'agent executor crashed mid-run');
        })
        .finally(() => {
          active -= 1;
          pump(); // 释放空位即触发待拾取扫描（§2.1：信号量空位驱动，无定时重试编排）
        });
    }
  }

  async function executeRun(runId: string): Promise<void> {
    // 1) advisory lock（会话级——必须专用连接持有到 run 结束；抢不到 = 别的实例已接管）
    const lockClient = await deps.pool.connect();
    const locked = await lockClient.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('agent-run:' || $1, 0)) AS ok",
      [runId],
    );
    if (locked.rows[0]?.ok !== true) {
      lockClient.release();
      return;
    }
    // 2) 拾取标记 + 首期租约（锁连接上做，释放前都有效）
    await lockClient.query(
      `UPDATE agent_run SET claimed_by=$2, lease_until=now() + $3 * interval '1 millisecond', updated_at=now()
       WHERE id=$1 AND status='running'`,
      [runId, deps.instanceId, AGENT_LEASE_TTL_MS],
    );
    const renew = setInterval(() => {
      void deps.pool
        .query(
          `UPDATE agent_run SET lease_until=now() + $2 * interval '1 millisecond', updated_at=now()
           WHERE id=$1 AND status='running'`,
          [runId, AGENT_LEASE_TTL_MS],
        )
        .catch((err: unknown) => deps.logger.warn({ err, runId }, 'lease renew failed'));
    }, AGENT_LEASE_RENEW_MS);
    renew.unref();

    try {
      await turnLoop(runId);
    } finally {
      clearInterval(renew);
      await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        `agent-run:${runId}`,
      ]).catch(() => undefined);
      lockClient.release();
    }
  }

  /** 每轮开始：FOR UPDATE 读 run + 墙钟记账 + 预算预检；超限则同事务终态化 */
  async function precheck(runId: string): Promise<{ proceed: boolean; run?: RunRow; nextRunId?: string }> {
    return tx(deps.pool, async (client) => {
      const { rows } = await client.query<RunRow>(
        `SELECT id, group_id, trigger_context, step_count, protocol_error_streak, wall_consumed_ms, wall_deadline_at
         FROM agent_run WHERE id=$1 AND status='running' FOR UPDATE`,
        [runId],
      );
      const run = rows[0];
      if (run === undefined) {
        // 读不到 running 行：并发终态化是正常路径，但「事务内拾取 → COMMIT 前抢跑」也会走到这——
        // 留日志不静默退出（BUGFIX 2026-09-28：e8553884 静默卡死 40min 的教训）
        deps.logger.warn({ runId }, 'precheck found no running run row; executor exiting');
        return { proceed: false };
      }
      // 墙钟记账（§5 逐字公式；停机不计——resume_at 只随进程内步事务推进）
      await client.query(
        `UPDATE agent_run SET
           wall_consumed_ms = wall_consumed_ms + GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(resume_at, created_at))) * 1000)::bigint,
           resume_at = now(), updated_at = now()
         WHERE id=$1`,
        [runId],
      );
      const verdict = checkBudget(
        {
          stepCount: run.step_count,
          wallConsumedMs: Number(run.wall_consumed_ms),
          wallDeadlineAt: run.wall_deadline_at,
          protocolErrorStreak: run.protocol_error_streak,
        },
        new Date(),
      );
      if (verdict.ok) return { proceed: true, run };
      const end = await endAgentRun(client, {
        runId,
        status: 'failed',
        endReason: verdict.endReason,
      });
      return { proceed: false, nextRunId: end.nextRunId };
    });
  }

  async function turnLoop(runId: string): Promise<void> {
    for (;;) {
      const pre = await precheck(runId);
      if (!pre.proceed) {
        if (pre.nextRunId !== undefined) startAgentRun(pre.nextRunId);
        return;
      }
      const run = pre.run;
      if (run === undefined) return;

      // ---- 恢复分支（§9.1 逐字）：最后一个未完成 step 的 status 决定断点续法 ----
      const pending = await tx(deps.pool, async (c) => {
        const { rows } = await c.query<{
          seq: number; status: string; dispatch_payload: unknown;
          raw_response: string | null; tool_use_id: string | null; name: string | null;
          client_msg_id: string | null; kick_target: string | null;
        }>(
          `SELECT seq, status, dispatch_payload, raw_response, tool_use_id, name, client_msg_id, kick_target
           FROM agent_run_step WHERE run_id=$1 AND status<>'done' ORDER BY seq DESC LIMIT 1`,
          [runId],
        );
        return rows[0];
      });

      let seq: number;
      let request: AgentTurnRequest;
      let rawRes: AgentRawResponse | undefined;
      let turn: AgentTurnResponse | undefined;
      let errCode: 'BAD_JSON' | 'TURN_TIMEOUT' | null = null;
      let errRaw: string | null = null;
      let resumeReceived = false;

      if (pending?.status === 'tool_dispatched') {
        // 效果型工具意图已落：反查外部现状，绝不重放（§9.1 TOOLKIND 分支逐字）
        seq = pending.seq;
        let recovered: ToolOutcome;
        if (pending.name === 'send_message' && pending.client_msg_id !== null) {
          recovered = await recoverSendOutcome(pending.client_msg_id, {
            pool: deps.pool, waiter: deps.deliveryWaiter,
          });
        } else if (pending.name === 'kick_user' && pending.kick_target !== null && deps.gateway !== undefined) {
          recovered = await recoverKickOutcome(
            { groupId: run.group_id, kickTarget: pending.kick_target },
            { pool: deps.pool, gateway: deps.gateway, convergeWait: deps.kickConvergeWait },
          );
        } else {
          // 凭据缺失（旧数据/未知工具）→ 按 SEND_FAILED 收敛（X-1 表内码）
          recovered = { type: 'result', content: JSON.stringify({ code: 'SEND_FAILED', message: 'recovery: missing dispatch credential' }), isError: true };
        }
        const assistant = pending.tool_use_id !== null && pending.name !== null
          ? [{ role: 'assistant', content: [{ type: 'tool_use', id: pending.tool_use_id, name: pending.name, input: null }] }]
          : [];
        const recContent = recovered.type === 'result' ? recovered.content : '{}';
        let recCode: string | undefined;
        try { const c = (JSON.parse(recContent) as { code?: string }).code; recCode = typeof c === 'string' ? c : undefined; } catch { /* 非 JSON 内容留空 */ }
        await appendToolResult(runId, seq, pending.tool_use_id ?? '', assistant, {
          content: recContent,
          isError: recovered.type === 'result' ? (recovered.isError ?? false) : true,
          errorCode: recCode,
          resultSummary: recovered.type === 'result' ? recovered.resultSummary : undefined,
        });
        continue;
      }

      // X-2 唯一取消检查点（§10 逐字）：每步循环开始前、发起本轮 turn 之前——
      // turn_received 续推进与 tool_dispatched 补笔都不算「发起 turn」（当前步完整落库先行）。
      if (pending?.status !== 'turn_received') {
        const cancel = await tx(deps.pool, (c) => agentCancelGate(c, runId, run.group_id));
        if (cancel.cancelled) {
          if (cancel.nextRunId !== undefined) startAgentRun(cancel.nextRunId);
          return;
        }
      }

      if (pending?.status === 'turn_received') {
        // 响应已落库未处理完：从 raw_response 续推进（§9.1 REPROC）
        seq = pending.seq;
        resumeReceived = true;
        rawRes = { status: 200, raw: pending.raw_response ?? '' };
        const v = validateTurnResponse(rawRes);
        if (v.ok) {
          turn = v.response;
        } else {
          errCode = 'BAD_JSON';
          errRaw = pending.raw_response;
        }
        request = pending.dispatch_payload as AgentTurnRequest; // 仅供后续语义，未再发
      } else if (pending?.status === 'turn_dispatched') {
        // 响应未知：用 dispatch_payload 快照重发同轮（同 runId；§12 无状态全量历史语义）
        seq = pending.seq;
        request = pending.dispatch_payload as AgentTurnRequest;
        try {
          rawRes = await deps.agentClient.rawTurn(request);
        } catch (err) {
          if (err instanceof AgentClientError) {
            errCode = err.protocolErrorCode;
            errRaw = err.rawBody ?? null;
          } else {
            errCode = 'TURN_TIMEOUT';
          }
        }
        if (errCode === null && rawRes !== undefined) {
          const v = validateTurnResponse(rawRes);
          if (!v.ok) { errCode = 'BAD_JSON'; errRaw = rawRes.raw; } else { turn = v.response; }
        }
      } else {
        // ---- 新步（步 1：意图先行——step 先 turn_dispatched 带请求快照，E11）----
        seq = run.step_count + 1;
        const messages = await tx(deps.pool, (c) => rebuildMessages(c, run));
        request = { runId, tools: AGENT_TOOLS, messages };
        await tx(deps.pool, (c) =>
          c.query(
            `INSERT INTO agent_run_step (run_id, seq, kind, status, dispatch_payload, appended_blocks)
             VALUES ($1, $2, 'tool_use', 'turn_dispatched', $3::jsonb, '[]'::jsonb)`,
            [runId, seq, JSON.stringify(request)],
          ),
        );
        // 步 2：HTTP（agentclient 传输层 AbortController 到时取消 → TURN_TIMEOUT）
        try {
          rawRes = await deps.agentClient.rawTurn(request);
        } catch (err) {
          if (err instanceof AgentClientError) {
            errCode = err.protocolErrorCode;
            errRaw = err.rawBody ?? null;
          } else {
            errCode = 'TURN_TIMEOUT';
          }
        }
        if (errCode === null && rawRes !== undefined) {
          const v = validateTurnResponse(rawRes);
          if (!v.ok) { errCode = 'BAD_JSON'; errRaw = rawRes.raw; } else { turn = v.response; }
        }
      }

      if (errCode !== null || turn === undefined) {
        // 路径 B：无 assistant 块、user PROTOCOL_ERROR 文本、计步 + streak+1（protocol-errors.ts）
        const { streakHit } = await tx(deps.pool, (c) =>
          recordProtocolErrorStep(c, {
            runId,
            seq,
            code: errCode ?? 'TURN_TIMEOUT',
            rawResponse: errRaw,
            stepCounted: resumeReceived, // turn_received 已计步
          }),
        );
        if (streakHit) {
          const end = await tx(deps.pool, (c) =>
            endAgentRun(c, { runId, status: 'failed', endReason: 'protocol_errors' }),
          );
          if (end.nextRunId !== undefined) startAgentRun(end.nextRunId);
          return;
        }
        continue;
      }

      // 步 3：合法形状响应 → turn_received + raw_response（≤2KB）+ streak 清零
      const received = resumeReceived
        ? true // 续推进：本步计步/streak 在崩溃前的 turn_received 事务已完成
        : await tx(deps.pool, async (client) => {
            const { rowCount } = await client.query(
              `UPDATE agent_run_step SET status='turn_received', raw_response=$3, updated_at=now()
               WHERE run_id=$1 AND seq=$2 AND status='turn_dispatched'`,
              [runId, seq, clipRawResponse(rawRes?.raw)],
            );
            if (rowCount !== 1) return false;
            await client.query(
              `UPDATE agent_run SET protocol_error_streak=0, step_count=step_count+1, updated_at=now() WHERE id=$1`,
              [runId],
            );
            return true;
          });
      if (!received) continue; // 晚到响应丢弃（该轮已按 TURN_TIMEOUT 落库）

      if (turn.stopReason === 'end_turn') {
        // 结束路径：step kind='final' + appended assistant text；run finished/final（不发群）
        const end = await tx(deps.pool, async (client) => {
          await client.query(
            `UPDATE agent_run_step SET kind='final', status='done',
                    appended_blocks=$3::jsonb, updated_at=now()
             WHERE run_id=$1 AND seq=$2`,
            [runId, seq, JSON.stringify([{ role: 'assistant', content: [turn.block] }])],
          );
          return endAgentRun(client, {
            runId,
            status: 'finished',
            endReason: 'final',
            summary: turn.block.text,
          });
        });
        if (end.nextRunId !== undefined) startAgentRun(end.nextRunId);
        return;
      }

      // 合法 tool_use 块：重复 id → DUPLICATE_TOOL_USE_ID（路径 B）；未知名/入参不符 → 路径 A
      const tool = turn.block;
      const dup = await tx(deps.pool, async (client) => {
        const { rows } = await client.query(
          'SELECT 1 FROM agent_run_step WHERE run_id=$1 AND tool_use_id=$2',
          [runId, tool.id],
        );
        return rows.length > 0;
      });
      if (dup) {
        // 路径 B（turn_received 已计步 → stepCounted:true 防重复计）
        const { streakHit } = await tx(deps.pool, (c) =>
          recordProtocolErrorStep(c, { runId, seq, code: 'DUPLICATE_TOOL_USE_ID', stepCounted: true }),
        );
        if (streakHit) {
          const end = await tx(deps.pool, (c) =>
            endAgentRun(c, { runId, status: 'failed', endReason: 'protocol_errors' }),
          );
          if (end.nextRunId !== undefined) startAgentRun(end.nextRunId);
          return;
        }
        continue;
      }

      const assistantBlock = [{ role: 'assistant', content: [{ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }] }];
      // 路径 A：未知名 → UNKNOWN_TOOL；入参不合 schema → INVALID_INPUT（protocol-errors.ts 落库）
      if (!AGENT_TOOL_NAMES.has(tool.name)) {
        await tx(deps.pool, (c) =>
          appendToolErrorResult(c, {
            runId, seq, toolUseId: tool.id, toolName: tool.name, input: tool.input,
            code: 'UNKNOWN_TOOL', message: `unknown tool: ${tool.name}`,
          }),
        );
        continue;
      }
      const schemaError = validateToolInput(tool.name, tool.input);
      if (schemaError !== null) {
        await tx(deps.pool, (c) =>
          appendToolErrorResult(c, {
            runId, seq, toolUseId: tool.id, toolName: tool.name, input: tool.input,
            code: 'INVALID_INPUT', message: schemaError,
          }),
        );
        continue;
      }

      // 步 4：效果/读工具分发前落 tool_use 意图（tool_use_id/name/input 同行）；
      //       finish 内置收束（§7.4）；其余经 executeTool 缝（T-P4-07..09 接管）
      await tx(deps.pool, (c) =>
        c.query(
          `UPDATE agent_run_step SET tool_use_id=$3, name=$4, input=$5::jsonb, updated_at=now()
           WHERE run_id=$1 AND seq=$2`,
          [runId, seq, tool.id, tool.name, JSON.stringify(tool.input ?? null)],
        ),
      );

      // kick_user 门槛 1 在审计前（§8.4 顺序逐字）：auto_kick_enabled=false → POLICY_DENIED
      if (tool.name === 'kick_user') {
        const denied = await tx(deps.pool, (c) => kickPreAudit(c, run.group_id));
        if (denied !== undefined) {
          await appendToolResult(runId, seq, tool.id, assistantBlock, {
            content: denied.type === 'result' ? denied.content : '{}',
            isError: true,
            errorCode: 'POLICY_DENIED',
            resultSummary: denied.type === 'result' ? denied.resultSummary : undefined,
          });
          continue;
        }
      }

      // send_message 的幂等预检在审计前（§8.2 KEY 分支逐字：命中即短路、不再审计）。
      // 读 + 命中等待——普通池连接（不包事务）：命中行是首次调用已提交的产物，
      // tx 包住等待只会白白占连接。
      if (tool.name === 'send_message') {
        const preClient = await deps.pool.connect();
        let hitOutcome: ToolOutcome | undefined;
        try {
          hitOutcome = await sendMessagePreAudit(
            { client: preClient, runId, groupId: run.group_id, input: tool.input },
            { pool: deps.pool, waiter: deps.deliveryWaiter },
          );
        } finally {
          preClient.release();
        }
        if (hitOutcome !== undefined) {
          const content = hitOutcome.type === 'result' ? hitOutcome.content : '{}';
          let hitCode: string | undefined;
          try { const c = (JSON.parse(content) as { code?: string }).code; hitCode = typeof c === 'string' ? c : undefined; } catch { /* noop */ }
          await appendToolResult(runId, seq, tool.id, assistantBlock, {
            content,
            isError: hitOutcome.type === 'result' ? (hitOutcome.isError ?? false) : true,
            errorCode: hitCode,
            resultSummary: hitOutcome.type === 'result' ? hitOutcome.resultSummary : undefined,
          });
          continue;
        }
      }

      // 效果型工具先过审计门禁（§8.1：send_message/kick_user 执行前必经 /agent/audit）；
      // 审计 pass 后才落 tool_dispatched 意图（§3 第 3 条次序：意图落库在执行前、审计后）
      if (isEffectTool(tool.name)) {
        const auditText = auditTextForTool(tool.name, tool.input);
        if (auditText === undefined) {
          await tx(deps.pool, (c) =>
            appendToolErrorResult(c, {
              runId, seq, toolUseId: tool.id, toolName: tool.name, input: tool.input,
              code: 'INVALID_INPUT', message: 'missing audit payload field',
            }),
          );
          continue;
        }
        const verdict = await runAuditGate(
          { agentClient: deps.agentClient, groupId: run.group_id, wallDeadlineAt: run.wall_deadline_at },
          auditText,
        );
        if (verdict === 'rejected') {
          // AUDIT_REJECTED：is_error tool_result、run 继续、key 不消耗（不落幂等表）；
          // audit_verdict='fail' 同步落库（§3 时序框 verdict=fail 分支逐字）
          await tx(deps.pool, async (c) => {
            await c.query(
              `UPDATE agent_run_step SET audit_verdict='fail' WHERE run_id=$1 AND seq=$2`,
              [runId, seq],
            );
            await appendToolErrorResult(c, {
              runId, seq, toolUseId: tool.id, toolName: tool.name, input: tool.input,
              code: 'AUDIT_REJECTED', message: 'audit verdict: fail',
            });
          });
          continue;
        }
        if (verdict === 'blocked' || verdict === 'wall_clock') {
          // 3 次无结论 → blocked/audit_blocked；重试中途墙钟到期 → wall_clock（§12 风险 2）
          const end = await tx(deps.pool, async (client) => {
            await client.query(
              `UPDATE agent_run_step SET status='done', audit_verdict='unresolved', updated_at=now()
               WHERE run_id=$1 AND seq=$2`,
              [runId, seq],
            );
            return endAgentRun(client, {
              runId,
              status: verdict === 'blocked' ? 'blocked' : 'failed',
              endReason: verdict === 'blocked' ? 'audit_blocked' : 'wall_clock',
            });
          });
          if (end.nextRunId !== undefined) startAgentRun(end.nextRunId);
          return;
        }
        // pass：工具执行意图落库（§3 第 3 条；audit_verdict='pass' 同行）
        // kick_user：kick_target 属「执行前已持久化凭据」（§9.2 kick 行逐字）——必须在网关调用
        //   前的已提交事务里落库；留在工具内部事务会被崩溃回滚吞掉，恢复只能记 missing credential。
        const kickTarget =
          tool.name === 'kick_user' && typeof tool.input === 'object' && tool.input !== null
            ? (tool.input as Record<string, unknown>)['platform_user_id']
            : undefined;
        await tx(deps.pool, (c) =>
          c.query(
            `UPDATE agent_run_step SET status='tool_dispatched', audit_verdict='pass',
                    kick_target=COALESCE($3, kick_target), updated_at=now()
             WHERE run_id=$1 AND seq=$2`,
            [runId, seq, typeof kickTarget === 'string' ? kickTarget : null],
          ),
        );
      }

      if (tool.name === 'finish') {
        // §7.4 逐字：step kind='final'、result_summary='ok'、run finished/final、summary=input.summary
        const outcome = execFinish(tool.input);
        const end = await tx(deps.pool, async (client) => {
          await client.query(
            `UPDATE agent_run_step SET kind='final', status='done', result_summary=$4,
                    appended_blocks=$3::jsonb, updated_at=now()
             WHERE run_id=$1 AND seq=$2`,
            [runId, seq, JSON.stringify(assistantBlock), outcome.resultSummary ?? 'ok'],
          );
          return endAgentRun(client, { runId, status: 'finished', endReason: 'final', summary: outcome.summary });
        });
        if (end.nextRunId !== undefined) startAgentRun(end.nextRunId);
        return;
      }

      // 工具执行不包 tx()：上下文是普通池连接（autocommit）。工具需要多写原子性的
      // （send_message 的 T13）在工具内部自起 tx() 提交后再进入长等待——包一层事务会让
      // queued 行对 waiter/dispatcher 不可见直到等待结束才提交（SEND_TIMEOUT 回归）。
      const toolExec = deps.executeTool ?? defaultToolExecutor(deps);
      const toolClient = await deps.pool.connect();
      let outcome: ToolOutcome;
      try {
        outcome = await toolExec({
          client: toolClient,
          pool: deps.pool,
          runId,
          groupId: run.group_id,
          stepSeq: seq,
          toolName: tool.name,
          input: tool.input,
        });
      } finally {
        toolClient.release();
      }

      if (outcome.type === 'end_run') {
        const end = await tx(deps.pool, async (client) => {
          const blocks = outcome.toolResult !== undefined
            ? [...assistantBlock, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: outcome.toolResult.content, is_error: outcome.toolResult.isError ?? false }] }]
            : assistantBlock;
          await client.query(
            `UPDATE agent_run_step SET status='done', kind=$5, appended_blocks=$3::jsonb,
                    result_summary=$4, updated_at=now()
             WHERE run_id=$1 AND seq=$2`,
            [runId, seq, JSON.stringify(blocks), outcome.resultSummary ?? null, outcome.stepKind ?? 'tool_use'],
          );
          return endAgentRun(client, {
            runId,
            status: outcome.status,
            endReason: outcome.endReason,
            summary: outcome.summary,
          });
        });
        if (end.nextRunId !== undefined) startAgentRun(end.nextRunId);
        return;
      }
      // 正常 tool_result：与 step 完成同事务（§3 第 4 条）；
      // errorCode 从 content 的 X-1 code 字段提取（§11：isError=true 时 errorCode 必填）
      let errCodeFromContent: string | undefined;
      try { const c = (JSON.parse(outcome.content) as { code?: string }).code; errCodeFromContent = typeof c === 'string' ? c : undefined; } catch { /* 非 JSON */ }
      await appendToolResult(runId, seq, tool.id, assistantBlock, {
        content: outcome.content,
        isError: outcome.isError ?? false,
        errorCode: outcome.isError === true ? errCodeFromContent : undefined,
        resultSummary: outcome.resultSummary,
      });
    }
  }

  /** 路径 A / 工具结果写回：assistant 块 + tool_result 块同事务，status='done' */
  async function appendToolResult(
    runId: string,
    seq: number,
    toolUseId: string,
    assistantBlock: unknown[],
    result: { content: string; isError: boolean; errorCode?: string; resultSummary?: string },
  ): Promise<void> {
    await tx(deps.pool, (c) =>
      c.query(
        `UPDATE agent_run_step SET status='done', appended_blocks=$3::jsonb,
                is_error=$4, error_code=$5, result_summary=$6, updated_at=now()
         WHERE run_id=$1 AND seq=$2`,
        [
          runId,
          seq,
          JSON.stringify([
            ...assistantBlock,
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result.content, is_error: result.isError }] },
          ]),
          result.isError,
          result.errorCode ?? null,
          (result.resultSummary ?? result.content).slice(0, MAX_RESULT_SUMMARY_CHARS),
        ],
      ),
    );
  }

  return {
    startRun(runId: string): void {
      pending.push(runId);
      pump();
    },
  };
}

const MAX_RESULT_SUMMARY_CHARS = 200; // resultSummary ≤200 字（REQ §2.3 行）

/** 缺省工具分发：get_recent_messages 实装（T-P4-08）；send_message/kick_user 归 T-P4-09/10 */
const defaultToolExecutor = (execDeps: AgentExecutorDeps): ToolExecutor => async (ctx) => {
  if (ctx.toolName === 'get_recent_messages') {
    return execGetRecentMessages(ctx.client, { groupId: ctx.groupId, input: ctx.input });
  }
  if (ctx.toolName === 'send_message') {
    return execSendMessage(ctx, { pool: execDeps.pool, waiter: execDeps.deliveryWaiter });
  }
  if (ctx.toolName === 'kick_user') {
    if (execDeps.gateway === undefined) {
      return { type: 'result', content: JSON.stringify({ code: 'SEND_FAILED', message: 'gateway not wired' }), isError: true };
    }
    return execKickUser(ctx, { gateway: execDeps.gateway, pool: execDeps.pool, convergeWait: execDeps.kickConvergeWait });
  }
  return {
    type: 'result',
    content: JSON.stringify({ code: 'UNKNOWN_TOOL', message: `tool not wired: ${ctx.toolName}` }),
    isError: true,
  };
};
