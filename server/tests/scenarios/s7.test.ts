// S7 并发启动（REQ §2.4 S7 行逐字、DES/07 §7）。
// 场景：同一群并发两次 POST /api/groups/:id/sequence-runs。
// 断言：恰好一个 201、一个 409 SEQUENCE_ALREADY_RUNNING（部分唯一索引仲裁，
//   非进程内锁——两端点同实例并发也走 DB ON CONFLICT 空转路径）；
//   sequence_run 表恰一行 running。
import { describe, expect, it } from 'vitest';
import {
  authed,
  countRows,
  setupGroup,
  startScenarioEnv,
  type ScenarioEnv,
} from '../helpers/env.js';

describe('S7 序列并发启动（REQ §2.4 S7）', () => {
  it('并发两次启动：恰好一个 201 + 一个 409 SEQUENCE_ALREADY_RUNNING；库内恰一条 running run', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });

      // 定义两步序列（step1 delay 大到足够：run 在整个测试期保持 running，唯一索引占位有效）
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
      expect(defRes.status).toBe(201);
      const { id: sequenceId } = (await defRes.json()) as { id: string };

      // 并发启动两次（同一 tick 两发 fetch——服务端两个请求交错进 tx，由
      // sequence_run (group_id) WHERE status='running' 部分唯一索引仲裁）
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
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      const body = (await loser.json()) as { error: { code: string } };
      expect(body.error.code).toBe('SEQUENCE_ALREADY_RUNNING');

      // DB 真值：恰一条 running run（卡片 d「断言以 DB 行数真值」）
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
