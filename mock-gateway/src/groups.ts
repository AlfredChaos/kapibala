// 群生命周期端点（T-P1-03）：create / invite / join / promote。
// 契约出处：REQ §2.1 群与成员节（字段名与响应形状逐字）；DES/14 §2（状态模型）、§3（时序引擎）。
// 时序默认区间随机、/_test/scenario 可钉死（任务卡 d 项；DES/14 §3）。
// kick / leave / send / members / by-client-id 归 T-P1-04，不在本文件。
import type { FastifyInstance } from 'fastify';
import { assertAccountOperationAllowed, assertConnectAllowed, type AccountGateError } from './accounts.js';
import { appendLedger, type GatewayState, type SwitchConfig } from './state.js';

// —— 契约时序（QR §1 / REQ §2.1）；mock 自己持有（mock 不依赖 server 的 constants.ts）——
/** join 受理后 member_joined 通常 100–1500ms 到达（REQ §2.1；QR §1） */
const MEMBER_JOINED_DELAY_MIN_MS = 100;
const MEMBER_JOINED_DELAY_MAX_MS = 1500;
/** invite 的 readyAfterMs「0 或数秒」（REQ §2.1）：数秒档的 mock 内部默认区间（非契约数字） */
const INVITE_READY_SLOW_MIN_MS = 2000;
const INVITE_READY_SLOW_MAX_MS = 5000;

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 开关是否命中：无 target = 全局；有 target 时，配置侧声明的每个 target 键都必须命中
 * （配置只写 groupId 时，带 accountId 的探查也算命中——「按群钉死」覆盖到该群全部账号）。
 * 返回命中的配置（含 params），供钉值读取。
 */
function activeSwitch(
  state: GatewayState,
  switchName: string,
  target?: { groupId?: string; accountId?: string },
): SwitchConfig | undefined {
  const config = state.switches.get(switchName);
  if (config === undefined) {
    return undefined;
  }
  if (target === undefined || config.target === undefined) {
    return config;
  }
  for (const [key, value] of Object.entries(config.target)) {
    const probed = key === 'groupId' ? target.groupId : key === 'accountId' ? target.accountId : undefined;
    if (probed !== value) {
      return undefined;
    }
  }
  return config;
}

function readNumberParam(config: SwitchConfig | undefined, key: string): number | undefined {
  const value = config?.params?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
    const pinnedReady = readNumberParam(activeSwitch(state, 'invite_not_ready', { groupId }), 'readyAfterMs');
    const readyAfterMs =
      pinnedReady ?? (Math.random() < 0.5 ? 0 : randomBetween(INVITE_READY_SLOW_MIN_MS, INVITE_READY_SLOW_MAX_MS));
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

    // 开关 21（invite_expired）按 DES/14 §5 是「join → 410」：join 时刻读开关，
    // 与 invite 创建时刻解耦（开关可能在 invite 之后才打开）
    if (activeSwitch(state, 'invite_expired', { groupId }) !== undefined) {
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
    if (group.members.has(account.platformUserId)) {
      // 已在群：409 且不再推 member_joined（REQ §2.1）
      return reply.code(409).send({ code: 'ALREADY_MEMBER', message: 'account already in group' });
    }

    // 202 受理；入群与事件按契约时序延后（钉值或区间随机），也可能永不到（gw-18）
    const joinTarget = { groupId, accountId: body.accountId };
    if (activeSwitch(state, 'member_joined_never', joinTarget) === undefined) {
      const pinnedDelay = readNumberParam(activeSwitch(state, 'member_joined_delay', joinTarget), 'delayMs');
      const delayMs = pinnedDelay ?? randomBetween(MEMBER_JOINED_DELAY_MIN_MS, MEMBER_JOINED_DELAY_MAX_MS);
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
    const promotee = state.accounts.get(body.accountId);
    if (promotee === undefined || !group.members.has(promotee.platformUserId)) {
      // 「对方 member_joined 之前」：不在网关成员集 = 事件未到（REQ §2.1）
      return reply.code(409).send({ code: 'NOT_MEMBER_YET', message: 'target member_joined has not arrived' });
    }
    group.promoted.add(promotee.platformUserId);
    return reply.send({});
  });
}
