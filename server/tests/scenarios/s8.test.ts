// S8 预检失败不建运行（REQ §2.4 S8 行逐字、DES/07 §2.4）。
// 场景：第 3 步 text 含未解析占位符 → POST sequence-runs 直接 422。
// 断言（卡片 b/d 逐字——counters + DB 行数双重真值）：
//   ① 422 + error.code='UNRESOLVED_PLACEHOLDER' + error.stepIndex=3 + error.key=占位符名；
//   ② counters.landedMessages=0（预检在任何 INSERT 之前，零落地零发送）；
//   ③ sequence_run / sequence_run_step 行数 0（无运行记录）；
//   ④ 补齐该占位符后同一群可正常启动（S8「之后可启动」逐字）。
import { describe, expect, it } from 'vitest';
import {
  authed,
  countRows,
  gatewayCounters,
  setupGroup,
  startScenarioEnv,
  type ScenarioEnv,
} from '../helpers/env.js';

describe('S8 序列预检失败（REQ §2.4 S8）', () => {
  it('step-3 未解析占位符 → 422+stepIndex/key；零发送零运行记录；补齐后可启动', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      const counters0 = await gatewayCounters(env);

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
      expect(defRes.status).toBe(201);
      const { id: sequenceId } = (await defRes.json()) as { id: string };

      // ① 缺 {latecode} → 422 UNRESOLVED_PLACEHOLDER（stepIndex=3、key=latecode 逐字字段）
      const bad = await fetch(`${env.serverUrl}/api/groups/${group.dbGroupId}/sequence-runs`, {
        method: 'POST',
        headers: authed(env.token),
        body: JSON.stringify({ sequenceId, vars: { nick: 'A' }, stepVars: {} }),
      });
      expect(bad.status).toBe(422);
      const badBody = (await bad.json()) as {
        error: { code: string; stepIndex?: number; key?: string };
      };
      expect(badBody.error.code).toBe('UNRESOLVED_PLACEHOLDER');
      expect(badBody.error.stepIndex).toBe(3);
      expect(badBody.error.key).toBe('latecode');

      // ② counters 真值：零落地
      expect((await gatewayCounters(env)).landedMessages).toBe(counters0.landedMessages);

      // ③ DB 真值：无运行记录（预检先于任何 INSERT——S8 逐字「不建运行」）
      expect(
        await countRows(env.pool, `SELECT count(*) AS n FROM sequence_run WHERE group_id=$1`, [
          group.dbGroupId,
        ]),
      ).toBe(0);
      expect(
        await countRows(
          env.pool,
          `SELECT count(*) AS n FROM sequence_run_step s
             JOIN sequence_run r ON r.id=s.run_id WHERE r.group_id=$1`,
          [group.dbGroupId],
        ),
      ).toBe(0);

      // ④ 补齐 → 可正常启动（201 + run 行落库）
      const okRes = await fetch(`${env.serverUrl}/api/groups/${group.dbGroupId}/sequence-runs`, {
        method: 'POST',
        headers: authed(env.token),
        body: JSON.stringify({
          sequenceId,
          vars: { nick: 'A' },
          stepVars: { '3': { latecode: 'done' } },
        }),
      });
      expect(okRes.status).toBe(201);
      expect(
        await countRows(
          env.pool,
          `SELECT count(*) AS n FROM sequence_run WHERE group_id=$1 AND status='running'`,
          [group.dbGroupId],
        ),
      ).toBe(1);
    } finally {
      await env.close();
    }
  }, 60000);
});
