// demo:s4 —— S4 限流（REQ §2.4 S4；429 RATE_LIMITED {retryAfterSeconds}）。
// 断言：账号 rate_limited + rateLimitedUntil 正确；窗口内 sendCallsByAccount 冻结
//   （零试探——一次试探 mock 会重置计时）；到期自动回 online；排队消息按原序落地。
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
} from '../../server/tests/helpers/env.js';

let checks = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  checks += 1;
  console.log(`  ✓ ${label}`);
}

const env = await startScenarioEnv();
try {
  console.log('[s4] env up:', { server: env.serverUrl, gateway: env.gatewayUrl, db: env.db.name });

  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  await armSwitch(env, 'rate_limit', { accountId: 'acc-01' }, { retryAfterSeconds: 3 });
  console.log(`[s4] group active: db=${group.dbGroupId}；armed rate_limit acc-01 retryAfter=3s`);

  const m1 = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's4 first' });
  await waitFor(async () => (await gatewayCounters(env)).sendCallsByAccount['acc-01'] === 1);
  console.log(`[s4] m1=${m1} 触发 429（sendCallsByAccount=1）`);

  await waitFor(async () => (await getAccount(env, 'acc-01')).status === 'rate_limited');
  const acc = await getAccount(env, 'acc-01');
  ok(acc.status === 'rate_limited', 'account status=rate_limited');
  ok(acc.rateLimitedUntil !== null, `rateLimitedUntil=${acc.rateLimitedUntil}`);

  // 清开关不清窗口：「窗口独立于开关存在」——期内 mock 仍按已记窗口拒绝
  await clearSwitch(env, 'rate_limit');

  const m2 = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's4 second' });
  console.log(`[s4] m2=${m2} 窗口内受理（queued，dispatcher 硬闸门拦在网关前）`);

  // 硬门：窗口期内 sendCallsByAccount 冻结（零试探）
  const probeDeadline = Date.now() + 2200;
  let probes = 0;
  while (Date.now() < probeDeadline) {
    const c = await gatewayCounters(env);
    ok(c.sendCallsByAccount['acc-01'] === 1, `窗口内 sendCallsByAccount 冻结于 1（探测点 ${++probes}）`);
    await new Promise((r) => setTimeout(r, 120));
  }
  ok((await getAccount(env, 'acc-01')).status === 'rate_limited', '窗口内仍 rate_limited');
  console.log(`[s4] 零试探确认：${probes} 个探测点 sendCalls 恒为 1`);

  await waitFor(async () => (await getAccount(env, 'acc-01')).status === 'online', 8000);
  console.log('[s4] 到期自动恢复 online');
  await waitFor(async () => {
    const items = await timeline(env, group.dbGroupId);
    return [m1, m2].every((id) => items.some((i) => i.clientMsgId === id && i.deliveryStatus === 'sent'));
  });

  const items = await timeline(env, group.dbGroupId);
  const i1 = items.findIndex((i) => i.clientMsgId === m1);
  const i2 = items.findIndex((i) => i.clientMsgId === m2);
  ok(i1 >= 0 && i2 >= 0, 'm1/m2 均已 sent');
  ok(i2 < i1, '按原顺序落地（时间线 sent_at DESC：m2 在前）');
  ok(items[i1]?.sentAt !== items[i2]?.sentAt, '落地时刻不同（顺序有据）');

  const counters = await gatewayCounters(env);
  ok(counters.sendCallsByAccount['acc-01'] === 3, 'sendCallsByAccount=3（1×429 + 2×成功）');
  ok(counters.sendCallsByClientMsgId[m1] === 2, `m1 重发一次（429+成功）`);
  ok(counters.sendCallsByClientMsgId[m2] === 1, `m2 一次成功`);
  ok(counters.landedMessages === 2, 'landedMessages=2');

  console.log(`PASS s4 — checks=${checks}, counters=${JSON.stringify(counters)}`);
} finally {
  await env.close();
}
