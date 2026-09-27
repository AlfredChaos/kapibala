// 三段式校验 + 协议错误两类分流测试（T-P4-06 c 项，先红后绿）。
// 契约出处：DES/06 §4 全文逐字 + REQ A5-3/§2.2/§2.3 + VITEST_PLAN §3.2 ag-1..7。
// 覆盖：三层各自的 BAD_JSON 形态（非 2xx / 围栏夹文非 JSON / 缺 stop_reason、块数≠1、
// stop_reason 与块类型不一致）；路径 B 三码的落库形状（无 assistant 块、user PROTOCOL_ERROR、
// tool_use_id/name/input=NULL、raw_response≤2KB、超时 null、计步计 streak）；
// 路径 A 两码（assistant 块照追加 + is_error tool_result、streak 清零、合法响应语义）；
// 连续 3 次 → failed/protocol_errors；合法响应清零。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { validateTurnResponse, validateToolInput } from '../../src/modules/agent/validation.js';
import {
  appendToolErrorResult,
  recordProtocolErrorStep,
} from '../../src/modules/agent/protocol-errors.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import type { AgentClient, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';
import { AgentClientError } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

// ---------- 单元：三段式校验 ----------

describe('三段式校验（DES/06 §4 L1/L2/L3；ag-1..4）', () => {
  it('L1：HTTP 非 2xx → BAD_JSON（400/500/502 同码）', () => {
    for (const status of [400, 500, 502]) {
      const v = validateTurnResponse({ status, raw: '{}' });
      expect(v).toMatchObject({ ok: false, code: 'BAD_JSON' });
    }
  });

  it('L2：非合法 JSON → BAD_JSON（markdown 围栏 / 前后夹文 / 截断全归一）', () => {
    const cases = [
      '```json\n{"stop_reason":"end_turn","content":[{"type":"text","text":"x"}]}\n```', // ag-1 围栏
      'Here you go: {"stop_reason":"end_turn","content":[{"type":"text","text":"x"}]} done', // ag-2 夹文
      '{"stop_reason":"end_turn"', // 截断
      'not json at all',
      '',
    ];
    for (const raw of cases) {
      expect(validateTurnResponse({ status: 200, raw })).toMatchObject({ ok: false, code: 'BAD_JSON' });
    }
  });

  it('L3：形状不符 → BAD_JSON（缺 stop_reason / 块数≠1 / 类型不一致 / 未知 stop_reason）', () => {
    const shapes = [
      JSON.stringify({ content: [{ type: 'text', text: 'x' }] }), // 缺 stop_reason
      JSON.stringify({ stop_reason: 'end_turn', content: [] }), // 块数 0
      JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), // 块数 2
      JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'x' }] }), // tool_use + text 块不一致
      JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 'a', name: 'finish', input: {} }] }), // end_turn + tool_use 不一致
      JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'x' }] }), // 未知 stop_reason
      JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'finish' }] }), // 缺 id
    ];
    for (const raw of shapes) {
      expect(validateTurnResponse({ status: 200, raw })).toMatchObject({ ok: false, code: 'BAD_JSON' });
    }
  });

  it('合法响应通过三段式：tool_use 与 end_turn 各一', () => {
    const t = validateTurnResponse({ status: 200, raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'finish', input: { summary: 's' } }] }) });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.response.stopReason).toBe('tool_use');
    const e = validateTurnResponse({ status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }) });
    expect(e.ok).toBe(true);
  });

  it('validateToolInput：缺 required/非正数 limit/未知工具各归位（ag-6 输入侧）', () => {
    expect(validateToolInput('finish', {})).toContain('summary');
    expect(validateToolInput('send_message', { text: 'x' })).toContain('idempotency_key');
    expect(validateToolInput('get_recent_messages', { limit: 0 })).toContain('positive');
    expect(validateToolInput('get_recent_messages', { limit: 1.5 })).toContain('integer');
    expect(validateToolInput('get_recent_messages', { limit: 100000 })).toBeNull(); // >50 钳制不归 INVALID_INPUT
    expect(validateToolInput('nonsense', {})).toBeNull(); // 未知名不归本层（UNKNOWN_TOOL 先判）
    expect(validateToolInput('finish', { summary: 'ok' })).toBeNull();
  });
});

// ---------- 单元：协议错误落库形状 ----------

