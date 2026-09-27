// mock-agent 测试共享 arrange/断言助手（T-P4-02 从 scripted.test.ts 提取，同 mock-gateway 的
// tests/helpers/gateway.ts 分工）：进程内装配、`/_test/scenario` 调用、turn 构造与「恰好一个块」窄化。
import { expect } from 'vitest';
import {
  AGENT_TOOLS,
  type AgentMessage,
  type TextBlock,
  type ToolDefinition,
  type ToolUseBlock,
  type TurnResponse,
} from '@kapibala/contract';
import { createAgentApp, type AgentApp } from '../../src/app.js';

export function newApp(): AgentApp {
  return createAgentApp({ mode: 'scripted' });
}

export interface InjectLike {
  statusCode: number;
  /** Fastify inject 的原始响应体（坏 JSON 用例必须绕开 .json()） */
  payload: string;
  json(): Promise<unknown>;
}

/** 合法触发上下文（REQ §2.2 messages[0] 的 text JSON 串） */
export function triggerContext(text = 'hello'): AgentMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          groupId: 'g-1',
          triggerMessages: [
            { msgId: 'm-1', senderPlatformUserId: 'puid-9', text, sentAt: '2026-09-27T00:00:00.000Z' },
          ],
          policy: { autoKickEnabled: false },
          ownPlatformUserIds: ['puid-1'],
        }),
      },
    ],
  };
}

export function toolUseMsg(block: ToolUseBlock): AgentMessage {
  return { role: 'assistant', content: [block] };
}

export function toolResultMsg(toolUseId: string, payload: unknown): AgentMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(payload) }] };
}

export async function turn(
  app: AgentApp,
  runId: string,
  messages: AgentMessage[],
  tools: readonly ToolDefinition[] = AGENT_TOOLS,
): Promise<InjectLike> {
  return app.inject({ method: 'POST', url: '/agent/turn', payload: { runId, tools, messages } });
}

/** 断言 200 + 恰好一个 tool_use 块（窄化出块供后续断言） */
export async function expectToolUse(res: InjectLike): Promise<ToolUseBlock> {
  expect(res.statusCode).toBe(200);
  const body = (await res.json()) as TurnResponse;
  expect(body.stop_reason).toBe('tool_use');
  expect(body.content).toHaveLength(1);
  const block = body.content[0];
  if (block === undefined || block.type !== 'tool_use') {
    throw new Error(`expected tool_use block, got: ${JSON.stringify(body)}`);
  }
  return block;
}

/** 断言 200 + 恰好一个 text 块 + stop_reason=end_turn */
export async function expectEndTurn(res: InjectLike): Promise<TextBlock> {
  expect(res.statusCode).toBe(200);
  const body = (await res.json()) as TurnResponse;
  expect(body.stop_reason).toBe('end_turn');
  expect(body.content).toHaveLength(1);
  const block = body.content[0];
  if (block === undefined || block.type !== 'text') {
    throw new Error(`expected text block, got: ${JSON.stringify(body)}`);
  }
  return block;
}

/** POST /_test/scenario（DES/12 §3 arrange 入口）；返回原始响应供 arrange 失败面断言 */
export async function scenario(
  app: AgentApp,
  switchName: string,
  params?: Record<string, unknown>,
  target?: Record<string, unknown>,
): Promise<InjectLike> {
  return app.inject({ method: 'POST', url: '/_test/scenario', payload: { switch: switchName, params, target } });
}

/** 装开关并断言 arrange 成功（重复调用 = 覆盖参数） */
export async function arm(
  app: AgentApp,
  switchName: string,
  params?: Record<string, unknown>,
  target?: Record<string, unknown>,
): Promise<void> {
  expect((await scenario(app, switchName, params, target)).statusCode).toBe(200);
}

export async function clearScenario(app: AgentApp, switchName?: string): Promise<void> {
  const payload = switchName === undefined ? {} : { switch: switchName };
  expect((await app.inject({ method: 'POST', url: '/_test/scenario/clear', payload })).statusCode).toBe(200);
}
