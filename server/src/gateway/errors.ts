// 网关 client 错误类型（T-P2-01；DES/01 §6.5）。
// 分类语义：
// - 带名字的错误码（body.code）逐字透传，HTTP 状态仅是伴随信息；
// - 503 → UNAVAILABLE 且 retryable=true（整体不可用、可重试类；与 504 的「结果未知」分流，DES/05 §8）；
// - 504 / 我方超时 → 结果未知，不可盲目重发（retryable=false）；
// - 2xx 形状不符 → INVALID_RESPONSE（浅校验标记，禁止静默 cast）；
// - 我方 AbortController 超时 → TIMEOUT（GatewayTimeoutError，status=0 表示无 HTTP 响应）；
// - 404 无业务码 → NOT_FOUND（by-client-id 的正常「未发出」判定依据，调用方决策）。
import { GATEWAY_ERROR_CODES, type GatewayAnyErrorCode } from '@kapibala/contract';

export type GatewayClientErrorCode =
  | GatewayAnyErrorCode
  | 'INVALID_RESPONSE'
  | 'TIMEOUT'
  | 'NOT_FOUND';

// 动态成员判定（码表来自 contract 常量，非手写字面量）
const NAMED_CODES: ReadonlySet<string> = new Set(GATEWAY_ERROR_CODES);

export function isNamedGatewayCode(value: unknown): value is GatewayAnyErrorCode {
  return typeof value === 'string' && NAMED_CODES.has(value);
}

/** 无 body.code 时按 HTTP 状态推导（DES/01 §6.5 分类） */
export function codeFromStatus(status: number): GatewayClientErrorCode {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 504) return 'NETWORK_TIMEOUT';
  if (status === 503) return 'UNAVAILABLE';
  if (status === 404) return 'NOT_FOUND';
  return 'INTERNAL';
}

export function isRetryableCode(code: GatewayClientErrorCode): boolean {
  // 仅整体不可用是「可重试类」；其余（结果未知/形状错/业务码）由调用方按语义决策
  return code === 'UNAVAILABLE';
}

export class GatewayError extends Error {
  /** 出错端点名（connect/send/kick/events…），错误必带（卡片 b） */
  readonly endpoint: string;
  /** HTTP 状态；0 = 未得到 HTTP 响应（本端超时/网络失败） */
  readonly status: number;
  readonly code: GatewayClientErrorCode;
  /** 响应体原文（best-effort 解析后的 JSON 或 null）——retryAfterSeconds 等字段原样保留不取整 */
  readonly body: unknown;
  readonly retryable: boolean;

  constructor(options: {
    endpoint: string;
    status: number;
    code: GatewayClientErrorCode;
    body?: unknown;
    message?: string;
  }) {
    super(options.message ?? `gateway ${options.endpoint} failed: ${options.status} ${options.code}`);
    this.name = 'GatewayError';
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.code = options.code;
    this.body = options.body ?? null;
    this.retryable = isRetryableCode(options.code);
  }
}

/** 我方显式超时（AbortController 取消）：与网关 504 同属「结果未知」，但可区分来源 */
export class GatewayTimeoutError extends GatewayError {
  readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number) {
    super({
      endpoint,
      status: 0,
      code: 'TIMEOUT',
      message: `gateway ${endpoint} timed out after ${timeoutMs}ms`,
    });
    this.name = 'GatewayTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
