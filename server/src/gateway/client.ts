// 网关 client —— server 侧唯一网关出口（T-P2-01；DES/01 §6.5、REQ §2.1）。
// 纪律（卡片 d）：client 不做任何业务决策——无重试、无限流回避、无状态推断；
// 只做：显式超时（AbortController）、HTTP 错误 → 类型化 GatewayError、响应浅校验。
// 超时预算全部来自 constants.ts（出处 DES/01 §4.4）：
//   普通 10s / kick 6s / send 8s / by-client-id 5s；timeouts 选项是测试注入缝（默认值不动）。
import {
  BY_CLIENT_ID_TIMEOUT_MS,
  GATEWAY_TIMEOUT_DEFAULT_MS,
  KICK_TIMEOUT_MS,
  SEND_TIMEOUT_BUDGET_MS,
} from '../constants.js';
import { codeFromStatus, GatewayError, GatewayTimeoutError, isNamedGatewayCode } from './errors.js';
import { checkCrashPoint } from '../crash.js';

export interface GatewayTimeouts {
  default: number;
  kick: number;
  send: number;
  byClientId: number;
}

export interface GatewayClientOptions {
  baseUrl: string;
  /** 测试注入缝：覆盖默认超时（默认值来自 constants.ts，DES/01 §4.4） */
  timeouts?: Partial<GatewayTimeouts>;
}

export interface GatewayClient {
  connect(accountId: string): Promise<{ platformUserId: string }>;
  disconnect(accountId: string): Promise<void>;
  createGroup(input: { creatorAccountId: string }): Promise<{ groupId: string }>;
  invite(groupId: string): Promise<{ inviteLink: string; readyAfterMs: number }>;
  join(groupId: string, input: { accountId: string; inviteLink: string }): Promise<{ accepted: boolean }>;
  promote(groupId: string, input: { byAccountId: string; accountId: string }): Promise<void>;
  kick(
    groupId: string,
    input: { byAccountId: string; targetPlatformUserId: string },
  ): Promise<{ kicked: boolean }>;
  leave(groupId: string, input: { accountId: string }): Promise<void>;
  send(
    groupId: string,
    input: { accountId: string; clientMsgId: string; text: string },
  ): Promise<{ accepted: boolean }>;
  members(groupId: string): Promise<Array<{ platformUserId: string }>>;
  /** 504 结果未知探测（DES/05 §2.4）：404 → NOT_FOUND，「确认未发出」与否由调用方决策 */
  getMessageByClientMsgId(groupId: string, clientMsgId: string): Promise<{ msgId: string; sentAt: string }>;
  /** mediaUrl 为网关返回的完整 URL（REQ §2.1 message.mediaUrl → GET /media/:id） */
  downloadMedia(mediaUrl: string): Promise<Uint8Array>;
}

// ---------- 浅校验助手（形状守卫；不符 → INVALID_RESPONSE，绝不静默 cast） ----------

