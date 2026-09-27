// send / kick / leave / members / by-client-id（T-P1-04）。
// 契约出处：REQ §2.1 发消息节 + 群与成员节；DES/14 §2（消息按 clientMsgId 有序列表，不去重）、
// §3（时序引擎：默认区间随机、scenario 钉值）、§5 注（message 全量回流是默认行为，S3 非开关）。
import type { FastifyInstance } from 'fastify';
import { assertAccountOperationAllowed, type AccountGateError } from './accounts.js';
import { appendLedger, type GatewayState, type MockMessageRecord } from './state.js';
import { activeSwitch, readBooleanParam, readNumberParam, readStringParam } from './switches.js';
import { randomBetween, resolveMessageSentDelayMs, resolveSendAcceptDelayMs } from './switches/basic.js';

// —— 契约时序（QR §1 / REQ §2.1）；mock 自持（不依赖 server 的 constants.ts）——
// send 202（gw-1）与 message_sent（gw-2）的钉值/区间解析归 switches/basic.ts（T-P1-05）。
/** kick 响应可能 1–5s（REQ §2.1；QR §1） */
const KICK_LATENCY_MIN_MS = 1000;
const KICK_LATENCY_MAX_MS = 5000;
/** send_504_land_1500 的固定落地时延（DES/14 §3：S5 编排为 1.5s；契约 2s 内落地） */
const SEND504_LAND_MS = 1500;

function sendGateError(reply: { code: (s: number) => { send: (b: unknown) => unknown } }, gate: AccountGateError) {
  reply.code(gate.statusCode).send(gate.body);
}

/** 契约时序延时（send 202 的 1–2s / kick 的 1–5s）：await 占住请求，到点再回 */
function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

interface SendBody {
  accountId?: unknown;
  clientMsgId?: unknown;
  text?: unknown;
}

