// HTTP 契约层（DES/12 §2）：POST /agent/turn、POST /agent/audit + `/_test` 控制平面。
// 职责：入参校验（tools 恰好 4 个固定工具 + input_schema.required 覆盖全部入参，
// 否则 400 TOOLS_INVALID——REQ §2.2）、provider 选择（AGENT_MODE）、响应形状透传。
// 不做任何业务决策（账号选择 / 审计门禁 / 幂等都在 server——任务卡 d 项、DES/12 §8）。
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  AGENT_TOOL_NAMES,
  type AuditRequest,
  type ToolDefinition,
  type TurnRequest,
} from '@kapibala/contract';
import { createScriptedProvider, type AgentProvider, type ProviderReply } from './providers/scripted.js';
import { createAgentState, registerTestEndpoints, type AgentState } from './scenario.js';

export type AgentMode = 'scripted' | 'anthropic';

/** Fastify 实例 + 状态句柄（测试与 /_test 面直接读） */
export type AgentApp = FastifyInstance & { agentState: AgentState };

export interface AgentAppOptions {
  /** 缺省读 AGENT_MODE（默认 scripted，DES/12 §6） */
  mode?: AgentMode | string;
  logger?: boolean;
}

/**
 * 解析 provider（DES/12 §2 单 HTTP 层双 provider）。
 * anthropic（C2）未实现：无 key → 拒起（env 未配置）；有 key → 仍拒起（实现归后续 C2 任务）——
 * 装配期炸掉好于起一台静默退化到 scripted 的假真实服务。
 */
function resolveProvider(mode: string, state: AgentState): AgentProvider {
  if (mode === 'scripted') {
    return createScriptedProvider(state);
  }
  if (mode === 'anthropic') {
    if (process.env['ANTHROPIC_API_KEY'] === undefined || process.env['ANTHROPIC_API_KEY'] === '') {
      throw new Error('AGENT_MODE=anthropic requires ANTHROPIC_API_KEY (DES/12 §6; C2 lands in a later task)');
    }
    throw new Error('AGENT_MODE=anthropic provider is not implemented yet (DES/12 §4; C2 lands in a later task)');
  }
  throw new Error(`unknown AGENT_MODE: ${JSON.stringify(mode)} (expected scripted|anthropic)`);
}

function sendProviderReply(reply: FastifyReply, out: ProviderReply): void {
  if (out.kind === 'raw') {
    reply.code(out.statusCode ?? 200).type('application/json').send(out.body);
    return;
  }
  reply.send(out.value);
}

/** REQ §2.2：tools 恰好 4 个、名字集 = 契约表、每个 input_schema 的 required 覆盖 properties 全部键。 */
function toolsInvalidReason(tools: unknown): string | null {
  if (!Array.isArray(tools) || tools.length !== AGENT_TOOL_NAMES.length) {
    return `tools must be exactly the ${AGENT_TOOL_NAMES.length} contract tools`;
  }
  const names = tools.map((tool) =>
    typeof tool === 'object' && tool !== null ? (tool as ToolDefinition).name : undefined,
  );
  for (const expected of AGENT_TOOL_NAMES) {
    if (!names.includes(expected)) {
      return `tools must be exactly ${AGENT_TOOL_NAMES.join(', ')}`;
    }
  }
  for (const tool of tools as ToolDefinition[]) {
    const schema = tool.input_schema;
    if (schema === undefined || typeof schema !== 'object') {
      return `tool ${tool.name}: input_schema must be a valid JSON Schema`;
    }
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) {
        return `tool ${tool.name}: required must cover every input (missing ${key})`;
      }
    }
  }
  return null;
}

/** messages 的最小结构校验：role ∈ user|assistant、content 为块数组（逐字形状在 server 侧组装，mock 不深挖语义） */
function messagesInvalidReason(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return 'messages must be an array';
  }
  for (const [index, message] of messages.entries()) {
    if (typeof message !== 'object' || message === null) {
      return `messages[${index}] must be an object`;
    }
    const m = message as Record<string, unknown>;
    if (m['role'] !== 'user' && m['role'] !== 'assistant') {
      return `messages[${index}].role must be user|assistant`;
    }
    if (!Array.isArray(m['content'])) {
      return `messages[${index}].content must be a block array`;
    }
  }
  return null;
}

export function createAgentApp(options: AgentAppOptions = {}): AgentApp {
  const mode = options.mode ?? process.env['AGENT_MODE'] ?? 'scripted';
  const state = createAgentState();
  const provider = resolveProvider(mode, state);
  // 单点受控断言：decorate 补上 agentState；经 unknown 是 Fastify decorate 的标准模式（同 mock-gateway）
  const app = Fastify({ logger: options.logger === true }) as unknown as AgentApp;
  app.decorate('agentState', state);

  app.post('/agent/turn', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const runId = body['runId'];
    if (typeof runId !== 'string' || runId === '') {
      return reply.code(400).send({ message: 'runId is required' });
    }
    const toolsError = toolsInvalidReason(body['tools']);
    if (toolsError !== null) {
      return reply.code(400).send({ code: 'TOOLS_INVALID', message: toolsError });
    }
    const messagesError = messagesInvalidReason(body['messages']);
    if (messagesError !== null) {
      return reply.code(400).send({ message: messagesError });
    }
    const turnRequest: TurnRequest = {
      runId,
      tools: body['tools'] as ToolDefinition[],
      messages: body['messages'] as TurnRequest['messages'],
    };
    sendProviderReply(reply, await provider.turn(turnRequest));
  });

  app.post('/agent/audit', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body['text'] !== 'string' || typeof body['groupId'] !== 'string') {
      return reply.code(400).send({ message: 'text and groupId are required' });
    }
    sendProviderReply(reply, await provider.audit(body as unknown as AuditRequest));
  });

  registerTestEndpoints(app, state, mode);
  return app;
}
