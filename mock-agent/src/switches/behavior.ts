// 行为类故障开关（T-P4-03）：ag-8..16/18。契约出处：REQ §2.2「Agent 服务可能出现的行为」
// 清单；DES/12 §7 行 8–16/18（audit 慢/挂确定性时长 6s 示例；slow_turn ~8s 可配）；QR §1 ~8s 行。
// turn 侧注入序：hang > slow >（协议 fault 在 protocol.ts）> 行为生成 > 剧本 > 默认
// ——挂起支配一切；慢速只改延迟不改内容（延迟之后照常走 fault/剧本/默认）。
// audit 侧注入序：hang > slow > 500 > bad_body（同序即可，它们互斥命中在测试面）。
// 命中判定复用 protocol.ts 的 matchingSwitch（target.runId 收窄约定一致）。
import type { AgentMessage } from '@kapibala/contract';
import type { AgentState, AgentSwitchConfig } from '../scenario.js';
import { matchingSwitch } from './protocol.js';
import type { ProviderReply } from '../providers/scripted.js';

/** ag-12 缺省慢速档：契约说「可能 8 秒左右」，落在后端 turn 超时 10–15s 的可配区间内（QR §1） */
const DEFAULT_SLOW_TURN_MS = 8000;
/** ag-16 audit_slow 缺省档：DES/12 §7 注的确定性示例时长 6s */
const DEFAULT_AUDIT_SLOW_MS = 6000;
/** ag-8/9/10 未命中注入条件时回落正常路径的 get_recent_messages 入参（与默认剧本同参） */
const RECENT_LIMIT = 10;

const HANG: Promise<never> = new Promise(() => {}); // ag-13/ag-16 hang：永不 resolve（ES2023 无 withResolvers）

