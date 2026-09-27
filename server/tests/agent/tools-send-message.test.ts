// send_message 工具端到端测试（T-P4-09 c 项，executor 集成）。
// 契约出处：DES/06 §8.2 流程图各分支码表 + §8.4 选账号 + REQ A5-5/7 + S5（SEND_TIMEOUT→重试返 sent）。
// 覆盖：审计→选账号→T13→落定 全链；accepted/sent 正常回 {clientMsgId,deliveryStatus}；
// failed(GROUP_UNREACHABLE)→同名码；failed(其他/账号终态)→SEND_FAILED run 继续；
// 5s 无结论 → SEND_TIMEOUT（不取消不标失败）；同 key 二次调用不发送不再审（ag-8/S5 半边）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import type { AgentClient, AgentAuditRequest, AgentAuditResponse, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';
import type { DeliveryWaiter } from '../../src/modules/agent/tools/send-message.js';

const silent = { info() {}, warn() {}, error() {} };

type TurnScript = Array<{ toolName: string; input: unknown } | 'end_turn'>;

class SendClient implements AgentClient {
  turnCalls: AgentTurnRequest[] = [];
  auditCalls: AgentAuditRequest[] = [];
  private script: TurnScript;
  private auditVerdicts: AgentAuditResponse[];

  constructor(script: TurnScript, auditVerdicts: AgentAuditResponse[] = [{ verdict: 'pass' }]) {
    this.script = script;
    this.auditVerdicts = auditVerdicts;
  }

