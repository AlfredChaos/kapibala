// gw-1/2/3 开关与 counters 完备性测试（T-P1-05 c 项，先红后绿）。
// 契约出处：DES/14 §5 行 1/2/3（send_accept_slow / message_sent_delay / dup_push_all）、
// §4（counters 是验收断言真值来源；同一开关重复调用 = 覆盖参数）；S1/S2 编排（VITEST_PLAN §2）。
// 说明（真实定时器例外）：钉值时序断言必须观测真实时钟（>= 钉值 + 有限上界）；
// 上界一律取**契约区间之外**的值——钉值被忽略时随机延迟必落在区间内，测试即变红（假绿防线）。
// 投递 seam 的乱序/延迟自检随 gw-4 落在 tests/switches-timing.test.ts（T-P2-12）。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  collectFrames,
  countersOf,
  framesOf,
  makeGroupWithMember,
  newApp,
  puidOf,
  scenario,
  send,
} from './helpers/gateway.js';

describe('gw-3 dup_push_all：每个事件帧投递两次（同 eventId，DES/14 §5 行 3）', () => {
  it('实时帧：一条 emit → 同一帧投递两次（id 与线上字节全同）；账本仍一行、framesEmitted 仍 1', async () => {
    const app = newApp();
    await scenario(app, 'dup_push_all');
    const frames = await collectFrames(app, '/events', 2, async () => {
      const emit = await app.inject({
        method: 'POST',
        url: '/_test/emit',
        payload: { type: 'account_status', data: { accountId: 'acc-01', status: 'suspended' } },
      });
      expect(emit.statusCode).toBe(200);
    });

    expect(frames.map((frame) => frame.id)).toEqual([1, 1]); // 同 eventId 投递两次
    expect(frames[1]?.event).toBe('account_status');
    expect(frames[1]?.wire).toBe(frames[0]?.wire); // 同一帧的复制，不是第二条事件
    // 双推是**投递层**行为（d 项）：账本一行、eventId 不重复分配、framesEmitted 计账本产出不计投递
    expect(app.gatewayState.ledger).toHaveLength(1);
    expect(app.gatewayState.counters.framesEmitted).toBe(1);
  });

  it('回放帧同样双推：2 条历史 + since=0 → 4 帧，eventId 两两成对 [1,1,2,2]', async () => {
    const app = newApp();
    await scenario(app, 'dup_push_all');
    for (const accountId of ['acc-01', 'acc-02']) {
      const emit = await app.inject({
        method: 'POST',
        url: '/_test/emit',
        payload: { type: 'account_status', data: { accountId, status: 'suspended' } },
      });
      expect(emit.statusCode).toBe(200);
    }

    const frames = await collectFrames(app, '/events?since=0', 4);
    expect(frames.map((frame) => frame.id)).toEqual([1, 1, 2, 2]);
    expect(app.gatewayState.ledger).toHaveLength(2); // 回放双推也不改账本
  });

  it('since 独占语义不被双推改写：since=1 → 只投 eventId 2（两次），eventId 1 一帧不回放', async () => {
    const app = newApp();
    await scenario(app, 'dup_push_all');
    for (const accountId of ['acc-01', 'acc-02']) {
      await app.inject({
        method: 'POST',
        url: '/_test/emit',
        payload: { type: 'account_status', data: { accountId, status: 'suspended' } },
      });
    }

    const frames = await collectFrames(app, '/events?since=1', 2);
    expect(frames.map((frame) => frame.id)).toEqual([2, 2]);
  });
});

