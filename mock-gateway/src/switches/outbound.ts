// 出站类开关（T-P3-09）：send 的同步错误与 504 两态、端点整体不可用、群不可写、发送者不在群、
// 强制离线、message_failed。契约出处：REQ §2.1「发消息」节同步错误表 +「任何端点（包括 by-client-id 查询）
// 都可能整体不可用（503）」；DES/14 §5 行 6–10 / 14–17、§3。开关名逐字取自 §5 表。
// 分工约定：本文件只做**判定**（唯一的状态写是 gw-6 契约要求的计时重置），HTTP 响应与落地副作用留在路由层。
import type { FastifyInstance } from 'fastify';
import type { GatewayAnyErrorCode } from '@kapibala/contract';
import type { GatewayState, MockGroupState, SwitchConfig } from '../state.js';
import { activeSwitch, readNumberParam, readStringParam, readTargetString, type SwitchTarget } from '../switches.js';

/** gw-6 未钉值时的等待秒数（契约只要求给出 retryAfterSeconds，数值由网关定；DES/14 §5 行 6） */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/** gw-7 的固定落地时延：S5 编排 1.5s，契约要求「504 时若已被接收，2 秒内落地并推 message_sent」（DES/14 §3） */
export const SEND504_LAND_MS = 1500;

/** 503 的错误体（扁平 {code,message}，与其它端点一致；code 取传输层类别 UNAVAILABLE，contract 码表） */
export const UNAVAILABLE_BODY: { code: GatewayAnyErrorCode; message: string } = {
  code: 'UNAVAILABLE',
  message: 'gateway is unavailable',
};

/** message_failed 的两闭集码（REQ §2.1 逐字：只有这两个） */
export const MESSAGE_FAILED_CODES = ['GROUP_WRITE_FORBIDDEN', 'ACCOUNT_SUSPENDED'] as const;
export type MessageFailedCode = (typeof MESSAGE_FAILED_CODES)[number];

function isMessageFailedCode(value: unknown): value is MessageFailedCode {
  return typeof value === 'string' && (MESSAGE_FAILED_CODES as readonly string[]).includes(value);
}

/**
 * gw-6 `rate_limit`：`429 RATE_LIMITED { retryAfterSeconds }`。
 * REQ §2.1 逐字：「等待期内该账号的任何 `send` 都会再次得到**同样**的错误，并且**计时重置**」——
 * 计时重置由网关侧实现（server 侧的另一半是限流期内零试探，S4：`counters.sendCallsByAccount` 必须为 0）。
 * 命中条件：开关命中该账号，**或**账号仍在限流窗口内（开关已 clear 但窗口未过 → 照旧 429，契约不依赖开关）。
 * 「同样的错误」= 窗口内复用首次的 retryAfterSeconds（不因 clear 后重探而漂到默认值）。
 */
export function rateLimitRejection(state: GatewayState, accountId: string): { retryAfterSeconds: number } | null {
  const config = activeSwitch(state, 'rate_limit', { accountId });
  const account = state.accounts.get(accountId);
  const now = Date.now();
  if (config === undefined && (account?.rateLimitedUntil ?? 0) <= now) {
    return null;
  }
  const retryAfterSeconds =
    readNumberParam(config, 'retryAfterSeconds') ?? account?.rateLimitRetryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  if (account !== undefined) {
    account.rateLimitedUntil = now + retryAfterSeconds * 1000; // 计时重置：每次试探都把窗口往后推
    account.rateLimitRetryAfterSeconds = retryAfterSeconds;
  }
  return { retryAfterSeconds };
}

/** send 的 504 三态（gw-7 已接收后落地 / gw-8 确实未发出 / 无开关 = 正常受理）；gw-8 优先于 gw-7 */
export type SendTimeoutOutcome = 'none' | 'land_after_1500' | 'not_sent';

export function resolveSendTimeout(state: GatewayState, target: SwitchTarget): SendTimeoutOutcome {
  if (activeSwitch(state, 'send_504_not_sent', target) !== undefined) {
    return 'not_sent';
  }
  if (activeSwitch(state, 'send_504_land_1500', target) !== undefined) {
    return 'land_after_1500';
  }
  return 'none';
}

/** gw-14 `group_write_forbidden`：群不可写（解散/禁言），**与账号无关**（REQ §2.1） */
export function isGroupWriteForbidden(state: GatewayState, group: MockGroupState, groupId: string): boolean {
  return group.writeForbidden || activeSwitch(state, 'group_write_forbidden', { groupId }) !== undefined;
}

/** gw-16 `sender_not_in_group`：强制「该账号不在这个群里」→ 403（即使它其实是成员） */
export function isForcedSenderNotInGroup(state: GatewayState, target: SwitchTarget): boolean {
  return activeSwitch(state, 'sender_not_in_group', target) !== undefined;
}

/**
 * gw-17 `account_offline_409`：强制该账号呈离线态 → 五操作（send/join/promote/kick/leave）`409 ACCOUNT_OFFLINE`。
 * 只作用于五操作闸门；connect 不受影响（REQ §2.1：409 的语义是「未 connect 或已 disconnect」的**操作**拒绝）。
 */