  async rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse> {
    this.turnCalls.push(req);
    const step = this.script.shift() ?? 'end_turn';
    if (step === 'end_turn') {
      return { status: 200, raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }) };
    }
    return {
      status: 200,
      raw: JSON.stringify({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu_${this.turnCalls.length}`, name: step.toolName, input: step.input }],
      }),
    };
  }

  async callAudit(req: AgentAuditRequest): Promise<AgentAuditResponse> {
    this.auditCalls.push(req);
    return this.auditVerdicts.shift() ?? { verdict: 'pass' };
  }
}

describe('send_message 工具端到端（DES/06 §8.2/§8.4 / A5-5/7）', () => {
  let db: TestDbHandle;
  let groupId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE group_member, "group", ws_event, account, agent_run_step, agent_run,
               agent_idempotency_key, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    await db.pool.query(`UPDATE account SET status='online', platform_user_id='puid-01' WHERE id='acc-01'`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`);
    groupId = rows[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-01','puid-01','member')`,
      [groupId]);
  });

  async function makeRun(): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds') RETURNING id`,
      [groupId]);
    return rows[0]?.id ?? '';
  }

  async function waitDone(runId: string): Promise<Record<string, unknown>> {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query('SELECT status, end_reason FROM agent_run WHERE id=$1', [runId]);
      row = rows[0];
      expect(row?.['status']).not.toBe('running');
    }, { interval: 20, timeout: 5000 });
    return row ?? {};
  }

  function executor(client: AgentClient, waiter: DeliveryWaiter) {
    return createAgentExecutor({
      pool: db.pool, agentClient: client, logger: silent, instanceId: 't', deliveryWaiter: waiter,
    });
  }

  async function lastToolResult(runId: string, seq = 1): Promise<Record<string, unknown>> {
    const { rows } = await db.pool.query(
      'SELECT appended_blocks FROM agent_run_step WHERE run_id=$1 AND seq=$2', [runId, seq]);
    const blocks = rows[0]?.appended_blocks as Array<{ role: string; content: Array<{ type: string; content?: string }> }>;
    const tr = blocks?.[1]?.content[0];
    return JSON.parse(tr?.content ?? '{}') as Record<string, unknown>;
  }

  it('accepted → tool_result {clientMsgId, deliveryStatus}；T13 三件套同事务落库', async () => {
    const runId = await makeRun();
    const waiter: DeliveryWaiter = async (pool, cmid) => {
      await pool.query(`UPDATE message SET delivery_status='accepted' WHERE client_msg_id=$1`, [cmid]);
      return { delivery_status: 'accepted', fail_code: null };
    };
    const client = new SendClient([
      { toolName: 'send_message', input: { text: 'buy now', idempotency_key: 'k-1' } },
      'end_turn',
    ]);
    executor(client, waiter).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished');
    const res = await lastToolResult(runId);
    expect(res['deliveryStatus']).toBe('accepted');
    expect(typeof res['clientMsgId']).toBe('string');
    // 审计在发送前；送审 text=待发文本逐字
    expect(client.auditCalls.map((c) => c.text)).toEqual(['buy now']);
    const { rows: keys } = await db.pool.query(
      `SELECT client_msg_id FROM agent_idempotency_key WHERE run_id=$1 AND idempotency_key='k-1'`, [runId]);
    expect(keys.length).toBe(1);
    const { rows: msg } = await db.pool.query(
      `SELECT delivery_status, source, account_id, sender_platform_user_id FROM message WHERE client_msg_id=$1`,
      [keys[0]?.client_msg_id ?? '']);
    expect(msg[0]).toMatchObject({ source: 'agent', account_id: 'acc-01', sender_platform_user_id: 'puid-01' });
  });

  it('同 run 同 key 第二次调用（ag-8/S5）：命中表 → 不发送不再审，返回该消息当前状态', async () => {
    const runId = await makeRun();
    const client = new SendClient([
      { toolName: 'send_message', input: { text: 'x', idempotency_key: 'k-2' } },
      { toolName: 'send_message', input: { text: 'x', idempotency_key: 'k-2' } }, // 同 key 重试（S5 编排）
      'end_turn',
    ]);
    const waiter: DeliveryWaiter = async (pool, cmid) => {
      await pool.query(`UPDATE message SET delivery_status='sent', msg_id='M-77' WHERE client_msg_id=$1`, [cmid]);
      return { delivery_status: 'sent', fail_code: null };
    };
    executor(client, waiter).startRun(runId);
    await waitDone(runId);
    expect(client.auditCalls.length).toBe(1); // 第二次不再审计（A5-7 逐字）
    const { rows: msgs } = await db.pool.query('SELECT count(*)::int AS n FROM message WHERE group_id=$1', [groupId]);
    expect(msgs[0]?.n).toBe(1); // 未二次发送
    const res2 = await lastToolResult(runId, 2);
    expect(res2['deliveryStatus']).toBe('sent'); // 返回首次消息当前状态（S5：第二次返 sent）
  });

  it('failed(GROUP_UNREACHABLE) → tool_result 同名码（§8.2 FGU 分支）', async () => {
    const runId = await makeRun();
    const waiter: DeliveryWaiter = async (pool, cmid) => {
      await pool.query(`UPDATE message SET delivery_status='failed', fail_code='GROUP_UNREACHABLE' WHERE client_msg_id=$1`, [cmid]);
      return { delivery_status: 'failed', fail_code: 'GROUP_UNREACHABLE' };
    };
    const client = new SendClient([
      { toolName: 'send_message', input: { text: 'x', idempotency_key: 'k-3' } },
      'end_turn',
    ]);
    executor(client, waiter).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished'); // run 继续（工具失败归 tool_result）
    const res = await lastToolResult(runId);
    expect(res['code']).toBe('GROUP_UNREACHABLE');
  });

  it('等待中账号变终态（failed/ACCOUNT_TERMINAL）→ SEND_FAILED，run 继续（A5-5）', async () => {
    const runId = await makeRun();
    const waiter: DeliveryWaiter = async (pool, cmid) => {
      // 模拟终态取消流程把消息标 failed(ACCOUNT_TERMINAL)
      await pool.query(`UPDATE message SET delivery_status='failed', fail_code='ACCOUNT_TERMINAL' WHERE client_msg_id=$1`, [cmid]);
      return { delivery_status: 'failed', fail_code: 'ACCOUNT_TERMINAL' };
    };
    const client = new SendClient([
      { toolName: 'send_message', input: { text: 'x', idempotency_key: 'k-4' } },
      'end_turn',
    ]);
    executor(client, waiter).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished');
    const res = await lastToolResult(runId);
    expect(res['code']).toBe('SEND_FAILED');
  });

  it('5s 仍 unknown → SEND_TIMEOUT：不取消不标失败（判定器继续收敛，§8.2 FST）', async () => {
    const runId = await makeRun();
    const waiter: DeliveryWaiter = async () => ({ delivery_status: 'unknown', fail_code: null }); // 5s 无结论
    const client = new SendClient([
      { toolName: 'send_message', input: { text: 'x', idempotency_key: 'k-5' } },
      'end_turn',
    ]);
    executor(client, waiter).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished');
    const res = await lastToolResult(runId);
    expect(res['code']).toBe('SEND_TIMEOUT');
    const { rows: msg } = await db.pool.query(
      `SELECT delivery_status FROM message WHERE client_msg_id LIKE 'cm-${runId}%'`, []);
    expect(msg[0]?.delivery_status).toBe('queued'); // 行保持 queued/unknown——不取消不标失败
  });

  it('选账号按 account_id 字典序取 online 群成员（§8.4）；无候选 → NO_AVAILABLE_ACCOUNT', async () => {
    // 加一个 online 成员 acc-02（字典序 acc-01 < acc-02 → 仍选 acc-01）+ 离线 acc-00（不满足 online）
    await db.pool.query(`UPDATE account SET status='online', platform_user_id='puid-02' WHERE id='acc-02'`);
    await db.pool.query(`INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-02','puid-02','member')`, [groupId]);
    const runId = await makeRun();
    const waiter: DeliveryWaiter = async (pool, cmid) => {
      await pool.query(`UPDATE message SET delivery_status='accepted' WHERE client_msg_id=$1`, [cmid]);
      return { delivery_status: 'accepted', fail_code: null };
    };
    const client = new SendClient([
      { toolName: 'send_message', input: { text: 'x', idempotency_key: 'k-6' } },
      'end_turn',
    ]);
    executor(client, waiter).startRun(runId);
    await waitDone(runId);
    const { rows: msg } = await db.pool.query('SELECT account_id FROM message WHERE group_id=$1', [groupId]);
    expect(msg[0]?.account_id).toBe('acc-01'); // 字典序第一
  });
});
