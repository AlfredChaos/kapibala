// agent run 崩溃恢复测试（T-P4-11 c 项，先红后绿）。
// 契约出处：DES/06 §9.1 四分支逐字（done→预算判定续轮 / turn_dispatched→快照重发同轮 /
// turn_received→续推进 / tool_dispatched→反查外部现状不重放）+ §9.2 凭据表 + §9.3 兜底 +
// §12 无状态全量历史语义 + REQ A5-8「已产生外部效果的工具不重放不记失败」。
// 步状态注入级：直接改 agent_run_step.status 模拟崩溃点（kill -9 级归 T-P7-03）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import { recoverAgentRuns } from '../../src/modules/agent/recovery.js';
import { setAgentRunStarter } from '../../src/modules/agent/trigger.js';
import type { GatewayClient } from '../../src/gateway/client.js';
import type { AgentClient, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

class FakeGateway implements Pick<GatewayClient, 'kick' | 'members'> {
  memberList: Array<{ platformUserId: string }> = [];
  kickCalls = 0;
  async kick() { this.kickCalls += 1; return { kicked: true }; }
  async members() { return this.memberList; }
}

/** 记录请求的假 AgentClient；responses 按轮次出队，末尾默认 end_turn 收口 */
class FakeAgent implements AgentClient {
  calls: AgentTurnRequest[] = [];
  queue: AgentRawResponse[] = [];
  endRaw: AgentRawResponse = {
    status: 200,
    raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }),
  };
  async turn(req: AgentTurnRequest) { this.calls.push(req); return this.endRaw; }
  async rawTurn(req: AgentTurnRequest) {
    this.calls.push(req);
    return this.queue.shift() ?? this.endRaw;
  }
  async callAudit() { return { verdict: 'pass' as const }; }
}

const TOOL_USE_RAW: AgentRawResponse = {
  status: 200,
  raw: JSON.stringify({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu-1', name: 'send_message', input: { text: 'hi', client_msg_id: 'cm-x' } }],
  }),
};

