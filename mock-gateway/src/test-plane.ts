// /_test 控制平面（DES/14 §4 逐字）：测试 arrange 的唯一入口。
// 端点与开关命名不自创契约（任务卡 d 项）；开关语义的完整接线随各域任务落地，
// 本任务落：开关登记/清除、reset（eventId 不回退）、counters、emit（入账本走正常投放）。
import type { FastifyInstance } from 'fastify';
import {
  appendLedger,
  isGatewayEventType,
  resetGatewayState,
  type GatewayState,
  type SwitchConfig,
} from './state.js';
import { injectExternalMemberEvents, injectOfflineBacklog } from './switches/backlog.js';

/**
 * 合法开关名全集（DES/14 §5 清单逐字；一行两名的拆开登记）。
 * scenario 打开未列名开关 = 400：拼错开关名必须在 arrange 阶段就炸，不能静默无效。
 */
const KNOWN_SWITCHES: readonly string[] = [
  'send_accept_slow', // 1
  'message_sent_delay', // 2
  'dup_push_all', // 3
  'reorder_1s', // 4
  'offline_backlog', // 5
  'rate_limit', // 6
  'send_504_land_1500', // 7
  'send_504_not_sent', // 8
  'by_client_id_503', // 9
  'gateway_503_all', // 10
  'account_suspended_403', // 11
  'session_expired_401', // 12
  'account_status_event', // 13
  'group_write_forbidden', // 14
  'message_failed_event', // 15
  'sender_not_in_group', // 16
  'account_offline_409', // 17
  'member_joined_never', // 18
  'member_joined_delay', // 19
  'invite_not_ready', // 20
  'invite_expired', // 21
  'already_member', // 22
  'promote_not_member_yet', // 23
  'kick_slow', // 24
  'kick_504', // 24
  'owner_left_on_kick', // 25
  'kick_no_permission', // 25
  'leave_500', // 26
  'media_message', // 27
  'media_expire_404', // 27
  'external_member_events', // 28
];

/**
 * 账号域开关的即时接线（开关 11/12）：scenario 打开即置终态标志，clear 即撤销。
 * 返回错误信息 = arrange 失败（target.accountId 给了但账号不存在 → 调用方 400）：
 * 测试平面契约是「拼错目标必须在 arrange 阶段炸」，不静默无效、不自动建号。
 * clear 路径（enabling=false）对已消失的账号宽容——只做拆除，不做断言
 * （reset 恢复种子后 clear 旧开关是合法时序）。
 */
function applyAccountDomainSwitch(
  state: GatewayState,
  switchName: string,
  config: SwitchConfig,
  enabling: boolean,
): string | null {
  if (switchName !== 'account_suspended_403' && switchName !== 'session_expired_401') {
    return null;
  }
  const target = config.target?.['accountId'];
  if (typeof target !== 'string') {
    return null; // 未给 target：不适用账号域接线（开关登记仍成功，行为接线归后续域任务）
  }
  const account = state.accounts.get(target);
  if (account === undefined) {
    return enabling ? `unknown target account: ${target}` : null;
  }
  if (switchName === 'account_suspended_403') {
    account.suspended = enabling;
  } else {
    account.sessionExpired = enabling;
  }
  return null;
}

/**
 * arm（打开开关）时刻的即时接线：开关 11/12 置账号终态标志、gw-5 注入离线补投帧、
 * gw-28 注入外部成员进出群事件。返回非 null = arrange 失败 → 400 且开关不登记（半生效比拒绝更糟）。
 */
function armSwitch(state: GatewayState, switchName: string, config: SwitchConfig): string | null {
  const accountError = applyAccountDomainSwitch(state, switchName, config, true);
  if (accountError !== null) {
    return accountError;
  }
  if (switchName === 'offline_backlog') {
    return injectOfflineBacklog(state, config);
  }
  if (switchName === 'external_member_events') {
    return injectExternalMemberEvents(state, config);
  }
  return null;
}

