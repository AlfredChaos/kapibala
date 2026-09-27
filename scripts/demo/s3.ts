// demo:s3 —— S3 自己的消息回流（REQ §2.4 S3；网关把服务账号发的消息推回为 message）。
// 断言：与出站记录合并为一行（isOwn=true、sent、msgId 回填）；agentEnabled=true 仍零 agent run。
import {
  armSwitch,
  countRows,
  gatewayCounters,
  patchGroup,
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
  console.log('[s3] env up:', { server: env.serverUrl, gateway: env.gatewayUrl, db: env.db.name });

  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  await patchGroup(env, group.dbGroupId, { agentEnabled: true });
  console.log(`[s3] group active + agentEnabled: db=${group.dbGroupId} gw=${group.gwGroupId}`);

  await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
  await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 0 });

  const clientMsgId = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's3 reflux' });
  console.log(`[s3] sent ${clientMsgId}；mock 落地后自动回流 message（sender=服务账号 puid）`);

  await waitFor(async () => (await gatewayCounters(env)).landedMessages >= 1);
  await waitFor(async () =>
    (await timeline(env, group.dbGroupId)).some(
      (i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'sent',
    ),
  );
  await waitFor(async () => {
    const frames = (await gatewayCounters(env)).framesEmitted;
    const stored = await countRows(env.pool, `SELECT count(*) AS n FROM gateway_event`, []);
    return stored >= frames && frames > 0;
  });

  const items = await timeline(env, group.dbGroupId);
  const rows = items.filter((i) => i.clientMsgId === clientMsgId);
  ok(rows.length === 1, `出站+回流合并恰一行（got ${rows.length}）`);
  ok(rows[0]?.isOwn === true, 'isOwn=true');
  ok(rows[0]?.deliveryStatus === 'sent', `deliveryStatus='sent'`);
  ok(rows[0]?.msgId !== null, `msgId=${rows[0]?.msgId}`);
  ok(
    items.filter((i) => i.msgId === rows[0]?.msgId).length === 1,
    '按 msgId 也恰一行（无独立回流行）',
  );
  ok(
    (await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [
      group.dbGroupId,
    ])) === 0,
    'agent_run=0（agentEnabled=true 也不触发）',
  );
  ok(
    (await countRows(env.pool, `SELECT count(*) AS n FROM agent_trigger_queue WHERE group_id=$1`, [
      group.dbGroupId,
    ])) === 0,
    'agent_trigger_queue=0',
  );

  const counters = await gatewayCounters(env);
  console.log(`PASS s3 — checks=${checks}, counters=${JSON.stringify(counters)}`);
} finally {
  await env.close();
}
