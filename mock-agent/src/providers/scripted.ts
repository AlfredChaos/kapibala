// scripted provider（DES/12 §3）：确定性剧本引擎 + 默认剧本。
// - 剧本步按 (runId, 调用序号) 推进；播完回落默认剧本「get_recent_messages → send_message → finish」。
// - ag-1..7 协议故障（protocol.ts）+ ag-8..16/18 行为故障（behavior.ts）：hang > slow > 协议 fault
//   > 行为生成 > 剧本 > 默认路径；慢速只延迟内容不变；audit 侧走 auditDelayMs/applyAuditFault。
// - 无状态全量历史规约（DES/12 §2.1）：默认剧本的下一步只由请求 messages 推出——
//   看最后一个已执行的 tool_use 决定剧本位置；同 runId 相同 messages 的重发返回新响应（新 tool_use.id）。
// - /agent/audit 确定性 pass（故障形态 ag-14/15/16 由本模块的 auditDelayMs/applyAuditFault 注入）。
import type {
  AgentMessage,
  AgentTriggerContext,
  AuditRequest,
  AuditResponse,
  ContentBlock,
  TurnRequest,
  TurnResponse,
} from '@kapibala/contract';
import type { AgentState, PlaybookStep } from '../scenario.js';
import {
  applyAuditFault,
  applyBehaviorTurn,
  auditDelayMs,
  behaviorDelayMs,
  HANG,
  sleepUnref,
} from '../switches/behavior.js';
import { applyProtocolFault } from '../switches/protocol.js';

/** provider 给 HTTP 层的应答：json = 契约形状（序列化）；raw = 原样字节（故障注入通道） */
export type ProviderReply = { kind: 'json'; value: unknown } | { kind: 'raw'; body: string; statusCode?: number };

export interface AgentProvider {
  turn(request: TurnRequest): Promise<ProviderReply>;
  audit(request: AuditRequest): Promise<ProviderReply>;
}


function nextToolUseId(state: AgentState): string {
  state.tuSeq += 1;
  return `tu_${state.tuSeq}`;
}

function renderStep(state: AgentState, step: PlaybookStep): ProviderReply {
  switch (step.kind) {
    case 'raw':
      return { kind: 'raw', body: step.body, statusCode: step.statusCode };
    case 'end_turn':
      return {
        kind: 'json',
        value: { stop_reason: 'end_turn', content: [{ type: 'text', text: step.text ?? '' }] } satisfies TurnResponse,
      };
    case 'finish':
      return {
        kind: 'json',
        value: {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: nextToolUseId(state), name: 'finish', input: { summary: step.summary ?? '' } },
          ],
        } satisfies TurnResponse,
      };
    case 'tool_use':
      return {
        kind: 'json',
        value: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: nextToolUseId(state), name: step.name, input: step.input ?? {} }],
        } satisfies TurnResponse,
      };
  }
}

/** 解析触发上下文（messages[0] 的首个 text 块是 JSON 串；REQ §2.2）。非预期形状 → undefined。 */
function parseTriggerContext(messages: readonly AgentMessage[]): AgentTriggerContext | undefined {
  const first = messages[0];
  if (first === undefined || first.role !== 'user') {
    return undefined;
  }
  const block = first.content[0];
  if (block === undefined || block.type !== 'text') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block.text) as AgentTriggerContext;
    return typeof parsed.groupId === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolUseReply(state: AgentState, name: string, input: Record<string, unknown>): ProviderReply {
  const content: [ContentBlock] = [{ type: 'tool_use', id: nextToolUseId(state), name, input }];
  return { kind: 'json', value: { stop_reason: 'tool_use', content } satisfies TurnResponse };
}

function endTurnReply(text: string): ProviderReply {
  const content: [ContentBlock] = [{ type: 'text', text }];
  return { kind: 'json', value: { stop_reason: 'end_turn', content } satisfies TurnResponse };
}

