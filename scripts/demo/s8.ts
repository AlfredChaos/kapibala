// demo:s8 —— S8 预检失败不建运行（REQ §2.4 S8 行逐字 + DES/07 §2.4）。
// 第 3 步含未解析占位符 → 422 UNRESOLVED_PLACEHOLDER（stepIndex=3、key=占位符名）；
// counters.landedMessages=0、sequence_run/step 行数 0（双重真值）；补齐后可正常启动。
import {
  authed,
  countRows,
  gatewayCounters,
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
  console.log('[s8] env up:', { server: env.serverUrl, gateway: env.gatewayUrl });
  const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
  const c0 = await gatewayCounters(env);

  const defRes = await fetch(`${env.serverUrl}/api/sequences`, {
    method: 'POST',
    headers: authed(env.token),
    body: JSON.stringify({
      name: 's8-seq',
      steps: [
        { index: 1, accountRole: 'member', text: 'hi {nick}', delaySeconds: 3600 },
        { index: 2, accountRole: 'member', text: 'again {nick}', delaySeconds: 3600 },
        { index: 3, accountRole: 'member', text: 'late {latecode}', delaySeconds: 3600 },
      ],
    }),
  });
  ok(defRes.status === 201, 'POST /api/sequences → 201');
  const { id: sequenceId } = (await defRes.json()) as { id: string };

  const bad = await fetch(`${env.serverUrl}/api/groups/${group.dbGroupId}/sequence-runs`, {
    method: 'POST',
    headers: authed(env.token),
    body: JSON.stringify({ sequenceId, vars: { nick: 'A' }, stepVars: {} }),
  });
  ok(bad.status === 422, `缺 {latecode} → ${bad.status}=422`);
  const badBody = (await bad.json()) as {
    error: { code: string; stepIndex?: number; key?: string };
  };
  ok(badBody.error.code === 'UNRESOLVED_PLACEHOLDER', 'error.code=UNRESOLVED_PLACEHOLDER');
  ok(badBody.error.stepIndex === 3, `error.stepIndex=${badBody.error.stepIndex}=3`);
  ok(badBody.error.key === 'latecode', `error.key=${badBody.error.key}=latecode`);

  const c1 = await gatewayCounters(env);
  ok(c1.landedMessages === c0.landedMessages, `counters.landedMessages=${c1.landedMessages}（零发送）`);
  const runRows = await countRows(
    env.pool,
    `SELECT count(*) AS n FROM sequence_run WHERE group_id=$1`,
    [group.dbGroupId],
  );
  ok(runRows === 0, `sequence_run rows=${runRows}（无运行记录）`);
  const stepRows = await countRows(
    env.pool,
    `SELECT count(*) AS n FROM sequence_run_step s
       JOIN sequence_run r ON r.id=s.run_id WHERE r.group_id=$1`,
    [group.dbGroupId],
  );
  ok(stepRows === 0, `sequence_run_step rows=${stepRows}`);

  const okRes = await fetch(`${env.serverUrl}/api/groups/${group.dbGroupId}/sequence-runs`, {
    method: 'POST',
    headers: authed(env.token),
    body: JSON.stringify({
      sequenceId,
      vars: { nick: 'A' },
      stepVars: { '3': { latecode: 'done' } },
    }),
  });
  ok(okRes.status === 201, `补齐 {latecode} → ${okRes.status}=201（之后可启动）`);
  const running = await countRows(
    env.pool,
    `SELECT count(*) AS n FROM sequence_run WHERE group_id=$1 AND status='running'`,
    [group.dbGroupId],
  );
  ok(running === 1, `sequence_run running rows=${running}`);

  console.log(`PASS s8 — ${checks} checks`);
} finally {
  await env.close();
}
