// 取消检查点 + 孤儿租约观测测试（T-P4-12 c 项，先红后绿）。
// 契约出处：DES/06 §10（X-2 修订：唯一检查点在每步循环开始前、发起本轮 turn 之前）+
// §9.4（O1 裁剪：只观测——error 日志 + inconsistency{kind:'orphan_run'}，同一 run 只推一次，
// 不 terminate 不接管，处置 = 重启进程）+ REQ A5-10「当前这一步结束后终止」。
// X-2 回归：send_message 步进行中关闭 agentEnabled → 当前步 tool_result 完整落库、
// run cancelled、会话历史无悬挂 tool_use。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import { runOrphanRunScan } from '../../src/scheduler/orphan-run-scan.js';
import { setAgentRunStarter } from '../../src/modules/agent/trigger.js';
import type { GatewayClient } from '../../src/gateway/client.js';
import type { AgentClient, AgentAuditResponse, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

class FakeGateway implements Pick<GatewayClient, 'kick' | 'members' | 'send'> {
  async send() { return { accepted: true }; }
  async kick() { return { kicked: true }; }
  async members() { return []; }
}

class FakeAgent implements AgentClient {
  calls: AgentTurnRequest[] = [];
  queue: AgentRawResponse[] = [];
  onAudit?: () => Promise<void> | void;
  endRaw: AgentRawResponse = {
    status: 200,
    raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }),
  };
  async turn() { return this.endRaw; }
  async rawTurn(req: AgentTurnRequest) {
    this.calls.push(req);
    return this.queue.shift() ?? this.endRaw;
  }
  async callAudit(): Promise<AgentAuditResponse> {
    await this.onAudit?.();
    return { verdict: 'pass' };
  }
}

