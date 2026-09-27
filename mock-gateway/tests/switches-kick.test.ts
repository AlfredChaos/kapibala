// kick 开关测试（T-P4-14 c 项，先红后绿）。
// 契约出处：DES/14 §5 行 24/25、§3 kick 行；REQ §2.1 kick 行；QR §1（1–5s、2s 收敛）。
// 覆盖：kick_slow 钉值延迟；kick_504 504+收敛真值解耦（kicked true/false）；
// gw-25 owner_left_on_kick→409 / kick_no_permission→403 强制注入（自然路径不触发时也生效）。
import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GatewayApp } from '../src/app.js';
import {
  framesOf,
  makeGroupWithMember,
  membersOf,
  newApp,
  puidOf,
  scenario,
} from './helpers/gateway.js';

async function kick(app: GatewayApp, groupId: string, byAccountId: string, targetPuid: string) {
  return app.inject({
    method: 'POST',
    url: `/groups/${groupId}/kick`,
    payload: { byAccountId, targetPlatformUserId: targetPuid },
  });
}

describe('kick 开关 gw-24/25（DES/14 §5 #24/25 + REQ §2.1）', () => {
  it('kick_slow 钉值：响应恰在钉值后返回（区间 1–5s 可钉；测试用 40ms 钉值验证判定通路）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'kick_slow', { delayMs: 40 }, { groupId });
    const t0 = Date.now();
    const res = await kick(app, groupId, 'acc-01', puidOf(app, 'acc-02'));
    const elapsed = Date.now() - t0;
    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(35); // 钉值生效（≈40ms）
    expect(elapsed).toBeLessThan(1000); // 远低于默认区间下限 1s——证明走的是钉值不是契约随机
  });

  it('kick_504 + kicked=true：504 返回后成员列表 2s 内收敛到「已踢出」+ member_left', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'kick_504', { kicked: true, delayMs: 40 }, { groupId });
    const res = await kick(app, groupId, 'acc-01', puidOf(app, 'acc-02'));
    expect(res.statusCode).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'NETWORK_TIMEOUT' });
    await sleep(80); // << 2s 收敛窗
    expect((await membersOf(app, groupId)).includes(puidOf(app, 'acc-02'))).toBe(false); // 收敛真值：踢出
    expect(framesOf(app, 'member_left').at(-1)?.data).toMatchObject({
      groupId, platformUserId: puidOf(app, 'acc-02'),
    });
  });

  it('kick_504 + kicked=false：504 但成员保留、无 member_left（响应与真值解耦）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'kick_504', { kicked: false, delayMs: 40 }, { groupId });
    const res = await kick(app, groupId, 'acc-01', puidOf(app, 'acc-02'));
    expect(res.statusCode).toBe(504);
    await sleep(80);
    expect((await membersOf(app, groupId)).includes(puidOf(app, 'acc-02'))).toBe(true);
    expect(framesOf(app, 'member_left').filter((f) => f.data['groupId'] === groupId)).toHaveLength(0);
  });

  it('owner_left_on_kick → 409 OWNER_LEFT：群主还在群里也强制（自然路径不触发时必须生效）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'owner_left_on_kick', {}, { groupId });
    const res = await kick(app, groupId, 'acc-01', puidOf(app, 'acc-02'));
    expect(res.statusCode).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OWNER_LEFT' });
    // 强制错误不写成员列表（契约：OWNER_LEFT 状态不变）
    expect((await membersOf(app, groupId)).includes(puidOf(app, 'acc-02'))).toBe(true);
  });

  it('kick_no_permission → 403 NO_PERMISSION：群主本人踢也强制（自然路径不可能 403）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'kick_no_permission', {}, { groupId });
    const res = await kick(app, groupId, 'acc-01', puidOf(app, 'acc-02')); // acc-01 是群主
    expect(res.statusCode).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NO_PERMISSION' });
    expect((await membersOf(app, groupId)).includes(puidOf(app, 'acc-02'))).toBe(true);
  });
});
