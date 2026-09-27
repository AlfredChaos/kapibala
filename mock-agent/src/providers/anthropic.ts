// anthropic provider（T-P8-02；DES/12 §4、REQ C2、DES/01 §6.5）。
// @anthropic-ai/sdk 透传 + 进出形状映射（§2.2 协议本就是 Anthropic Messages tool-use 形状，
// 近同构）：
//   请求方向——AgentMessage/ToolDefinition → SDK params（role/content 原样、tools 同构映射）；
//   响应方向——SDK 多 content 块 → 首个有效块（tool_use/text）+ 恰一块；stop_reason 一致性
//             由块类型裁定（块与 SDK 声明不一致时信块）；SDK 未知 stop_reason →
//             end_turn + text 兜底块（§4 逐字「其余映射为 end_turn + text 兜底块」）。
// audit 走 judge prompt：只收 { "verdict": "pass"|"fail", "reason": "…" } JSON；
//   解析失败/非约定值/SDK 抛错 → raw 500（契约「拿不到明确结论」故障形态——后端 §8.1
//   无结论路径（重试 ≤3 → blocked）由此真实走到）。
// AnthropicLike 是注入式鸭子类型：测试注入假 client 零网络；装配边界（app.ts resolveProvider）
// 才 new Anthropic() 真 SDK。
import type { AgentMessage, AuditRequest, ToolDefinition, TurnRequest, TurnResponse } from '@kapibala/contract';
import Anthropic from '@anthropic-ai/sdk';
import type { ProviderReply, AgentProvider } from './scripted.js';

// ---------- 最小 SDK 鸭子类型（测试用假 client；真 SDK 的字段结构与之同构） ----------

export interface AnthropicContentBlockLike {
  readonly type: string;
  readonly [k: string]: unknown;
}

export interface AnthropicMessageLike {
  readonly stop_reason: string | null;
  readonly content: readonly AnthropicContentBlockLike[];
}

export interface AnthropicCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly { role: 'user' | 'assistant'; content: unknown }[];
  readonly tools?: readonly { name: string; description?: string; input_schema: unknown }[];
  readonly system?: string;
}

export interface AnthropicMessagesLike {
  create(params: AnthropicCreateParams): Promise<AnthropicMessageLike>;
}

export interface AnthropicLike {
  readonly messages: AnthropicMessagesLike;
}

export interface AnthropicProviderDeps {
  readonly client: AnthropicLike;
  readonly model: string;
  readonly logger?: { warn(o: unknown, m?: string): void };
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const TURN_MAX_TOKENS = 1024;
const AUDIT_MAX_TOKENS = 256;

/** tools 同构映射（§2.2 的 {name,description,input_schema} == SDK Tool 形状） */
function mapTools(tools: readonly ToolDefinition[]): AnthropicCreateParams['tools'] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/** messages 近同构透传（role + content 块数组原样；块形状即 SDK ContentBlockParam） */
function mapMessages(messages: readonly AgentMessage[]): AnthropicCreateParams['messages'] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

interface UsableBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function usable(block: AnthropicContentBlockLike | undefined): block is AnthropicContentBlockLike & UsableBlock {
  return block !== undefined && (block.type === 'text' || block.type === 'tool_use');
}

/**
 * 响应形状映射（§4 逐字）：多 content 块取首个 tool_use/text，其余丢弃，恰一块；
 * stop_reason 一致性——SDK 的 stop_reason ∉ {'tool_use','end_turn'} 时强制 end_turn + text
 * 兜底块（不管块里是什么）。已知值下由首个有效块的类型裁定 stop_reason（块与声明不一致时
 * 信块——「stop_reason 一致」的含义是块类型与 stop_reason 互相印证，不是照搬 SDK 字段）。
 */
export function mapTurnResponse(message: AnthropicMessageLike): TurnResponse {
  const known = message.stop_reason === 'tool_use' || message.stop_reason === 'end_turn';
  const first = message.content.find(usable);
  if (!known || first === undefined) {
    // 未知 stop_reason（max_tokens/stop_sequence/未来值）或空/无效块 → end_turn + text 兜底
    const fallbackText =
      first?.type === 'text' && typeof first.text === 'string' ? first.text : '';
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: fallbackText }] };
  }
  if (first.type === 'tool_use') {
    return {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: typeof first.id === 'string' ? first.id : '',
          name: typeof first.name === 'string' ? first.name : '',
          input:
            first.input !== null && typeof first.input === 'object'
              ? (first.input as Record<string, unknown>)
              : {},
        },
      ],
    };
  }
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: typeof first.text === 'string' ? first.text : '' }],
  };
}