export function isForcedOffline(state: GatewayState, accountId: string): boolean {
  return activeSwitch(state, 'account_offline_409', { accountId }) !== undefined;
}

/** gw-15 `message_failed_event`：受理后不落地，改推 `message_failed {clientMsgId, code}`（码见闭集） */
export function resolveMessageFailedCode(state: GatewayState, target: SwitchTarget): MessageFailedCode | undefined {
  const code = readStringParam(activeSwitch(state, 'message_failed_event', target), 'code');
  return isMessageFailedCode(code) ? code : undefined;
}

/**
 * gw-15 的 arrange 校验：`params.code` 缺失或不在两码闭集 → 400 且开关不登记。
 * 静默忽略会让「推 message_failed」的用例悄悄退化成正常落地（假绿）——测试平面契约是当场炸。
 */
export function validateMessageFailedParams(config: SwitchConfig): string | null {
  const code = config.params?.['code'];
  if (code === undefined) {
    return 'message_failed_event requires params.code (GROUP_WRITE_FORBIDDEN | ACCOUNT_SUSPENDED)';
  }
  if (!isMessageFailedCode(code)) {
    return `message_failed_event unknown code: ${JSON.stringify(code)} (REQ §2.1 只有两码)`;
  }
  return null;
}

/**
 * gw-9/gw-10 的不可用窗口归一：arm 时把相对的 `params.durationMs` 折算成绝对 `params.untilMs`
 * （DES/14 §5「可配恢复时刻/时长」）。两者都未给 = 不可用直到 clear。
 */
export function normalizeOutageParams(config: SwitchConfig): void {
  const durationMs = readNumberParam(config, 'durationMs');
  if (durationMs === undefined || readNumberParam(config, 'untilMs') !== undefined) {
    return;
  }
  config.params = { ...config.params, untilMs: Date.now() + durationMs };
}

/** 该开关的不可用窗口是否仍在生效（未给 untilMs = 直到 clear） */
export function isOutageActive(state: GatewayState, switchName: string, target?: SwitchTarget): boolean {
  const config = activeSwitch(state, switchName, target);
  if (config === undefined) {
    return false;
  }
  const untilMs = readNumberParam(config, 'untilMs');
  return untilMs === undefined || untilMs > Date.now();
}

/** gw-9 `by_client_id_503`：by-client-id 查询 503（可配恢复时刻）；其它端点不受影响 */
export function isByClientIdOutage(state: GatewayState, target: SwitchTarget): boolean {
  return isOutageActive(state, 'by_client_id_503', target);
}

/**
 * gw-10 `gateway_503_all`：所有端点 503（可配时长）。
 * `/_test` 控制平面**豁免**——它是 arrange 的唯一入口，一并 503 就等于开关关不掉（DES/14 §4）。
 */
export function isGatewayOutage(state: GatewayState, urlPath: string): boolean {
  if (urlPath.startsWith('/_test')) {
    return false;
  }
  return isOutageActive(state, 'gateway_503_all');
}

/** gw-10 的全局拦截（注册在所有路由之前）：不可用窗口内直接 503，不进业务处理、不计调用计数 */
export function registerGatewayOutageHook(app: FastifyInstance, state: GatewayState): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isGatewayOutage(state, request.url)) {
      return;
    }
    await reply.code(503).send(UNAVAILABLE_BODY);
  });
}

/**
 * 出站类开关的 arm/clear 接线（test-plane 的 armSwitch 调用）。
 * 返回非 null = arrange 失败（400 且开关不登记）；clear 路径一律宽容（只做拆除，不做断言）。
 */
export function applyOutboundSwitch(
  state: GatewayState,
  switchName: string,
  config: SwitchConfig,
  enabling: boolean,
): string | null {
  if (switchName === 'by_client_id_503' || switchName === 'gateway_503_all') {
    if (enabling) {
      normalizeOutageParams(config);
    }
    return null;
  }
  if (switchName === 'group_write_forbidden') {
    return applyGroupWriteForbidden(state, config, enabling);
  }
  if (switchName === 'message_failed_event') {
    return enabling ? validateMessageFailedParams(config) : null;
  }
  return null;
}

/**
 * gw-14 的状态位接线：DES/14 §2 的 group 行明文「解散/禁言开关置 `writeForbidden`」，
 * 故 arm/clear 同步该字段（群域真值，供状态检视）；未给 target.groupId = 全局禁写，只靠开关命中判定。
 */
function applyGroupWriteForbidden(state: GatewayState, config: SwitchConfig, enabling: boolean): string | null {
  const groupId = readTargetString(config, 'groupId');
  if (groupId === undefined) {
    return null;
  }
  const group = state.groups.get(groupId);
  if (group === undefined) {
    return enabling ? `unknown target group: ${groupId}` : null;
  }
  group.writeForbidden = enabling;
  return null;
}
