// 协议错误两类分流的落库原语（T-P4-06；DES/06 §4 全文逐字 + REQ A5-3 + §2.3 字段表）。
// 路径 B（BAD_JSON / DUPLICATE_TOOL_USE_ID / TURN_TIMEOUT）：**不追加 assistant 块**，
//   只追加一条 role:'user' 的 text 块 `PROTOCOL_ERROR <code>: <一句话>`；
//   step: kind='protocol_error'、tool_use_id/name/input=NULL（§2.3 逐字）、
//   raw_response=原始体(≤2KB，超时为 NULL)；计步 + streak+1。
// 路径 A（UNKNOWN_TOOL / INVALID_INPUT）：响应本身合法 → assistant tool_use 块照常追加 +
//   is_error:true 的 tool_result {code,message}；计步、streak 清零（合法响应）。
// 两类都计 step_count（A5-2「一步=一次往返无论返回什么」）——stepCountAlreadyBumped
// 区分「turn_received 已计步」的晚路径（dup-id 检测在 turn_received 之后发生）。
import type { PoolClient } from 'pg';
import { PROTOCOL_ERROR_STREAK_LIMIT } from '../../constants.js';

export const RAW_RESPONSE_MAX_BYTES = 2048; // raw_response ≤2KB（REQ §2.3 / DES/06 §11 逐字）

/** 原始体截断：按字节截（多字节 UTF-8 不断码——subarray 边界取整到码元） */
export function clipRawResponse(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const buf = Buffer.from(raw, 'utf8');
  if (buf.byteLength <= RAW_RESPONSE_MAX_BYTES) return raw;
  return buf.subarray(0, RAW_RESPONSE_MAX_BYTES).toString('utf8');
}

/** 路径 B 的协议错误一句话（`PROTOCOL_ERROR <code>: <一句话>` 的冒号右侧） */
const PROTOCOL_ERROR_ONELINER: Record<string, string> = {
  BAD_JSON: 'response is not valid JSON or malformed',
  DUPLICATE_TOOL_USE_ID: 'tool_use id was already used in this run',
  TURN_TIMEOUT: 'turn response did not arrive in time',
};

/** user text 块：协议错误步 appended_blocks 的唯一内容（d 项：无悬挂 assistant 块） */
export function protocolErrorBlocks(code: string): unknown[] {
  const line = PROTOCOL_ERROR_ONELINER[code] ?? 'agent response rejected';
  return [{ role: 'user', content: [{ type: 'text', text: `PROTOCOL_ERROR ${code}: ${line}` }] }];
}

export interface ProtocolErrorResult {
  /** 计步生效（写入成功；status 守卫拒收 = 晚到/重复丢弃） */
  readonly recorded: boolean;
  /** streak 触顶（≥3 → run failed/protocol_errors，§4 STREAK 框） */
  readonly streakHit: boolean;
}

/**
 * 路径 B 落库：step 终态化（turn_dispatched/turn_received 两态都收——dup-id 在 received 后才发现）
 * + streak+1 + （未被 turn_received 计步时）step_count+1。同一事务（§3 固定结构第 2/5 条）。
 */
export async function recordProtocolErrorStep(
  client: PoolClient,
  args: { runId: string; seq: number; code: 'BAD_JSON' | 'DUPLICATE_TOOL_USE_ID' | 'TURN_TIMEOUT'; rawResponse?: string | null; stepCounted?: boolean },
): Promise<ProtocolErrorResult> {
  // raw_response：未给新值时保留既有值——dup-id 在 turn_received 后才判定，row 里已有
  // 步 3 落库的原始响应体，无条件覆写 $4 会把它冲成 NULL（REQ §2.3 rawResponse 必填）。
  const { rowCount } = await client.query(
    `UPDATE agent_run_step SET kind='protocol_error', status='done', error_code=$3,
            tool_use_id=NULL, name=NULL, input=NULL,
            raw_response=COALESCE($4, raw_response), appended_blocks=$5::jsonb, updated_at=now()
     WHERE run_id=$1 AND seq=$2 AND status IN ('turn_dispatched','turn_received')`,
    [args.runId, args.seq, args.code, clipRawResponse(args.rawResponse), JSON.stringify(protocolErrorBlocks(args.code))],
  );
  if (rowCount !== 1) return { recorded: false, streakHit: false };
  const bump = args.stepCounted === true ? 0 : 1;
  const { rows } = await client.query<{ streak: number }>(
    `UPDATE agent_run SET protocol_error_streak=protocol_error_streak+1,
            step_count=step_count+$2::int, updated_at=now()
     WHERE id=$1 RETURNING protocol_error_streak AS streak`,
    [args.runId, bump],
  );
  return { recorded: true, streakHit: (rows[0]?.streak ?? 0) >= PROTOCOL_ERROR_STREAK_LIMIT };
}

/**
 * 路径 A 落库：assistant tool_use 块 + is_error tool_result 同事务；
 * step done + is_error/error_code；streak 清零由 turn_received 步统一做（合法响应）。
 */
export async function appendToolErrorResult(
  client: PoolClient,
  args: { runId: string; seq: number; toolUseId: string; toolName: string; input: unknown; code: 'UNKNOWN_TOOL' | 'INVALID_INPUT' | 'AUDIT_REJECTED'; message: string },
): Promise<void> {
  const blocks = [
    { role: 'assistant', content: [{ type: 'tool_use', id: args.toolUseId, name: args.toolName, input: args.input ?? null }] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: args.toolUseId,
          content: JSON.stringify({ code: args.code, message: args.message }),
          is_error: true,
        },
      ],
    },
  ];
  await client.query(
    `UPDATE agent_run_step SET status='done', kind='tool_use',
            tool_use_id=$3, name=$4, input=$5::jsonb,
            is_error=true, error_code=$6, appended_blocks=$7::jsonb,
            result_summary=$8, updated_at=now()
     WHERE run_id=$1 AND seq=$2`,
    [
      args.runId,
      args.seq,
      args.toolUseId,
      args.toolName,
      JSON.stringify(args.input ?? null),
      args.code,
      JSON.stringify(blocks),
      `${args.code}: ${args.message}`.slice(0, 200),
    ],
  );
}
