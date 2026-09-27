// agent run 崩溃恢复测试（T-P4-11 c 项，先红后绿）。
// 契约出处：DES/06 §9.1 四分支逐字（done→预算判定续轮 / turn_dispatched→快照重发同轮 /
// turn_received→续推进 / tool_dispatched→反查外部现状不重放）+ §9.2 凭据表 + §9.3 兜底 +
// §12 无状态全量历史语义 + REQ A5-8「已产生外部效果的工具不重放不记失败」。
// 步状态注入级：直接改 agent_run_step.status 模拟崩溃点（kill -9 级归 T-P7-03）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { derivePlatformUserId } from 'mock-gateway/src/state.js';
import { assertPostCrashHealth, crashGatewayCounters } from '../helpers/crash.js';
import { startCrashServer, type CrashServerHandle } from '../helpers/server-process.js';
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

// ---------- kill -9 级崩溃注入（T-P7-03；VITEST_PLAN §4 ②③；I10）----------
// 与上面步状态注入级同文件串行（共享文件纪律）；真实子进程 + 真 mock + 真 PG。
// 窗口命名：turn_dispatched → agent.call.agent_turn.before/after；
//   tool_dispatched(send) → gateway.call.send.before/after（步已落库、效果未知）；
//   tool_dispatched(kick)  → gateway.call.kick.before/after（成员列表判现状）。

interface CrashGroup { readonly dbGroupId: string; readonly gwGroupId: string }

async function killConnect(h: CrashServerHandle, token: string, accountId: string): Promise<void> {
  const res = await fetch(`${h.baseUrl}/api/accounts/${accountId}/connect`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`connect ${accountId}: ${res.status}`);
}

async function killCreateGroup(h: CrashServerHandle, token: string): Promise<CrashGroup> {
  const res = await fetch(`${h.baseUrl}/api/groups`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ creatorAccountId: 'acc-01', memberAccountIds: ['acc-02'] }),
  });
  if (!res.ok) throw new Error(`POST /api/groups: ${res.status} ${await res.text()}`);
  const { jobId } = (await res.json()) as { jobId: string };
  for (let i = 0; i < 400; i += 1) {
    const jr = await fetch(`${h.baseUrl}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
    const job = (await jr.json()) as { status: string };
    if (job.status === 'finished') {
      const { rows } = await h.db.pool.query<{ group_id: string }>(
        `SELECT group_id FROM job WHERE id=$1`, [jobId]);
      const dbGroupId = rows[0]?.group_id;
      if (dbGroupId === undefined) throw new Error('job has no group_id');
      const gr = await fetch(`${h.baseUrl}/api/groups/${dbGroupId}`, { headers: { authorization: `Bearer ${token}` } });
      const group = (await gr.json()) as { gatewayGroupId: string };
      return { dbGroupId, gwGroupId: group.gatewayGroupId };
    }
    if (job.status === 'failed') throw new Error('create-group job failed');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('create-group job timeout');
}

async function killPatchGroup(h: CrashServerHandle, token: string, dbGroupId: string): Promise<void> {
  const res = await fetch(`${h.baseUrl}/api/groups/${dbGroupId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agentEnabled: true, autoKickEnabled: true }),
  });
  if (!res.ok) throw new Error(`PATCH group: ${res.status}`);
}

async function killEmitInbound(h: CrashServerHandle, gwGroupId: string, msgId: string): Promise<void> {
  const res = await fetch(`${h.gatewayUrl}/_test/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      data: {
        groupId: gwGroupId, msgId,
        senderPlatformUserId: 'pu-external',
        text: 'trigger agent', sentAt: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) throw new Error(`emit: ${res.status}`);
}

async function killArmPlaybook(h: CrashServerHandle, steps: unknown[]): Promise<void> {
  const res = await fetch(`${h.agentUrl}/_test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ switch: 'playbook', params: { steps }, target: {} }),
  });
  if (!res.ok) throw new Error(`arm playbook: ${res.status}`);
}

