// demo:s7 —— S7 并发启动（REQ §2.4 S7 行逐字 + DES/07 §7）。
// 同一群并发两次 POST /api/groups/:id/sequence-runs → 恰好一个 201、一个
// 409 SEQUENCE_ALREADY_RUNNING（部分唯一索引仲裁）；sequence_run 恰一条 running。
import {
  authed,
  countRows,
  setupGroup,
  startScenarioEnv,
} from '../../server/tests/helpers/env.js';

let checks = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  checks += 1;
  console.log(`  ✓ ${label}`);
}

const env = await startScenarioEnv();
try {
  console.log('[s7] env up:', { server: env.serverUrl, gateway: env.gatewayUrl });
  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  ok(group.dbGroupId.length > 0, 'group active');

  const defRes = await fetch(`${env.serverUrl}/api/sequences`, {
    method: 'POST',
    headers: authed(env.token),
    body: JSON.stringify({
      name: 's7-seq',
      steps: [
        { index: 1, accountRole: 'member', text: 'first', delaySeconds: 3600 },
        { index: 2, accountRole: 'member', text: 'second', delaySeconds: 3600 },
      ],
    }),
  });
  ok(defRes.status === 201, 'POST /api/sequences → 201');
  const { id: sequenceId } = (await defRes.json()) as { id: string };

  const [r1, r2] = await Promise.all([
    fetch(`${env.serverUrl}/api/groups/${group.dbGroupId}/sequence-runs`, {
      method: 'POST',
      headers: authed(env.token),
      body: JSON.stringify({ sequenceId, vars: {}, stepVars: {} }),
    }),
    fetch(`${env.serverUrl}/api/groups/${group.dbGroupId}/sequence-runs`, {
      method: 'POST',
      headers: authed(env.token),
      body: JSON.stringify({ sequenceId, vars: {}, stepVars: {} }),
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  ok(statuses[0] === 201 && statuses[1] === 409, `并发启动 status=[${statuses}] → 恰一 201 一 409`);
  const loser = r1.status === 409 ? r1 : r2;
  const body = (await loser.json()) as { error: { code: string } };
  ok(body.error.code === 'SEQUENCE_ALREADY_RUNNING', '409 error.code=SEQUENCE_ALREADY_RUNNING');

  const running = await countRows(
    env.pool,
    `SELECT count(*) AS n FROM sequence_run WHERE group_id=$1 AND status='running'`,
    [group.dbGroupId],
  );
  ok(running === 1, `sequence_run running rows=${running}（DB 仲裁真值）`);

  console.log(`PASS s7 — ${checks} checks`);
} finally {
  await env.close();
}
