// gw-4/5/19/28 开关测试（T-P2-12 c 项，先红后绿）。
// 契约出处：DES/14 §5 行 4/5/19/28、§3（乱序窗口 / 补投两行）、§1（R-G：补投 ≠ SSE 断线回放）、
// REQ §2.1（乱序 ≤1s；离线补投带新的更大 eventId + 原值 msgId/sentAt，不受 1s 窗口限制；
// 外部用户进出群同样推 member_joined/member_left）。
// 说明（真实定时器例外）：投递顺序/延迟必须真定时器观测；上界取契约区间之外的值作假绿防线。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { GatewayApp } from '../src/app.js';
import { createGatewayState, type LedgerFrame } from '../src/state.js';
import { resolveMemberJoinedDelayMs } from '../src/switches/timing.js';
import {
  clearScenario,
  collectFrames,
  connect,
  createGroup,
  createInvite,
  disconnect,
  framesOf,
  joinGroup,
  makeGroupWithMember,
  membersOf,
  newApp,
  postScenario,
  puidOf,
  scenario,
  send,
} from './helpers/gateway.js';

/** `/_test/emit` 手动注入（DES/14 §4）→ 返回分配的 eventId */
async function emit(app: GatewayApp, type: string, data: Record<string, unknown>): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/_test/emit', payload: { type, data } });
  expect(res.statusCode).toBe(200);
  return ((await res.json()) as { eventId: number }).eventId;
}

/** 取该类型第 index 帧；缺失即用例失败（收窄 undefined，不用非受控断言——宪法 §3-7） */
function frameAt(app: GatewayApp, type: LedgerFrame['type'], index = 0): LedgerFrame {
  const frame = framesOf(app, type)[index];
  if (frame === undefined) {
    throw new Error(`expected ledger frame #${index} of type ${type}`);
  }
  return frame;
}

/** 断言恰一帧并取出（同上：收窄 undefined） */
function singleFrame(frames: readonly LedgerFrame[], label: string): LedgerFrame {
  expect(frames, label).toHaveLength(1);
  const frame = frames[0];
  if (frame === undefined) {
    throw new Error(`expected exactly one frame: ${label}`);
  }
  return frame;
}

