// get_recent_messages + finish 工具测试（T-P4-08 c 项，先红后绿）。
// 契约出处：DES/06 §7.1/§7.4 逐字 + REQ §2.2 工具表 + A5-9 + QR §1（50/500/8KB/200 字行）。
// 覆盖：limit>50 钳制不报错（ag-11）；升序 + 含触发消息与 run 期间新到消息；单条 >500 字截断；
// 整体 >8KB 截断置 truncated；{messages,truncated} 形状；resultSummary≤200；finish 收束
// （kind=final/finished/final/summary 落库/不再调 turn）；ag-9/10 重复调用正常返回（预算兜底）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { queryRecentMessages, execGetRecentMessages } from '../../src/modules/agent/tools/query.js';
import { execFinish } from '../../src/modules/agent/tools/finish.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import type { AgentClient, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

describe('get_recent_messages（DES/06 §7.1 / QR §1）', () => {
  let db: TestDbHandle;
  let groupId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`);
    groupId = rows[0]?.id ?? '';
  });

  async function addMsg(text: string, sentAt: Date, over: { isOwn?: boolean; puid?: string; msgId?: string } = {}): Promise<void> {
    await db.pool.query(
      `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, over.msgId ?? `m-${Math.random().toString(36).slice(2, 10)}`, over.puid ?? 'ext', over.isOwn ?? false, text, sentAt],
    );
  }

  it('升序返回 + 含触发消息与 run 期间新到消息（无时间过滤快照）', async () => {
    await addMsg('first', new Date('2026-09-28T01:00:00Z'));
    await addMsg('second', new Date('2026-09-28T01:00:01Z'));
    await addMsg('third (arrived mid-run)', new Date('2026-09-28T01:00:02Z'));
    const res = await queryRecentMessages(db.pool as never, groupId, 10);
    const parsed = JSON.parse(res.content) as { messages: Array<{ text: string; sentAt: string }>; truncated: boolean };
    expect(parsed.truncated).toBe(false);
    expect(parsed.messages.map((m) => m.text)).toEqual(['first', 'second', 'third (arrived mid-run)']); // sentAt 升序
    const s0 = parsed.messages[0]?.sentAt ?? ''; const s2 = parsed.messages[2]?.sentAt ?? ''; expect(s0 !== '' && s0 < s2).toBe(true);
  });

  it('limit=min(limit,50)：>50 钳制不报错（ag-11；§7.1 逐字「超过按 50 处理」）', async () => {
    for (let i = 0; i < 60; i++) {
      await addMsg(`m${i}`, new Date(Date.UTC(2026, 8, 28, 1, 0, 0) + i * 1000));
    }
    const res = await queryRecentMessages(db.pool as never, groupId, 100000); // ag-11 巨值
    const parsed = JSON.parse(res.content) as { messages: Array<{ text: string }> };
    expect(parsed.messages.length).toBe(50); // 恰按 50 处理
    expect(parsed.messages[0]?.text).toBe('m10'); // 最近 50 条的头部（升序后第 51 条）
    expect(parsed.messages[49]?.text).toBe('m59'); // 最新一条在尾
  });

  it('单条 text >500 字截断并置 truncated:true', async () => {
    await addMsg('x'.repeat(600), new Date());
    const res = await queryRecentMessages(db.pool as never, groupId, 10);
    const parsed = JSON.parse(res.content) as { messages: Array<{ text: string }>; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages[0]?.text.length).toBe(500);
  });

  it('整体 content >8KB → 截断置 truncated:true（A5-9；尾丢弃保序）', async () => {
    for (let i = 0; i < 30; i++) {
      await addMsg('y'.repeat(400), new Date(Date.UTC(2026, 8, 28, 2, 0, 0) + i * 1000));
    }
    const res = await queryRecentMessages(db.pool as never, groupId, 50);
    expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(8192);
    const parsed = JSON.parse(res.content) as { messages: unknown[]; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages.length).toBeLessThan(30);
  });

  it('返回元素形状 {msgId,senderPlatformUserId,isOwn,text,sentAt}；result_summary ≤200 字', async () => {
    await addMsg('hi', new Date('2026-09-28T03:00:00Z'), { msgId: 'mm-1', puid: 'ext-7' });
    const outcome = await execGetRecentMessages(db.pool as never, { groupId, input: { limit: 5 } });
    expect(outcome.type).toBe('result');
    if (outcome.type !== 'result') return;
    const parsed = JSON.parse(outcome.content) as { messages: Array<Record<string, unknown>> };
    expect(parsed.messages[0]).toEqual({
      msgId: 'mm-1', senderPlatformUserId: 'ext-7', isOwn: false, text: 'hi',
      sentAt: '2026-09-28T03:00:00.000Z',
    });
    expect((outcome.resultSummary ?? '').length).toBeLessThanOrEqual(200);
  });
});