/** 本包唯一的对象形状守卫（网关边界导出；字段访问仍逐个 typeof 校验） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(endpoint: string, body: unknown, detail: string): GatewayError {
  return new GatewayError({
    endpoint,
    status: 200,
    code: 'INVALID_RESPONSE',
    body,
    message: `gateway ${endpoint} returned unexpected shape: ${detail}`,
  });
}

function requireString(endpoint: string, body: unknown, key: string): string {
  if (!isRecord(body)) throw invalid(endpoint, body, 'expected an object');
  const value = body[key];
  if (typeof value !== 'string') throw invalid(endpoint, body, `field ${key} must be a string`);
  return value;
}

function requireNumber(endpoint: string, body: unknown, key: string): number {
  if (!isRecord(body)) throw invalid(endpoint, body, 'expected an object');
  const value = body[key];
  if (typeof value !== 'number') throw invalid(endpoint, body, `field ${key} must be a number`);
  return value;
}

function requireBoolean(endpoint: string, body: unknown, key: string): boolean {
  if (!isRecord(body)) throw invalid(endpoint, body, 'expected an object');
  const value = body[key];
  if (typeof value !== 'boolean') throw invalid(endpoint, body, `field ${key} must be a boolean`);
  return value;
}

// ---------- 核心：单请求（超时 + 错误映射 + 浅校验） ----------

interface RequestInitLite {
  method: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
}

async function request<T>(
  baseUrl: string,
  endpoint: string,
  path: string,
  init: RequestInitLite,
  validate: (body: unknown) => T,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  // 预算覆盖整次调用（T-P2-01 review #1）：teardown 统一放在最外层 finally——
  // 头部到达后 body 吊死同样被 AbortController 掐断，不再逃逸端点预算。
  try {
    checkCrashPoint(`gateway.call.${endpoint}.before`); // T-P7-01：「外部调用前」窗口
    checkCrashPoint('gateway.call.before');
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    checkCrashPoint(`gateway.call.${endpoint}.after`); // T-P7-01：「外部调用后」（响应已收）
    checkCrashPoint('gateway.call.after');

    if (!response.ok) {
      // 错误 body 是 best-effort：读取被超时掐断/失败时退化为 null——状态码已知，
      // 分类仍按「body 码优先、状态推导兜底」给出（不因 body 缺失改判超时）
      const raw = await response.text().catch(() => '');
      const parsed = raw === '' ? null : safeJson(raw);
      const bodyCode = isRecord(parsed) ? parsed.code : undefined;
      const code = isNamedGatewayCode(bodyCode) ? bodyCode : codeFromStatus(response.status);
      throw new GatewayError({ endpoint, status: response.status, code, body: parsed });
    }

    const text = await response.text();
    const parsed = safeJson(text);
    return validate(parsed);
  } catch (err) {
    if (err instanceof GatewayError) throw err; // 类型化错误（HTTP 映射 / 浅校验）逐字透传
    if (controller.signal.aborted) {
      // 我方超时取消（AbortController）——异常带端点名与预算值（卡片 b）；连接段与 body 段同判
      throw new GatewayTimeoutError(endpoint, init.timeoutMs);
    }
    throw new GatewayError({
      endpoint,
      status: 0,
      code: 'INTERNAL',
      message: `gateway ${endpoint} network failure: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------- 工厂 ----------

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const base = options.baseUrl.replace(/\/$/, '');
  const timeouts: GatewayTimeouts = {
    default: options.timeouts?.default ?? GATEWAY_TIMEOUT_DEFAULT_MS, // 10s（DES/01 §4.4）
    kick: options.timeouts?.kick ?? KICK_TIMEOUT_MS, // 6s = 契约 1–5s + 余量
    send: options.timeouts?.send ?? SEND_TIMEOUT_BUDGET_MS, // 8s = 202 可能 1–2s + 余量
    byClientId: options.timeouts?.byClientId ?? BY_CLIENT_ID_TIMEOUT_MS, // 5s
  };

  const post = <T>(
    endpoint: string,
    path: string,
    body: unknown | undefined,
    timeoutMs: number,
    validate: (parsed: unknown) => T,
  ): Promise<T> => request(base, endpoint, path, { method: 'POST', body, timeoutMs }, validate);

  return {
    connect(accountId) {
      return post(
        'connect',
        `/accounts/${encodeURIComponent(accountId)}/connect`,
        {},
        timeouts.default,
        (body) => ({ platformUserId: requireString('connect', body, 'platformUserId') }),
      );
    },
    disconnect(accountId) {
      return post(
        'disconnect',
        `/accounts/${encodeURIComponent(accountId)}/disconnect`,
        {},
        timeouts.default,
        () => undefined,
      );
    },
    createGroup(input) {
      return post(
        'createGroup',
        '/groups',
        input,
        timeouts.default,
        (body) => ({ groupId: requireString('createGroup', body, 'groupId') }),
      );
    },
    invite(groupId) {
      return post('invite', `/groups/${encodeURIComponent(groupId)}/invite`, {}, timeouts.default, (body) => ({
        inviteLink: requireString('invite', body, 'inviteLink'),
        readyAfterMs: requireNumber('invite', body, 'readyAfterMs'),
      }));
    },
    join(groupId, input) {
      return post(
        'join',
        `/groups/${encodeURIComponent(groupId)}/join`,
        input,
        timeouts.default,
        (body) => ({ accepted: requireBoolean('join', body, 'accepted') }),
      );
    },
    promote(groupId, input) {
      return post(
        'promote',
        `/groups/${encodeURIComponent(groupId)}/promote`,
        input,
        timeouts.default,
        () => undefined,
      );
    },
    kick(groupId, input) {
      return post(
        'kick',
        `/groups/${encodeURIComponent(groupId)}/kick`,
        input,
        timeouts.kick,
        (body) => ({ kicked: requireBoolean('kick', body, 'kicked') }),
      );
    },
    leave(groupId, input) {
      return post(
        'leave',
        `/groups/${encodeURIComponent(groupId)}/leave`,
        input,
        timeouts.default,
        () => undefined,
      );
    },
    send(groupId, input) {
      return post(
        'send',
        `/groups/${encodeURIComponent(groupId)}/send`,
        input,
        timeouts.send,
        (body) => ({ accepted: requireBoolean('send', body, 'accepted') }),
      );
    },
    members(groupId) {
      return request(
        base,
        'members',
        `/groups/${encodeURIComponent(groupId)}/members`,
        { method: 'GET', timeoutMs: timeouts.default },
        (body) => {
          if (!Array.isArray(body)) throw invalid('members', body, 'expected an array');
          return body.map((entry) => ({
            platformUserId: requireString('members', entry, 'platformUserId'),
          }));
        },
      );
    },
    getMessageByClientMsgId(groupId, clientMsgId) {
      return request(
        base,
        'byClientId',
        `/groups/${encodeURIComponent(groupId)}/messages/by-client-id/${encodeURIComponent(clientMsgId)}`,
        { method: 'GET', timeoutMs: timeouts.byClientId },
        (body) => ({
          msgId: requireString('byClientId', body, 'msgId'),
          sentAt: requireString('byClientId', body, 'sentAt'),
        }),
      );
    },
    async downloadMedia(mediaUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeouts.default);
      // 预算覆盖整次下载（与 request() 同一 teardown 形态，T-P2-01 review #2）：
      // arrayBuffer 在 try 内、clearTimeout 在最外层 finally——成功/失败/超时路径都必然清理
      try {
        const response = await fetch(mediaUrl, { signal: controller.signal });
        if (!response.ok) {
          const raw = await response.text().catch(() => '');
          throw new GatewayError({
            endpoint: 'media',
            status: response.status,
            code: codeFromStatus(response.status),
            body: safeJson(raw),
          });
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        if (err instanceof GatewayError) throw err;
        if (controller.signal.aborted) throw new GatewayTimeoutError('media', timeouts.default);
        throw new GatewayError({
          endpoint: 'media',
          status: 0,
          code: 'INTERNAL',
          message: `gateway media network failure: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
