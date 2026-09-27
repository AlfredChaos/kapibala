// 出站类开关测试 gw-6..10 / 14..17 / 27（T-P3-09 c 项，先红后绿）。
// 契约出处：REQ §2.1「发消息」节同步错误表（429 计时重置 / 504 两态 / 403 三码 / 409 离线）、
// 「任何端点（包括 by-client-id 查询）都可能整体不可用（503）」、「账号进入这两种状态后，网关会自动把它
// 移出所有群并推 member_left」、mediaUrl（GET /media/:id 返回字节、过期 404）；DES/14 §5 行 6–17/27、§3。
// 说明（真实定时器例外）：gw-7 的「504 后 2s 内落地」与 gw-8 的「超过 2s 仍 404」是契约数字，必须真定时器实测。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { GatewayApp } from '../src/app.js';
import {
  byClientId,
  clearScenario,
  countersOf,
  createGroup,
  createInvite,
  framesOf,
  joinGroup,
  lastFrame,
  makeGroupWithMember,
  membersOf,
  newApp,
  postScenario,
  puidOf,
  scenario,
  send,
  singleFrame,
  withListening,
} from './helpers/gateway.js';

/** send 的两段时序钉 0：本文件多数用例只看状态码/帧，不看契约区间（区间断言在 switches-basic） */
async function pinFastLanding(app: GatewayApp): Promise<void> {
  await scenario(app, 'send_accept_slow', { delayMs: 0 });
  await scenario(app, 'message_sent_delay', { delayMs: 0 });
}

/** 第二个群（acc-01 建群 + acc-02 入群）：「按群收窄」与「移出所有群」断言用 */
async function makeSecondGroup(app: GatewayApp): Promise<string> {
  const groupId = await createGroup(app, 'acc-01');
  await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
  const inviteLink = await createInvite(app, groupId);
  await scenario(app, 'member_joined_delay', { delayMs: 20 }, { groupId });
  expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(202);
  await sleep(100);
  return groupId;
}

describe('gw-6 rate_limit：429 + 期内任何 send 再 429 且计时重置（REQ §2.1 逐字）', () => {
  it('首次 send → 429 {retryAfterSeconds:N}；窗口内再 send → 同样 N 且窗口后移；到期自动恢复 202', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    await scenario(app, 'rate_limit', { retryAfterSeconds: 1 }, { accountId: 'acc-02' });

    const first = await send(app, groupId, 'acc-02', 'c-rl-1');
    expect(first.statusCode).toBe(429);
    expect(await first.json()).toEqual({
      code: 'RATE_LIMITED',
      message: 'account is rate limited',
      retryAfterSeconds: 1,
    });
    const untilAfterFirst = app.gatewayState.accounts.get('acc-02')?.rateLimitedUntil ?? 0;

    await sleep(60);
    const second = await send(app, groupId, 'acc-02', 'c-rl-2');
    expect(second.statusCode).toBe(429);
    // 「再次得到同样的错误」：retryAfterSeconds 数值不变（不是剩余时间、也不重新随机）
    expect(await second.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 1 });
    // 「并且计时重置」：窗口起点后移（一次试探就把等待期续满——server 侧零试探的反面教材）
    const untilAfterSecond = app.gatewayState.accounts.get('acc-02')?.rateLimitedUntil ?? 0;
    expect(untilAfterSecond).toBeGreaterThan(untilAfterFirst);
    // 被拒的尝试照计调用（S4「限流期内 sendCallsByAccount = 0」的断言真值基础）
    expect((await countersOf(app)).sendCallsByAccount).toEqual({ 'acc-02': 2 });
    expect((await countersOf(app)).landedMessages).toBe(0);

    // 到期自动恢复：窗口过了（开关仍 arm 也不再命中？不——开关命中恒 429，故先 clear 再看窗口自然到期）
    await clearScenario(app, 'rate_limit');
    await sleep(1100);
    expect((await send(app, groupId, 'acc-02', 'c-rl-3')).statusCode).toBe(202);
  });

  it('clear 后窗口仍在：仍 429 且复用首次的 retryAfterSeconds（不漂到默认值）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'rate_limit', { retryAfterSeconds: 7 }, { accountId: 'acc-02' });
    expect((await send(app, groupId, 'acc-02', 'c-a')).statusCode).toBe(429);

    await clearScenario(app, 'rate_limit');
    const probe = await send(app, groupId, 'acc-02', 'c-b');
    expect(probe.statusCode).toBe(429); // 契约不依赖开关存活：窗口内就是 429
    expect(await probe.json()).toMatchObject({ retryAfterSeconds: 7 }); // 未漂到默认 30

    // 未钉值时的默认等待秒数（mock 自持；契约只要求给出 retryAfterSeconds）
    await scenario(app, 'rate_limit', undefined, { accountId: 'acc-01' });
    const defaulted = await send(app, groupId, 'acc-01', 'c-default');
    expect(defaulted.statusCode).toBe(429);
    expect(await defaulted.json()).toMatchObject({ retryAfterSeconds: 30 });
  });
});

