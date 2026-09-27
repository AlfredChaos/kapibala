// turn 循环骨架测试（T-P4-05 c 项，先红后绿）。
// 契约出处：DES/06 §3 每步事务固定结构 + §6（超时丢弃/历史全 DB 重建）+ §2.1（拾取/租约/并发闸）；
// REQ A5-2（step=一次往返、超时记协议错误、晚到响应丢弃）、§2.2（tools 恰 4 个）。
// 形态：真实 DB + 注入假 AgentClient（fetch 不出网）；executeTool 缝注入假工具。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'; // vi.waitFor: 条件等待(非固定时长)
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createAgentExecutor, type ToolOutcome } from '../../src/modules/agent/executor.js';
import { AGENT_TOOLS } from '../../src/modules/agent/tools-def.js';
import type { AgentClient, AgentTurnRequest, AgentTurnResponse } from '../../src/agentclient/index.js';
import { AgentClientError } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

class FakeAgentClient implements AgentClient {
  readonly calls: AgentTurnRequest[] = [];
  private script: Array<(req: AgentTurnRequest) => Promise<AgentTurnResponse>> = [];

  push(fn: (req: AgentTurnRequest) => Promise<AgentTurnResponse>): void {
    this.script.push(fn);
  }

  async callTurn(req: AgentTurnRequest): Promise<AgentTurnResponse> {
    this.calls.push(req);
    const next = this.script.shift();
    if (next === undefined) {
      // 默认剧本：finish
      return {
        stopReason: 'tool_use',
        block: { type: 'tool_use', id: `tu_${this.calls.length}`, name: 'finish', input: { summary: 'done' } },
      };
    }
    return next(req);
  }
  async callAudit(): Promise<{ verdict: 'pass' | 'fail' | 'unresolved' }> {
    return { verdict: 'pass' };
  }
}

function toolUse(id: string, name: string, input: unknown): AgentTurnResponse {
  return { stopReason: 'tool_use', block: { type: 'tool_use', id, name, input } };
}
function endTurn(text: string): AgentTurnResponse {
  return { stopReason: 'end_turn', block: { type: 'text', text } };
}

async function waitRun(pool: TestDbHandle['pool'], runId: string): Promise<Record<string, unknown>> {
  let row: Record<string, unknown> | undefined;
  await vi.waitFor(async () => {
    const { rows } = await pool.query(
      'SELECT status, end_reason, summary, step_count FROM agent_run WHERE id=$1', [runId]);
    row = rows[0];
    expect(row?.['status']).not.toBe('running'); // 条件断言：非 running 即返回
  }, { interval: 20, timeout: 5000 });
  return row ?? {};
}

