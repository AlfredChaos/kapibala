// 群生命周期端点测试（T-P1-03 c 项，先红后绿）。
// 契约出处：REQ §2.1 群与成员节；DES/14 §2–§3；QR §1（member_joined 100–1500ms 行）。
// 说明（真实定时器例外）：member_joined 是契约时序行为（默认区间随机 / scenario 钉值），
// 必须真定时器观测；用例一律用 member_joined_delay 钉成小值保确定性。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createGatewayApp, type GatewayApp } from '../src/app.js';

function newApp(): GatewayApp {
  return createGatewayApp({ seedAccountIds: ['acc-01', 'acc-02', 'acc-03'] });
}

async function json<S>(res: { statusCode: number; json(): Promise<unknown> }, status: S) {
  expect(res.statusCode).toBe(status);
  return res.json();
}

async function connect(app: GatewayApp, accountId: string): Promise<void> {
  const res = await app.inject({ method: 'POST', url: `/accounts/${accountId}/connect` });
  expect(res.statusCode).toBe(200);
}

async function createGroup(app: GatewayApp, creatorAccountId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId } });
  const body = await json(res, 200);
  return (body as { groupId: string }).groupId;
}

async function invite(app: GatewayApp, groupId: string): Promise<{ inviteLink: string; readyAfterMs: number }> {
  const res = await app.inject({ method: 'POST', url: `/groups/${groupId}/invite` });
  return (await json(res, 200)) as { inviteLink: string; readyAfterMs: number };
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

describe('POST /groups：创建者即成员且不推 member_joined（REQ §2.1）', () => {
  it('返回 gw-<seq> 群 id；creator 立即可见于成员集；账本零帧', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    const groupId = await createGroup(app, 'acc-01');
    expect(groupId).toMatch(/^gw-\d+$/);

    const group = app.gatewayState.groups.get(groupId);
    expect(group).toBeDefined();
    const creatorPuid = app.gatewayState.accounts.get('acc-01')?.platformUserId;
    expect(creatorPuid).toBeDefined();
    expect(group?.members.has(creatorPuid ?? '')).toBe(true);
    // 建群不推 member_joined（契约明文）
    expect(app.gatewayState.ledger).toHaveLength(0);
  });

  it('终态账号建群 → 403 ACCOUNT_SUSPENDED（「所有请求」含建群）', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await scenario(app, 'account_suspended_403', undefined, { accountId: 'acc-01' });
    const res = await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId: 'acc-01' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });
});

