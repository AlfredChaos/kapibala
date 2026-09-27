// 消息 / kick / leave / members / by-client-id / media 存根测试（T-P1-04 c 项，先红后绿）。
// 契约出处：REQ §2.1 发消息节 + 群与成员节（kick/leave/members）；DES/14 §2–§3、§5 注（S3 非开关）。
// 说明（真实定时器例外）：全部时序经开关钉值（DES/14 §3「可钉死为确定值」），
// 唯 send_504_land_1500 按契约固定 1.5s 实测。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createGatewayApp, type GatewayApp } from '../src/app.js';

function newApp(): GatewayApp {
  return createGatewayApp({ seedAccountIds: ['acc-01', 'acc-02', 'acc-03'] });
}

async function ok(res: { statusCode: number; json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  expect(res.statusCode).toBeLessThan(300);
  return res.json() as Promise<Record<string, unknown>>;
}

async function connect(app: GatewayApp, accountId: string): Promise<void> {
  expect((await app.inject({ method: 'POST', url: `/accounts/${accountId}/connect` })).statusCode).toBe(200);
}

async function scenario(
  app: GatewayApp,
  switchName: string,
  params?: Record<string, unknown>,
  target?: Record<string, unknown>,
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/_test/scenario',
    payload: { switch: switchName, params, target },
  });
  expect(res.statusCode).toBe(200);
}

async function makeGroupWithMember(app: GatewayApp): Promise<string> {
  await connect(app, 'acc-01');
  await connect(app, 'acc-02');
  const groupId = ((await ok(
    await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-01' } }),
  )) as { groupId: string }).groupId;
  await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
  const inviteLink = ((await ok(await app.inject({ method: 'POST', url: `/groups/${groupId}/invite` }))) as {
    inviteLink: string;
  }).inviteLink;
  await scenario(app, 'member_joined_delay', { delayMs: 40 }, { groupId });
  const join = await app.inject({
    method: 'POST',
    url: `/groups/${groupId}/join`,
    payload: { accountId: 'acc-02', inviteLink },
  });
  expect(join.statusCode).toBe(202);
  await sleep(120); // 等 member_joined 落定
  return groupId;
}

async function send(
  app: GatewayApp,
  groupId: string,
  accountId: string,
  clientMsgId: string,
  text = 'hi',
): Promise<{ statusCode: number; json(): Promise<unknown> }> {
  return app.inject({
    method: 'POST',
    url: `/groups/${groupId}/send`,
    payload: { accountId, clientMsgId, text },
  });
}

function puidOf(app: GatewayApp, accountId: string): string {
  return app.gatewayState.accounts.get(accountId)?.platformUserId ?? '';
}

function framesOf(app: GatewayApp, type: string): Array<{ eventId: number; data: Record<string, unknown> }> {
  return app.gatewayState.ledger.filter((f) => f.type === type);
}

describe('send：202 → message_sent + message 全量回流（REQ §2.1；S3 默认行为非开关）', () => {
  it('钉值时序：202 {accepted:true}；60ms 后 message_sent 与 message（含自己的消息）各一帧', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 60 }, { groupId });

    const res = await send(app, groupId, 'acc-02', 'c-1', 'hello');
    expect(res.statusCode).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(framesOf(app, 'message_sent')).toHaveLength(0); // 未到时序

    await sleep(150);
    const sent = framesOf(app, 'message_sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toMatchObject({ clientMsgId: 'c-1', msgId: expect.any(String), sentAt: expect.any(String) });

    const messages = framesOf(app, 'message');
    expect(messages).toHaveLength(1); // 回流：自己的消息同样推 message（网关不区分来源）
    expect(messages[0]?.data).toMatchObject({
      groupId,
      msgId: sent[0]?.data['msgId'],
      senderPlatformUserId: puidOf(app, 'acc-02'),
      text: 'hello',
      sentAt: sent[0]?.data['sentAt'],
    });

    // 落地行 + by-client-id 命中最早一条
    const query = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/c-1` });
    expect(query.statusCode).toBe(200);
    expect(await query.json()).toMatchObject({ msgId: sent[0]?.data['msgId'], sentAt: sent[0]?.data['sentAt'] });
  });

  it('不去重：同一 clientMsgId 两次 → 落地两条、message_sent 两帧，by-client-id 返回最早一条', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 40 }, { groupId });

    await send(app, groupId, 'acc-02', 'dup', 'first');
    await sleep(80);
    await send(app, groupId, 'acc-02', 'dup', 'second');
    await sleep(80);

    expect(framesOf(app, 'message_sent')).toHaveLength(2);
    expect(app.gatewayState.messages.get('dup')).toHaveLength(2);
    const query = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/dup` });
    const body = (await ok(query)) as { msgId: string };
    expect(body.msgId).toBe(framesOf(app, 'message_sent')[0]?.data['msgId']);
  });

  it('by-client-id：不存在 → 404；群不匹配 → 404（查询是群作用域的）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const missing = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/nope` });
    expect(missing.statusCode).toBe(404);
    const wrongGroup = await app.inject({ method: 'GET', url: `/groups/gw-999/messages/by-client-id/nope` });
    expect(wrongGroup.statusCode).toBe(404);
  });
});