describe('gw-7/gw-8 504 两态（REQ §2.1：2s 内落地 / 超过 2s 仍 404 = 确定未发出）', () => {
  it('gw-7 send_504_land_1500：504 → 恰 1.5s 后落地并推 message_sent（<2s 契约上界），by-client-id 404→200', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_504_land_1500', undefined, { clientMsgId: 'c-504' });

    const started = Date.now();
    const res = await send(app, groupId, 'acc-02', 'c-504');
    expect(res.statusCode).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'NETWORK_TIMEOUT' });
    expect((await byClientId(app, groupId, 'c-504')).statusCode).toBe(404); // 尚未落地

    await sleep(1700);
    const sent = singleFrame(framesOf(app, 'message_sent'), 'message_sent');
    const landedAfterMs = sent.emittedAt - started;
    expect(landedAfterMs).toBeGreaterThanOrEqual(1500); // S5 编排的 1.5s（DES/14 §3）
    expect(landedAfterMs).toBeLessThan(2000); // 契约上界：504 时已被接收 → 2 秒内落地
    expect((await byClientId(app, groupId, 'c-504')).statusCode).toBe(200);
    expect((await countersOf(app)).landedMessages).toBe(1);
  });

  it('gw-8 send_504_not_sent：504 且确实未发出——超过 2s 仍 404、零帧、零落地', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_504_not_sent', undefined, { clientMsgId: 'c-ns' });

    const res = await send(app, groupId, 'acc-02', 'c-ns');
    expect(res.statusCode).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'NETWORK_TIMEOUT' });

    await sleep(2100); // 契约：504 之后超过 2 秒仍是 404，即可确定没有发出
    expect((await byClientId(app, groupId, 'c-ns')).statusCode).toBe(404);
    expect(framesOf(app, 'message_sent')).toHaveLength(0);
    expect(framesOf(app, 'message')).toHaveLength(0);
    expect((await countersOf(app)).landedMessages).toBe(0);
  });
});