/**
 * 默认剧本的下一步：只看 messages 历史（无状态规约）。
 * 位置 = 最后一个已执行的工具（assistant 的 tool_use 块，含 finish 在内）；
 * 尚未调过 → get_recent_messages；已调 get_recent_messages → send_message；已发过 → finish。
 * 回复文本回声触发上下文里最新一条触发消息；幂等键按「第几次 send_message 调用」推导，
 * 相同历史永远推出同一 key（后端重发同轮 = 幂等重发同一逻辑发送，不违反 idempotency 语义）。
 */
function defaultTurn(state: AgentState, request: TurnRequest): ProviderReply {
  const toolUses = request.messages.flatMap((message) =>
    message.role === 'assistant' ? message.content.filter((b) => b.type === 'tool_use') : [],
  );
  const last = toolUses.at(-1);
  if (last === undefined) {
    return toolUseReply(state, 'get_recent_messages', { limit: 10 });
  }
  if (last.name === 'get_recent_messages') {
    const sendCalls = toolUses.filter((block) => block.name === 'send_message').length;
    const context = parseTriggerContext(request.messages);
    const latest = context?.triggerMessages.at(-1);
    const text = latest === undefined ? 'ack' : `reply to ${latest.senderPlatformUserId}: ${latest.text}`;
    return toolUseReply(state, 'send_message', { text, idempotency_key: `ik-${request.runId}-${sendCalls + 1}` });
  }
  if (last.name === 'send_message') {
    return toolUseReply(state, 'finish', { summary: 'fetched context, sent reply, done' });
  }
  if (last.name === 'finish' || last.name === 'kick_user') {
    // finish 之后若仍被调用（后端异常路径），end_turn 是最温和的合法结束形状
    return endTurnReply('run already finished');
  }
  // 未知工具在历史里（后端喂进来的）：合理 agent 回落到拿上下文
  return toolUseReply(state, 'get_recent_messages', { limit: 10 });
}

export function createScriptedProvider(state: AgentState): AgentProvider {
  return {
    async turn(request) {
      // ag-13 hang_turn / ag-12 slow_turn：延迟先决于内容（hang = 永不 resolve；unref 定时器不拖进程）
      const delayMs = behaviorDelayMs(state, request.runId);
      if (delayMs === Number.POSITIVE_INFINITY) {
        await HANG;
      } else if (delayMs > 0) {
        await sleepUnref(delayMs);
      }
      // 协议故障开关优先于剧本：持续型注入 = 命中开关的每次 turn 都炸（DES/12 §7 行 1–7）
      const fault = applyProtocolFault(state, request.runId);
      if (fault !== undefined) {
        return fault;
      }
      // 行为生成（ag-8..11）：命中才拦路；ag-8 只在历史里有已完成 send_message 时注入同 key 重发
      const behavior = applyBehaviorTurn(state, request);
      if (behavior !== undefined) {
        return behavior;
      }
      const steps = state.playbooks.get(request.runId) ?? state.playbooks.get('*');
      if (steps !== undefined) {
        const cursor = state.cursors.get(request.runId) ?? 0;
        const step = steps[cursor];
        if (step !== undefined) {
          state.cursors.set(request.runId, cursor + 1);
          return renderStep(state, step);
        }
      }

      return defaultTurn(state, request);
    },
    // audit 契约 {verdict:'pass'|'fail', reason}（REQ §2.2）：scripted 默认确定性 pass；
    // ag-14/15/16（500 / 坏 body / 慢 / 挂）走 auditDelayMs + applyAuditFault。
    async audit(request: AuditRequest) {
      const delayMs = auditDelayMs(state);
      if (delayMs === Number.POSITIVE_INFINITY) {
        await HANG;
      } else if (delayMs > 0) {
        await sleepUnref(delayMs);
      }
      const fault = applyAuditFault(state);
      if (fault !== undefined) {
        return fault;
      }
      const value: AuditResponse = {
        verdict: 'pass',
        reason: `scripted audit ok for group ${request.groupId} (${request.text.length} chars)`,
      };
      return { kind: 'json', value };
    },
  };
}