describe('POST /groups/:id/invite（REQ §2.1：readyAfterMs 0 或数秒；链接可过期）', () => {
  it('默认返回 {inviteLink, readyAfterMs}；invite_not_ready 钉值 readyAfterMs=3000', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    const groupId = await createGroup(app, 'acc-01');
    const first = await invite(app, groupId);
    expect(typeof first.inviteLink).toBe('string');
    expect(first.inviteLink.length).toBeGreaterThan(0);
    expect(first.readyAfterMs).toBeGreaterThanOrEqual(0);

    await scenario(app, 'invite_not_ready', { readyAfterMs: 3000 }, { groupId });
    const pinned = await invite(app, groupId);
    expect(pinned.readyAfterMs).toBe(3000);
  });

  it('未知群 → 404', async () => {
    const app = newApp();
    const res = await app.inject({ method: 'POST', url: '/groups/gw-999/invite' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /groups/:id/join（REQ §2.1：202 受理，member_joined 100–1500ms 或永不到）', () => {
  async function setupJoined(app: GatewayApp): Promise<{ groupId: string; inviteLink: string }> {
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
    const { inviteLink } = await invite(app, groupId);
    return { groupId, inviteLink };
  }

  it('正常路径：202 立即返回时未入群；钉 60ms 后 member_joined {groupId, platformUserId} 且成员集更新', async () => {
    const app = newApp();
    const { groupId, inviteLink } = await setupJoined(app);
    // 钉 member_joined 延迟为 60ms（契约区间 100–1500ms 的钉值，DES/14 §3）
    await scenario(app, 'member_joined_delay', { delayMs: 60 }, { groupId });

    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/join`,
      payload: { accountId: 'acc-02', inviteLink },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });

    const puid2 = app.gatewayState.accounts.get('acc-02')?.platformUserId ?? '';
    expect(app.gatewayState.groups.get(groupId)?.members.has(puid2)).toBe(false); // 真正入群以事件为准
    await sleep(150);
    expect(app.gatewayState.groups.get(groupId)?.members.has(puid2)).toBe(true);
    const frames = app.gatewayState.ledger.filter((f) => f.type === 'member_joined');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toMatchObject({ groupId, platformUserId: puid2, eventId: frames[0]?.eventId });
  });

  it('就绪前 join → 409 INVITE_NOT_READY（带剩余等待）', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 3000 }, { groupId });
    const { inviteLink } = await invite(app, groupId);
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/join`,
      payload: { accountId: 'acc-02', inviteLink },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INVITE_NOT_READY' });
    expect((res.json() as { readyAfterMs?: number }).readyAfterMs).toBeGreaterThan(0);
  });

  it('invite_expired 链接过期 → 410 INVITE_EXPIRED', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
    const { inviteLink } = await invite(app, groupId);
    await scenario(app, 'invite_expired', { expireAfterMs: 0 }, { groupId });

    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/join`,
      payload: { accountId: 'acc-02', inviteLink },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'INVITE_EXPIRED' });
  });

  it('离线账号 join → 409 ACCOUNT_OFFLINE；未知群 → 404', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
    const { inviteLink } = await invite(app, groupId);

    const offline = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/join`,
      payload: { accountId: 'acc-02', inviteLink }, // 未 connect
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json()).toMatchObject({ code: 'ACCOUNT_OFFLINE' });

    const unknown = await app.inject({
      method: 'POST',
      url: '/groups/gw-999/join',
      payload: { accountId: 'acc-01', inviteLink },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('已在群账号 join → 409 ALREADY_MEMBER 且不再推事件', async () => {
    const app = newApp();
    const { groupId, inviteLink } = await setupJoined(app);
    await scenario(app, 'member_joined_delay', { delayMs: 40 }, { groupId });
    await app.inject({ method: 'POST', url: `/groups/${groupId}/join`, payload: { accountId: 'acc-02', inviteLink } });
    await sleep(100);

    const again = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/join`,
      payload: { accountId: 'acc-02', inviteLink },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'ALREADY_MEMBER' });
    await sleep(100);
    expect(app.gatewayState.ledger.filter((f) => f.type === 'member_joined')).toHaveLength(1);
  });

  it('member_joined_never：202 但事件永不到，账号从未入群（gw-18 参数暴露）', async () => {
    const app = newApp();
    const { groupId, inviteLink } = await setupJoined(app);
    await scenario(app, 'member_joined_never', undefined, { groupId });
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/join`,
      payload: { accountId: 'acc-02', inviteLink },
    });
    expect(res.statusCode).toBe(202);
    await sleep(250);
    const puid2 = app.gatewayState.accounts.get('acc-02')?.platformUserId ?? '';
    expect(app.gatewayState.groups.get(groupId)?.members.has(puid2)).toBe(false);
    expect(app.gatewayState.ledger).toHaveLength(0);
  });
});

describe('POST /groups/:id/promote（REQ §2.1：群主校验 / NOT_MEMBER_YET / 不推事件）', () => {
  it('非群主 → 403 NO_PERMISSION；对方 member_joined 之前 → 409 NOT_MEMBER_YET；成功 200 且无事件、记录提升', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    await connect(app, 'acc-03');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
    const { inviteLink } = await invite(app, groupId);

    // 非群主 promote → 403
    const notOwner = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/promote`,
      payload: { byAccountId: 'acc-03', accountId: 'acc-02' },
    });
    expect(notOwner.statusCode).toBe(403);
    expect(notOwner.json()).toMatchObject({ code: 'NO_PERMISSION' });

    // join 已受理但 member_joined 未到 → NOT_MEMBER_YET
    await scenario(app, 'member_joined_delay', { delayMs: 120 }, { groupId });
    await app.inject({ method: 'POST', url: `/groups/${groupId}/join`, payload: { accountId: 'acc-02', inviteLink } });
    const tooEarly = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/promote`,
      payload: { byAccountId: 'acc-01', accountId: 'acc-02' },
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json()).toMatchObject({ code: 'NOT_MEMBER_YET' });

    // 事件到达后 promote 成功：200 {}、无事件、promoted 集合记录（kick 语义用，T-P1-04）
    await sleep(200);
    const ok = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/promote`,
      payload: { byAccountId: 'acc-01', accountId: 'acc-02' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({});
    expect(app.gatewayState.ledger.filter((f) => f.type === 'member_joined')).toHaveLength(1); // 仍只有 join 的一帧
    const puid2 = app.gatewayState.accounts.get('acc-02')?.platformUserId ?? '';
    expect(app.gatewayState.groups.get(groupId)?.promoted.has(puid2)).toBe(true);
  });

  it('离线/终态操作者走共享闸门：suspended → 403 ACCOUNT_SUSPENDED', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'account_suspended_403', undefined, { accountId: 'acc-01' });
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/promote`,
      payload: { byAccountId: 'acc-01', accountId: 'acc-02' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
  });

  it('未知群 → 404', async () => {
    const app = newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/groups/gw-999/promote',
      payload: { byAccountId: 'acc-01', accountId: 'acc-02' },
    });
    expect(res.statusCode).toBe(404);
  });
});