describe('gw-9 by_client_id_503 / gw-10 gateway_503_all（REQ §2.1：任何端点都可能整体不可用）', () => {
  it('gw-9：by-client-id → 503 UNAVAILABLE，只影响该端点（send 照常 202）；durationMs 到期自动恢复', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    expect((await send(app, groupId, 'acc-02', 'c-9')).statusCode).toBe(202);
    await sleep(60);
    expect((await byClientId(app, groupId, 'c-9')).statusCode).toBe(200);

    await scenario(app, 'by_client_id_503', { durationMs: 80 }, { groupId });
    const outage = await byClientId(app, groupId, 'c-9');
    expect(outage.statusCode).toBe(503);
    expect(await outage.json()).toEqual({ code: 'UNAVAILABLE', message: 'gateway is unavailable' });
    expect((await send(app, groupId, 'acc-02', 'c-9b')).statusCode).toBe(202); // 其它端点不受影响

    await sleep(150);
    expect((await byClientId(app, groupId, 'c-9')).statusCode).toBe(200); // 恢复时刻到 → 自动恢复
  });

  it('gw-9 untilMs 配方：绝对恢复时刻之前恒 503、之后恢复 200', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    expect((await send(app, groupId, 'acc-02', 'c-u')).statusCode).toBe(202);
    await sleep(60);

    await scenario(app, 'by_client_id_503', { untilMs: Date.now() + 100 });
    expect((await byClientId(app, groupId, 'c-u')).statusCode).toBe(503);
    await sleep(50);
    expect((await byClientId(app, groupId, 'c-u')).statusCode).toBe(503); // 仍在不可用窗口
    await sleep(120);
    expect((await byClientId(app, groupId, 'c-u')).statusCode).toBe(200);
  });

  it('gw-10：所有业务端点 503（send/kick/members/connect/by-client-id），/_test 控制平面豁免，clear 后恢复', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    await scenario(app, 'gateway_503_all');

    const rejected = await send(app, groupId, 'acc-02', 'c-10');
    expect(rejected.statusCode).toBe(503);
    expect(await rejected.json()).toEqual({ code: 'UNAVAILABLE', message: 'gateway is unavailable' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/groups/${groupId}/kick`,
          payload: { byAccountId: 'acc-01', targetPlatformUserId: puidOf(app, 'acc-02') },
        })
      ).statusCode,
    ).toBe(503);
    expect((await app.inject({ method: 'GET', url: `/groups/${groupId}/members` })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/accounts/acc-01/connect' })).statusCode).toBe(503);
    expect((await byClientId(app, groupId, 'c-10')).statusCode).toBe(503);

    // 控制平面豁免（否则开关关不掉）；且 503 在业务处理之前拦截 → 调用未被受理、不计入 counters
    const counters = await countersOf(app);
    expect(counters.sendCallsByAccount).toEqual({});
    expect(counters.kickCalls).toBe(0);

    await clearScenario(app, 'gateway_503_all');
    expect((await send(app, groupId, 'acc-02', 'c-10b')).statusCode).toBe(202);
    expect((await countersOf(app)).sendCallsByAccount).toEqual({ 'acc-02': 1 });
  });

  it('gw-10 也覆盖 SSE 端点：/events → 503（不是事件流）', async () => {
    const app = newApp();
    await scenario(app, 'gateway_503_all');
    await withListening(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/events?since=0`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: 'UNAVAILABLE', message: 'gateway is unavailable' });
    });
  });
});