describe('gw-4 reorder_1s：相邻帧交换投递（乱序窗口 ≤1s，DES/14 §5 行 4）', () => {
  it('账本 [1,2] → 消费端收到 [2,1]；账本顺序不变（修饰只在投递层）', async () => {
    const app = newApp();
    await scenario(app, 'reorder_1s');
    await emit(app, 'account_status', { accountId: 'acc-01', status: 'suspended' });
    await emit(app, 'member_left', { groupId: 'gw-1', platformUserId: 'puid-x' });

    const frames = await collectFrames(app, '/events?since=0', 2);
    expect(frames.map((frame) => frame.id)).toEqual([2, 1]); // 相邻交换
    expect(frames.map((frame) => frame.event)).toEqual(['member_left', 'account_status']);
    expect(app.gatewayState.ledger.map((frame) => frame.eventId)).toEqual([1, 2]);
  });

  it('message 先于 message_sent（卡面点名）：落地两帧同刻产出 → 大 eventId 先到、msgId 同一', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 0 }, { groupId });
    await scenario(app, 'reorder_1s');

    const frames = await collectFrames(app, '/events', 2, async () => {
      expect((await send(app, groupId, 'acc-02', 'c-reorder', 'hello')).statusCode).toBe(202);
    });
    expect(frames.map((frame) => frame.event)).toEqual(['message', 'message_sent']);
    expect(frames[0]?.id).toBeGreaterThan(frames[1]?.id ?? Number.NaN); // 乱序：后产生的先到
    expect(frames[0]?.data['msgId']).toBe(frames[1]?.data['msgId']); // 同一条消息的两帧
  });

  it('扣住的尾帧必被冲刷（不丢帧）：单帧 + holdMs 钉 120 → ≥120ms 后到达', async () => {
    const app = newApp();
    await scenario(app, 'reorder_1s', { holdMs: 120 });
    let emittedAt = 0;
    const frames = await collectFrames(app, '/events', 1, async () => {
      emittedAt = Date.now();
      await emit(app, 'account_status', { accountId: 'acc-01', status: 'suspended' });
    });
    expect(frames).toHaveLength(1);
    expect(Date.now() - emittedAt).toBeGreaterThanOrEqual(120);
    expect(Date.now() - emittedAt).toBeLessThan(1000);
  });

  it('holdMs 超契约窗口被夹到 1s：钉 5000 → 尾帧仍 <1.5s 到达（乱序窗口 ≤1s 不可改写，宪法 §3-2）', async () => {
    const app = newApp();
    await scenario(app, 'reorder_1s', { holdMs: 5000 });
    let emittedAt = 0;
    const frames = await collectFrames(app, '/events', 1, async () => {
      emittedAt = Date.now();
      await emit(app, 'account_status', { accountId: 'acc-01', status: 'session_expired' });
    });
    expect(frames).toHaveLength(1);
    expect(Date.now() - emittedAt).toBeLessThan(1500);
  });

  it('未开开关 → 原序透传；流中关闭 → 先冲刷已扣住的帧再透传（不倒序、不丢帧）', async () => {
    const plain = newApp();
    await emit(plain, 'account_status', { accountId: 'acc-01', status: 'suspended' });
    await emit(plain, 'member_left', { groupId: 'gw-1', platformUserId: 'puid-x' });
    expect((await collectFrames(plain, '/events?since=0', 2)).map((frame) => frame.id)).toEqual([1, 2]);

    const app = newApp();
    await scenario(app, 'reorder_1s', { holdMs: 5000 });
    const frames = await collectFrames(app, '/events', 2, async () => {
      await emit(app, 'account_status', { accountId: 'acc-01', status: 'suspended' }); // 被扣住
      await clearScenario(app, 'reorder_1s');
      await emit(app, 'member_left', { groupId: 'gw-1', platformUserId: 'puid-x' }); // 触发冲刷 + 透传
    });
    expect(frames.map((frame) => frame.id)).toEqual([1, 2]);
  });
});

