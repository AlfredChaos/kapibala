// gw-18/20/21/22/23/26 建群 / 成员生命周期开关测试（T-P3-10 c 项，先红后绿）。
// 契约出处：REQ §2.1 群与成员节（202 仅受理、member_joined 可能永不到此时未入群、
// 已在群再 join → 409 ALREADY_MEMBER 且不再推 member_joined、readyAfterMs 0 或数秒就绪前
// 409 INVITE_NOT_READY、链接任意时刻可过期 410 INVITE_EXPIRED、promote 409 NOT_MEMBER_YET
// 不推事件、leave 可能 500 没退成）；DES/14 §5 行 18/20–23/26、§4 语义（重复 arm = 覆盖、
// clear 归零）；QR §2（ALREADY_MEMBER「视为成功，直接 promote」、NOT_MEMBER_YET 总调用 ≤2）。
// 自然路径（真在群 / 真未就绪 / 成员未到）已在 tests/groups.test.ts 覆盖；
// 本文件断言开关的**强制注入**面：未在群也要 409、成员已在群也要 409、事件必须缺席。
// 说明（真实定时器例外）：member_joined / readyAfterMs 是契约时序行为，必须真定时器观测；
// 「永不到」用例取契约区间上界（1500ms）之外作沉降窗，钉值 0 判定时只睡短窗。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { GatewayApp } from '../src/app.js';
import {
  clearScenario,
  connect,
  createGroup,
  createInvite,
  framesOf,
  joinGroup,
  jsonOf,
  makeGroupWithMember,
  membersOf,
  newApp,
  puidOf,
  scenario,
  type InjectResponse,
} from './helpers/gateway.js';

async function inviteReady(
  app: GatewayApp,
  groupId: string,
  readyAfterMs = 0,
): Promise<string> {
  await scenario(app, 'invite_not_ready', { readyAfterMs }, { groupId });
  return createInvite(app, groupId);
}

async function promote(
  app: GatewayApp,
  groupId: string,
  byAccountId: string,
  accountId: string,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: `/groups/${groupId}/promote`,
    payload: { byAccountId, accountId },
  });
}

async function leave(app: GatewayApp, groupId: string, accountId: string): Promise<InjectResponse> {
  return app.inject({ method: 'POST', url: `/groups/${groupId}/leave`, payload: { accountId } });
}

describe('gw-18 member_joined_never：join 202 但 member_joined 永不到（REQ §2.1：此时账号并未入群）', () => {
  it('202 受理后越过契约上界（1500ms）仍无事件、不在成员集；clear 后重 join 恢复入群', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    const inviteLink = await inviteReady(app, groupId);
    await scenario(app, 'member_joined_delay', { delayMs: 20 }, { groupId }); // 若 never 被忽略则 20ms 内必暴露
    await scenario(app, 'member_joined_never', undefined, { groupId });

    const res = await joinGroup(app, groupId, 'acc-02', inviteLink);
    expect(res.statusCode).toBe(202);
    await sleep(1600); // 契约区间 100–1500ms 之外沉降：「永不到」的强断言
    expect(framesOf(app, 'member_joined')).toHaveLength(0);
    expect(await membersOf(app, groupId)).not.toContain(puidOf(app, 'acc-02'));

    // 开关是注入源而非账户状态：clear 后同一链接重 join → 正常入群并推事件
    await clearScenario(app, 'member_joined_never');
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(202);
    await sleep(120);
    expect(await membersOf(app, groupId)).toContain(puidOf(app, 'acc-02'));
    const joined = framesOf(app, 'member_joined');
    expect(joined.map((frame) => frame.data['platformUserId'])).toEqual([puidOf(app, 'acc-02')]);
  });
});