describe('gw-13 account_status_event：推 account_status + 自动移出所有群并逐群推 member_left（REQ §2.1）', () => {
  it('两群成员 → account_status 一帧在前、每群一帧 member_left；成员列表移除；此后所有请求回同码', async () => {
    const app = newApp();
    const g1 = await makeGroupWithMember(app);
    const g2 = await makeSecondGroup(app);
    await pinFastLanding(app);
    const puid = puidOf(app, 'acc-02');
    expect(await membersOf(app, g1)).toContain(puid);
    expect(await membersOf(app, g2)).toContain(puid);

    await scenario(app, 'account_status_event', { status: 'suspended' }, { accountId: 'acc-02' });

    const status = lastFrame(app, 'account_status');
    expect(status.data).toMatchObject({ accountId: 'acc-02', status: 'suspended' });
    const lefts = framesOf(app, 'member_left');
    expect(lefts.map((frame) => frame.data['groupId'])).toEqual([g1, g2]); // 逐群推
    expect(lefts.every((frame) => frame.data['platformUserId'] === puid)).toBe(true);
    expect(status.eventId).toBeLessThan(lefts[0]?.eventId ?? 0); // 先 account_status 后 member_left
    expect(await membersOf(app, g1)).not.toContain(puid);
    expect(await membersOf(app, g2)).not.toContain(puid);

    // 终态生效：此后该账号所有请求（含 connect）回同码；群主不受影响
    expect((await app.inject({ method: 'POST', url: '/accounts/acc-02/connect' })).statusCode).toBe(403);
    const denied = await send(app, g1, 'acc-02', 'c-term');
    expect(denied.statusCode).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    expect((await send(app, g1, 'acc-01', 'c-owner')).statusCode).toBe(202);
  });

  it('status=session_expired → 401；clear 撤终态标志（已推事件与移出群不撤回）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'account_status_event', { status: 'session_expired' }, { accountId: 'acc-02' });

    expect(lastFrame(app, 'account_status').data).toMatchObject({ accountId: 'acc-02', status: 'session_expired' });
    expect((await app.inject({ method: 'POST', url: '/accounts/acc-02/connect' })).statusCode).toBe(401);

    await clearScenario(app, 'account_status_event');
    expect((await app.inject({ method: 'POST', url: '/accounts/acc-02/connect' })).statusCode).toBe(200);
    // 移出群是既成事实：clear 不把它塞回群，也不追删已推的 member_left
    expect(await membersOf(app, groupId)).not.toContain(puidOf(app, 'acc-02'));
    expect(framesOf(app, 'member_left')).toHaveLength(1);
  });

  it('arrange 失败面：缺 target.accountId / 未知账号 / 缺 status / status 非闭集 → 400、不登记、不推帧', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    expect((await postScenario(app, 'account_status_event', { status: 'suspended' })).statusCode).toBe(400);
    expect(
      (await postScenario(app, 'account_status_event', { status: 'suspended' }, { accountId: 'acc-nope' })).statusCode,
    ).toBe(400);
    expect((await postScenario(app, 'account_status_event', undefined, { accountId: 'acc-02' })).statusCode).toBe(400);
    expect(
      (await postScenario(app, 'account_status_event', { status: 'banned' }, { accountId: 'acc-02' })).statusCode,
    ).toBe(400);
    expect(app.gatewayState.switches.has('account_status_event')).toBe(false);
    expect(framesOf(app, 'account_status')).toHaveLength(0);
    expect(await membersOf(app, groupId)).toContain(puidOf(app, 'acc-02')); // 未被误移出群
  });
});