describe('gw-1 send_accept_slow / gw-2 message_sent_delay：钉值精确生效（DES/14 §5 行 1/2）', () => {
  it('gw-1 钉 1500ms：send 202 不早于 1500ms 返回；改钉 300ms（契约下沿 1000ms 之下）即跟钉值', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);

    await scenario(app, 'send_accept_slow', { delayMs: 1500 }, { groupId });
    let started = Date.now();
    let res = await send(app, groupId, 'acc-02', 'c-slow-1500');
    expect(res.statusCode).toBe(202);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500); // setTimeout 语义：不早于钉值

    // 覆盖为区间外钉值：钉值若未生效，延迟必落在契约区间 [1000,2000] 内 → 上界断言变红
    await scenario(app, 'send_accept_slow', { delayMs: 300 }, { groupId });
    started = Date.now();
    res = await send(app, groupId, 'acc-02', 'c-slow-300');
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(202);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(1000);
  });

  it('gw-2 钉 80ms：202 即回（gw-1 钉 0），message_sent 帧恰在 ≥80ms 后入账本', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 80 }, { groupId });

    const started = Date.now();
    const res = await send(app, groupId, 'acc-02', 'c-msd');
    expect(res.statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(80); // 两段独立计时：202 不等 message_sent（DES/14 §3）
    expect(framesOf(app, 'message_sent')).toHaveLength(0);

    await sleep(30);
    expect(framesOf(app, 'message_sent')).toHaveLength(0); // 钉值未到
    await sleep(200);
    const sent = framesOf(app, 'message_sent');
    expect(sent).toHaveLength(1);
    const landedAfterMs = (sent[0]?.emittedAt ?? Number.NaN) - started;
    expect(landedAfterMs).toBeGreaterThanOrEqual(80); // 恰钉值后到达
    expect(landedAfterMs).toBeLessThan(300);
  });

  it('开关重复调用 = 覆盖参数（不叠加）：message_sent_delay 先钉 300 后钉 0 → 落地跟 0', async () => {
    const app = newApp();
    const groupId = await makeGroupWithMember(app);
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 300 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 0 }, { groupId }); // 覆盖（DES/14 §4）

    const started = Date.now();
    expect((await send(app, groupId, 'acc-02', 'c-override')).statusCode).toBe(202);
    await sleep(60);
    const sent = framesOf(app, 'message_sent');
    expect(sent).toHaveLength(1);
    // 契约区间下沿 50ms：<50 只可能来自钉值 0（未覆盖则 ≥300，钉值被忽略则 ≥50）
    expect((sent[0]?.emittedAt ?? Number.NaN) - started).toBeLessThan(50);
  });
});

describe('counters 完备性（DES/14 §4：验收断言的真值来源）', () => {
  it('五项计数与实际调用一一对应；被拒的 send 也计调用；reset 全部清零', async () => {
    const app = newApp();
    // 2 条手动注入事件：入账本计 framesEmitted，但不是落地消息（不计 landedMessages）
    for (const accountId of ['acc-01', 'acc-02']) {
      const emit = await app.inject({
        method: 'POST',
        url: '/_test/emit',
        payload: { type: 'account_status', data: { accountId, status: 'suspended' } },
      });
      expect(emit.statusCode).toBe(200);
    }
    const groupId = await makeGroupWithMember(app, 30); // +1 帧 member_joined
    await scenario(app, 'send_accept_slow', { delayMs: 0 }, { groupId });
    await scenario(app, 'message_sent_delay', { delayMs: 20 }, { groupId });

    // 2 次落地 send：同 clientMsgId、不同账号（网关不按 clientMsgId 去重，DES/14 §2）→ 各 +2 帧
    expect((await send(app, groupId, 'acc-02', 'c-cnt')).statusCode).toBe(202);
    expect((await send(app, groupId, 'acc-01', 'c-cnt')).statusCode).toBe(202);
    // 1 次被拒 send（群不存在 → 404）：调用照计、不落地——counters 计「尝试」，S4 零试探断言的语义基础
    expect((await send(app, 'gw-does-not-exist', 'acc-02', 'c-nope')).statusCode).toBe(404);
    // 1 次被拒 kick（acc-02 非群主且未 promote → 403）：调用照计
    const kick = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/kick`,
      payload: { byAccountId: 'acc-02', targetPlatformUserId: puidOf(app, 'acc-01') },
    });
    expect(kick.statusCode).toBe(403);
    await sleep(80); // 等两条 message_sent/message 落定

    expect(await countersOf(app)).toEqual({
      sendCallsByAccount: { 'acc-02': 2, 'acc-01': 1 },
      sendCallsByClientMsgId: { 'c-cnt': 2, 'c-nope': 1 },
      landedMessages: 2,
      kickCalls: 1,
      framesEmitted: 7, // 2 emit + 1 member_joined + 2×(message_sent + message)
    });

    expect((await app.inject({ method: 'POST', url: '/_test/reset' })).statusCode).toBe(200);
    expect(await countersOf(app)).toEqual({
      sendCallsByAccount: {},
      sendCallsByClientMsgId: {},
      landedMessages: 0,
      kickCalls: 0,
      framesEmitted: 0,
    });
  });
});