describe('gw-20 invite_not_ready：invite readyAfterMs>0，就绪前 join → 409 INVITE_NOT_READY（DES/14 §5 行 20）', () => {
  it('钉值 readyAfterMs=3000：响应带回该值；就绪前 join → 409 + 剩余 readyAfterMs、不入群', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 3000 }, { groupId });
    const res = await app.inject({ method: 'POST', url: `/groups/${groupId}/invite` });
    const body = (await jsonOf(res)) as { inviteLink: string; readyAfterMs: number };
    expect(body.readyAfterMs).toBe(3000);

    const join = await joinGroup(app, groupId, 'acc-02', body.inviteLink);
    expect(join.statusCode).toBe(409);
    expect(await join.json()).toMatchObject({
      code: 'INVITE_NOT_READY',
      readyAfterMs: expect.any(Number),
    });
    // 未就绪的 join 不受理：不入成员集、不推事件
    expect(await membersOf(app, groupId)).not.toContain(puidOf(app, 'acc-02'));
    expect(framesOf(app, 'member_joined')).toHaveLength(0);
  });

  it('arm 未钉参数：readyAfterMs 强制 >0（开关语义是制造未就绪，不是随机 0/几秒）', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', undefined, { groupId });
    const body = (await jsonOf(await app.inject({ method: 'POST', url: `/groups/${groupId}/invite` }))) as {
      readyAfterMs: number;
    };
    expect(body.readyAfterMs).toBeGreaterThan(0);
    expect(body.readyAfterMs).toBeLessThanOrEqual(5000); // mock 内部「数秒」档上界
  });

  it('钉值就绪后 join → 202 且 member_joined 按钉值到达（B2：等 readyAfterMs 后重试必成）', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    const inviteLink = await inviteReady(app, groupId, 40);
    await scenario(app, 'member_joined_delay', { delayMs: 20 }, { groupId });

    await sleep(80); // 越过钉值的 readyAfterMs
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(202);
    await sleep(80);
    expect(await membersOf(app, groupId)).toContain(puidOf(app, 'acc-02'));
    expect(framesOf(app, 'member_joined')).toHaveLength(1);
  });
});

describe('gw-21 invite_expired：join → 410 INVITE_EXPIRED（REQ §2.1：链接任意时刻可过期）', () => {
  it('arm 在 invite 之后也生效（join 时刻读开关）；新链接照 410；clear 后恢复受理', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    const inviteLink = await inviteReady(app, groupId);
    await scenario(app, 'invite_expired', undefined, { groupId });

    const res = await joinGroup(app, groupId, 'acc-02', inviteLink);
    expect(res.statusCode).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'INVITE_EXPIRED' });
    expect(await membersOf(app, groupId)).not.toContain(puidOf(app, 'acc-02'));

    // 「任意时刻」含重申之后：开关开着，新链接同样过期（B2「重申一次」的重试也要吃到 410）
    const inviteLink2 = await inviteReady(app, groupId);
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink2)).statusCode).toBe(410);

    await clearScenario(app, 'invite_expired');
    await scenario(app, 'member_joined_delay', { delayMs: 20 }, { groupId });
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink2)).statusCode).toBe(202);
    await sleep(80);
    expect(await membersOf(app, groupId)).toContain(puidOf(app, 'acc-02'));
  });
});

describe('gw-22 already_member：join → 409 ALREADY_MEMBER 且不推事件（REQ §2.1 明文；server D2-2 依赖）', () => {
  it('自然已在群：重 join 409 且 member_joined 计数不涨', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app); // acc-02 已真实入群（钉值 40ms 落定）
    const baseline = framesOf(app, 'member_joined').length;
    expect(baseline).toBe(1);

    const inviteLink = await inviteReady(app, groupId);
    const res = await joinGroup(app, groupId, 'acc-02', inviteLink);
    expect(res.statusCode).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ALREADY_MEMBER' });
    expect(framesOf(app, 'member_joined')).toHaveLength(baseline);
  });

  it('强制路径：账号并不在群也 409、不推事件，且成员集补真（QR §2：视为成功，随后 promote 能成）', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    const inviteLink = await inviteReady(app, groupId);
    await scenario(app, 'member_joined_delay', { delayMs: 0 }, { groupId }); // 若误排事件，立即暴露
    await scenario(app, 'already_member', undefined, { groupId, accountId: 'acc-02' });

    const res = await joinGroup(app, groupId, 'acc-02', inviteLink);
    expect(res.statusCode).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ALREADY_MEMBER' });
    await sleep(200); // 沉降窗：任何误排的 member_joined 都已到点
    expect(framesOf(app, 'member_joined')).toHaveLength(0);
    // 「已在群」必须自洽：成员集含该账号 → promote 200（D2-2 UPSERT 兜底链路的入口条件）
    expect(await membersOf(app, groupId)).toContain(puidOf(app, 'acc-02'));
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(200);
  });

  it('target 收窄：只对命中账号强制 409，未命中账号走正常入群路径', async () => {
    const app = newApp(['acc-01', 'acc-02', 'acc-03']);
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    await connect(app, 'acc-03');
    const groupId = await createGroup(app, 'acc-01');
    const inviteLink = await inviteReady(app, groupId);
    await scenario(app, 'member_joined_delay', { delayMs: 20 }, { groupId });
    await scenario(app, 'already_member', undefined, { accountId: 'acc-02' });

    expect((await joinGroup(app, groupId, 'acc-03', inviteLink)).statusCode).toBe(202);
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(409);
    await sleep(80);
    expect(framesOf(app, 'member_joined').map((frame) => frame.data['platformUserId'])).toEqual([
      puidOf(app, 'acc-03'),
    ]);
    const members = await membersOf(app, groupId);
    expect(members).toContain(puidOf(app, 'acc-03'));
    expect(members).toContain(puidOf(app, 'acc-02')); // 强制已在群 → 成员集补齐
  });
});