export function registerMessagingRoutes(app: FastifyInstance, state: GatewayState): void {
  // POST /groups/:groupId/send {accountId, clientMsgId, text} → 202 {accepted:true}（REQ §2.1）
  // 检查顺序（对外可观测）：群 404 → 账号闸门(终态/离线) → 429 限流(重置计时) → 504 两态
  // → 403 群不可写 → 403 发送者不在群 → 受理。
  app.post('/groups/:groupId/send', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const body = (request.body ?? {}) as SendBody;
    if (typeof body.accountId !== 'string' || typeof body.clientMsgId !== 'string' || typeof body.text !== 'string') {
      return reply.code(400).send({ message: 'accountId, clientMsgId and text are required' });
    }
    const { accountId, clientMsgId, text } = body;

    // counters 是验收真值（DES/14 §4）：进入 send 即计（含将失败的尝试）
    state.counters.sendCallsByAccount.set(accountId, (state.counters.sendCallsByAccount.get(accountId) ?? 0) + 1);
    state.counters.sendCallsByClientMsgId.set(
      clientMsgId,
      (state.counters.sendCallsByClientMsgId.get(clientMsgId) ?? 0) + 1,
    );

    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    const gate = assertAccountOperationAllowed(state, accountId);
    if (gate) {
      return sendGateError(reply, gate);
    }
    const account = state.accounts.get(accountId);
    if (account === undefined) {
      return reply.code(400).send({ message: `unknown account: ${accountId}` });
    }

    // 429 RATE_LIMITED（开关 6）：期内任何 send 再 429 且计时重置（REQ §2.1）
    const rateConfig = activeSwitch(state, 'rate_limit', { accountId });
    const now = Date.now();
    if (rateConfig !== undefined || (account.rateLimitedUntil ?? 0) > now) {
      const retryAfterSeconds = readNumberParam(rateConfig, 'retryAfterSeconds') ?? 30;
      account.rateLimitedUntil = now + retryAfterSeconds * 1000; // 计时重置
      return reply.code(429).send({
        code: 'RATE_LIMITED',
        message: 'account is rate limited',
        retryAfterSeconds,
      });
    }

    const sendTarget = { groupId, accountId, clientMsgId };

    // 504 NETWORK_TIMEOUT 两态（开关 7/8，DES/14 §5）
    if (activeSwitch(state, 'send_504_not_sent', sendTarget) !== undefined) {
      return reply.code(504).send({ code: 'NETWORK_TIMEOUT', message: 'send result unknown' });
    }
    const landConfig = activeSwitch(state, 'send_504_land_1500', sendTarget);
    if (landConfig !== undefined) {
      // 504 但已被接收：契约 2s 内落地并推 message_sent（S5 编排 1.5s）
      setTimeout(() => {
        landMessage(state, groupId, account.platformUserId, clientMsgId, text);
      }, SEND504_LAND_MS).unref();
      return reply.code(504).send({ code: 'NETWORK_TIMEOUT', message: 'send result unknown' });
    }

    // 403 群不可写（开关 14：解散/禁言，按群注入）
    if (activeSwitch(state, 'group_write_forbidden', { groupId }) !== undefined) {
      return reply.code(403).send({ code: 'GROUP_WRITE_FORBIDDEN', message: 'group is not writable' });
    }
    // 403 发送者不在群：自然语义 + 开关 16 强制注入
    if (!group.members.has(account.platformUserId) || activeSwitch(state, 'sender_not_in_group', sendTarget)) {
      return reply.code(403).send({ code: 'SENDER_NOT_IN_GROUP', message: 'sender is not in this group' });
    }

    // 受理：202 本身可能 1–2s（gw-1 钉值或区间随机）；message_sent 在 202 之后再计时（gw-2）
    const acceptDelay = resolveSendAcceptDelayMs(state, sendTarget);
    const senderPuid = account.platformUserId;
    const failureCode = readStringParam(activeSwitch(state, 'message_failed_event', sendTarget), 'code');
    const landDelay = resolveMessageSentDelayMs(state, sendTarget);
    // 两段独立计时（DES/14 §3）：先 await 慢回 202（占住请求），落地在 202 后 landDelay
    await waitMs(acceptDelay);
    reply.code(202).send({ accepted: true });
    setTimeout(() => {
      if (failureCode === 'GROUP_WRITE_FORBIDDEN' || failureCode === 'ACCOUNT_SUSPENDED') {
        // message_failed 两闭集码（REQ §2.1）；不落地、不推 message
        appendLedger(state, 'message_failed', { clientMsgId, code: failureCode });
        return;
      }
      landMessage(state, groupId, senderPuid, clientMsgId, text);
    }, landDelay).unref();
  });

  // GET /groups/:groupId/messages/by-client-id/:clientMsgId → 200 {msgId, sentAt} 最早一条 / 404（REQ §2.1）
  app.get('/groups/:groupId/messages/by-client-id/:clientMsgId', async (request, reply) => {
    const { groupId, clientMsgId } = request.params as { groupId: string; clientMsgId: string };
    if (!state.groups.has(groupId)) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    // 网关不按 clientMsgId 去重：同 id 多条各占一项，返回最早落地的一条（DES/14 §2 R-F）
    const rows = state.messages.get(clientMsgId);
    const earliest = rows?.find((row) => row.groupId === groupId && row.landed);
    if (earliest === undefined) {
      return reply.code(404).send({ message: 'message not found' });
    }
    return reply.send({ msgId: earliest.msgId, sentAt: earliest.sentAt });
  });

  // POST /groups/:groupId/kick {byAccountId, targetPlatformUserId} → 200 {kicked:true}（REQ §2.1）
  // 目标在 200 返回前已从成员列表移除，随后推 member_left；响应可能 1–5s；504 后 2s 内收敛。
  app.post('/groups/:groupId/kick', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const body = (request.body ?? {}) as { byAccountId?: unknown; targetPlatformUserId?: unknown };
    if (typeof body.byAccountId !== 'string' || typeof body.targetPlatformUserId !== 'string') {
      return reply.code(400).send({ message: 'byAccountId and targetPlatformUserId are required' });
    }
    state.counters.kickCalls += 1;

    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    const gate = assertAccountOperationAllowed(state, body.byAccountId);
    if (gate) {
      return sendGateError(reply, gate);
    }
    const byAccount = state.accounts.get(body.byAccountId);
    if (byAccount === undefined) {
      return reply.code(400).send({ message: `unknown account: ${body.byAccountId}` });
    }

    // 开关 25 强制注入（DES/14 §5）；自然语义：群主已退群 → 409；非群主且未被 promote → 403
    const kickTarget = { groupId, accountId: body.byAccountId };
    if (activeSwitch(state, 'owner_left_on_kick', kickTarget) !== undefined || !group.members.has(group.creator)) {
      return reply.code(409).send({ code: 'OWNER_LEFT', message: 'group owner has left' });
    }
    const isOwner = byAccount.platformUserId === group.creator;
    const isPromoted = group.promoted.has(byAccount.platformUserId);
    if (
      activeSwitch(state, 'kick_no_permission', kickTarget) !== undefined ||
      (!isOwner && !isPromoted)
    ) {
      return reply.code(403).send({ code: 'NO_PERMISSION', message: 'kick requires owner or promoted admin' });
    }

    const targetPuid = body.targetPlatformUserId;
    const timeoutConfig = activeSwitch(state, 'kick_504', kickTarget);
    // 响应延迟：kick_slow 钉值 / kick_504 自带钉值（504 也可能慢回）/ 契约区间随机
    const delay =
      readNumberParam(activeSwitch(state, 'kick_slow', kickTarget), 'delayMs') ??
      readNumberParam(timeoutConfig, 'delayMs') ??
      randomBetween(KICK_LATENCY_MIN_MS, KICK_LATENCY_MAX_MS);
    // 响应在延迟后发出（契约 1–5s）：await 占住请求；成员移除发生在 200 返回之前
    await waitMs(delay);
    const liveGroup = state.groups.get(groupId); // 落定时刻重查（reset/删除后不写陈旧对象）
    // 504 分支：结果未知，但成员列表 2s 内收敛到真值（kicked 独立可配，DES/14 §3）
    const kicked = timeoutConfig === undefined ? true : readBooleanParam(timeoutConfig, 'kicked', true);
    const removed = liveGroup !== undefined && kicked && liveGroup.members.delete(targetPuid);
    if (timeoutConfig !== undefined) {
      reply.code(504).send({ code: 'NETWORK_TIMEOUT', message: 'kick result unknown' });
    } else {
      reply.send({ kicked: true });
    }
    if (removed) {
      appendLedger(state, 'member_left', { groupId, platformUserId: targetPuid }); // 随后推出
    }
  });

  // POST /groups/:groupId/leave {accountId} → 200 / 500（REQ §2.1）
  // 200：成员移除 + member_left；500：没退成（成员保留，无事件）。
  app.post('/groups/:groupId/leave', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const body = (request.body ?? {}) as { accountId?: unknown };
    if (typeof body.accountId !== 'string') {
      return reply.code(400).send({ message: 'accountId is required' });
    }
    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    const gate = assertAccountOperationAllowed(state, body.accountId);
    if (gate) {
      return sendGateError(reply, gate);
    }
    const account = state.accounts.get(body.accountId);
    if (account === undefined) {
      return reply.code(400).send({ message: `unknown account: ${body.accountId}` });
    }
    if (activeSwitch(state, 'leave_500', { groupId, accountId: body.accountId }) !== undefined) {
      return reply.code(500).send({ message: 'leave failed' });
    }
    if (group.members.delete(account.platformUserId)) {
      appendLedger(state, 'member_left', { groupId, platformUserId: account.platformUserId });
    }
    return reply.send({});
  });

  // GET /groups/:groupId/members → [{platformUserId}]（REQ §2.1：网关视角当前成员）
  app.get('/groups/:groupId/members', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    return reply.send([...group.members].map((platformUserId) => ({ platformUserId })));
  });
}

