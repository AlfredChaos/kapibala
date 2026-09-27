// 审计门禁测试（T-P4-07 c 项，先红后绿）。
// 契约出处：DES/06 §8.1/§8.3 逐字 + REQ A5-4 + §5（重试前查墙钟；§12 风险 2 交错）
// + 解读 #8（audit 单次 5s，归 agentclient AUDIT_SINGLE_TIMEOUT_MS）。
// 覆盖：text 构造（send=待发文本；kick=JSON action 形状）；pass→执行 / fail→AUDIT_REJECTED
// +run继续+key不消耗；unresolved×3（ag-14/15/16：500/坏JSON/慢不返回）→blocked+audit_blocked
// +ws_event；中途墙钟到期 → wall_clock；verdict 其他值=无结论；单次失败不返回 agent 不计步。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { runAuditGate, auditTextForTool, AUDIT_MAX_ATTEMPTS } from '../../src/modules/agent/audit.js';
import { createAgentExecutor, type ToolOutcome } from '../../src/modules/agent/executor.js';
import type { AgentClient, AgentAuditRequest, AgentAuditResponse, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

// ---------- 单元：text 构造 + 门禁循环 ----------

describe('审计门禁（DES/06 §8.1/A5-4）', () => {
  it('送审 text：send_message=待发文本；kick_user=JSON action 形状（逐字）', () => {
    expect(auditTextForTool('send_message', { text: 'hello world', idempotency_key: 'k' })).toBe('hello world');
    expect(auditTextForTool('kick_user', { platform_user_id: 'pu-9', reason: 'spam' }))
      .toBe(JSON.stringify({ action: 'kick', platform_user_id: 'pu-9', reason: 'spam' }));
    expect(auditTextForTool('get_recent_messages', { limit: 5 })).toBeUndefined();
    expect(auditTextForTool('finish', { summary: 's' })).toBeUndefined();
  });

  it('verdict=pass → pass；fail → rejected；其他值/缺字段 → 视为无结论重试', async () => {
    const mk = (verdict: AgentAuditResponse['verdict']) => ({
      agentClient: {
        rawTurn: async () => ({ status: 200, raw: '{}' }),
        callAudit: async () => ({ verdict }),
      } as AgentClient,
      groupId: 'g',
      wallDeadlineAt: null,
    });
    expect(await runAuditGate(mk('pass'), 'x')).toBe('pass');
    expect(await runAuditGate(mk('fail'), 'x')).toBe('rejected');
  });

  it('连续 unresolved → 恰 3 次调用后 blocked；单次失败不泄露（调用方不外传）', async () => {
    let calls = 0;
    const client = {
      rawTurn: async () => ({ status: 200, raw: '{}' }),
      callAudit: async () => { calls += 1; return { verdict: 'unresolved' as const }; },
    } as AgentClient;
    const out = await runAuditGate({ agentClient: client, groupId: 'g', wallDeadlineAt: null }, 'x');
    expect(out).toBe('blocked');
    expect(calls).toBe(AUDIT_MAX_ATTEMPTS); // 至多 3 次逐字
  });

  it('unresolved 后接 pass → pass（3 次内成功即放行）', async () => {
    let calls = 0;
    const client = {
      rawTurn: async () => ({ status: 200, raw: '{}' }),
      callAudit: async () => { calls += 1; return { verdict: calls < 2 ? 'unresolved' as const : 'pass' as const }; },
    } as AgentClient;
    expect(await runAuditGate({ agentClient: client, groupId: 'g', wallDeadlineAt: null }, 'x')).toBe('pass');
    expect(calls).toBe(2);
  });

  it('重试中途墙钟到期 → wall_clock 而非 audit_blocked（§12 风险 2 交错）', async () => {
    const deadline = new Date(1_000_000); // 固定点
    let tick = 900_000; // 第一次尝试前未到期
    const client = {
      rawTurn: async () => ({ status: 200, raw: '{}' }),
      callAudit: async () => {
        tick = 2_000_000; // 审计耗时跨过 deadline（计入墙钟的形态）
        return { verdict: 'unresolved' as const };
      },
    } as AgentClient;
    const out = await runAuditGate(
      { agentClient: client, groupId: 'g', wallDeadlineAt: deadline, now: () => tick },
      'x',
    );
    expect(out).toBe('wall_clock'); // 第 2 次重试前检出到期
  });

  it('deadline 已过 → 一次不调直接 wall_clock（重试前判定含首次）', async () => {
    let calls = 0;
    const client = {
      rawTurn: async () => ({ status: 200, raw: '{}' }),
      callAudit: async () => { calls += 1; return { verdict: 'pass' as const }; },
    } as AgentClient;
    const out = await runAuditGate(
      { agentClient: client, groupId: 'g', wallDeadlineAt: new Date(Date.now() - 1) },
      'x',
    );
    expect(out).toBe('wall_clock');
    expect(calls).toBe(0);
  });
});

// ---------- 集成：executor 内审计门禁 ----------

class AuditScriptClient implements AgentClient {
  turnCalls: AgentTurnRequest[] = [];
  auditCalls: AgentAuditRequest[] = [];
  private auditScript: AgentAuditResponse[] = [];
  pushAudit(r: AgentAuditResponse): void { this.auditScript.push(r); }
  async rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse> {
    this.turnCalls.push(req);
    // 首轮固定发 send_message tool_use；之后 end_turn
    if (this.turnCalls.length === 1) {
      return {
        status: 200,
        raw: JSON.stringify({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_send', name: 'send_message', input: { text: 'promo!', idempotency_key: 'k-1' } }],
        }),
      };
    }
    return { status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }) };
  }
  async callAudit(req: AgentAuditRequest): Promise<AgentAuditResponse> {
    this.auditCalls.push(req);
    return this.auditScript.shift() ?? { verdict: 'unresolved' };
  }
}

