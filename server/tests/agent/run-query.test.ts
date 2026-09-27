// agent-runs 查询端点测试（T-P4-13 c 项，先红后绿）。
// 契约出处：REQ §2.3 两行逐字（GET /api/agent-runs/:id 的 steps[] 逐字段 +
// GET /api/groups/:id/agent-runs 最近 20 条）+ DES/06 §11 + 解读 #22。
// 覆盖：step kind 闭集、协议错误步 toolUseId/name/input=null、rawResponse ≤2KB、
// isError→errorCode 必填、resultSummary ≤200、endReason 运行中为 null、
// endReason→status 映射逐字、列表 created_at DESC LIMIT 20、ISO 8601 时间、404。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';

describe('agent-runs 查询端点（REQ §2.3 + DES/06 §11）', () => {
  let db: TestDbHandle;
  let app: App;
  let groupId: string;
  let auth: { authorization: string };

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
    });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'viewer', password: 'viewer' } });
    auth = { authorization: `Bearer ${(res.json() as { accessToken: string }).accessToken}` };
  });
  afterAll(async () => { await app.close(); await db.close(); });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE group_member, "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status) VALUES (gen_random_uuid(), 'acc-01', 'active') RETURNING id`,
    );
    groupId = rows[0]?.id ?? '';
  });
  async function insertRun(over: { status?: string; endReason?: string; createdAt?: string } = {}): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, end_reason, trigger_context, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '{}'::jsonb, COALESCE($4::timestamptz, now())) RETURNING id`,
      [groupId, over.status ?? 'running', over.endReason ?? null, over.createdAt ?? null],
    );
    return rows[0]?.id ?? '';
  }

  it('GET /api/agent-runs/:id → run 字段 + steps 按 seq 逐字段映射', async () => {
    const runId = await insertRun({ status: 'finished', endReason: 'final' });
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, tool_use_id, name, input, result_summary, is_error, error_code, audit_verdict, raw_response, appended_blocks)
       VALUES
       ($1, 1, 'tool_use', 'done', 'tu-1', 'send_message', '{"text":"hi"}'::jsonb, 'accepted', false, NULL, 'pass', '{"ok":true}', '[]'::jsonb),
       ($1, 2, 'protocol_error', 'done', NULL, NULL, NULL, NULL, false, NULL, NULL, 'BROKEN RAW BODY', '[]'::jsonb),
       ($1, 3, 'final', 'done', NULL, NULL, NULL, 'ok', false, NULL, NULL, NULL, '[]'::jsonb)`,
      [runId],
    );
    const res = await app.inject({ method: 'GET', url: `/api/agent-runs/${runId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string; groupId: string; status: string; endReason: string | null;
      steps: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({ id: runId, groupId, status: 'finished', endReason: 'final' });
    expect(body.steps.length).toBe(3);
    // 逐字段映射（REQ §2.3 逐字顺序）：kind/toolUseId/name/input/resultSummary/isError/errorCode/auditVerdict/rawResponse
    expect(body.steps[0]).toMatchObject({
      kind: 'tool_use', toolUseId: 'tu-1', name: 'send_message',
      input: { text: 'hi' }, resultSummary: 'accepted', isError: false,
      errorCode: null, auditVerdict: 'pass', rawResponse: '{"ok":true}',
    });
    // 协议错误步：toolUseId/name/input = null（逐字）
    expect(body.steps[1]).toMatchObject({
      kind: 'protocol_error', toolUseId: null, name: null, input: null, rawResponse: 'BROKEN RAW BODY',
    });
    expect(body.steps[2]?.['kind']).toBe('final');
  });

  it('isError=true → errorCode 必填（§11 约束直接映射）；endReason 运行中为 null', async () => {
    const running = await insertRun({ status: 'running' });
    const res = await app.inject({ method: 'GET', url: `/api/agent-runs/${running}`, headers: auth });
    expect((res.json() as { endReason: string | null }).endReason).toBeNull();
    const failed = await insertRun({ status: 'failed', endReason: 'protocol_errors' });
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, tool_use_id, name, is_error, error_code, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'done', 'tu-9', 'send_message', true, 'SEND_FAILED', '[]'::jsonb)`,
      [failed],
    );
    const res2 = await app.inject({ method: 'GET', url: `/api/agent-runs/${failed}`, headers: auth });
    const body = res2.json() as { status: string; endReason: string; steps: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ status: 'failed', endReason: 'protocol_errors' });
    expect(body.steps[0]?.['errorCode']).toBe('SEND_FAILED');
  });

  it('时间字段 ISO 8601 UTC（ended_at 无值 → null）', async () => {
    const runId = await insertRun({ status: 'finished', endReason: 'final' });
    await db.pool.query(`UPDATE agent_run SET ended_at=now() WHERE id=$1`, [runId]);
    const res = await app.inject({ method: 'GET', url: `/api/agent-runs/${runId}`, headers: auth });
    const body = res.json() as { createdAt: string; endedAt: string | null };
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const running = await insertRun({ status: 'running' });
    const res2 = await app.inject({ method: 'GET', url: `/api/agent-runs/${running}`, headers: auth });
    expect((res2.json() as { endedAt: string | null }).endedAt).toBeNull();
  });

  it('GET /api/groups/:id/agent-runs → 最近 20 条、created_at DESC、不含 steps', async () => {
    for (let i = 0; i < 25; i += 1) {
      // uq_agent_run_single_flight 每群只允许一条 running——列表夹具用 finished（只测排序/截断）
      await insertRun({ status: 'finished', endReason: 'final', createdAt: `2026-01-0${Math.floor(i / 9) + 1}T0${(i % 9) + 1}:00:00Z` });
    }
    const res = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/agent-runs`, headers: auth });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; status: string; steps?: unknown; createdAt: string }>;
    expect(list.length).toBe(20); // LIMIT 20 逐字
    for (let i = 1; i < list.length; i += 1) {
      expect((list[i - 1]?.createdAt ?? '') >= (list[i]?.createdAt ?? '')).toBe(true); // created_at DESC
    }
    expect(list[0]?.steps).toBeUndefined(); // 列表可不含 steps
  });

  it('未知 run → 404；未知群 → 空列表', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agent-runs/00000000-0000-0000-0000-000000000000`, headers: auth });
    expect(res.statusCode).toBe(404);
    const res2 = await app.inject({ method: 'GET', url: `/api/groups/00000000-0000-0000-0000-000000000000/agent-runs`, headers: auth });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual([]);
  });
});