function readNumber(config: AgentSwitchConfig | undefined, key: string): number | undefined {
  const value = config?.params?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** unref 定时器：pinned 慢速用例等它；未 pin 的长延迟不拖住进程退出（Vitest worker 同理） */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function toolUseReply(state: AgentState, name: string, input: Record<string, unknown>): ProviderReply {
  state.tuSeq += 1;
  return {
    kind: 'json',
    value: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${state.tuSeq}`, name, input }] },
  };
}

// ---------- turn 延迟（ag-12/13）：先决于一切内容 ----------

/**
 * 命中 hang/slow 时返回要等待的毫秒数（hang = Infinity）。
 * 慢速只延迟，不改内容；调用方 sleep 后继续正常生成。
 */
export function behaviorDelayMs(state: AgentState, runId: string): number {
  if (matchingSwitch(state, 'hang_turn', runId) !== undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const slow = matchingSwitch(state, 'slow_turn', runId);
  if (slow !== undefined) {
    return readNumber(slow, 'delayMs') ?? DEFAULT_SLOW_TURN_MS;
  }
  return 0;
}

// ---------- turn 内容注入（ag-8..11） ----------

/** 最后一个「已拿到 tool_result」的 send_message 调用的 input（按历史顺序） */
function lastCompletedSendInput(messages: readonly AgentMessage[]): Record<string, unknown> | undefined {
  const sends = new Map<string, Record<string, unknown>>();
  const answered = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use' && block.name === 'send_message') {
        sends.set(block.id, block.input);
      }
      if (block.type === 'tool_result') {
        answered.add(block.tool_use_id);
      }
    }
  }
  let found: Record<string, unknown> | undefined;
  for (const [id, input] of sends) {
    if (answered.has(id)) {
      found = input; // 保持迭代序 → 最后一个已完成的 send
    }
  }
  return found;
}

/**
 * 行为生成器：命中返回本 turn 的合法 tool_use 响应（形状合法、语义恶劣），未命中 undefined。
 * ag-8 是条件注入：历史里没有「已完成 send_message」时不拦路（首轮仍是 get_recent_messages）；
 * 命中后**持续**重发同一 input（同一 idempotency_key），直到开关 clear——这正是 S5 要测的形态。
 * ag-9/10/11 持续生效（每轮都是工具调用），clear 恢复。
 * ag-18 `same_runid_redispatch` 无代码分支：它的契约（同 runId 相同 messages → 新响应）
 * 就是无状态默认路径本身（§2.1）；开关登记即测试意图标记，不另造差异实现。
 */
export function applyBehaviorTurn(state: AgentState, request: {
  runId: string;
  messages: readonly AgentMessage[];
}): ProviderReply | undefined {
  const retry = matchingSwitch(state, 'send_timeout_key_retry', request.runId);
  if (retry !== undefined) {
    const input = lastCompletedSendInput(request.messages);
    if (input !== undefined) {
      return toolUseReply(state, 'send_message', input); // 逐字复用 → 同 idempotency_key
    }
  }
  if (matchingSwitch(state, 'endless_tools', request.runId) !== undefined) {
    // 交替 get_recent_messages / send_message：一直调工具、永不 finish（12 步/60s 预算的靶子）
    const lastTool = request.messages
      .flatMap((m) => (m.role === 'assistant' ? m.content : []))
      .filter((b) => b.type === 'tool_use')
      .at(-1);
    if (lastTool !== undefined && lastTool.type === 'tool_use' && lastTool.name === 'get_recent_messages') {
      const sends = request.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'tool_use' && b.name === 'send_message').length;
      return toolUseReply(state, 'send_message', {
        text: `loop message ${sends + 1}`,
        idempotency_key: `ik-${request.runId}-loop-${sends + 1}`, // 每次都是新的逻辑发送
      });
    }
    return toolUseReply(state, 'get_recent_messages', { limit: RECENT_LIMIT });
  }
  if (matchingSwitch(state, 'repeat_get_recent', request.runId) !== undefined) {
    return toolUseReply(state, 'get_recent_messages', { limit: RECENT_LIMIT }); // 逐字同参复读
  }
  if (matchingSwitch(state, 'huge_limit', request.runId) !== undefined) {
    return toolUseReply(state, 'get_recent_messages', { limit: 100000 }); // REQ §2.2 逐字数字
  }
  return undefined;
}

// ---------- audit 故障面（ag-14/15/16） ----------

const AUDIT_NON_JSON_BODY = 'not json at all: audit service hiccup';
const AUDIT_NO_VERDICT_BODY = '{"result":"ok","note":"verdict field missing"}';
const AUDIT_WRONG_VERDICT_BODY = '{"verdict":"maybe","reason":"ambiguous outcome"}';

/** audit 延迟：hang（Infinity）> slow（pin 或 6s）；0 = 不延迟 */
export function auditDelayMs(state: AgentState): number {
  if (state.switches.has('audit_hang')) {
    return Number.POSITIVE_INFINITY;
  }
  const slow = state.switches.get('audit_slow');
  if (slow !== undefined) {
    return readNumber(slow, 'delayMs') ?? DEFAULT_AUDIT_SLOW_MS;
  }
  return 0;
}

/** audit 故障响应（延迟之后判定内容）：500 > bad_body；未命中 undefined → 正常 pass */
export function applyAuditFault(state: AgentState): ProviderReply | undefined {
  if (state.switches.has('audit_500')) {
    return { kind: 'raw', body: '{"message":"audit failed"}', statusCode: 500 };
  }
  const badBody = state.switches.get('audit_bad_body');
  if (badBody !== undefined) {
    const variant = badBody.params?.['variant'];
    const body =
      variant === 'no_verdict'
        ? AUDIT_NO_VERDICT_BODY
        : variant === 'wrong_verdict'
          ? AUDIT_WRONG_VERDICT_BODY
          : AUDIT_NON_JSON_BODY;
    return { kind: 'raw', body };
  }
  return undefined;
}

export { sleepUnref, HANG };
