// S5 Agent 重试同一个 key（REQ §2.4 S5 行逐字 + gw-7/ag-8 语义）。
// 断言真值：网关 counters（sendCallsByClientMsgId=1、landedMessages）+
//   agent_run 行 + steps（audit 恰一次 = audit_verdict='pass' 步数 1；幂等命中步短路口径）。
// 场景：入站消息触发 agent run → 剧本 turn1 send_message(key=K) → 网关 504、1.5s 后落地
//   → 剧本 turn2 同 key 再调（ag-8 语义）→ key 命中返回 sent、不再审计 → finish。
import { describe, expect, it } from 'vitest';
import {
  countRows,
  emitEvent,
  gatewayCounters,
  patchGroup,
  queryRows,
  setupGroup,
  startScenarioEnv,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

/** mock-agent 剧本装载（/_test/scenario playbook；通配 '*' 覆盖所有 runId） */
async function armPlaybook(env: ScenarioEnv, steps: unknown[]): Promise<void> {
  const res = await fetch(`${env.agentUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ switch: 'playbook', params: { steps }, target: {} }),
  });
  if (!res.ok) throw new Error(`arm playbook: ${res.status} ${await res.text()}`);
}

async function latestRun(env: ScenarioEnv, groupId: string): Promise<{ id: string; status: string; end_reason: string | null }> {
  const rows = await queryRows<{ id: string; status: string; end_reason: string | null }>(
    env.pool,
    `SELECT id, status, end_reason FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [groupId],
  );
  if (rows[0] === undefined) throw new Error('no agent_run yet');
  return rows[0];
}

describe('S5 Agent 重试同一幂等 key（REQ §2.4 S5）', () => {
  it('首调 504+1.5s 落地；同 key 再调 → 网关恰一条消息、二次返回 sent、审计恰一次、run 正常结束', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      await patchGroup(env, group.dbGroupId, { agentEnabled: true });

      // gw-7：send 受理后 504，1.5s 后消息落地（504 → unknown → 判定器落定 sent）
      const res = await fetch(`${env.gatewayUrl}/_test/scenario`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ switch: 'send_504_land_1500', params: {}, target: {} }),
      });
      expect(res.status).toBe(200);

      // 剧本：send_message(key) → send_message(同 key) → finish
      await armPlaybook(env, [
        { kind: 'tool_use', name: 'send_message', input: { text: 's5 msg', idempotency_key: 's5-key-1' } },
        { kind: 'tool_use', name: 'send_message', input: { text: 's5 msg', idempotency_key: 's5-key-1' } },
        { kind: 'finish', summary: 's5 done' },
      ]);

      // 触发 run：群成员外部入站消息
      await emitEvent(env, 'message', {
        groupId: group.gwGroupId,
        msgId: 'msg-s5-inbound',
        senderPlatformUserId: 'puid-acc-02',
        text: 'please announce',
        sentAt: new Date().toISOString(),
      });

      // run 结束（finished|final：正常结束；两个工具步都走完后 finish）
      await waitFor(async () => {
        const rows = await queryRows<{ status: string }>(
          env.pool,
          `SELECT status FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [group.dbGroupId],
        );
        return rows[0] !== undefined && ['finished', 'failed', 'blocked'].includes(rows[0].status);
      }, 20000);
      const run = await latestRun(env, group.dbGroupId);
      expect(run.status).toBe('finished');
      expect(run.end_reason).toBe('final');

      // 断言 1：网关里恰好一条消息——sendCallsByClientMsgId 恰 1（幂等 key 短路未重发）
      const counters = await gatewayCounters(env);
      const sendCounts = Object.values(counters.sendCallsByClientMsgId);
      expect(sendCounts.reduce((a, b) => a + b, 0)).toBe(1);
      expect(counters.landedMessages).toBe(1); // 504 后 1.5s 落地的那一条

      // 断言 2：审计恰一次（audit_verdict='pass' 步数 = 1——key 命中步短路不再审计）
      const audited = await countRows(
        env.pool,
        `SELECT count(*) AS n FROM agent_run_step WHERE run_id=$1 AND audit_verdict='pass'`,
        [run.id],
      );
      expect(audited).toBe(1);

      // 断言 3：第二个 send_message 步返回当前状态 sent（幂等命中返回最终值，非 SEND_TIMEOUT）
      const steps = await queryRows<{ seq: number; status: string; is_error: boolean; error_code: string | null; result_summary: string | null; name: string | null }>(
        env.pool,
        `SELECT seq, status, is_error, error_code, result_summary, name FROM agent_run_step WHERE run_id=$1 ORDER BY seq`,
        [run.id],
      );
      const sendSteps = steps.filter((s) => s['name'] === 'send_message');
      expect(sendSteps.length).toBe(2);
      expect(sendSteps[0]?.['status']).toBe('done');
      // 首调契约结果：504 → SEND_TIMEOUT（5s 内未确认）或落定快时 sent——两者都合法
      expect(['SEND_TIMEOUT', 'sent']).toContain(
        sendSteps[0]?.['is_error'] ? sendSteps[0]?.['error_code'] : (sendSteps[0]?.['result_summary'] ?? '').split(' ')[0],
      );
      expect(sendSteps[1]?.['status']).toBe('done');
      expect(sendSteps[1]?.['is_error']).toBe(false); // 命中返回 sent（非错误）
      expect(sendSteps[1]?.['result_summary']).toContain('sent');
    } finally {
      await env.close();
    }
  }, 60000);
});