describe('gw-5 offline_backlog：账号离线补投（新 eventId + 原值 msgId/sentAt，REQ §2.1 / DES/14 §5 行 5）', () => {
  it('补投帧带新的更大 eventId、原值 msgId/sentAt；不产生第二条落地记录', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 0 }, { groupId });
    expect((await send(app, groupId, 'acc-02', 'c-backlog', 'first')).statusCode).toBe(202);
    await sleep(60);
    const original = frameAt(app, 'message');

    await disconnect(app, 'acc-02'); // 离线补投的前提语义（REQ §2.1「离线账号之前发过的消息」）
    const eventIdBefore = app.gatewayState.eventIdCounter;
    await scenario(app, 'offline_backlog', undefined, { accountId: 'acc-02', groupId });

    const redelivered = singleFrame(
      framesOf(app, 'message').filter((frame) => frame.eventId > eventIdBefore),
      'backlog',
    );
    expect(redelivered.eventId).toBeGreaterThan(original.eventId); // 新的更大 eventId
    expect(redelivered.data).toEqual({ ...original.data, eventId: redelivered.eventId }); // 原值 msgId/sentAt
    expect(redelivered.data['msgId']).toBe(original.data['msgId']);
    expect(redelivered.data['sentAt']).toBe(original.data['sentAt']);
    expect(app.gatewayState.counters.landedMessages).toBe(1); // 补投 ≠ 第二条落地消息
  });

  it('补投走正常 SSE 投放：在线消费者实时收到该帧（新 eventId）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 0 }, { groupId });
    expect((await send(app, groupId, 'acc-02', 'c-live-backlog', 'hello')).statusCode).toBe(202);
    await sleep(60);
    const original = frameAt(app, 'message');

    const frames = await collectFrames(app, '/events', 1, async () => {
      await scenario(app, 'offline_backlog', undefined, { accountId: 'acc-02', groupId });
    });
    expect(frames[0]?.event).toBe('message');
    expect(frames[0]?.id).toBeGreaterThan(original.eventId);
    expect(frames[0]?.data['msgId']).toBe(original.data['msgId']);
    expect(frames[0]?.data['sentAt']).toBe(original.data['sentAt']);
  });

  it('sentAt 任意早 + 离线窗口过滤：只补投窗口内那条，其 sentAt 早于后收消息而 eventId 更大', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 0 }, { groupId });
    expect((await send(app, groupId, 'acc-02', 'c-old', 'old')).statusCode).toBe(202);
    await sleep(80); // 让两条消息的 sentAt 拉开可观测的间隔
    expect((await send(app, groupId, 'acc-02', 'c-new', 'new')).statusCode).toBe(202);
    await sleep(60);
    const older = frameAt(app, 'message', 0);
    const newer = frameAt(app, 'message', 1);

    const eventIdBefore = app.gatewayState.eventIdCounter;
    await scenario(
      app,
      'offline_backlog',
      { sentAtUntilMs: Date.parse(older.data['sentAt'] as string) }, // 离线窗口只覆盖较早那条
      { accountId: 'acc-02', groupId },
    );

    const redelivered = singleFrame(
      framesOf(app, 'message').filter((frame) => frame.eventId > eventIdBefore),
      'backlog in window',
    );
    expect(redelivered.data['sentAt']).toBe(older.data['sentAt']);
    // 关键不变量：eventId 更大而 sentAt 更早——排序只能用 sentAt，不能用到达顺序/eventId（QR §1）
    expect(Date.parse(redelivered.data['sentAt'] as string)).toBeLessThan(Date.parse(newer.data['sentAt'] as string));
    expect(redelivered.eventId).toBeGreaterThan(newer.eventId);
  });

  it('R-G 区分：since 回放是默认行为（原 eventId、账本零新增），gw-5 才产生新 eventId 的补投帧', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 0 }, { groupId });
    expect((await send(app, groupId, 'acc-02', 'c-rg', 'hello')).statusCode).toBe(202);
    await sleep(60);
    const before = app.gatewayState.ledger.map((frame) => frame.eventId);

    // gw-5：补投 = 账本**新增**一帧、eventId 更大（是新事件），业务字段仍为原值
    await scenario(app, 'offline_backlog', undefined, { accountId: 'acc-02', groupId });
    const afterBacklog = app.gatewayState.ledger.map((frame) => frame.eventId);
    expect(afterBacklog).toHaveLength(before.length + 1);
    expect(afterBacklog.at(-1) ?? Number.NaN).toBeGreaterThan(Math.max(...before));

    // R-G 的另一半：断线重连补拉**不需要任何开关**、回放既有 eventId、账本零新增——与补投不是一回事
    const replayed = await collectFrames(app, '/events?since=0', afterBacklog.length);
    expect(replayed.map((frame) => frame.id)).toEqual(afterBacklog);
    expect(app.gatewayState.ledger.map((frame) => frame.eventId)).toEqual(afterBacklog);
  });

  it('arrange 失败面：窗口无命中 / 账号不存在 / 缺 accountId → 400 且开关不登记', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    expect(
      (await postScenario(app, 'offline_backlog', { sentAtFromMs: Date.now() + 60_000 }, { accountId: 'acc-02', groupId }))
        .statusCode,
    ).toBe(400); // 无命中 = arrange 写错，不静默无效
    expect((await postScenario(app, 'offline_backlog', undefined, { accountId: 'acc-nope' })).statusCode).toBe(400);
    expect((await postScenario(app, 'offline_backlog')).statusCode).toBe(400);
    expect(app.gatewayState.switches.has('offline_backlog')).toBe(false); // 不留半生效状态
  });
});

