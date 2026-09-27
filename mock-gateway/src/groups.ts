// 群生命周期端点（T-P1-03）：create / invite / join / promote。
// 契约出处：REQ §2.1 群与成员节（字段名与响应形状逐字）；DES/14 §2（状态模型）、§3（时序引擎）。
// 时序默认区间随机、/_test/scenario 可钉死（任务卡 d 项；DES/14 §3）。
// 开关判定归 switches/*：member_joined 延迟（gw-19）→ timing.ts；建群类（gw-18/20/21/22/23）→ group-lifecycle.ts。
// kick / leave / send / members / by-client-id 归 T-P1-04，不在本文件。
import type { FastifyInstance } from 'fastify';
import { assertAccountOperationAllowed, assertConnectAllowed, type AccountGateError } from './accounts.js';
import { appendLedger, type GatewayState } from './state.js';
import {
  consumePromoteNotMemberYet,
  isAlreadyMemberForced,
  isInviteExpired,
  isMemberJoinedNever,
  resolveInviteReadyAfterMs,
} from './switches/group-lifecycle.js';
import { resolveMemberJoinedDelayMs } from './switches/timing.js';

function sendGateError(reply: { code: (s: number) => { send: (b: unknown) => unknown } }, gate: AccountGateError) {
  reply.code(gate.statusCode).send(gate.body);
}

