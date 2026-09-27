// demo:s6 —— S6 Agent 坏响应（REQ §2.4 S6 逐字 + ag-17 三连剧本）。
// mock-agent 依次返回：坏 JSON → 未知工具调用 → 正常结束。
// 断言：run 以 final/budget_exhausted/protocol_errors 之一结束；服务不崩（第二个入站消息
//   再建起新 run）；每一步（REST /api/agent-runs/:id）都有 kind 和 rawResponse。
import {
  authed,
  emitEvent,
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
  console.log('[s6] env up:', { server: env.serverUrl, gateway: env.gatewayUrl, agent: env.agentUrl });

  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  await patchGroup(env, group.dbGroupId, { agentEnabled: true });
  const arm = await fetch(`${env.agentUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ switch: 's6_sequence', params: {}, target: {} }),
  });
  ok(arm.status === 200, 'ag-17 s6_sequence armed (bad JSON → unknown tool → finish)');

  await emitEvent(env, 'message', {
    groupId: group.gwGroupId,
    msgId: 'msg-s6-inbound',
    senderPlatformUserId: 'puid-acc-02',
    text: 'trigger s6',
    sentAt: new Date().toISOString(),
  });

  await waitFor(async () => {
    const rows = await queryRows<{ status: string }>(
      env.pool,
      `SELECT status FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [group.dbGroupId],
    );
    return rows[0] !== undefined && rows[0].status !== 'running';
  }, 20000);
  const [run] = await queryRows<{ id: string; status: string; end_reason: string | null }>(
    env.pool,
    `SELECT id, status, end_reason FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [group.dbGroupId],
  );
  console.log(`[s6] run ${run?.id} → ${run?.status}/${run?.end_reason}`);
  ok(
    ['final', 'budget_exhausted', 'protocol_errors'].includes(run?.end_reason ?? ''),
    `endReason ∈ {final,budget_exhausted,protocol_errors} (got ${run?.end_reason})`,
  );

  const res = await fetch(`${env.serverUrl}/api/agent-runs/${run?.id}`, { headers: authed(env.token) });
  const body = (await res.json()) as { steps: Array<{ kind: string; rawResponse: string | null }> };
  ok(body.steps.length === 3, `three steps (got ${body.steps.length})`);
  ok(body.steps.every((s) => s.kind.length > 0 && s.rawResponse !== null), 'every step has kind + rawResponse');
  console.log(`[s6] step kinds: ${body.steps.map((s) => s.kind).join(' → ')}`);

  // 服务不崩：再触发一次 → 第二个 run 建起
  await emitEvent(env, 'message', {
    groupId: group.gwGroupId,
    msgId: 'msg-s6-again',
    senderPlatformUserId: 'puid-acc-02',
    text: 'again',
    sentAt: new Date().toISOString(),
  });
  await waitFor(async () => {
    const rows = await queryRows<{ n: string }>(
      env.pool, `SELECT count(*)::int AS n FROM agent_run WHERE group_id=$1`, [group.dbGroupId]);
    return Number(rows[0]?.n) >= 2;
  });
  ok(true, 'service alive: second inbound message produced a new run');

  console.log(`[s6] PASS — ${checks} checks`);
} finally {
  await env.close();
}