describe('协议错误落库原语（§4 路径 A/B + §2.3 字段）', () => {
  let db: TestDbHandle;
  let runId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE gateway_event, "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`,
    );
    const { rows: r } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds') RETURNING id`,
      [g[0]?.id ?? ''],
    );
    runId = r[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, dispatch_payload, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'turn_dispatched', '{}'::jsonb, '[]'::jsonb)`,
      [runId],
    );
  });

  it('路径 B：kind=protocol_error、tool_use_id/name/input=NULL、仅 user PROTOCOL_ERROR 块、计步+streak', async () => {
    await tx(db.pool, (c: PoolClient) =>
      recordProtocolErrorStep(c, { runId, seq: 1, code: 'BAD_JSON', rawResponse: 'garbage body' }),
    );
    const { rows } = await db.pool.query(
      'SELECT kind, tool_use_id, name, input, error_code, raw_response, appended_blocks, status FROM agent_run_step WHERE run_id=$1', [runId]);
    const step = rows[0]; expect(step).toBeDefined(); if (step === undefined) return;
    expect(step).toMatchObject({ kind: 'protocol_error', tool_use_id: null, name: null, input: null, error_code: 'BAD_JSON', status: 'done' });
    expect(step['raw_response']).toBe('garbage body');
    const blocks = step['appended_blocks'] as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.role).toBe('user');
    expect(blocks[0]?.content[0]?.type).toBe('text');
    expect(blocks[0]?.content[0]?.text).toMatch(/^PROTOCOL_ERROR BAD_JSON: /);
    const { rows: run } = await db.pool.query('SELECT step_count, protocol_error_streak FROM agent_run WHERE id=$1', [runId]);
    expect(run[0]).toMatchObject({ step_count: 1, protocol_error_streak: 1 });
  });

  it('TURN_TIMEOUT → raw_response=NULL（超时无原始体）', async () => {
    await tx(db.pool, (c) => recordProtocolErrorStep(c, { runId, seq: 1, code: 'TURN_TIMEOUT' }));
    const { rows } = await db.pool.query('SELECT raw_response, error_code FROM agent_run_step WHERE run_id=$1', [runId]);
    expect(rows[0]).toMatchObject({ raw_response: null, error_code: 'TURN_TIMEOUT' });
  });

  it('raw_response 截断 2KB（REQ §2.3 逐字）', async () => {
    const big = 'x'.repeat(5000);
    await tx(db.pool, (c) => recordProtocolErrorStep(c, { runId, seq: 1, code: 'BAD_JSON', rawResponse: big }));
    const { rows } = await db.pool.query('SELECT raw_response FROM agent_run_step WHERE run_id=$1', [runId]);
    expect((rows[0]?.['raw_response'] as string).length).toBe(2048);
  });

  it('turn_received 已计步的协议错误不再加 step_count（dup-id 晚路径）', async () => {
    await db.pool.query(`UPDATE agent_run SET step_count=1 WHERE id=$1`, [runId]);
    await db.pool.query(`UPDATE agent_run_step SET status='turn_received' WHERE run_id=$1`, [runId]);
    await tx(db.pool, (c) =>
      recordProtocolErrorStep(c, { runId, seq: 1, code: 'DUPLICATE_TOOL_USE_ID', stepCounted: true }),
    );
    const { rows } = await db.pool.query('SELECT step_count, protocol_error_streak FROM agent_run WHERE id=$1', [runId]);
    expect(rows[0]).toMatchObject({ step_count: 1, protocol_error_streak: 1 }); // 步未重复计
  });

  it('streak 触顶判定：第 3 次连续错误 → streakHit=true', async () => {
    await db.pool.query('UPDATE agent_run SET protocol_error_streak=2 WHERE id=$1', [runId]);
    const res = await tx(db.pool, (c) => recordProtocolErrorStep(c, { runId, seq: 1, code: 'BAD_JSON' }));
    expect(res.streakHit).toBe(true);
  });

  it('路径 A：assistant tool_use 块 + is_error tool_result 同 step（合法响应语义）', async () => {
    await tx(db.pool, (c) =>
      appendToolErrorResult(c, {
        runId, seq: 1, toolUseId: 'tu_9', toolName: 'bogus', input: {},
        code: 'UNKNOWN_TOOL', message: 'unknown tool: bogus',
      }),
    );
    const { rows } = await db.pool.query(
      'SELECT kind, tool_use_id, name, is_error, error_code, appended_blocks FROM agent_run_step WHERE run_id=$1', [runId]);
    const step = rows[0]; expect(step).toBeDefined(); if (step === undefined) return;
    expect(step).toMatchObject({ kind: 'tool_use', tool_use_id: 'tu_9', name: 'bogus', is_error: true, error_code: 'UNKNOWN_TOOL' });
    const blocks = step['appended_blocks'] as Array<{ role: string; content: Array<{ type: string; is_error?: boolean }> }>;
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.role).toBe('assistant');
    expect(blocks[0]?.content[0]?.type).toBe('tool_use'); // assistant 块照追加（路径 A 与 B 的分界）
    expect(blocks[1]?.content[0]?.type).toBe('tool_result');
    expect(blocks[1]?.content[0]?.is_error).toBe(true);
  });
});

// ---------- 集成：executor 两路径 + 连续 3 次终结 ----------

class ScriptedClient implements AgentClient {
  calls: AgentTurnRequest[] = [];
  private queue: Array<AgentRawResponse | (() => never)> = [];
  push(r: AgentRawResponse | (() => never)): void { this.queue.push(r); }
  async rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) {
      return { status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }) };
    }
    if (typeof next === 'function') return next();
    return next;
  }
  async callAudit() { return { verdict: 'pass' as const }; }
}

describe('executor 集成：两类分流 + streak（ag-1..7 端到端）', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE gateway_event, "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
  });

  async function makeRun(): Promise<string> {
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds') RETURNING id`,
      [g[0]?.id ?? '']);
    return rows[0]?.id ?? '';
  }

  async function waitDone(runId: string): Promise<Record<string, unknown>> {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query('SELECT status, end_reason, protocol_error_streak, step_count FROM agent_run WHERE id=$1', [runId]);
      row = rows[0];
      expect(row?.['status']).not.toBe('running');
    }, { interval: 20, timeout: 5000 });
    return row ?? {};
  }

  function bad(code: 'BAD_JSON' | 'TURN_TIMEOUT'): AgentRawResponse | (() => never) {
    if (code === 'TURN_TIMEOUT') {
      return () => { throw new AgentClientError('TURN_TIMEOUT', 'aborted'); };
    }
    return { status: 200, raw: 'not json' };
  }

  it('ag-1..4 混合形态 → 全走路径 B；连续 3 次 → failed/protocol_errors', async () => {
    const runId = await makeRun();
    const client = new ScriptedClient();
    client.push({ status: 500, raw: 'err' }); // L1
    client.push({ status: 200, raw: '```json\n{}\n```' }); // L2 围栏
    client.push({ status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [] }) }); // L3
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'failed', end_reason: 'protocol_errors', step_count: 3 });
    const { rows: steps } = await db.pool.query(
      'SELECT kind, error_code, tool_use_id, appended_blocks FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps.length).toBe(3);
    for (const s of steps) {
      expect(s).toMatchObject({ kind: 'protocol_error', error_code: 'BAD_JSON', tool_use_id: null });
      const b = s['appended_blocks'] as Array<{ role: string }>;
      expect(b.every((x) => x.role === 'user')).toBe(true); // 无 assistant 块（路径 B 定义）
    }
  });

  it('合法响应清零 streak（A5-2 逐字）：错、合法、错、合法 → 不终结', async () => {
    const runId = await makeRun();
    const client = new ScriptedClient();
    client.push(bad('BAD_JSON'));
    client.push({ status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) }); // 合法 → 清零
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'finished', protocol_error_streak: 0 });
  });

  it('ag-5 未知工具 → 路径 A：is_error tool_result(UNKNOWN_TOOL)，step 计步但 streak 清零、run 继续', async () => {
    const runId = await makeRun();
    const client = new ScriptedClient();
    client.push({ status: 200, raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'weird_tool', input: {} }] }) });
    client.push({ status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) });
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished');
    const { rows: steps } = await db.pool.query(
      'SELECT kind, is_error, error_code, appended_blocks FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps[0]).toMatchObject({ kind: 'tool_use', is_error: true, error_code: 'UNKNOWN_TOOL' });
    const b = steps[0]?.appended_blocks as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(b[0]?.role).toBe('assistant'); // 路径 A：assistant 块保留
    expect(b[1]?.content[0]?.type).toBe('tool_result');
  });

  it('ag-6 入参不合 schema → 路径 A INVALID_INPUT', async () => {
    const runId = await makeRun();
    const client = new ScriptedClient();
    client.push({ status: 200, raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_2', name: 'finish', input: {} }] }) }); // 缺 summary
    client.push({ status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) });
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    await waitDone(runId);
    const { rows: steps } = await db.pool.query('SELECT error_code, is_error FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId]);
    expect(steps[0]).toMatchObject({ error_code: 'INVALID_INPUT', is_error: true });
  });

  it('ag-7 重复 tool_use.id → 路径 B DUPLICATE_TOOL_USE_ID（UNIQUE 检测语义）', async () => {
    // 首步 get_recent_messages 不终结 run；第二步同 tool_use.id 撞 UNIQUE(run_id,tool_use_id)
    const client2 = new ScriptedClient();
    const runId2 = await makeRun();
    client2.push({ status: 200, raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'get_recent_messages', input: { limit: 1 } }] }) });
    client2.push({ status: 200, raw: JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'finish', input: { summary: 's' } }] }) }); // 同 id
    client2.push({ status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) });
    createAgentExecutor({
      pool: db.pool, agentClient: client2, logger: silent, instanceId: 't',
      executeTool: async () => ({ type: 'result', content: '{}' }),
    }).startRun(runId2);
    await waitDone(runId2);
    const { rows: steps } = await db.pool.query('SELECT kind, error_code FROM agent_run_step WHERE run_id=$1 ORDER BY seq', [runId2]);
    expect(steps[1]).toMatchObject({ kind: 'protocol_error', error_code: 'DUPLICATE_TOOL_USE_ID' });
    expect(steps[1]?.['tool_use_id'] ?? null).toBeNull(); // 路径 B 不写 tool_use_id
  });
});