describe('agent run 崩溃恢复（DES/06 §9.1/§9.2/§9.3 + A5-8）', () => {
  let db: TestDbHandle;
  let groupId: string;
  let runId: string;
  let agent: FakeAgent;
  let gateway: FakeGateway;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { setAgentRunStarter(undefined); await db.close(); });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE group_member, "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    await db.pool.query(`UPDATE account SET status='online', platform_user_id='puid-01' WHERE id='acc-01'`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, auto_kick_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, true, 'gw-9') RETURNING id`);
    groupId = rows[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role)
       VALUES ($1,'acc-01','puid-01','admin'),($1,'acc-02','puid-vic','member')`,
      [groupId],
    );
    const { rows: r } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', $2::jsonb, now()+interval '60 seconds') RETURNING id`,
      [groupId, JSON.stringify({ groupId, triggerMessages: [{ msgId: 'm1', senderPlatformUserId: 'u', text: 'hi', sentAt: '2026-01-01T00:00:00Z' }], policy: { autoKickEnabled: true }, ownPlatformUserIds: ['puid-01'] })]);
    runId = r[0]?.id ?? '';
    agent = new FakeAgent();
    gateway = new FakeGateway();
    setAgentRunStarter(createAgentExecutor({
      pool: db.pool, agentClient: agent, logger: silent, instanceId: 'test-recovery',
      gateway: gateway as unknown as GatewayClient,
      kickConvergeWait: async () => {},
      deliveryWaiter: async () => undefined,
    }));
  });

  async function waitRun(statuses: string[]): Promise<void> {
    await expect.poll(async () => {
      const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM agent_run WHERE id=$1', [runId]);
      return rows[0]?.status;
    }, { interval: 20, timeout: 5000 }).toSatisfy((s) => statuses.includes(s as string));
  }

  it('done 步断点：预算预检后续轮——历史由 appended_blocks 原样重建进新请求', async () => {
    const blocks = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-0', name: 'get_recent_messages', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-0', content: '[]', is_error: false }] },
    ];
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'done', $2::jsonb)`,
      [runId, JSON.stringify(blocks)],
    );
    await db.pool.query('UPDATE agent_run SET step_count=1 WHERE id=$1', [runId]);
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished']);
    expect(agent.calls.length).toBe(1);
    // 历史拼接：messages[0]=trigger_context，其后 appended_blocks 逐块（§6 + §9.1 会话语义逐字）
    const msgs = agent.calls[0]?.messages ?? [];
    expect(msgs[1]).toEqual(blocks[0]);
    expect(msgs[2]).toEqual(blocks[1]);
    const { rows } = await db.pool.query('SELECT status, end_reason FROM agent_run WHERE id=$1', [runId]);
    expect(rows[0]).toMatchObject({ status: 'finished', end_reason: 'final' });
  });

  it('turn_dispatched 断点：用 dispatch_payload 快照重发同轮（同 runId，逐字快照）', async () => {
    const snapshot = {
      runId,
      tools: [{ name: 'send_message' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '{"trigger":"x"}' }] }],
    };
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, dispatch_payload, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'turn_dispatched', $2::jsonb, '[]'::jsonb)`,
      [runId, JSON.stringify(snapshot)],
    );
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished']);
    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]).toEqual(snapshot); // 重发 = 快照逐字（§9.1 RESEND 框 + §12）
    expect(agent.calls[0]?.runId).toBe(runId); // 同 runId 续传
  });

  it('turn_received 断点：从 raw_response 续推进，不再发 HTTP', async () => {
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, dispatch_payload, raw_response, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'turn_received', '{}'::jsonb, $2, '[]'::jsonb)`,
      [runId, TOOL_USE_RAW.raw.replace('send_message', 'get_recent_messages')],
    );
    await db.pool.query('UPDATE agent_run SET step_count=1 WHERE id=$1', [runId]);
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished']);
    expect(agent.calls.length).toBe(1); // 只有续轮那次请求（tool_result 后开新 turn），turn_received 步未重发
    const { rows } = await db.pool.query(
      'SELECT status, tool_use_id FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
    expect(rows[0]?.status).toBe('done');
  });

  it('tool_dispatched(send) 断点：查 message 现状生成 tool_result——绝不二次创建（A5-8）', async () => {
    await db.pool.query(
      `INSERT INTO message (group_id, client_msg_id, delivery_status, sender_platform_user_id, text, is_own, sent_at)
       VALUES ($1, 'cm-1', 'sent', 'puid-01', 'hi', true, now())`,
      [groupId],
    );
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, tool_use_id, name, client_msg_id, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'tool_dispatched', 'tu-1', 'send_message', 'cm-1', '[]'::jsonb)`,
      [runId],
    );
    await db.pool.query('UPDATE agent_run SET step_count=1 WHERE id=$1', [runId]);
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished']);
    const { rows: msgs } = await db.pool.query('SELECT count(*)::int AS n FROM message WHERE client_msg_id=$1', ['cm-1']);
    expect(msgs[0]?.n).toBe(1); // 不重放：消息行数仍 1
    const { rows } = await db.pool.query(
      `SELECT status, appended_blocks, is_error FROM agent_run_step WHERE run_id=$1 AND seq=1`, [runId]);
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.is_error).toBe(false); // sent → 成功 tool_result
  });

  it('tool_dispatched(kick) 断点·目标已不在：{kicked:true} 回填；kick 零调用（不重放）', async () => {
    gateway.memberList = []; // 成员列表查无此人
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, tool_use_id, name, kick_target, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'tool_dispatched', 'tu-1', 'kick_user', 'puid-vic', '[]'::jsonb)`,
      [runId],
    );
    await db.pool.query('UPDATE agent_run SET step_count=1 WHERE id=$1', [runId]);
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished']);
    expect(gateway.kickCalls).toBe(0); // A5-8 不重放逐字
    const { rows } = await db.pool.query(
      `SELECT is_error, appended_blocks FROM agent_run_step WHERE run_id=$1 AND seq=1`, [runId]);
    expect(rows[0]?.is_error).toBe(false);
    expect(JSON.stringify(rows[0]?.appended_blocks)).toContain('kicked');
  });

  it('tool_dispatched(kick) 断点·目标仍在：SEND_FAILED tool_result 回填，run 继续（不判 run 失败）', async () => {
    gateway.memberList = [{ platformUserId: 'puid-vic' }];
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, tool_use_id, name, kick_target, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'tool_dispatched', 'tu-1', 'kick_user', 'puid-vic', '[]'::jsonb)`,
      [runId],
    );
    await db.pool.query('UPDATE agent_run SET step_count=1 WHERE id=$1', [runId]);
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished']); // run 继续到 final，不因 kick 失败而 failed（§9.2）
    const { rows } = await db.pool.query(
      `SELECT is_error, error_code, appended_blocks FROM agent_run_step WHERE run_id=$1 AND seq=1`, [runId]);
    expect(rows[0]?.is_error).toBe(true);
    expect(rows[0]?.error_code).toBe('SEND_FAILED');
  });

  it('剩余预算 ≤0：恢复后第一轮预检即 wall_clock 终结（§9.3）', async () => {
    await db.pool.query(`UPDATE agent_run SET wall_consumed_ms=70000 WHERE id=$1`, [runId]);
    await recoverAgentRuns({ pool: db.pool });
    await waitRun(['finished', 'failed']);
    const { rows } = await db.pool.query('SELECT status, end_reason FROM agent_run WHERE id=$1', [runId]);
    expect(rows[0]).toMatchObject({ status: 'failed', end_reason: 'wall_clock' });
    expect(agent.calls.length).toBe(0);
  });

  it('advisory lock 抢不到：本实例跳过，run 保持 running（§9.3 兜底）', async () => {
    const conn = await db.pool.connect();
    try {
      await conn.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`agent-run:${runId}`]);
      await recoverAgentRuns({ pool: db.pool });
      await new Promise((r) => setTimeout(r, 300)); // 给 executor 尝试窗口
      expect(agent.calls.length).toBe(0);
      const { rows } = await db.pool.query('SELECT status FROM agent_run WHERE id=$1', [runId]);
      expect(rows[0]?.status).toBe('running');
    } finally {
      await conn.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`agent-run:${runId}`]);
      conn.release();
    }
  });
});
