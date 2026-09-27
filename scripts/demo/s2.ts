// demo:s2 —— S2 事件重复（REQ §2.4 S2；dup_push_all：每个事件帧投两次）。
// 断言：时间线无重复行、agent_run 恰一个（重复帧不重复触发）、agent_trigger_queue 空、
//   gateway_event 行数 == mock framesEmitted（账本产出数；投递层复制被吸收）。
import {
  armSwitch,
  countRows,
  emitEvent,
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
  console.log('[s2] env up:', { server: env.serverUrl, gateway: env.gatewayUrl, db: env.db.name });

  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  await patchGroup(env, group.dbGroupId, { agentEnabled: true });
  console.log(`[s2] group active + agentEnabled: db=${group.dbGroupId} gw=${group.gwGroupId}`);

  await armSwitch(env, 'dup_push_all');
  await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
  await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 0 });
  console.log('[s2] switches: dup_push_all（每帧投两次）+ 两段延迟钉 0');

  const clientMsgId = await sendMessage(env, group.dbGroupId, { accountId: 'acc-01', text: 's2 own' });
  await waitFor(async () => (await gatewayCounters(env)).landedMessages >= 1);
  await waitFor(async () =>
    (await timeline(env, group.dbGroupId)).some(
      (i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'sent',
    ),
  );
  console.log(`[s2] own msg sent+confirmed (clientMsgId=${clientMsgId})`);

  const externalMsgId = 'msg-ext-s2-1';
  await emitEvent(env, 'message', {
    groupId: group.gwGroupId,
    msgId: externalMsgId,
    senderPlatformUserId: 'pu-external-s2',
    text: 's2 external hello',
    sentAt: new Date().toISOString(),
  });
  console.log('[s2] emitted external message（dup_push_all 下该帧投两次）');

  await waitFor(
    async () =>
      (await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [
        group.dbGroupId,
      ])) >= 1,
  );
  // SSE 水位对齐：账本产出的每帧都应入库（dup 帧被吸收；framesEmitted 不增产）
  await waitFor(async () => {
    const frames = (await gatewayCounters(env)).framesEmitted;
    const stored = await countRows(env.pool, `SELECT count(*) AS n FROM gateway_event`, []);
    return stored >= frames && frames > 0;
  });

  const items = await timeline(env, group.dbGroupId);
  ok(
    items.filter((i) => i.clientMsgId === clientMsgId).length === 1,
    'own 消息恰一行（dup message_sent 被吸收）',
  );
  ok(
    items.filter((i) => i.msgId === externalMsgId).length === 1,
    '外部消息恰一行（dup message 被吸收）',
  );
  ok(
    (await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [
      group.dbGroupId,
    ])) === 1,
    'agent_run 恰一个（重复帧未重复触发）',
  );
  ok(
    (await countRows(env.pool, `SELECT count(*) AS n FROM agent_trigger_queue WHERE group_id=$1`, [
      group.dbGroupId,
    ])) === 0,
    'agent_trigger_queue 为空',
  );

  const counters = await gatewayCounters(env);
  ok(
    (await countRows(env.pool, `SELECT count(*) AS n FROM gateway_event`, [])) === counters.framesEmitted,
    `gateway_event 行数 == framesEmitted=${counters.framesEmitted}（每事件恰一行）`,
  );
  ok(counters.landedMessages === 1, 'landedMessages=1');

  console.log(`PASS s2 — checks=${checks}, counters=${JSON.stringify(counters)}`);
} finally {
  await env.close();
}