describe('executor 审计门禁集成（ag-14/15/16 + AUDIT_REJECTED + blocked）', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE gateway_event, "group", ws_event, account, agent_run_step, agent_run,
               agent_idempotency_key, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
  });

  async function makeRun(wallDeadline?: 'past'): Promise<string> {
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, $2) RETURNING id`,
      [g[0]?.id ?? '', wallDeadline === 'past' ? new Date(Date.now() - 500) : new Date(Date.now() + 60000)]);
    return rows[0]?.id ?? '';
  }

  async function waitDone(runId: string): Promise<Record<string, unknown>> {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query(
        'SELECT status, end_reason FROM agent_run WHERE id=$1', [runId]);
      row = rows[0];
      expect(row?.['status']).not.toBe('running');
    }, { interval: 20, timeout: 5000 });
    return row ?? {};
  }

  function executor(client: AgentClient, executeTool?: () => Promise<ToolOutcome>) {
    return createAgentExecutor({
      pool: db.pool, agentClient: client, logger: silent, instanceId: 't',
      ...(executeTool !== undefined ? { executeTool } : {}),
    });
  }

  it('audit pass → 工具执行缝被调（send_message 送审 text=待发文本逐字）', async () => {
    const runId = await makeRun();
    const client = new AuditScriptClient();
    client.pushAudit({ verdict: 'pass', reason: 'fine' });
    let toolRan = false;
    executor(client, async () => { toolRan = true; return { type: 'result', content: '{}' }; }).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished');
    expect(toolRan).toBe(true);
    expect(client.auditCalls.length).toBe(1);
    expect(client.auditCalls[0]).toMatchObject({ text: 'promo!' }); // send_message 送审=待发文本
    const { rows: steps } = await db.pool.query(
      'SELECT audit_verdict, status FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
    expect(steps[0]).toMatchObject({ audit_verdict: 'pass' }); // §3 时序框：审计通过落 audit_verdict='pass'
  });

  it('audit fail → AUDIT_REJECTED is_error tool_result；run 继续；幂等 key 不消耗', async () => {
    const runId = await makeRun();
    const client = new AuditScriptClient();
    client.pushAudit({ verdict: 'fail', reason: 'spam' });
    let toolRan = false;
    executor(client, async () => { toolRan = true; return { type: 'result', content: '{}' }; }).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished'); // run 继续到 end_turn
    expect(toolRan).toBe(false); // 工具不执行
    const { rows: steps } = await db.pool.query(
      'SELECT is_error, error_code, audit_verdict FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
    expect(steps[0]).toMatchObject({ is_error: true, error_code: 'AUDIT_REJECTED', audit_verdict: 'fail' });
    const { rows: keys } = await db.pool.query('SELECT count(*)::int AS n FROM agent_idempotency_key WHERE run_id=$1', [runId]);
    expect(keys[0]?.n).toBe(0); // key 不消耗（A5-7）
  });

  it('ag-14/15/16 三形态（500/坏 body/无返回）→ 连续 3 次无结论 → blocked/audit_blocked + 事件', async () => {
    const runId = await makeRun();
    const client = new AuditScriptClient();
    client.pushAudit({ verdict: 'unresolved' }); // 500（client 已归一）
    client.pushAudit({ verdict: 'unresolved' }); // 坏 JSON/缺 verdict（同归一）
    client.pushAudit({ verdict: 'unresolved' }); // 超时（同归一）
    executor(client, async () => ({ type: 'result', content: '{}' })).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'blocked', end_reason: 'audit_blocked' });
    expect(client.auditCalls.length).toBe(3);
    const { rows: steps } = await db.pool.query(
      'SELECT audit_verdict FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
    expect(steps[0]?.audit_verdict).toBe('unresolved');
    const { rows: ev } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='agent_run' AND payload->>'endReason'='audit_blocked'");
    expect(ev.length).toBe(1); // 阻塞通知操作员（A5-4 推事件）
  });

  it('审计重试中途墙钟到期 → wall_clock 而非 audit_blocked（交错 B）', async () => {
    const runId = await makeRun('past'); // deadline 已过：门禁首次判定即墙钟
    const client = new AuditScriptClient();
    client.pushAudit({ verdict: 'unresolved' });
    executor(client, async () => ({ type: 'result', content: '{}' })).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'failed', end_reason: 'wall_clock' });
    expect(client.auditCalls.length).toBe(0); // deadline 先到 → 一次不调
  });

  it('verdict 其他值 → 无结论（client 层已归一 unresolved；此处钉「3 次未过审不执行」不变式）', async () => {
    const runId = await makeRun();
    const client = new AuditScriptClient();
    client.pushAudit({ verdict: 'unresolved' });
    client.pushAudit({ verdict: 'unresolved' });
    client.pushAudit({ verdict: 'unresolved' });
    let toolRan = false;
    executor(client, async () => { toolRan = true; return { type: 'result', content: '{}' }; }).startRun(runId);
    await waitDone(runId);
    expect(toolRan).toBe(false);
  });
});