/** 落地一条消息：分配 msgId/sentAt、入有序列表、推 message_sent + message（全量回流，S3） */
function landMessage(
  state: GatewayState,
  groupId: string,
  senderPuid: string,
  clientMsgId: string,
  text: string,
): void {
  if (!state.groups.has(groupId)) {
    return; // 受理与落地之间群已消失（reset/删除）：不落地不推帧
  }
  const msgId = `m-${++state.msgSeq}`;
  const sentAt = new Date().toISOString(); // 毫秒精度；同一毫秒可能多条（REQ §2.1）
  const row: MockMessageRecord = { groupId, senderPuid, msgId, text, sentAt, landed: true };
  const rows = state.messages.get(clientMsgId);
  if (rows === undefined) {
    state.messages.set(clientMsgId, [row]);
  } else {
    rows.push(row); // 不去重：同 clientMsgId 两条是两条落地记录（DES/14 §2）
  }
  state.counters.landedMessages += 1;
  appendLedger(state, 'message_sent', { clientMsgId, msgId, sentAt });
  // 网关不区分消息来自谁：自己的消息同样推 message（S3 默认行为，非开关——DES/14 §5 注）
  appendLedger(state, 'message', { groupId, msgId, senderPlatformUserId: senderPuid, text, sentAt });
}
