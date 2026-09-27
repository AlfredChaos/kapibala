// 统一错误映射（DES/01 §6.3；宪法 §3-7）：对外错误一律 { error: { code, message, requestId, ...extra } }。
// - AppError → 按 code 映射 HTTP 状态；
// - fastify 的 schema / body 解析类 4xx → 400 VALIDATION_ERROR；
// - 未知异常 → 500 INTERNAL，且 error 日志带 err（pino 序列化含 stack）。
import type { FastifyError } from 'fastify';
import type { ApiErrorCode } from '@kapibala/contract';
import type { App } from '../app.js';

// HTTP 状态映射：QR §4 逐字；设计值码（不在 QR 表内）的语义由各自任务卡最终钉死，
// 此处给出合理缺省，构造 AppError 时可用 statusCode 显式覆盖。
const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  ACCOUNT_NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  CAS_CONFLICT: 409,
  ACCOUNT_NOT_IN_GROUP: 409,
  ACCOUNT_UNAVAILABLE: 409,
  SEQUENCE_ALREADY_RUNNING: 409,
  UNRESOLVED_PLACEHOLDER: 422,
  ACCOUNT_NOT_ONLINE: 422,
  JOIN_TIMEOUT: 500, // QR §4 标注「job error」：不直接映射 HTTP，兜底 500
  TOOLS_INVALID: 400,
  JOB_NOT_FOUND: 404,
  AGENT_RUN_NOT_FOUND: 404,
  GROUP_NOT_FOUND: 404,
  LEAVE_FAILED: 500,
  GROUP_UNREACHABLE: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  /** 合并进 error 对象的业务字段（如 UNRESOLVED_PLACEHOLDER 的 stepIndex / key，REQ §2.3） */
  readonly extra: Record<string, unknown> | undefined;
  readonly statusCode: number;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { extra?: Record<string, unknown>; statusCode?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.extra = options.extra;
    this.statusCode = options.statusCode ?? STATUS_BY_CODE[code];
  }
}

// 【解读】传输层 404（路由不存在）不在 QR §4 域错误码表内——code 表只覆盖域错误；
// 此处本地补充 'NOT_FOUND'，不进 @kapibala/contract 的域枚举。
type EnvelopeCode = ApiErrorCode | 'NOT_FOUND';

interface ErrorEnvelope {
  error: { code: EnvelopeCode; message: string; requestId: string } & Record<string, unknown>;
}

function envelope(
  code: EnvelopeCode,
  message: string,
  requestId: string,
  extra?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: { code, message, requestId, ...(extra ?? {}) } };
}

export async function applyErrorMapping(app: App): Promise<void> {
  // 参数类型交由 App 实例推断（避免手写 FastifyRequest 默认泛型与 App 的 logger 泛型错位）
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const requestId = String(request.id);
    if (err instanceof AppError) {
      void reply.status(err.statusCode).send(envelope(err.code, err.message, requestId, err.extra));
      return;
    }
    // 【解读】fastify 框架 4xx（schema 校验、JSON body 解析等）统一收敛为 VALIDATION_ERROR/400：
    // QR §4 只定义了这两个横切档位，405/415 等极端路径不单独造码。
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      void reply.status(400).send(envelope('VALIDATION_ERROR', err.message, requestId));
      return;
    }
    request.log.error({ err }, 'unhandled error');
    void reply.status(500).send(envelope('INTERNAL', err.message, requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(
        envelope(
          'NOT_FOUND',
          `route ${request.method} ${request.url} not found`,
          String(request.id),
        ),
      );
  });
}