describe('send 同步错误（REQ §2.1 发消息节逐字）', () => {
  it('429 RATE_LIMITED：期内任何 send 再 429 且计时重置；只作用于 send', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'rate_limit', { retryAfterSeconds: 30 }, { accountId: 'acc-02' });

    const first = await send(app, groupId, 'acc-02', 'c-r1');
    expect(first.statusCode).toBe(429);
    expect(await first.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect((await first.json() as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    const untilAfterFirst = app.gatewayState.accounts.get('acc-02')?.rateLimitedUntil;

    await sleep(50);
    const second = await send(app, groupId, 'acc-02', 'c-r2');
    expect(second.statusCode).toBe(429);
    // 计时重置：第二次 429 后窗口起点后移
    const untilAfterSecond = app.gatewayState.accounts.get('acc-02')?.rateLimitedUntil;
    expect(untilAfterSecond ?? 0).toBeGreaterThan(untilAfterFirst ?? 0);

    // 限流只作用于 send：join 不受影响（REQ §2.1 rate-limit 行只约束 send）
    const groupId2 = ((await ok(
      await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-01' } }),
    )) as { groupId: string }).groupId;
    await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId: groupId2 });
    const inviteLink = ((await ok(await app.inject({ method: 'POST', url: `/groups/${groupId2}/invite` }))) as {
      inviteLink: string;
    }).inviteLink;
    const join = await app.inject({
      method: 'POST',
      url: `/groups/${groupId2}/join`,
      payload: { accountId: 'acc-02', inviteLink },
    });
    expect(join.statusCode).toBe(202);
  });

  it('403 GROUP_WRITE_FORBIDDEN（group_write_forbidden 开关按群注入）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'group_write_forbidden', undefined, { groupId });
    const res = await send(app, groupId, 'acc-02', 'c-w');
    expect(res.statusCode).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'GROUP_WRITE_FORBIDDEN' });
  });

  it('403 SENDER_NOT_IN_GROUP：非成员自然命中；开关可对成员强制注入', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await connect(app, 'acc-03'); // acc-03 不在群
    const natural = await send(app, groupId, 'acc-03', 'c-s1');
    expect(natural.statusCode).toBe(403);
    expect(await natural.json()).toMatchObject({ code: 'SENDER_NOT_IN_GROUP' });

    await scenario(app, 'sender_not_in_group', undefined, { groupId });
    const forced = await send(app, groupId, 'acc-02', 'c-s2'); // acc-02 是成员
    expect(forced.statusCode).toBe(403);
    expect(await forced.json()).toMatchObject({ code: 'SENDER_NOT_IN_GROUP' });
  });

  it('离线 / 未知群：409 ACCOUNT_OFFLINE / 404', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const offline = await send(app, groupId, 'acc-03', 'c-o'); // 未 connect
    expect(offline.statusCode).toBe(409);
    expect(await offline.json()).toMatchObject({ code: 'ACCOUNT_OFFLINE' });
    const unknown = await send(app, 'gw-999', 'acc-02', 'c-u');
    expect(unknown.statusCode).toBe(404);
  });
});