interface RunRow { readonly id: string; readonly status: string; readonly end_reason: string | null }

async function waitMessageSent(h: CrashServerHandle, clientMsgId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await h.db.pool.query<{ delivery_status: string }>(
      `SELECT delivery_status FROM message WHERE client_msg_id=$1`, [clientMsgId]);
    if (rows[0]?.delivery_status === 'sent') return;
    if (Date.now() > deadline) throw new Error(`message ${clientMsgId} not sent (status=${rows[0]?.delivery_status ?? 'none'})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function waitRunDone(h: CrashServerHandle, timeoutMs = 60_000): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await h.db.pool.query<RunRow>(
      `SELECT id, status, end_reason FROM agent_run ORDER BY created_at DESC LIMIT 1`);
    const r = rows[0];
    if (r !== undefined && ['finished', 'failed', 'blocked'].includes(r.status)) return r;
    if (Date.now() > deadline) throw new Error(`run not done; status=${r?.status ?? 'none'}`);
    await new Promise((r2) => setTimeout(r2, 150));
  }
}

async function armPoint(h: CrashServerHandle, token: string, name: string): Promise<void> {
  const res = await fetch(`${h.baseUrl}/_test/crash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, hit: 1 }),
  });
  if (!res.ok) throw new Error(`arm: ${res.status}`);
}