describe('gw-14/15/16：send 的 403 三态与 message_failed（REQ §2.1 同步错误表）', () => {
  it('gw-14：403 GROUP_WRITE_FORBIDDEN + 置 writeForbidden；按群收窄（另一群照常 202）；clear 复位', async () => {
    const app = newApp();
    const g1 = await makeGroupWithMember(app);
    const g2 = await makeSecondGroup(app);
    await pinFastLanding(app);

    await scenario(app, 'group_write_forbidden', undefined, { groupId: g1 });
    const forbidden = await send(app, g1, 'acc-02', 'c-wf');
    expect(forbidden.statusCode).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'GROUP_WRITE_FORBIDDEN' });
    expect(app.gatewayState.groups.get(g1)?.writeForbidden).toBe(true); // DES/14 §2 状态位
    expect((await send(app, g2, 'acc-02', 'c-wf2')).statusCode).toBe(202); // 与账号无关、只作用于该群

    await clearScenario(app, 'group_write_forbidden');
    expect(app.gatewayState.groups.get(g1)?.writeForbidden).toBe(false);
    expect((await send(app, g1, 'acc-02', 'c-wf3')).statusCode).toBe(202);
  });

  it('gw-15：202 后推 message_failed {clientMsgId, code}，不落地、不推 message、by-client-id 404', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    await scenario(app, 'message_failed_event', { code: 'ACCOUNT_SUSPENDED' }, { groupId });

    expect((await send(app, groupId, 'acc-02', 'c-fail')).statusCode).toBe(202);
    await sleep(80);
    const failed = singleFrame(framesOf(app, 'message_failed'), 'message_failed');
    expect(failed.data).toMatchObject({ clientMsgId: 'c-fail', code: 'ACCOUNT_SUSPENDED' });
    expect(framesOf(app, 'message_sent')).toHaveLength(0);
    expect(framesOf(app, 'message')).toHaveLength(0);
    expect((await byClientId(app, groupId, 'c-fail')).statusCode).toBe(404);
    expect((await countersOf(app)).landedMessages).toBe(0);
  });

  it('gw-15 arrange 校验：缺 params.code 或不在两码闭集 → 400 且不登记（静默忽略会让用例假绿）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    expect((await postScenario(app, 'message_failed_event', undefined, { groupId })).statusCode).toBe(400);
    expect((await postScenario(app, 'message_failed_event', { code: 'BOGUS' }, { groupId })).statusCode).toBe(400);
    expect(app.gatewayState.switches.has('message_failed_event')).toBe(false);

    expect(
      (await postScenario(app, 'message_failed_event', { code: 'GROUP_WRITE_FORBIDDEN' }, { groupId })).statusCode,
    ).toBe(200);
    expect(app.gatewayState.switches.get('message_failed_event')?.params).toEqual({ code: 'GROUP_WRITE_FORBIDDEN' });
  });

  it('counters：gw-16/14/6 的拒绝都计入 sendCalls*（网关已受理调用）；gw-10 的 503 不计（未进业务处理）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);

    await scenario(app, 'sender_not_in_group', undefined, { groupId, accountId: 'acc-02' });
    const notInGroup = await send(app, groupId, 'acc-02', 'c-16');
    expect(notInGroup.statusCode).toBe(403); // acc-02 其实是成员：开关强制注入同码
    expect(await notInGroup.json()).toMatchObject({ code: 'SENDER_NOT_IN_GROUP' });
    await clearScenario(app, 'sender_not_in_group');

    await scenario(app, 'group_write_forbidden', undefined, { groupId });
    expect((await send(app, groupId, 'acc-02', 'c-14')).statusCode).toBe(403);
    await clearScenario(app, 'group_write_forbidden');

    await scenario(app, 'rate_limit', { retryAfterSeconds: 30 }, { accountId: 'acc-02' });
    expect((await send(app, groupId, 'acc-02', 'c-6')).statusCode).toBe(429);

    const counters = await countersOf(app);
    expect(counters.sendCallsByAccount).toEqual({ 'acc-02': 3 });
    expect(counters.sendCallsByClientMsgId).toEqual({ 'c-16': 1, 'c-14': 1, 'c-6': 1 });
    expect(counters.landedMessages).toBe(0);

    // gw-10 在路由之前拦截：限流窗口内的这次调用连 429 都到不了，也不计数
    await scenario(app, 'gateway_503_all');
    expect((await send(app, groupId, 'acc-02', 'c-10')).statusCode).toBe(503);
    const after = await countersOf(app);
    expect(after.sendCallsByAccount).toEqual({ 'acc-02': 3 });
    expect(after.sendCallsByClientMsgId['c-10']).toBeUndefined();
  });
});

describe('gw-17 account_offline_409：强制离线（REQ §2.1 五操作闸门）', () => {
  it('已 connect 的账号五操作全 409；connect 不受影响；clear 后恢复 202', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    await scenario(app, 'account_offline_409', undefined, { accountId: 'acc-02' });

    const offline = await send(app, groupId, 'acc-02', 'c-17');
    expect(offline.statusCode).toBe(409);
    expect(await offline.json()).toMatchObject({ code: 'ACCOUNT_OFFLINE' });
    expect(
      (await app.inject({ method: 'POST', url: `/groups/${groupId}/leave`, payload: { accountId: 'acc-02' } }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/groups/${groupId}/kick`,
          payload: { byAccountId: 'acc-02', targetPlatformUserId: puidOf(app, 'acc-01') },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/groups/${groupId}/promote`,
          payload: { byAccountId: 'acc-02', accountId: 'acc-01' },
        })
      ).statusCode,
    ).toBe(409);
    const inviteLink = await createInvite(app, groupId);
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(409);

    // connect 不在五操作内（REQ §2.1：409 只约束 send/join/promote/kick/leave）
    expect((await app.inject({ method: 'POST', url: '/accounts/acc-02/connect' })).statusCode).toBe(200);
    expect(app.gatewayState.accounts.get('acc-02')?.online).toBe(true); // 强制离线不改真实在线状态

    await clearScenario(app, 'account_offline_409');
    expect((await send(app, groupId, 'acc-02', 'c-17b')).statusCode).toBe(202);
  });
});

