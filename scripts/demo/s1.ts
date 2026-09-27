// demo:s1 —— S1 受理与发出（REQ §2.4 S1；一条命令编排，断言走 /_test/counters + REST 读面）。
// 编排：起环境（真 PG 测试库 + in-process mock ×2 + 真实 server）→ 建群 → 钉两段延迟 →
//   send → accepted 窗口断言 → message_sent → sent 断言 → counters 快照 → PASS 摘要 → 清理。
// 可重复运行：测试库 kapibala_test_<rand>，结束 DROP；失败也清理（finally）。
import {
  armSwitch,
  countRows,
  gatewayCounters,
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
  console.log('[s1] env up:', { server: env.serverUrl, gateway: env.gatewayUrl, db: env.db.name });

  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  console.log(`[s1] group active: db=${group.dbGroupId} gw=${group.gwGroupId} (job ${group.jobId})`);

  await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
  await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 1500 });
  console.log('[s1] switches: send_accept_slow=0ms, message_sent_delay=1500ms');

  const clientMsgId = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's1 hello' });
  console.log(`[s1] sent → 202 clientMsgId=${clientMsgId}`);

  // 窗口断言：message_sent 之前 deliveryStatus='accepted'
  await waitFor(async () =>
    (await timeline(env, group.dbGroupId)).some(
      (i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'accepted',
    ),
  );
  const before = (await timeline(env, group.dbGroupId)).filter((i) => i.clientMsgId === clientMsgId);
  ok(before.length === 1, `message_sent 之前恰一行（got ${before.length}）`);
  ok(before[0]?.deliveryStatus === 'accepted', `deliveryStatus='accepted'（got ${before[0]?.deliveryStatus}）`);
  ok(before[0]?.msgId === null, 'msgId 未回填（message_sent 未到）');

  // 事件到达后 → 'sent' + msgId 回填
  await waitFor(async () => (await gatewayCounters(env)).landedMessages >= 1);
  await waitFor(async () =>
    (await timeline(env, group.dbGroupId)).some(
      (i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'sent' && i.msgId !== null,
    ),
  );
  const after = (await timeline(env, group.dbGroupId)).filter((i) => i.clientMsgId === clientMsgId);
  ok(after.length === 1, `message_sent 之后恰一行（got ${after.length}）`);
  ok(after[0]?.deliveryStatus === 'sent', `deliveryStatus='sent'（got ${after[0]?.deliveryStatus}）`);
  ok(after[0]?.msgId !== null, `msgId 回填（${after[0]?.msgId}）`);

  const counters = await gatewayCounters(env);
  ok(counters.sendCallsByAccount['acc-01'] === 1, 'sendCallsByAccount[acc-01]=1');
  ok(counters.sendCallsByClientMsgId[clientMsgId] === 1, 'sendCallsByClientMsgId=1');
  ok(counters.landedMessages === 1, 'landedMessages=1');
  ok(
    (await countRows(env.pool, `SELECT count(*) AS n FROM message WHERE client_msg_id=$1`, [clientMsgId])) === 1,
    'message 行恰一条（库口径）',
  );

  console.log(`PASS s1 — checks=${checks}, counters=${JSON.stringify(counters)}`);
} finally {
  await env.close();
}