/** audit 的 judge prompt（§4：只输出 {verdict,reason} JSON——无 markdown、无解释） */
function judgePrompt(request: AuditRequest): string {
  return [
    'You are an audit judge. Review the following agent-generated message text for policy violations.',
    `Group: ${request.groupId}`,
    `Text: ${request.text}`,
    'Respond with ONLY a JSON object, no markdown, no explanation:',
    '{"verdict": "pass" | "fail", "reason": "<short reason>"}',
  ].join('\n');
}

/** 解析 judge 输出：合法 {verdict:pass|fail, reason:string} → AuditResponse；否则 null */
function parseAuditOutput(text: string): { verdict: 'pass' | 'fail'; reason: string } | null {
  const trimmed = text.trim();
  // 容忍「模型裹了 ```json」的实操形态：剥 fence 再解析——解析标准只约束 JSON 本体
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const verdict = record['verdict'];
  const reason = record['reason'];
  if ((verdict === 'pass' || verdict === 'fail') && typeof reason === 'string') {
    return { verdict, reason };
  }
  return null;
}

const AUDIT_500_BODY = JSON.stringify({ error: 'audit judge produced no conclusive verdict' });

export function createAnthropicProvider(deps: AnthropicProviderDeps): AgentProvider {
  const log = deps.logger ?? { warn: () => {} };
  return {
    async turn(request: TurnRequest): Promise<ProviderReply> {
      try {
        const message = await deps.client.messages.create({
          model: deps.model,
          max_tokens: TURN_MAX_TOKENS,
          messages: mapMessages(request.messages),
          tools: mapTools(request.tools),
        });
        return { kind: 'json', value: mapTurnResponse(message) };
      } catch (err) {
        // SDK/网络失败不外抛——HTTP 层需要的是「无结论」故障形态（500）
        log.warn({ err, runId: request.runId }, 'anthropic turn failed; returning 500');
        return { kind: 'raw', statusCode: 500, body: AUDIT_500_BODY };
      }
    },
    async audit(request: AuditRequest): Promise<ProviderReply> {
      try {
        const message = await deps.client.messages.create({
          model: deps.model,
          max_tokens: AUDIT_MAX_TOKENS,
          messages: [{ role: 'user', content: [{ type: 'text', text: judgePrompt(request) }] }],
        });
        // 取首个 text 块解析（judge 不该有 tool_use；多块同样只认首块）
        const first = message.content.find((b) => b.type === 'text');
        const text = first !== undefined && typeof first['text'] === 'string' ? (first['text'] as string) : '';
        const parsed = parseAuditOutput(text);
        if (parsed === null) {
          log.warn({ groupId: request.groupId, raw: text }, 'audit judge output unparsable; returning 500');
          return { kind: 'raw', statusCode: 500, body: AUDIT_500_BODY };
        }
        return { kind: 'json', value: parsed };
      } catch (err) {
        log.warn({ err, groupId: request.groupId }, 'anthropic audit failed; returning 500');
        return { kind: 'raw', statusCode: 500, body: AUDIT_500_BODY };
      }
    },
  };
}

/** 真 SDK 装配（仅在 resolveProvider 命中 anthropic 且 key 在位时调用） */
export function createAnthropicProviderFromEnv(
  deps: Omit<AnthropicProviderDeps, 'client' | 'model'> & { apiKey: string },
): AgentProvider {
  const client = new Anthropic({ apiKey: deps.apiKey });
  return createAnthropicProvider({
    client: client as unknown as AnthropicLike,
    model: process.env['LLM_MODEL'] ?? DEFAULT_MODEL,
    logger: deps.logger,
  });
}