describe('gw-23 promote_not_member_yet：前 N 次 promote → 409 NOT_MEMBER_YET（A2：重试、总调用 ≤2）', () => {
  it('配 times=1：首次 409、第二次 200（卡面 b 项逐字；成员其实已在群 = 纯注入）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'promote_not_member_yet', { times: 1 }, { groupId });

    const first = await promote(app, groupId, 'acc-01', 'acc-02');
    expect(first.statusCode).toBe(409);
    expect(await first.json()).toMatchObject({ code: 'NOT_MEMBER_YET' });
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(200);
    expect(app.gatewayState.groups.get(groupId)?.promoted.has(puidOf(app, 'acc-02'))).toBe(true);
  });

  it('缺省 times=1；配 times=2 则两次 409 后第三次 200（「可配出现次数」）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    // 缺省档
    await scenario(app, 'promote_not_member_yet', undefined, { groupId });
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(409);
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(200);

    // 重新 arm = 覆盖参数且计数归零（DES/14 §4）
    await scenario(app, 'promote_not_member_yet', { times: 2 }, { groupId });
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(409);
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(409);
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(200);
  });

  it('clear 归零配额：clear 后 promote 落到自然判定 → 200', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'promote_not_member_yet', { times: 2 }, { groupId });
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(409);
    await clearScenario(app, 'promote_not_member_yet');
    expect((await promote(app, groupId, 'acc-01', 'acc-02')).statusCode).toBe(200);
  });

  it('按 (groupId,accountId) 作用域：A 群配额不殃及 B 群（target 收窄）', async () => {
    const app = newApp();
    const groupA = await makeGroupWithMember(app);
    const groupB = await makeGroupWithMember(app); // 复用 acc-01/acc-02；各自的 member_joined 帧独立
    await scenario(app, 'promote_not_member_yet', { times: 1 }, { groupId: groupA });

    expect((await promote(app, groupA, 'acc-01', 'acc-02')).statusCode).toBe(409);
    expect((await promote(app, groupB, 'acc-01', 'acc-02')).statusCode).toBe(200); // 未命中 target
    expect((await promote(app, groupA, 'acc-01', 'acc-02')).statusCode).toBe(200); // A 群配额已尽
  });
});

describe('gw-26 leave_500：leave → 500（没退成：成员保留、不推 member_left；QR §2 errors[]）', () => {
  it('500 且成员仍在、账本零 member_left；clear 后同账号正常退出', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const puid2 = puidOf(app, 'acc-02');
    await scenario(app, 'leave_500', undefined, { groupId, accountId: 'acc-02' });

    const res = await leave(app, groupId, 'acc-02');
    expect(res.statusCode).toBe(500);
    expect(await membersOf(app, groupId)).toContain(puid2); // 没退成
    await sleep(120); // 沉降窗：确认没有误推 member_left
    expect(framesOf(app, 'member_left')).toHaveLength(0);

    // target 收窄：群主不受影响可正常退（但群主退出语义不属本开关，留成员集即可证保留）
    await clearScenario(app, 'leave_500');
    expect((await leave(app, groupId, 'acc-02')).statusCode).toBe(200);
    await sleep(80);
    expect(await membersOf(app, groupId)).not.toContain(puid2);
    expect(framesOf(app, 'member_left').map((frame) => frame.data['platformUserId'])).toEqual([puid2]);
  });
});