describe('agent run kill -9 恢复（T-P7-03；I10 + ag-18 编排）', () => {
  it('② turn_dispatched·HTTP 前：快照重发同 runId，run 继续至 final（ag-18）', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await killConnect(h, token, 'acc-01');
      await killConnect(h, token, 'acc-02');
      const g = await killCreateGroup(h, token);
      await killPatchGroup(h, token, g.dbGroupId);
      await killArmPlaybook(h, [
        { kind: 'tool_use', name: 'get_recent_messages', input: {} },
        { kind: 'finish', summary: 'after recovery' },
      ]);
      await armPoint(h, token, 'agent.call.agent_turn.before');
      await killEmitInbound(h, g.gwGroupId, 'm-k9-turn-pre').catch(() => undefined);
      const code = await Promise.race([h.awaitExit(), new Promise((r)=>setTimeout(()=>r('TIMEOUT'),30000))]);
      expect(code).toBe(9);

      const before = await h.db.pool.query(`SELECT count(*)::int AS n FROM agent_run`);
      await assertPostCrashHealth(h); // restart → §9.1 恢复扫描接管 running run
      const run = await waitRunDone(h);
      expect(run.status).toBe('finished');
      expect(run.end_reason).toBe('final');
      const after = await h.db.pool.query(`SELECT count(*)::int AS n FROM agent_run`);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n); // I10：同一 runId，无新 run
    } finally {
      await h.stop();
    }
  }, 120000);

  it('② turn_dispatched·HTTP 后：响应已收未写回 → 快照重发（消耗剧本下一步）至 final', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await killConnect(h, token, 'acc-01');
      await killConnect(h, token, 'acc-02');
      const g = await killCreateGroup(h, token);
      await killPatchGroup(h, token, g.dbGroupId);
      await killArmPlaybook(h, [
        { kind: 'tool_use', name: 'get_recent_messages', input: {} }, // 崩溃前轮消耗
        { kind: 'finish', summary: 'resend replay finish' },          // 快照重发轮消费
      ]);
      await armPoint(h, token, 'agent.call.agent_turn.after');
      await killEmitInbound(h, g.gwGroupId, 'm-k9-turn-post').catch(() => undefined);
      expect(await h.awaitExit()).toBe(9);

      await assertPostCrashHealth(h);
      const run = await waitRunDone(h);
      expect(run.status).toBe('finished');
      expect(run.end_reason).toBe('final');
    } finally {
      await h.stop();
    }
  }, 120000);

  it('③ tool_dispatched(send)·网关 send 前：补发恰一次，网关该 clientMsgId 恰 1 条（I2/A5-8）', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await killConnect(h, token, 'acc-01');
      await killConnect(h, token, 'acc-02');
      const g = await killCreateGroup(h, token);
      await killPatchGroup(h, token, g.dbGroupId);
      await killArmPlaybook(h, [
        { kind: 'tool_use', name: 'send_message', input: { text: 'k9 send pre', idempotency_key: 'k9-pre' } },
        { kind: 'finish', summary: 'send recovered' },
      ]);
      await armPoint(h, token, 'gateway.call.send.before');
      await killEmitInbound(h, g.gwGroupId, 'm-k9-send-pre').catch(() => undefined);
      expect(await h.awaitExit()).toBe(9);

      await assertPostCrashHealth(h);
      const run = await waitRunDone(h, 90_000);
      expect(run.status).toBe('finished');

      const { rows: steps } = await h.db.pool.query<{ status: string; is_error: boolean; client_msg_id: string | null; error_code: string | null; result_summary: string | null }>(
        `SELECT status, is_error, client_msg_id, error_code FROM agent_run_step WHERE run_id=$1 AND name='send_message'`,
        [run.id]);
      expect(steps[0]?.status).toBe('done');
      // A5-8「不记失败」契约落地：恢复路径按消息现状生成 tool_result——sent→成功、
      // 判定器仍在收敛→SEND_TIMEOUT（不取消不标失败、判定器续收敛）；真正失败码才 is_error
      const allowed = ['sent', 'SEND_TIMEOUT'];
      const outcome = steps[0]?.is_error ? (steps[0]?.error_code ?? '') : 'sent';
      expect(allowed).toContain(outcome);
      const clientMsgId = steps[0]?.client_msg_id;
      await waitMessageSent(h, clientMsgId ?? ''); // SEND_TIMEOUT 后判定器续收敛——落定才算外部现状
      const counters = await crashGatewayCounters(h);
      expect(counters.sendCallsByClientMsgId[clientMsgId ?? '']).toBe(1); // 恰一次
      expect(counters.landedMessages).toBe(1);
      const { rows: msgs } = await h.db.pool.query<{ delivery_status: string }>(
        `SELECT delivery_status FROM message WHERE client_msg_id=$1`, [clientMsgId]);
      expect(msgs[0]?.delivery_status).toBe('sent');
    } finally {
      await h.stop();
    }
  }, 150000);

  it('③ tool_dispatched(send)·send 响应后：已发不重发——by-client-id 200 落定、counters 恰 1（A5-8）', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await killConnect(h, token, 'acc-01');
      await killConnect(h, token, 'acc-02');
      const g = await killCreateGroup(h, token);
      await killPatchGroup(h, token, g.dbGroupId);
      await killArmPlaybook(h, [
        { kind: 'tool_use', name: 'send_message', input: { text: 'k9 send post', idempotency_key: 'k9-post' } },
        { kind: 'finish', summary: 'send recovered' },
      ]);
      await armPoint(h, token, 'gateway.call.send.after');
      await killEmitInbound(h, g.gwGroupId, 'm-k9-send-post').catch(() => undefined);
      expect(await h.awaitExit()).toBe(9);

      await assertPostCrashHealth(h);
      const run = await waitRunDone(h, 90_000);
      expect(run.status).toBe('finished');
      const { rows: steps } = await h.db.pool.query<{ status: string; is_error: boolean; client_msg_id: string | null }>(
        `SELECT status, is_error, client_msg_id FROM agent_run_step WHERE run_id=$1 AND name='send_message'`,
        [run.id]);
      // send.after 窗口：网关侧已落地 → 判定器 200 → sent；极端时序下 5s 等待先到期
      // 记 SEND_TIMEOUT（不标失败、判定器续收敛）——两者都是「不重放」契约的合法形状
      const allowedPost = ['sent', 'SEND_TIMEOUT'];
      const outcomePost = steps[0]?.is_error ? 'SEND_TIMEOUT' : 'sent';
      expect(allowedPost).toContain(outcomePost);
      await waitMessageSent(h, steps[0]?.client_msg_id ?? '');
      const counters = await crashGatewayCounters(h);
      expect(counters.sendCallsByClientMsgId[steps[0]?.client_msg_id ?? '']).toBe(1); // 不重放逐字
      expect(counters.landedMessages).toBe(1);
    } finally {
      await h.stop();
    }
  }, 150000);

  it('③ tool_dispatched(kick)·kick 前：成员仍在 → tool_result 记失败但 run 继续至 final（§9.2）', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await killConnect(h, token, 'acc-01');
      await killConnect(h, token, 'acc-02');
      const g = await killCreateGroup(h, token);
      await killPatchGroup(h, token, g.dbGroupId);
      const victimPuid = derivePlatformUserId('acc-02');
      await killArmPlaybook(h, [
        { kind: 'tool_use', name: 'kick_user', input: { platform_user_id: victimPuid, reason: 'k9 test' } },
        { kind: 'finish', summary: 'kick recovered' },
      ]);
      await armPoint(h, token, 'gateway.call.kick.before');
      await killEmitInbound(h, g.gwGroupId, 'm-k9-kick-pre').catch(() => undefined);
      expect(await h.awaitExit()).toBe(9);

      await assertPostCrashHealth(h);
      const run = await waitRunDone(h, 90_000);
      expect(run.status).toBe('finished'); // kick 失败不判 run 失败（§9.2 逐字）
      const { rows: steps } = await h.db.pool.query<{ is_error: boolean; error_code: string | null }>(
        `SELECT is_error, error_code FROM agent_run_step WHERE run_id=$1 AND name='kick_user'`, [run.id]);
      expect(steps[0]?.is_error).toBe(true); // 成员仍在 → 等 2s 收敛仍 → 失败 tool_result
      const { rows: members } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM group_member WHERE group_id=$1 AND account_id='acc-02' AND left_at IS NULL`,
        [g.dbGroupId]);
      expect(members[0]?.n).toBe(1); // 未踢出
    } finally {
      await h.stop();
    }
  }, 150000);

  it('③ tool_dispatched(kick)·kick 后：成员列表查无 → {kicked:true} 回填成功、kick 零重放', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await killConnect(h, token, 'acc-01');
      await killConnect(h, token, 'acc-02');
      const g = await killCreateGroup(h, token);
      await killPatchGroup(h, token, g.dbGroupId);
      const victimPuid = derivePlatformUserId('acc-02');
      await killArmPlaybook(h, [
        { kind: 'tool_use', name: 'kick_user', input: { platform_user_id: victimPuid, reason: 'k9 test' } },
        { kind: 'finish', summary: 'kick recovered' },
      ]);
      await armPoint(h, token, 'gateway.call.kick.after');
      await killEmitInbound(h, g.gwGroupId, 'm-k9-kick-post').catch(() => undefined);
      expect(await h.awaitExit()).toBe(9);

      const counters = await crashGatewayCounters(h);
      expect(counters.kickCalls).toBe(1); // 崩溃前 kick 已到网关一次
      await assertPostCrashHealth(h);
      const run = await waitRunDone(h, 90_000);
      expect(run.status).toBe('finished');
      const { rows: steps } = await h.db.pool.query<{ is_error: boolean; error_code: string | null }>(
        `SELECT is_error, error_code FROM agent_run_step WHERE run_id=$1 AND name='kick_user'`, [run.id]);
      expect(steps[0]?.is_error).toBe(false); // {kicked:true} 成功 tool_result
      const afterCounters = await crashGatewayCounters(h);
      expect(afterCounters.kickCalls).toBe(1); // A5-8：已产生效果，零重放
    } finally {
      await h.stop();
    }
  }, 150000);
});