export function registerTestPlane(app: FastifyInstance, state: GatewayState): void {
  // POST /_test/scenario { switch, params?, target? }：打开开关；重复调用 = 覆盖参数（DES/14 §4）
  app.post('/_test/scenario', async (request, reply) => {
    // 空 body 防 500：undefined.switch 会 TypeError；?? {} 让校验分支给出正确的 4xx
    const body = (request.body ?? {}) as { switch?: unknown; params?: unknown; target?: unknown };
    const switchName = body.switch;
    if (typeof switchName !== 'string' || !KNOWN_SWITCHES.includes(switchName)) {
      return reply
        .code(400)
        .send({ message: `unknown switch: ${JSON.stringify(switchName)} (see DES/14 section 5)` });
    }
    const config: SwitchConfig = {};
    if (body.params !== undefined) {
      if (typeof body.params !== 'object' || body.params === null) {
        return reply.code(400).send({ message: 'params must be an object' });
      }
      config.params = body.params as Record<string, unknown>;
    }
    if (body.target !== undefined) {
      if (typeof body.target !== 'object' || body.target === null) {
        return reply.code(400).send({ message: 'target must be an object' });
      }
      config.target = body.target as Record<string, unknown>;
    }
    const applyError = armSwitch(state, switchName, config);
    if (applyError !== null) {
      // arrange 期失败：开关不登记（半生效状态比拒绝更糟）
      return reply.code(400).send({ message: applyError });
    }
    state.switches.set(switchName, config);
    return reply.send({ ok: true });
  });

  // POST /_test/scenario/clear { switch? }：关闭指定/全部开关（DES/14 §4）。
  // clear 只撤销有状态标志（11/12 终态）；gw-5/gw-28 已注入的账本事件不撤回（账本 append-only）。
  app.post('/_test/scenario/clear', async (request, reply) => {
    const body = (request.body ?? {}) as { switch?: unknown };
    if (body.switch === undefined) {
      for (const [name, config] of state.switches) {
        applyAccountDomainSwitch(state, name, config, false);
      }
      state.switches.clear();
      return reply.send({ ok: true });
    }
    if (typeof body.switch !== 'string') {
      return reply.code(400).send({ message: 'switch must be a string' });
    }
    const config = state.switches.get(body.switch);
    if (config) {
      applyAccountDomainSwitch(state, body.switch, config, false);
      state.switches.delete(body.switch);
    }
    return reply.send({ ok: true });
  });

  // POST /_test/reset { startEventId? }：清业务状态+账本+计数器；
  // eventId 计数器不回退，startEventId 只抬高（DES/14 §1 关键坑）。
  app.post('/_test/reset', async (request, reply) => {
    const body = (request.body ?? {}) as { startEventId?: unknown };
    const startEventId =
      typeof body.startEventId === 'number' && Number.isInteger(body.startEventId)
        ? body.startEventId
        : undefined;
    const eventIdCounter = resetGatewayState(state, startEventId);
    return reply.send({ eventIdCounter });
  });

  // GET /_test/counters：验收断言的真值来源（DES/14 §4）。Map → 普通对象便于 JSON 断言。
  app.get('/_test/counters', async _request =>
    replyCounters(state),
  );

  // POST /_test/emit { type, data }：手动注入事件——只入账本，走正常 SSE 投放（DES/14 §4）。
  // eventId 由分配器指派并在 data 中补齐（SSE 帧契约：data 同时带 eventId 与 type）。
  app.post('/_test/emit', async (request, reply) => {
    const body = (request.body ?? {}) as { type?: unknown; data?: unknown };
    if (!isGatewayEventType(body.type)) {
      return reply.code(400).send({ message: 'type must be one of the six contract event types' });
    }
    if (body.data !== undefined && (typeof body.data !== 'object' || body.data === null)) {
      return reply.code(400).send({ message: 'data must be an object' });
    }
    const frame = appendLedger(state, body.type, (body.data ?? {}) as Record<string, unknown>);
    return reply.send(frame);
  });
}

function replyCounters(state: GatewayState): {
  sendCallsByAccount: Record<string, number>;
  sendCallsByClientMsgId: Record<string, number>;
  landedMessages: number;
  kickCalls: number;
  framesEmitted: number;
} {
  const sendCallsByAccount: Record<string, number> = {};
  for (const [accountId, count] of state.counters.sendCallsByAccount) {
    sendCallsByAccount[accountId] = count;
  }
  const sendCallsByClientMsgId: Record<string, number> = {};
  for (const [clientMsgId, count] of state.counters.sendCallsByClientMsgId) {
    sendCallsByClientMsgId[clientMsgId] = count;
  }
  return {
    sendCallsByAccount,
    sendCallsByClientMsgId,
    landedMessages: state.counters.landedMessages,
    kickCalls: state.counters.kickCalls,
    framesEmitted: state.counters.framesEmitted,
  };
}