describe('gw-27 media_message / media_expire_404：mediaUrl + GET /media/:id 字节 / 过期 404（REQ §2.1）', () => {
  it('默认不带 mediaUrl；arm 后 message 事件带**绝对** mediaUrl，下载得 200 + content-type + 字节；过期后 404', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);

    expect((await send(app, groupId, 'acc-02', 'c-plain')).statusCode).toBe(202);
    await sleep(60);
    expect(lastFrame(app, 'message').data).not.toHaveProperty('mediaUrl'); // 默认行为不变

    await scenario(app, 'media_message', undefined, { groupId });
    await withListening(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/groups/${groupId}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'acc-02', clientMsgId: 'c-media', text: 'photo' }),
      });
      expect(res.status).toBe(202);
      await sleep(80);

      const frame = lastFrame(app, 'message');
      const msgId = frame.data['msgId'] as string;
      // 绝对 URL 是消费方契约：server 的 downloadMedia(mediaUrl) 直接 fetch，不做 base 拼接
      expect(frame.data['mediaUrl']).toBe(`${baseUrl}/media/${msgId}`);

      const ok = await fetch(frame.data['mediaUrl'] as string);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/svg+xml');
      expect(new TextDecoder().decode(new Uint8Array(await ok.arrayBuffer()))).toContain(msgId);

      await scenario(app, 'media_expire_404'); // 未给 afterMs = arm 即过期
      expect((await fetch(frame.data['mediaUrl'] as string)).status).toBe(404);
      await clearScenario(app, 'media_expire_404');
      expect((await fetch(frame.data['mediaUrl'] as string)).status).toBe(200); // 过期安排可撤销
    });
  });

  it('afterMs 配方：创建后 afterMs 内 200、到期后 404；未知媒体 id 恒 404', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    await scenario(app, 'media_expire_404', { afterMs: 120 });
    await scenario(app, 'media_message', undefined, { groupId });

    expect((await send(app, groupId, 'acc-02', 'c-exp')).statusCode).toBe(202);
    await sleep(40);
    const msgId = lastFrame(app, 'message').data['msgId'] as string;
    expect((await app.inject({ method: 'GET', url: `/media/${msgId}` })).statusCode).toBe(200); // 未到期
    await sleep(160);
    expect((await app.inject({ method: 'GET', url: `/media/${msgId}` })).statusCode).toBe(404); // 已过期
    expect((await app.inject({ method: 'GET', url: '/media/m-does-not-exist' })).statusCode).toBe(404);
  });

  it('mediaId 收窄：只让指定媒体过期，同批另一个仍可下载', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await pinFastLanding(app);
    await scenario(app, 'media_message', undefined, { groupId });
    expect((await send(app, groupId, 'acc-02', 'c-m1')).statusCode).toBe(202);
    await sleep(40);
    const first = lastFrame(app, 'message').data['msgId'] as string;
    expect((await send(app, groupId, 'acc-02', 'c-m2')).statusCode).toBe(202);
    await sleep(40);
    const second = lastFrame(app, 'message').data['msgId'] as string;
    expect(second).not.toBe(first);

    await scenario(app, 'media_expire_404', undefined, { mediaId: second });
    expect((await app.inject({ method: 'GET', url: `/media/${second}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/media/${first}` })).statusCode).toBe(200);
  });
});