describe('agent executor turn 循环（DES/06 §3/§6 / A5-2）', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE gateway_event, group_member, "group", job, ws_event, account,
               sequence_run_step, sequence_run, sequence, agent_run_step, agent_trigger_queue,
               agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
  });

  async function makeGroup(): Promise<string> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ('acc-01','online','puid-01') ON CONFLICT (id) DO NOTHING`,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`,
    );
    return rows[0]?.id ?? '';
  }

  async function makeRun(groupId: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', $2::jsonb, now() + interval '60 seconds') RETURNING id`,
      [groupId, JSON.stringify({ groupId, triggerMessages: [{ msgId: 'm0', senderPlatformUserId: 'ext', text: 'hi', sentAt: new Date().toISOString() }], policy: { autoKickEnabled: false }, ownPlatformUserIds: ['puid-01'] })],
    );
    return rows[0]?.id ?? '';
  }

  function makeExecutor(client: FakeAgentClient, executeTool?: (ctx: { toolName: string; input: unknown }) => Promise<ToolOutcome>) {
    return createAgentExecutor({
      pool: db.pool,
      agentClient: client,
      logger: silent,
      instanceId: 'test-1',
      ...(executeTool !== undefined ? { executeTool: (c) => executeTool(c) } : {}),
    });
  }

  // ---------- 正常路径 ----------

  it('end_turn → step kind=final + assistant text 块 + run finished/final + summary（不发群）', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => endTurn('all done here'));
    makeExecutor(client).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run).toMatchObject({ status: 'finished', end_reason: 'final', summary: 'all done here', step_count: 1 });
    const { rows: steps } = await db.pool.query(
      'SELECT kind, status, appended_blocks, dispatch_payload FROM agent_run_step WHERE run_id=$1', [runId]);
    expect(steps.length).toBe(1);
    expect(steps[0]?.kind).toBe('final');
    expect(steps[0]?.status).toBe('done');
    const blocks = steps[0]?.appended_blocks as Array<{ role: string }>;
    expect(blocks[0]?.role).toBe('assistant');
    // dispatch_payload=意图先行请求快照（E11）：含 tools×4 + messages[0]=trigger_context
    const dp = steps[0]?.dispatch_payload as AgentTurnRequest;
    expect(dp.tools.length).toBe(4);
    const m0 = dp.messages[0] as { role: string; content: Array<{ text: string }> };
    expect(m0.role).toBe('user');
    const firstBlock = m0.content[0]; expect(firstBlock).toBeDefined(); expect(JSON.parse((firstBlock ?? { text: '{}' }).text)).toMatchObject({ groupId });
  });

  it('finish 工具 → step kind=final + run finished/final + summary=input.summary', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => toolUse('tu_f', 'finish', { summary: 'wrapped up' }));
    makeExecutor(client).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run).toMatchObject({ status: 'finished', end_reason: 'final', summary: 'wrapped up' });
    const { rows: steps } = await db.pool.query('SELECT kind, tool_use_id, name FROM agent_run_step WHERE run_id=$1', [runId]);
    expect(steps[0]).toMatchObject({ kind: 'final', tool_use_id: 'tu_f', name: 'finish' });
    expect(client.calls.length).toBe(1); // finish 之后不再调 turn
  });

  it('工具经 executeTool 缝执行：tool_use→tool_result 追加 + step done，run 继续到 finish', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => toolUse('tu_q', 'get_recent_messages', { limit: 5 }));
    client.push(async () => endTurn('bye'));
    const seen: string[] = [];
    makeExecutor(client, async (ctx) => {
      seen.push(ctx.toolName);
      return { type: 'result', content: '{"messages":[],"truncated":false}', resultSummary: '0 msgs' };
    }).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run.status).toBe('finished');
    expect(seen).toEqual(['get_recent_messages']);
    const { rows: steps } = await db.pool.query(
      'SELECT seq, kind, status, appended_blocks, result_summary FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps.length).toBe(2);
    const b1 = steps[0]?.appended_blocks as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>;
    expect(b1.length).toBe(2); // assistant tool_use + user tool_result
    expect(b1[0]?.content[0]?.type).toBe('tool_use');
    expect(b1[1]?.content[0]?.type).toBe('tool_result');
    expect(b1[1]?.content[0]?.tool_use_id).toBe('tu_q');
    expect(steps[0]?.result_summary).toBe('0 msgs');
  });

  it('历史重建：第二轮请求 messages 含首轮 appended_blocks（executor 零内存依赖）', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => toolUse('tu_1', 'get_recent_messages', { limit: 5 }));
    client.push(async () => endTurn('x'));
    makeExecutor(client, async () => ({ type: 'result', content: '[]' })).startRun(runId);
    await waitRun(db.pool, runId);
    const second = client.calls[1]; expect(second).toBeDefined(); if (second === undefined) return;
    // messages = user(trigger ctx) + assistant tool_use + user tool_result
    expect(second.messages.length).toBe(3);
    expect(second.messages[1]?.role).toBe('assistant');
    expect(second.messages[2]?.role).toBe('user');
    expect(JSON.stringify(second.messages[2])).toContain('tool_result');
  });

  // ---------- 协议错误 ----------

  it('turn 超时（TURN_TIMEOUT）→ 协议错误步：无 assistant 块，仅 user PROTOCOL_ERROR 文本，streak+1', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => { throw new AgentClientError('TURN_TIMEOUT', 'aborted'); });
    client.push(async () => endTurn('ok'));
    makeExecutor(client).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run.status).toBe('finished');
    const { rows: steps } = await db.pool.query(
      'SELECT seq, kind, error_code, appended_blocks FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps[0]).toMatchObject({ kind: 'protocol_error', error_code: 'TURN_TIMEOUT' });
    const b = steps[0]?.appended_blocks as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(b.length).toBe(1);
    expect(b[0]?.role).toBe('user');
    expect(b[0]?.content[0]?.text).toContain('PROTOCOL_ERROR TURN_TIMEOUT');
    const { rows: run2 } = await db.pool.query('SELECT protocol_error_streak FROM agent_run WHERE id=$1', [runId]);
    expect(run2[0]?.protocol_error_streak).toBe(0); // 后续合法响应清零
  });

  it('连续 3 次协议错误 → run failed/protocol_errors', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    for (let i = 0; i < 3; i++) client.push(async () => { throw new AgentClientError('BAD_JSON', 'bad', '<html>'); });
    makeExecutor(client).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run).toMatchObject({ status: 'failed', end_reason: 'protocol_errors', step_count: 3 });
  });

  it('晚到响应丢弃：step 已落 TURN_TIMEOUT 后响应写回 rowcount=0，不覆盖（A5-2）', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => {
      // 模拟「超时路径已先落库」：并发把该 step 按 TURN_TIMEOUT 终态化，再返回晚到响应
      await db.pool.query(
        `UPDATE agent_run_step SET kind='protocol_error', status='done', error_code='TURN_TIMEOUT',
                appended_blocks='[{"role":"user","content":[{"type":"text","text":"PROTOCOL_ERROR TURN_TIMEOUT: x"}]}]'::jsonb
         WHERE run_id=$1 AND status='turn_dispatched'`, [runId]);
      await db.pool.query('UPDATE agent_run SET protocol_error_streak=protocol_error_streak+1, step_count=step_count+1 WHERE id=$1', [runId]);
      return toolUse('tu_late', 'get_recent_messages', { limit: 1 }); // 合法但晚到
    });
    client.push(async () => endTurn('done'));
    makeExecutor(client).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run.status).toBe('finished');
    const { rows: steps } = await db.pool.query(
      'SELECT seq, kind, error_code FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps[0]?.error_code).toBe('TURN_TIMEOUT'); // 未被晚到响应覆盖
    expect(steps.length).toBe(2); // 下一步照常进行
  });

  it('重复 tool_use_id → DUPLICATE_TOOL_USE_ID 协议错误步', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => toolUse('tu_dup', 'get_recent_messages', { limit: 1 }));
    client.push(async () => toolUse('tu_dup', 'get_recent_messages', { limit: 2 })); // 同 id
    client.push(async () => endTurn('x'));
    makeExecutor(client, async () => ({ type: 'result', content: '[]' })).startRun(runId);
    await waitRun(db.pool, runId);
    const { rows: steps } = await db.pool.query(
      'SELECT seq, kind, error_code FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps[1]?.error_code).toBe('DUPLICATE_TOOL_USE_ID');
    expect(steps[1]?.kind).toBe('protocol_error');
  });

  it('未知工具 → 路径 A：assistant 块照追加 + is_error tool_result，run 继续（streak 清零语义）', async () => {
    const groupId = await makeGroup();
    const runId = await makeRun(groupId);
    const client = new FakeAgentClient();
    client.push(async () => toolUse('tu_u', 'nonsense_tool', {}));
    client.push(async () => endTurn('x'));
    makeExecutor(client).startRun(runId);
    const run = await waitRun(db.pool, runId);
    expect(run.status).toBe('finished');
    const { rows: steps } = await db.pool.query(
      'SELECT kind, is_error, error_code, appended_blocks FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps[0]).toMatchObject({ kind: 'tool_use', is_error: true, error_code: 'UNKNOWN_TOOL' });
    const b = steps[0]?.appended_blocks as Array<{ role: string }>;
    expect(b.length).toBe(2); // assistant tool_use + is_error tool_result（路径 A）
  });

  // ---------- tools 常量（ag-19 反测钉死） ----------

  it('tools 常量恰 4 个且 required 覆盖全部入参', () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(['get_recent_messages', 'send_message', 'kick_user', 'finish']);
    for (const t of AGENT_TOOLS) {
      const schema = t.input_schema as { required?: string[]; properties?: Record<string, unknown> };
      const required = new Set(schema.required ?? []);
      for (const prop of Object.keys(schema.properties ?? {})) {
        expect(required.has(prop)).toBe(true); // required 覆盖全部入参（否则 400 TOOLS_INVALID）
      }
    }
  });

  // ---------- 拾取闸 ----------

  it('并发闸：maxConcurrentRuns=1 时第二个 run 排队，释放后拾取', async () => {
    const groupId = await makeGroup();
    const runId1 = await makeRun(groupId);
    const groupId2 = await makeGroup();
    const runId2 = await makeRun(groupId2);
    const client = new FakeAgentClient();
    let release1!: () => void;
    const gate = new Promise<void>((r) => { release1 = r; });
    client.push(async () => { await gate; return endTurn('r1'); });
    client.push(async () => endTurn('r2'));
    const ex = createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't', maxConcurrentRuns: 1 });
    ex.startRun(runId1);
    ex.startRun(runId2);
    await vi.waitFor(() => expect(client.calls.length).toBe(1), { interval: 20, timeout: 5000 });
    expect(client.calls.length).toBe(1); // run2 未拾取（信号量挡——release 前不可能到 2）
    release1();
    await waitRun(db.pool, runId1);
    await waitRun(db.pool, runId2);
    expect(client.calls.length).toBe(2); // 释放空位后被拾起
  });
});
