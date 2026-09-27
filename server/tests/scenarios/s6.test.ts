// S6 Agent 坏响应（REQ §2.4 S6 行逐字 + ag-17 三连剧本）。
// 场景：mock-agent 依次返回坏 JSON → 未知工具调用 → 正常结束（finish）。
// 断言：run 以 final/budget_exhausted/protocol_errors 之一结束、服务不崩（下一步仍受理）、
//   每一步都有 kind 和 rawResponse（REST 读面逐字）。
import { describe, expect, it } from 'vitest';
import {
  authed,
  countRows,
  emitEvent,
  patchGroup,
  queryRows,
  setupGroup,
  startScenarioEnv,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

async function armS6(env: ScenarioEnv): Promise<void> {
  const res = await fetch(`${env.agentUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ switch: 's6_sequence', params: {}, target: {} }),
  });
  if (!res.ok) throw new Error(`arm s6_sequence: ${res.status} ${await res.text()}`);
}

describe('S6 Agent 坏响应（REQ §2.4 S6 + ag-17）', () => {
  it('坏 JSON → 未知工具 → 正常结束：run 终态、服务不崩、每步 kind+rawResponse 齐备', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      await patchGroup(env, group.dbGroupId, { agentEnabled: true });
      await armS6(env); // ag-17：bad_json_raw → teleport_member(未知) → finish

      await emitEvent(env, 'message', {
        groupId: group.gwGroupId,
        msgId: 'msg-s6-inbound',
        senderPlatformUserId: 'puid-acc-02',
        text: 'trigger s6',
        sentAt: new Date().toISOString(),
      });

      await waitFor(async () => {
        const rows = await queryRows<{ status: string; end_reason: string | null }>(
          env.pool,
          `SELECT status, end_reason FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [group.dbGroupId],
        );
        return rows[0] !== undefined && rows[0].status !== 'running';
      }, 20000);

      const [run] = await queryRows<{ id: string; status: string; end_reason: string | null }>(
        env.pool,
        `SELECT id, status, end_reason FROM agent_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [group.dbGroupId],
      );
      expect(['final', 'budget_exhausted', 'protocol_errors']).toContain(run?.end_reason);
      expect(run?.status).toBe('finished'); // finish 步正常结束

      // REST 读面：每一步都有 kind 和 rawResponse（REQ §2.4 逐字；含协议错误步）
      const res = await fetch(`${env.serverUrl}/api/agent-runs/${run?.id}`, { headers: authed(env.token) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { steps: Array<{ kind: string; rawResponse: string | null; errorCode: string | null }> };
      expect(body.steps.length).toBe(3);
      expect(body.steps.map((s) => s.kind)).toEqual(['protocol_error', 'tool_use', 'final']);
      for (const s of body.steps) {
        expect(s.kind).toBeTruthy();
        expect(s.rawResponse).not.toBeNull(); // 每步都有 rawResponse（finish 步也有 raw 快照）
      }
      // 协议错误步：kind=protocol_error + BAD_JSON + rawResponse 是坏 JSON 原文（截断 ≤2KB）
      expect(body.steps[0]?.errorCode).toBe('BAD_JSON');
      expect((body.steps[0]?.rawResponse?.length ?? 0) <= 2048).toBe(true);
      // 未知工具步：is_error tool_result UNKNOWN_TOOL（rawResponse 为该轮原始体）
      expect(body.steps[1]?.errorCode).toBe('UNKNOWN_TOOL');
      expect(body.steps[1]?.rawResponse).toContain('teleport_member');

      // 服务不崩：run 终态后再来一次入站消息 → 新 run 照常建起（单飞行已释放）
      await emitEvent(env, 'message', {
        groupId: group.gwGroupId,
        msgId: 'msg-s6-inbound-2',
        senderPlatformUserId: 'puid-acc-02',
        text: 'trigger again',
        sentAt: new Date().toISOString(),
      });
      await waitFor(async () =>
        (await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [group.dbGroupId])) >= 2,
      );
    } finally {
      await env.close();
    }
  }, 60000);
});