function toolUseRaw(name: string, id: string, input: Record<string, unknown>): AgentRawResponse {
  return {
    status: 200,
    raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }),
  };
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('agent 取消检查点 + 孤儿租约观测（DES/06 §10/§9.4 + A5-10）', () => {
  let db: TestDbHandle;
  let groupId: string;
  let runId: string;
  let agent: FakeAgent;
  let executor: ReturnType<typeof createAgentExecutor>;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { setAgentRunStarter(undefined); await db.close(); });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE group_member, "group", ws_event, account, agent_run_step, agent_run, message, agent_idempotency_key RESTART IDENTITY CASCADE`,
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
    executor = createAgentExecutor({
      pool: db.pool, agentClient: agent, logger: silent, instanceId: 'test-cancel',
      gateway: new FakeGateway() as unknown as GatewayClient,
      kickConvergeWait: async () => {},
      // send 落定等待缝：默认返回 undefined → status 保持现值（测试里由 fixture 钉）
      deliveryWaiter: async () => undefined,
    });
    setAgentRunStarter(executor);
  });

  it('X-2 回归：send_message 步进行中关闭 agentEnabled → tool_result 完整落库、run cancelled、无悬挂 tool_use', async () => {
    // 第 1 轮返回 send_message 工具调用；工具内落定等待期间把开关关掉（模拟 PATCH）
    agent.queue = [
      toolUseRaw('send_message', 'tu-send', { text: 'hello', idempotency_key: 'key-cancel-1' }),
    ];
    const flipDuringTool = async () => {
      await db.pool.query(`UPDATE "group" SET agent_enabled=false WHERE id=$1`, [groupId]);
      return undefined; // 落定未到 → message 保持 queued
    };
    const ex = createAgentExecutor({
      pool: db.pool, agentClient: agent, logger: silent, instanceId: 't-x2',
      gateway: new FakeGateway() as unknown as GatewayClient,
      deliveryWaiter: flipDuringTool,
    });
    setAgentRunStarter(ex);
    ex.startRun(runId);
    await waitFor(async () => {
      const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM agent_run WHERE id=$1', [runId]);
      return ['cancelled', 'finished', 'failed'].includes(rows[0]?.status ?? '');
    });
    const { rows: run } = await db.pool.query('SELECT status, end_reason FROM agent_run WHERE id=$1', [runId]);
    expect(run[0]).toMatchObject({ status: 'cancelled', end_reason: 'cancelled' });
    // 当前步完整落库：step done + appended_blocks 含 tool_result（无悬挂 tool_use）
    const { rows: step } = await db.pool.query(
      `SELECT status, appended_blocks FROM agent_run_step WHERE run_id=$1 AND seq=1`, [runId]);
    expect(step[0]?.status).toBe('done');
    const blocks = step[0]?.appended_blocks as Array<{ role: string; content: Array<{ type: string }> }>;
    const hasDanglingToolUse = blocks.some(
      (b) => b.role === 'assistant' && b.content.some((c) => c.type === 'tool_use'),
    ) && !blocks.some((b) => b.content.some((c) => c.type === 'tool_result'));
    expect(hasDanglingToolUse).toBe(false); // tool_use 必有配对 tool_result
    expect(agent.calls.length).toBe(1); // 取消前未发起第二轮
  });

  it('群变 unreachable：当前步 GROUP_UNREACHABLE 错误 tool_result 收尾，循环顶部 cancelled（A5-10）', async () => {
    // 审计过、GATE1 前群变 unreachable：send 的 GATE1 以 GROUP_UNREACHABLE 收尾当前步
    agent.queue = [
      toolUseRaw('send_message', 'tu-g1', { text: 'hi', idempotency_key: 'key-g1' }),
    ];
    agent.onAudit = async () => {
      await db.pool.query(`UPDATE "group" SET status='unreachable' WHERE id=$1`, [groupId]);
    };
    executor.startRun(runId);
    await waitFor(async () => {
      const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM agent_run WHERE id=$1', [runId]);
      return ['cancelled', 'finished', 'failed'].includes(rows[0]?.status ?? '');
    });
    const { rows: step } = await db.pool.query(
      `SELECT status, is_error, error_code, appended_blocks FROM agent_run_step WHERE run_id=$1 AND seq=1`, [runId]);
    expect(step[0]?.status).toBe('done');
    expect(step[0]?.error_code).toBe('GROUP_UNREACHABLE'); // GATE1 收尾（§8.2/§10 X-2）
    const { rows: run } = await db.pool.query('SELECT status, end_reason FROM agent_run WHERE id=$1', [runId]);
    expect(run[0]).toMatchObject({ status: 'cancelled', end_reason: 'cancelled' }); // 下一循环顶部取消
    expect(agent.calls.length).toBe(1); // 未发起新一轮
  });

  it('孤儿租约：lease_until 过期 running run → error 日志 + inconsistency{orphan_run}，同一 run 只推一次（O1）', async () => {
    await db.pool.query(
      `UPDATE agent_run SET lease_until=now()-interval '10 seconds', claimed_by='dead-pid' WHERE id=$1`,
      [runId],
    );
    const errors: Array<Record<string, unknown>> = [];
    const logger = { error: (o: unknown) => { errors.push(o as Record<string, unknown>); } };
    const first = await runOrphanRunScan({ pool: db.pool, logger });
    expect(first).toBe(1);
    expect(errors[0]?.['runId']).toBe(runId);
    const { rows: ev } = await db.pool.query(
      `SELECT payload FROM ws_event WHERE type='inconsistency' AND payload->>'kind'='orphan_run'`,
    );
    expect(ev.length).toBe(1);
    expect(ev[0]?.payload).toMatchObject({ ref: runId });
    // 重扫幂等：同一 run 只推一次（§9.4 状态去重）
    const second = await runOrphanRunScan({ pool: db.pool, logger });
    expect(second).toBe(0);
    const { rows: ev2 } = await db.pool.query(
      `SELECT count(*)::int AS n FROM ws_event WHERE type='inconsistency' AND payload->>'kind'='orphan_run'`,
    );
    expect(ev2[0]?.n).toBe(1);
    // O1：不接管不终结——run 保持 running（处置 = 重启进程触发恢复）
    const { rows: run } = await db.pool.query('SELECT status FROM agent_run WHERE id=$1', [runId]);
    expect(run[0]?.status).toBe('running');
  });

  it('lease 未过期不误报：running + lease_until 未来 → 扫描空转', async () => {
    await db.pool.query(`UPDATE agent_run SET lease_until=now()+interval '30 seconds' WHERE id=$1`, [runId]);
    const n = await runOrphanRunScan({ pool: db.pool, logger: silent });
    expect(n).toBe(0);
  });
});
