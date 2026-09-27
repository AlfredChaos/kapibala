// demo:s5 —— S5 Agent 重试同一个幂等 key（REQ §2.4 S5 逐字）。
// 剧本：send_message(key=K) → send_message(同 K) → finish；网关 gw-7：首调 504、1.5s 后落地。
// 断言：网关恰一条消息（sendCallsByClientMsgId 合计=1，landedMessages=1）、审计恰一次
//   （audit_verdict='pass' 步数=1——幂等命中短路）、第二个 send 步返回 sent、run finished/final。
import {
  emitEvent,
  gatewayCounters,
  patchGroup,
  queryRows,
  setupGroup,
  startScenarioEnv,
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
  console.log('[s5] env up:', { server: env.serverUrl, gateway: env.gatewayUrl, agent: env.agentUrl });

  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  await patchGroup(env, group.dbGroupId, { agentEnabled: true });
  console.log(`[s5] group active: db=${group.dbGroupId}`);

  // gw-7：send 504、1.5s 后落地
  await fetch(`${env.gatewayUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ switch: 'send_504_land_1500', params: {}, target: {} }),
  });
  // 剧本：同 key 两次 send_message → finish
  await fetch(`${env.agentUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      switch: 'playbook',
      params: {
        steps: [
          { kind: 'tool_use', name: 'send_message', input: { text: 's5 msg', idempotency_key: 's5-key-1' } },
          { kind: 'tool_use', name: 'send_message', input: { text: 's5 msg', idempotency_key: 's5-key-1' } },
          { kind: 'finish', summary: 's5 done' },
        ],
      },
      target: {},
    }),
  });
  console.log('[s5] armed: gw send_504_land_1500 + agent playbook(send→send→finish)');

  await emitEvent(env, 'message', {
    groupId: group.gwGroupId,
    msgId: 'msg-s5-inbound',
    senderPlatformUserId: 'puid-acc-02',
    text: 'please announce',
    sentAt: new Date().toISOString(),
  });

  await waitFor(async () => {
    const rows = await queryRows<{ status: string }>(
      env.pool,
      `SELECT status FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [group.dbGroupId],
    );
    return rows[0] !== undefined && ['finished', 'failed', 'blocked'].includes(rows[0].status);
  }, 20000);
  const [run] = await queryRows<{ id: string; status: string; end_reason: string | null }>(
    env.pool,
    `SELECT id, status, end_reason FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [group.dbGroupId],
  );
  console.log(`[s5] run ${run?.id} → ${run?.status}/${run?.end_reason}`);
  ok(run?.status === 'finished' && run?.end_reason === 'final', 'run finished/final');

  const counters = await gatewayCounters(env);
  const totalSends = Object.values(counters.sendCallsByClientMsgId).reduce((a, b) => a + b, 0);
  ok(totalSends === 1, `gateway sendCallsByClientMsgId total = 1 (got ${totalSends})`);
  ok(counters.landedMessages === 1, `landedMessages = 1 (got ${counters.landedMessages})`);

  const audited = await queryRows<{ n: string }>(
    env.pool,
    `SELECT count(*)::int AS n FROM agent_run_step WHERE run_id=$1 AND audit_verdict='pass'`,
    [run?.id ?? ''],
  );
  ok(Number(audited[0]?.n) === 1, `audit pass steps = 1 exactly (got ${audited[0]?.n})`);

  const steps = await queryRows<{ name: string | null; is_error: boolean; result_summary: string | null }>(
    env.pool,
    `SELECT name, is_error, result_summary FROM agent_run_step WHERE run_id=$1 ORDER BY seq`,
    [run?.id ?? ''],
  );
  const sends = steps.filter((s) => s.name === 'send_message');
  ok(sends.length === 2, `two send_message steps (got ${sends.length})`);
  ok(sends[1]?.is_error === false && (sends[1]?.result_summary ?? '').includes('sent'),
    `second send returns current status sent (got ${sends[1]?.result_summary})`);

  console.log(`[s5] PASS — ${checks} checks`);
} finally {
  await env.close();
}
