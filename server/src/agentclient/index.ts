// Agent 服务 HTTP 客户端（T-P4-04；接口层——T-P4-05 executor 唯一消费方）。
// 契约出处：REQ §2.2（/agent/turn、/agent/audit 请求与响应形状逐字）、
// DES/06 §4 三段式校验（第一层 HTTP 状态 → 第二层 JSON 解析 → 第三层形状）+ §6（组装/丢弃细节）。
// 三段式的「形状」只验协议外形：stop_reason 存在且与块类型一致、content 恰一块；
// 工具名/schema 合法性不归本层（DES/06 §4：UNKNOWN_TOOL/INVALID_INPUT 走路径 A，由 executor 判）。
// 错误语义（§4 流程图逐字）：HTTP 非 2xx / 非合法 JSON（含 markdown 围栏、前后夹文）/ 形状不符
// → BAD_JSON；网络失败或超时 → TURN_TIMEOUT。两类都经 AgentClientError.protocolErrorCode 透出，
// executor 原样写协议错误步（raw_response ≤2KB 截断也留调用方——本层原样透传原始体）。
// ---------- /agent/turn ----------

export interface AgentTurnToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface AgentMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly unknown[];
}

export interface AgentTurnRequest {
  readonly runId: string;
  readonly tools: readonly AgentTurnToolDef[];
  readonly messages: readonly AgentMessage[];
}

export interface AgentToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface AgentTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/** 校验通过的 /agent/turn 响应（stop_reason↔块类型一致性已由三段式保证） */
export type AgentTurnResponse =
  | { readonly stopReason: 'tool_use'; readonly block: AgentToolUseBlock }
  | { readonly stopReason: 'end_turn'; readonly block: AgentTextBlock };

// ---------- /agent/audit ----------

export interface AgentAuditRequest {
  readonly text: string;
  readonly groupId: string;
}

/**
 * 审计结论（A5-4）：pass/fail 是契约值；unresolved 覆盖全部「拿不到明确结论」形态
 * （非 2xx、非 JSON、缺 verdict、verdict 为别的值、超时、网络失败）——executor 据此走 3 次重试。
 */
export interface AgentAuditResponse {
  readonly verdict: 'pass' | 'fail' | 'unresolved';
  readonly reason?: string;
}

// ---------- 错误 ----------

export type AgentProtocolErrorCode = 'BAD_JSON' | 'TURN_TIMEOUT';

export class AgentClientError extends Error {
  /** executor 写协议错误步的 error_code（§4：非 2xx 也记 BAD_JSON 逐字） */
  readonly protocolErrorCode: AgentProtocolErrorCode;
  /** 原始响应体（raw_response 落库素材；超时/网络失败为 undefined） */
  readonly rawBody?: string;

  constructor(code: AgentProtocolErrorCode, message: string, rawBody?: string) {
    super(message);
    this.name = 'AgentClientError';
    this.protocolErrorCode = code;
    this.rawBody = rawBody;
  }
}

// ---------- 客户端 ----------

export interface AgentClientDeps {
  /** AGENT_URL（/agent/turn、/agent/audit 拼接基座） */
  readonly baseUrl: string;
  /** 每轮 turn 超时（契约 10–15s 可配；REQ §2.2）；缺省 12s */
  readonly turnTimeoutMs?: number;
  /** 审计单次超时（计入 60s 墙钟；【解读】默认与 turn 同档 5s——3 次重试总占用仍 < 墙钟） */
  readonly auditTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface AgentRawResponse {
  readonly status: number;
  readonly raw: string;
}

export interface AgentClient {
  /**
   * 纯传输层（三段式归调用方 server/src/modules/agent/validation.ts——T-P4-06 唯一收口）：
   * 返回 {status, raw}；HTTP 层失败（超时/网络）抛 AgentClientError(TURN_TIMEOUT)。
   * 响应校验三段（HTTP 状态 → JSON 解析 → 形状）由 validateTurnResponse 完成，本层不判。
   */
  rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse>;
  callAudit(req: AgentAuditRequest): Promise<AgentAuditResponse>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function postJson(
  deps: Required<Pick<AgentClientDeps, 'fetchImpl'>> & Pick<AgentClientDeps, 'baseUrl'>,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, raw: await res.text() };
  } catch (err) {
    // abort → TURN_TIMEOUT；连接拒绝/DNS 等同样归 TURN_TIMEOUT 语义（「响应未按时到达」）
    throw new AgentClientError('TURN_TIMEOUT', `agent request failed: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function createAgentClient(deps: AgentClientDeps): AgentClient {
  const impl = { baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl ?? fetch };
  const turnTimeout = deps.turnTimeoutMs ?? 12_000;
  const auditTimeout = deps.auditTimeoutMs ?? 5_000;

  return {
    async rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse> {
      return postJson(impl, '/agent/turn', req, turnTimeout);
    },

    async callAudit(req: AgentAuditRequest): Promise<AgentAuditResponse> {
      let res: { status: number; raw: string };
      try {
        res = await postJson(impl, '/agent/audit', req, auditTimeout);
      } catch (err) {
        if (err instanceof AgentClientError) {
          return { verdict: 'unresolved' }; // 超时/网络失败 = 「拿不到明确结论」
        }
        throw err;
      }
      // audit 的全部非完美形态都归 unresolved（§4 不按协议错误计——审计重试不入步数）
      if (res.status < 200 || res.status >= 300) return { verdict: 'unresolved' };
      let body: unknown;
      try {
        body = JSON.parse(res.raw);
      } catch {
        return { verdict: 'unresolved' };
      }
      if (!isRecord(body)) return { verdict: 'unresolved' };
      const verdict = body['verdict'];
      if (verdict !== 'pass' && verdict !== 'fail') return { verdict: 'unresolved' };
      const reason = body['reason'];
      return { verdict, reason: typeof reason === 'string' ? reason : undefined };
    },
  };
}