export function registerGroupRoutes(app: FastifyInstance, state: GatewayState): void {
  // POST /groups {creatorAccountId} → {groupId}（REQ §2.1）
  // 创建者即群主、响应返回时即为成员、不为它推 member_joined。
  app.post('/groups', async (request, reply) => {
    const body = (request.body ?? {}) as { creatorAccountId?: unknown };
    if (typeof body.creatorAccountId !== 'string' || body.creatorAccountId === '') {
      return reply.code(400).send({ message: 'creatorAccountId is required' });
    }
    // 终态闸门：「之后该账号的所有请求」含建群（REQ §2.1）；离线不拦（契约未定义，server 侧自防）
    const gate = assertConnectAllowed(state, body.creatorAccountId);
    if (gate) {
      return sendGateError(reply, gate);
    }
    const account = state.accounts.get(body.creatorAccountId);
    if (account === undefined) {
      return reply.code(400).send({ message: `unknown creator account: ${body.creatorAccountId}` });
    }
    const groupId = `gw-${++state.gwSeq}`;
    state.groups.set(groupId, {
      creator: account.platformUserId,
      members: new Set([account.platformUserId]),
      writeForbidden: false,
      promoted: new Set(),
    });
    return reply.send({ groupId });
  });

  // POST /groups/:groupId/invite → {inviteLink, readyAfterMs}（REQ §2.1）
  // readyAfterMs 0 或数秒；链接任意时刻可过期（过期由 invite_expired 开关在 join 时刻注入）。
  app.post('/groups/:groupId/invite', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    // gw-20 `invite_not_ready`：钉值优先，否则契约的「可能是 0，也可能几秒」（REQ §2.1）
    const readyAfterMs = resolveInviteReadyAfterMs(state, groupId);
    const link = `inv-${groupId}-${++state.msgSeq}`;
    group.invite = { link, readyAt: Date.now() + readyAfterMs };
    return reply.send({ inviteLink: link, readyAfterMs });
  });

  // POST /groups/:groupId/join {accountId, inviteLink} → 202 {accepted:true}（REQ §2.1）
  // 真正入群以随后的 member_joined 事件为准（100–1500ms，或永不到——此时账号并未入群）。
  app.post('/groups/:groupId/join', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const body = (request.body ?? {}) as { accountId?: unknown; inviteLink?: unknown };
    if (typeof body.accountId !== 'string' || typeof body.inviteLink !== 'string') {
      return reply.code(400).send({ message: 'accountId and inviteLink are required' });
    }
    // 资源层级先于账号闸门：群不存在时无从谈成员资格（与 invite 一致）
    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    // 共享闸门：终态 → 403/401；离线 → 409 ACCOUNT_OFFLINE（REQ §2.1 五操作含 join）
    const gate = assertAccountOperationAllowed(state, body.accountId);
    if (gate) {
      return sendGateError(reply, gate);
    }
    const account = state.accounts.get(body.accountId);
    if (account === undefined) {
      return reply.code(400).send({ message: `unknown account: ${body.accountId}` });
    }

    // gw-21 `invite_expired`：按 DES/14 §5 是「join → 410」——join 时刻读开关，与 invite 创建时刻解耦
    // （链接任意时刻可能过期，开关也可能在 invite 之后才打开；QR §2：重新申请链接，重试一次）
    if (isInviteExpired(state, groupId)) {
      return reply.code(410).send({ code: 'INVITE_EXPIRED', message: 'invite link expired' });
    }
    const invite = group.invite;
    if (invite === undefined || invite.link !== body.inviteLink) {
      return reply.code(410).send({ code: 'INVITE_EXPIRED', message: 'invite link is invalid' });
    }
    const remainingReadyMs = invite.readyAt - Date.now();
    if (remainingReadyMs > 0) {
      return reply.code(409).send({
        code: 'INVITE_NOT_READY',
        message: 'invite not ready yet',
        readyAfterMs: remainingReadyMs,
      });
    }
    const joinTarget = { groupId, accountId: body.accountId };
    if (group.members.has(account.platformUserId) || isAlreadyMemberForced(state, joinTarget)) {
      // 已在群（自然）或 gw-22 强制「视为已在群」：409 且**不推** member_joined（REQ §2.1 明文；
      // server 侧 D2-2 的成员行 UPSERT 依赖这条）。强制路径补齐成员集——QR §2「视为成功，直接 promote」
      // 要求随后的 promote 能成，mock 状态不能自相矛盾（已在群时 add 是幂等无操作）。
      group.members.add(account.platformUserId);
      return reply.code(409).send({ code: 'ALREADY_MEMBER', message: 'account already in group' });
    }

    // 202 受理；入群与事件按契约时序延后（钉值或区间随机），也可能永不到（gw-18：此时账号并未入群）
    if (!isMemberJoinedNever(state, joinTarget)) {
      const delayMs = resolveMemberJoinedDelayMs(state, joinTarget);
      const puid = account.platformUserId;
      setTimeout(() => {
        // 事件时刻才真正入群；群已消失（reset/删除）或已重复入群则跳过
        const live = state.groups.get(groupId);
        if (live === undefined || live.members.has(puid)) {
          return;
        }
        live.members.add(puid);
        appendLedger(state, 'member_joined', { groupId, platformUserId: puid });
      }, delayMs).unref();
    }
    return reply.code(202).send({ accepted: true });
  });

  // POST /groups/:groupId/promote {byAccountId, accountId} → 200 {}（REQ §2.1）
  // byAccountId 必须是群主（创建者），否则 403 NO_PERMISSION；
  // 对方 member_joined 之前 → 409 NOT_MEMBER_YET；成功不推事件，记录 promoted（kick 语义用，T-P1-04）。
  app.post('/groups/:groupId/promote', async (request, reply) => {
    const { groupId } = request.params as { groupId: string };
    const body = (request.body ?? {}) as { byAccountId?: unknown; accountId?: unknown };
    if (typeof body.byAccountId !== 'string' || typeof body.accountId !== 'string') {
      return reply.code(400).send({ message: 'byAccountId and accountId are required' });
    }
    const group = state.groups.get(groupId);
    if (group === undefined) {
      return reply.code(404).send({ message: `unknown group: ${groupId}` });
    }
    const gate = assertAccountOperationAllowed(state, body.byAccountId);
    if (gate) {
      return sendGateError(reply, gate);
    }
    const byAccount = state.accounts.get(body.byAccountId);
    if (byAccount === undefined || byAccount.platformUserId !== group.creator) {
      return reply.code(403).send({ code: 'NO_PERMISSION', message: 'promote requires the group owner' });
    }
    // gw-23 `promote_not_member_yet`：前 N 次调用强制 409（驱动 server 的「重试、总调用 ≤2」，QR §2）；
    // 配额用尽后落到自然判定——「对方 member_joined 之前」：不在网关成员集 = 事件未到（REQ §2.1）
    const promotee = state.accounts.get(body.accountId);
    if (
      consumePromoteNotMemberYet(state, { groupId, accountId: body.accountId }) ||
      promotee === undefined ||
      !group.members.has(promotee.platformUserId)
    ) {
      return reply.code(409).send({ code: 'NOT_MEMBER_YET', message: 'target member_joined has not arrived' });
    }
    group.promoted.add(promotee.platformUserId);
    return reply.send({});
  });
}