describe('send 异步路径（message_failed / 504 两态，DES/14 §5 行 7/8/15）', () => {
  it('message_failed_event：202 后推 message_failed（code 可配），不落地、不推 message', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 40 }, { groupId });
    await scenario(app, 'message_failed_event', { code: 'GROUP_WRITE_FORBIDDEN' }, { groupId });

    const res = await send(app, groupId, 'acc-02', 'c-f');
    expect(res.statusCode).toBe(202);
    await sleep(120);
    expect(framesOf(app, 'message_failed')).toHaveLength(1);
    expect(framesOf(app, 'message_failed')[0]?.data).toMatchObject({
      clientMsgId: 'c-f',
      code: 'GROUP_WRITE_FORBIDDEN',
    });
    expect(framesOf(app, 'message_sent')).toHaveLength(0);
    expect(framesOf(app, 'message')).toHaveLength(0);
    const query = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/c-f` });
    expect(query.statusCode).toBe(404);
  });

  it('send_504_not_sent：504 NETWORK_TIMEOUT，恒不落地（by-client-id 404）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_504_not_sent', undefined, { clientMsgId: 'c-n' });
    const res = await send(app, groupId, 'acc-02', 'c-n');
    expect(res.statusCode).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'NETWORK_TIMEOUT' });
    await sleep(250);
    const query = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/c-n` });
    expect(query.statusCode).toBe(404);
    expect(framesOf(app, 'message_sent')).toHaveLength(0);
  });

  it('send_504_land_1500：504 后 1.5s 落地并推 message_sent + message', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_504_land_1500', undefined, { clientMsgId: 'c-5' });
    const res = await send(app, groupId, 'acc-02', 'c-5');
    expect(res.statusCode).toBe(504);
    await sleep(500);
    expect(framesOf(app, 'message_sent')).toHaveLength(0); // 尚未落地
    await sleep(1200); // 契约固定 1.5s（DES/14 §3：S5 编排为 1.5s）
    expect(framesOf(app, 'message_sent')).toHaveLength(1);
    expect(framesOf(app, 'message')).toHaveLength(1);
    const query = await app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/c-5` });
    expect(query.statusCode).toBe(200);
  });
});

describe('kick（REQ §2.1：1–5s、200 前移除、随后 member_left；权限/OWNER_LEFT 自然语义）', () => {
  it('非群主且未被 promote → 403 NO_PERMISSION；promote 后可踢', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const denied = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/kick`,
      payload: { byAccountId: 'acc-02', targetPlatformUserId: puidOf(app, 'acc-01') },
    });
    expect(denied.statusCode).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'NO_PERMISSION' });

    await ok(
      await app.inject({
        method: 'POST',
        url: `/groups/${groupId}/promote`,
        payload: { byAccountId: 'acc-01', accountId: 'acc-02' },
      }),
    );
    await scenario(app, 'kick_slow', { delayMs: 40 }, { groupId });
    const kick = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/kick`,
      payload: { byAccountId: 'acc-02', targetPlatformUserId: puidOf(app, 'acc-01') },
    });
    expect(kick.statusCode).toBe(200);
    expect(await kick.json()).toEqual({ kicked: true });
    // 200 返回前目标已移除；member_left 随后推出
    expect(app.gatewayState.groups.get(groupId)?.members.has(puidOf(app, 'acc-01'))).toBe(false);
    await sleep(60);
    expect(framesOf(app, 'member_left')).toHaveLength(1);
    expect(framesOf(app, 'member_left')[0]?.data).toMatchObject({
      groupId,
      platformUserId: puidOf(app, 'acc-01'),
    });
    expect(app.gatewayState.counters.kickCalls).toBe(2); // 403 那次也计入调用
  });

  it('群主已退群 → 任何 kick 409 OWNER_LEFT（自然语义）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    // 群主退群（leave 归本任务，先走通）
    await ok(await app.inject({ method: 'POST', url: `/groups/${groupId}/leave`, payload: { accountId: 'acc-01' } }));
    await sleep(60);
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/kick`,
      payload: { byAccountId: 'acc-02', targetPlatformUserId: puidOf(app, 'acc-02') },
    });
    expect(res.statusCode).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OWNER_LEFT' });
  });

  it('kick_504：504 后成员列表 2s 内收敛（kicked=true 移除+事件；kicked=false 不动）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'kick_504', { kicked: true, delayMs: 40 }, { groupId });
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/kick`,
      payload: { byAccountId: 'acc-01', targetPlatformUserId: puidOf(app, 'acc-02') },
    });
    expect(res.statusCode).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'NETWORK_TIMEOUT' });
    await sleep(80);
    expect(app.gatewayState.groups.get(groupId)?.members.has(puidOf(app, 'acc-02'))).toBe(false);
    expect(framesOf(app, 'member_left')).toHaveLength(1);

    // kicked=false：504 且确实没踢
    const groupId2 = await makeGroupWithMember(app);
    await scenario(app, 'kick_504', { kicked: false, delayMs: 40 }, { groupId: groupId2 });
    const res2 = await app.inject({
      method: 'POST',
      url: `/groups/${groupId2}/kick`,
      payload: { byAccountId: 'acc-01', targetPlatformUserId: puidOf(app, 'acc-02') },
    });
    expect(res2.statusCode).toBe(504);
    await sleep(80);
    expect(app.gatewayState.groups.get(groupId2)?.members.has(puidOf(app, 'acc-02'))).toBe(true);
    expect(app.gatewayState.ledger.filter((f) => f.type === 'member_left' && f.data['groupId'] === groupId2)).toHaveLength(0);
  });
});

describe('leave（REQ §2.1：200 + member_left / 500 没退成）', () => {
  it('正常：200、成员移除、member_left 推出', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const res = await app.inject({ method: 'POST', url: `/groups/${groupId}/leave`, payload: { accountId: 'acc-02' } });
    expect(res.statusCode).toBe(200);
    expect(app.gatewayState.groups.get(groupId)?.members.has(puidOf(app, 'acc-02'))).toBe(false);
    await sleep(60);
    expect(framesOf(app, 'member_left')).toHaveLength(1);
  });

  it('leave_500：500 且成员保留、无 member_left（没退成）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'leave_500', undefined, { groupId });
    const res = await app.inject({ method: 'POST', url: `/groups/${groupId}/leave`, payload: { accountId: 'acc-02' } });
    expect(res.statusCode).toBe(500);
    expect(app.gatewayState.groups.get(groupId)?.members.has(puidOf(app, 'acc-02'))).toBe(true);
    await sleep(60);
    expect(framesOf(app, 'member_left')).toHaveLength(0);
  });

  it('离线账号 leave → 409 ACCOUNT_OFFLINE（五操作含 leave）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await app.inject({ method: 'POST', url: '/accounts/acc-02/disconnect' });
    const res = await app.inject({ method: 'POST', url: `/groups/${groupId}/leave`, payload: { accountId: 'acc-02' } });
    expect(res.statusCode).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ACCOUNT_OFFLINE' });
  });
});

describe('GET /groups/:id/members 与 GET /media/:id（REQ §2.1）', () => {
  it('members 返回 [{platformUserId}] 网关视角快照；未知群 404', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const res = await app.inject({ method: 'GET', url: `/groups/${groupId}/members` });
    const body = (await ok(res)) as unknown as Array<{ platformUserId: string }>;
    expect(body.map((m) => m.platformUserId).sort()).toEqual(
      [puidOf(app, 'acc-01'), puidOf(app, 'acc-02')].sort(),
    );
    const unknown = await app.inject({ method: 'GET', url: '/groups/gw-999/members' });
    expect(unknown.statusCode).toBe(404);
  });

  it('media 存根：GET /media/:id → 404（gw-27 落地真实行为）', async () => {
    const app = newApp();
    const res = await app.inject({ method: 'GET', url: '/media/m-1' });
    expect(res.statusCode).toBe(404);
  });
});

describe('counters 接线（DES/14 §4：验收断言真值来源）', () => {
  it('sendCallsByAccount / sendCallsByClientMsgId / landedMessages 随 send 递增', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 30 }, { groupId });
    await send(app, groupId, 'acc-02', 'c-1');
    await send(app, groupId, 'acc-02', 'c-2');
    await sleep(80);

    const counters = app.gatewayState.counters;
    expect(counters.sendCallsByAccount.get('acc-02')).toBe(2);
    expect(counters.sendCallsByClientMsgId.get('c-1')).toBe(1);
    expect(counters.sendCallsByClientMsgId.get('c-2')).toBe(1);
    expect(counters.landedMessages).toBe(2);
  });
});