describe('gw-19 member_joined_delay：钉值精确生效（DES/14 §5 行 19）', () => {
  it('钉 40ms（契约区间 100–1500ms 下沿之下）：join 202 即回，member_joined 恰 ≥40ms 且 <100ms 到达', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    await connect(app, 'acc-02');
    const groupId = await createGroup(app, 'acc-01');
    await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId });
    const inviteLink = await createInvite(app, groupId);
    await scenario(app, 'member_joined_delay', { delayMs: 40 }, { groupId });

    const started = Date.now();
    expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(40); // 202 只表示受理，入群以事件为准（REQ §2.1）
    expect(framesOf(app, 'member_joined')).toHaveLength(0);

    await sleep(150);
    const joined = framesOf(app, 'member_joined');
    expect(joined).toHaveLength(1);
    const arrivedAfterMs = (joined[0]?.emittedAt ?? Number.NaN) - started;
    expect(arrivedAfterMs).toBeGreaterThanOrEqual(40); // 恰钉值后到达
    expect(arrivedAfterMs).toBeLessThan(100); // < 契约下沿 → 只能是钉值生效
    expect(joined[0]?.data).toMatchObject({ groupId, platformUserId: puidOf(app, 'acc-02') });
  });

  it('未钉值 → 延迟取自契约区间 [100,1500]ms（QR §1 数字不可改写；守护常量归宿迁移）', () => {
    const state = createGatewayState(['acc-01']);
    const samples = Array.from({ length: 200 }, () => resolveMemberJoinedDelayMs(state, { groupId: 'gw-1' }));
    for (const ms of samples) {
      expect(ms).toBeGreaterThanOrEqual(100);
      expect(ms).toBeLessThanOrEqual(1500);
    }
    // 区间两端都被覆盖到（均匀随机 200 次落在窄段的概率 < 1e-9）：证明用的是整个契约区间
    expect(Math.min(...samples)).toBeLessThan(250);
    expect(Math.max(...samples)).toBeGreaterThan(1350);
  });
});

describe('gw-28 external_member_events：外部用户进出群推成员事件（DES/14 §5 行 28）', () => {
  it('arm → mock 自造 ext-<seq> 外部用户入群并推 member_joined；网关成员列表含它', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'external_member_events', undefined, { groupId });

    const joined = framesOf(app, 'member_joined').at(-1);
    const extPuid = joined?.data['platformUserId'] as string;
    expect(extPuid).toMatch(/^ext-\d+$/); // mock 自造 id（DES/14 §2 末行）
    expect([puidOf(app, 'acc-01'), puidOf(app, 'acc-02')]).not.toContain(extPuid); // 非服务账号
    expect(joined?.data['groupId']).toBe(groupId);
    expect(await membersOf(app, groupId)).toContain(extPuid); // 网关视角当前成员
  });

  it('action=left → 该外部用户退群并推 member_left；成员列表不再含它（服务账号成员不受影响）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'external_member_events', undefined, { groupId });
    const extPuid = framesOf(app, 'member_joined').at(-1)?.data['platformUserId'] as string;

    await scenario(app, 'external_member_events', { action: 'left' }, { groupId });
    const left = framesOf(app, 'member_left').at(-1);
    expect(left?.data).toMatchObject({ groupId, platformUserId: extPuid });
    const members = await membersOf(app, groupId);
    expect(members).not.toContain(extPuid);
    expect(members).toEqual(expect.arrayContaining([puidOf(app, 'acc-01'), puidOf(app, 'acc-02')]));
  });

  it('外部成员事件经 SSE 正常推送（在线消费者实时收到 joined 与 left）', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    const frames = await collectFrames(app, '/events', 2, async () => {
      await scenario(app, 'external_member_events', undefined, { groupId });
      await scenario(app, 'external_member_events', { action: 'left' }, { groupId });
    });
    expect(frames.map((frame) => frame.event)).toEqual(['member_joined', 'member_left']);
    expect(frames[0]?.data['platformUserId']).toMatch(/^ext-\d+$/);
    expect(frames[1]?.data['platformUserId']).toBe(frames[0]?.data['platformUserId']);
  });

  it('arrange 失败面：缺 target.groupId / 群不存在 / left 但群内无外部成员 / action 非法 → 400 且不登记', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    expect((await postScenario(app, 'external_member_events')).statusCode).toBe(400);
    expect((await postScenario(app, 'external_member_events', undefined, { groupId: 'gw-nope' })).statusCode).toBe(400);
    expect((await postScenario(app, 'external_member_events', { action: 'left' }, { groupId })).statusCode).toBe(400);
    expect((await postScenario(app, 'external_member_events', { action: 'teleport' }, { groupId })).statusCode).toBe(400);
    expect(app.gatewayState.switches.has('external_member_events')).toBe(false);
  });
});