// ---------- finish + executor 集成 ----------

class ToolScriptClient implements AgentClient {
  calls: AgentTurnRequest[] = [];
  private responses: string[] = [];
  pushRaw(raw: string): void { this.responses.push(raw); }
  async rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse> {
    this.calls.push(req);
    const raw = this.responses.shift() ??
      JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'fin' }] });
    return { status: 200, raw };
  }
  async callAudit() { return { verdict: 'pass' as const }; }
}

describe('finish 工具 + 集成（§7.4；ag-9/10 重复调用正常）', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
  });

  async function makeRun(): Promise<{ runId: string; groupId: string }> {
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds') RETURNING id`,
      [g[0]?.id ?? '']);
    return { runId: rows[0]?.id ?? '', groupId: g[0]?.id ?? '' };
  }

  async function waitDone(runId: string): Promise<Record<string, unknown>> {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query('SELECT status, end_reason, summary FROM agent_run WHERE id=$1', [runId]);
      row = rows[0];
      expect(row?.['status']).not.toBe('running');
    }, { interval: 20, timeout: 5000 });
    return row ?? {};
  }

  it('execFinish 纯函数：end_run finished/final + summary 透传 + stepKind=final', () => {
    const out = execFinish({ summary: 'wrapped' });
    expect(out).toMatchObject({ type: 'end_run', status: 'finished', endReason: 'final', summary: 'wrapped', stepKind: 'final' });
    expect(execFinish({})).toMatchObject({ summary: '' });
  });

  it('executor 内 finish：step kind=final + run finished/final + summary 落库 + 不再调 turn', async () => {
    const { runId } = await makeRun();
    const client = new ToolScriptClient();
    client.pushRaw(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_f', name: 'finish', input: { summary: 'done here' } }] }));
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'finished', end_reason: 'final', summary: 'done here' });
    expect(client.calls.length).toBe(1); // finish 后不再调 turn（§7.4）
    const { rows: steps } = await db.pool.query('SELECT kind, result_summary FROM agent_run_step WHERE run_id=$1', [runId]);
    expect(steps[0]).toMatchObject({ kind: 'final', result_summary: 'ok' });
  });

  it('executor 内 get_recent_messages 真执行：tool_result 含 messages JSON，run 续到 end_turn', async () => {
    const { runId, groupId } = await makeRun();
    await db.pool.query(
      `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
       VALUES ($1, 'mm', 'ext', false, 'hello', now())`, [groupId]);
    const client = new ToolScriptClient();
    client.pushRaw(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_q', name: 'get_recent_messages', input: { limit: 5 } }] }));
    client.pushRaw(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'bye' }] }));
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished');
    const { rows: steps } = await db.pool.query(
      'SELECT appended_blocks FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
    const blocks = steps[0]?.appended_blocks as Array<{ role: string; content: Array<{ content?: string }> }>;
    const toolResult = blocks[1]?.content[0];
    const payload = JSON.parse(toolResult?.content ?? '{}') as { messages: Array<{ text: string }> };
    expect(payload.messages[0]?.text).toBe('hello');
  });

  it('ag-9/10：重复同样入参调用正常返回（预算兜底而非报错）', async () => {
    const { runId, groupId } = await makeRun();
    await db.pool.query(
      `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
       VALUES ($1, 'mm', 'ext', false, 'x', now())`, [groupId]);
    const client = new ToolScriptClient();
    for (let i = 0; i < 3; i++) {
      client.pushRaw(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${i}`, name: 'get_recent_messages', input: { limit: 5 } }] }));
    }
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run.status).toBe('finished'); // 3 次重复调用全部正常返回，第 4 轮 end_turn
    expect(client.calls.length).toBe(4);
    const { rows: steps } = await db.pool.query(
      `SELECT count(*)::int AS n FROM agent_run_step WHERE run_id=$1 AND kind='tool_use' AND is_error=false`, [runId]);
    expect(steps[0]?.n).toBe(3); // 每个查询步都正常 done
  });
});
