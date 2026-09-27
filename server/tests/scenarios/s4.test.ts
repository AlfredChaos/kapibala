// S4 限流（REQ §2.4 S4 行、analysis/09 §1、DES/14 §8）。
// 逐字断言：「网关对 send 回 429 RATE_LIMITED { retryAfterSeconds: N }」→
//   账号 rate_limited + rateLimitedUntil 正确；期内网关收不到该账号的任何 send
//   （sendCallsByAccount 不再增长——计数在进入路由时即计，429 那一下已算进 baseline；
//   一次试探就会让 mock 重置计时，硬门因此是「计数冻结」）；
//   到期自动恢复（rate_limit 扫描回 online）→ 排队消息按原顺序发出。
// 断言真值：GET /api/accounts/:id 状态面 + GET /_test/counters.sendCallsByAccount。
import { describe, expect, it } from 'vitest';
import {
  armSwitch,
  clearSwitch,
  gatewayCounters,
  getAccount,
  sendMessage,
  setupGroup,
  startScenarioEnv,
  timeline,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

describe('S4 限流（REQ §2.4 S4）', () => {
  it('429 → rate_limited；窗口内零试探；到期恢复后按序发出', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      // retryAfterSeconds=3：窗口必须跨过「m1 429 → 窗口内零试探 → 到期 → m1/m2 依序落地」全链
      await armSwitch(env, 'rate_limit', { accountId: 'acc-01' }, { retryAfterSeconds: 3 });

      // act-1：第一条 send 吃掉 429（202 受理在前，失败在 dispatcher 侧发生）
      const m1 = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's4 first' });
      await waitFor(async () => (await gatewayCounters(env)).sendCallsByAccount['acc-01'] === 1);

      // assert-1：账号进入 rate_limited 且 rateLimitedUntil 指向未来
      await waitFor(async () => (await getAccount(env, 'acc-01')).status === 'rate_limited');
      const acc = await getAccount(env, 'acc-01');
      expect(acc.rateLimitedUntil).not.toBeNull();
      expect(Date.parse(acc.rateLimitedUntil as string)).toBeGreaterThan(Date.now());

      // 开关保持武装会永久拒（"期内任何 send 再 429"针对开关命中）；clear 后 mock 仍按
      // 已记录的窗口（rateLimitedUntil）拒绝——正是「窗口独立于开关存在」的契约语义
      await clearSwitch(env, 'rate_limit');

      // act-2：窗口内再排第二条（受理照常 queued——限流不阻断受理，REQ §2.1.1；
      //   dispatcher 硬闸门拦在网关调用前，不会产生 send 计数）
      const m2 = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's4 second' });
      // assert-2（硬门）：窗口剩余期内对该账号的 send 调用数冻结在 baseline（零试探，
      //   否则 mock 会重置 rateLimitedUntil——一旦泄漏试探，后续断言全盘失真，故先钉死窗口）
      const probeDeadline = Date.now() + 2200; // 明显短于 3s 窗口余量
      while (Date.now() < probeDeadline) {
        expect((await gatewayCounters(env)).sendCallsByAccount['acc-01']).toBe(1);
        await new Promise((r) => setTimeout(r, 120));
      }
      expect((await getAccount(env, 'acc-01')).status).toBe('rate_limited'); // 仍在窗口内

      // assert-3：到期自动恢复 online → 排队消息依序全部落地（序号升序）
      await waitFor(async () => (await getAccount(env, 'acc-01')).status === 'online', 8000);
      await waitFor(async () => {
        const items = await timeline(env, group.dbGroupId);
        return [m1, m2].every((id) =>
          items.some((i) => i.clientMsgId === id && i.deliveryStatus === 'sent'),
        );
      });
      const items = await timeline(env, group.dbGroupId);
      const i1 = items.findIndex((i) => i.clientMsgId === m1);
      const i2 = items.findIndex((i) => i.clientMsgId === m2);
      expect(i2).toBeGreaterThanOrEqual(0);
      // 时间线按 sentAt 降序（ORDER BY sent_at DESC）：「按原顺序」= m1 先落地 → m2 在前（索引更小）
      expect(i2).toBeLessThan(i1);
      expect(items[i2]?.sentAt !== items[i1]?.sentAt).toBe(true); // 顺序有据：落地时刻不同

      const counters = await gatewayCounters(env);
      // 恢复后 m1 重发 + m2 首发 → 该账号总 send 调用数恰为 3（1 次 429 + 2 次成功）
      expect(counters.sendCallsByAccount['acc-01']).toBe(3);
      expect(counters.sendCallsByClientMsgId[m1]).toBe(2); // 429 一次 + 恢复后成功一次
      expect(counters.sendCallsByClientMsgId[m2]).toBe(1);
      expect(counters.landedMessages).toBe(2);

      await clearSwitch(env); // 幂等清理（库随 env.close() 整体销毁，开关态也归零）
    } finally {
      await env.close();
    }
  }, 30_000);
});
