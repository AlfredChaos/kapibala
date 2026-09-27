// /agent/turn 响应三段式校验的唯一收口（T-P4-06；DES/06 §4 流程图 L1→L2→L3 逐字 + REQ §2.2/A5-3）。
// 三层逐字：
//   L1 HTTP 状态非 2xx → BAD_JSON（契约规定非 2xx 也记 BAD_JSON，不单列码）；
//   L2 JSON 解析——markdown 围栏/前后夹文天然 JSON.parse 失败 → BAD_JSON；
//   L3 形状——缺 stop_reason / 块数≠1 / stop_reason 与块类型不一致 → BAD_JSON。
// 工具名/schema 合法性不在本层（UNKNOWN_TOOL/INVALID_INPUT 归路径 A，protocol-errors.ts）。
// rawBody 全程透传供 raw_response 落库（≤2KB 截断在写路径做）。
import type { AgentRawResponse, AgentTurnResponse, AgentToolUseBlock, AgentTextBlock } from '../../agentclient/index.js';
import { AGENT_TOOLS, AGENT_TOOL_NAMES } from './tools-def.js';

export type TurnValidation =
  | { readonly ok: true; readonly response: AgentTurnResponse }
  | { readonly ok: false; readonly code: 'BAD_JSON'; readonly reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 三段式校验 {status, raw}（rawTurn 传输层的唯一消费入口）。
 * 返回 ok:false 时一律 BAD_JSON——三种失败形态契约同码（DES/06 §4 BADJSON 汇合框逐字）。
 */
export function validateTurnResponse(res: AgentRawResponse): TurnValidation {
  // L1：HTTP 状态
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, code: 'BAD_JSON', reason: `HTTP ${res.status}` };
  }
  // L2：JSON 解析（```json 围栏 / 前后夹文 / 截断 全部在此失败）
  let body: unknown;
  try {
    body = JSON.parse(res.raw);
  } catch {
    return { ok: false, code: 'BAD_JSON', reason: 'not valid JSON' };
  }
  // L3：形状
  return validateTurnShape(body);
}

export function validateTurnShape(body: unknown): TurnValidation {
  const bad = (reason: string): TurnValidation => ({ ok: false, code: 'BAD_JSON', reason });
  if (!isRecord(body)) return bad('body is not an object');
  const stopReason = body['stop_reason'];
  const content = body['content'];
  if (typeof stopReason !== 'string') return bad('missing stop_reason');
  if (!Array.isArray(content) || content.length !== 1) return bad('content must have exactly one block');
  const block: unknown = content[0];
  if (!isRecord(block) || typeof block['type'] !== 'string') return bad('block malformed');
  const blockType = block['type'];

  if (stopReason === 'tool_use') {
    if (blockType !== 'tool_use') return bad('stop_reason tool_use but block type mismatch');
    const id = block['id'];
    const name = block['name'];
    if (typeof id !== 'string' || typeof name !== 'string') return bad('tool_use block missing id/name');
    const toolBlock: AgentToolUseBlock = { type: 'tool_use', id, name, input: block['input'] };
    return { ok: true, response: { stopReason: 'tool_use', block: toolBlock } };
  }
  if (stopReason === 'end_turn') {
    const text = block['text'];
    if (blockType !== 'text' || typeof text !== 'string') {
      return bad('stop_reason end_turn but block type mismatch');
    }
    const textBlock: AgentTextBlock = { type: 'text', text };
    return { ok: true, response: { stopReason: 'end_turn', block: textBlock } };
  }
  return bad(`unknown stop_reason: ${String(stopReason)}`);
}

// ---------- 工具入参校验（路径 A 的 INVALID_INPUT 判定源） ----------

const TOOL_INPUT_CHECKERS: Record<string, (input: Record<string, unknown>) => string | null> = {
  get_recent_messages: (i) => {
    const limit = i['limit'];
    if (typeof limit !== 'number' || !Number.isInteger(limit)) return 'limit must be an integer';
    if (limit <= 0) return 'limit must be positive'; // 非正数 → INVALID_INPUT（§7.1 逐字；>50 钳制不报错）
    return null;
  },
  send_message: (i) => {
    if (typeof i['text'] !== 'string' || i['text'] === '') return 'text must be a non-empty string';
    if (typeof i['idempotency_key'] !== 'string' || i['idempotency_key'] === '') {
      return 'idempotency_key must be a non-empty string';
    }
    return null;
  },
  kick_user: (i) => {
    if (typeof i['platform_user_id'] !== 'string' || i['platform_user_id'] === '') {
      return 'platform_user_id must be a non-empty string';
    }
    if (typeof i['reason'] !== 'string') return 'reason must be a string';
    return null;
  },
  finish: (i) => (typeof i['summary'] === 'string' ? null : 'summary must be a string'),
};

/**
 * 入参校验（input_schema.required 全覆盖 + 各参数类型/域）。
 * 未知工具名 → null（由 UNKNOWN_TOOL 分支先判）；入参非对象/缺 required/类型不符 → 原因串（INVALID_INPUT）。
 */
export function validateToolInput(name: string, input: unknown): string | null {
  if (!AGENT_TOOL_NAMES.has(name)) return null; // 工具名合法性在上游判（UNKNOWN_TOOL）
  const def = AGENT_TOOLS.find((t) => t.name === name);
  const required = (def?.input_schema as { required?: string[] } | undefined)?.required ?? [];
  if (typeof input !== 'object' || input === null) return `missing input for ${name}`;
  const rec = input as Record<string, unknown>;
  for (const key of required) {
    if (rec[key] === undefined) return `missing required param: ${key}`;
  }
  return TOOL_INPUT_CHECKERS[name]?.(rec) ?? null;
}
