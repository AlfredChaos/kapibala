// 序列 run 查询端点测试（T-P6-05 c 项，先红后绿）。
// 契约出处：REQ §2.3 GET /api/sequence-runs/:id 行逐字 + DES/07 §6 响应组装。
// 覆盖：steps[] 逐字段（index/status/scheduledAt/sentAt/clientMsgId/resolvedVars/varSources）、
// 未排期 scheduledAt=null、未发出 sentAt=null、枚举闭集、varSources ∈ default|step:<i>、
// ISO 8601 UTC、404。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';

describe('GET /api/sequence-runs/:id（REQ §2.3 + DES/07 §6）', () => {
  let db: TestDbHandle;
  let app: App;
  let auth: { authorization: string };
  let groupId: string;
  let runId: string;

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
      `TRUNCATE sequence_run_step, sequence_run, "sequence", "group" RESTART IDENTITY CASCADE`,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status) VALUES (gen_random_uuid(), 'acc-01', 'active') RETURNING id`);
    groupId = rows[0]?.id ?? '';
    const { rows: s } = await db.pool.query<{ id: string }>(
      `INSERT INTO "sequence" (id, name, steps) VALUES (gen_random_uuid(), 'seq', '[]'::jsonb) RETURNING id`);
    const { rows: r } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status, vars, current_step_index)
       VALUES (gen_random_uuid(), $1, $2, 'running', '{"event":"发布会"}'::jsonb, 2) RETURNING id`,
      [groupId, s[0]?.id]);
    runId = r[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO sequence_run_step (run_id, "index", status, account_role, text_template, delay_seconds,
         scheduled_at, sent_at, client_msg_id, resolved_vars, var_sources) VALUES
       ($1, 1, 'sent', 'admin', 'a {event}', 0, now()-interval '30 seconds', now()-interval '25 seconds', 'cm-1',
        '{"event":"发布会"}'::jsonb, '{"event":"default"}'::jsonb),
       ($1, 2, 'accepted', 'member', 'b {loc}', 10, now()-interval '3 seconds', NULL, 'cm-2',
        '{"event":"发布会","loc":"B"}'::jsonb, '{"event":"default","loc":"step:2"}'::jsonb),
       ($1, 3, 'pending', 'member', 'c', 5, NULL, NULL, NULL,
        '{"event":"发布会","loc":"B"}'::jsonb, '{"event":"default","loc":"step:2"}'::jsonb)`,
      [runId],
    );
  });

  it('run + steps 逐字段：枚举闭集、未排期 scheduledAt=null、未发出 sentAt=null、快照原样', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string; currentStepIndex: number;
      steps: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({ status: 'running', currentStepIndex: 2 });
    expect(body.steps.length).toBe(3);
    expect(body.steps.map((s) => s['index'])).toEqual([1, 2, 3]);
    // 闭集断言（逐字）：run status ∈ running|finished|failed|stopped；step ∈ pending|accepted|sent|skipped|failed
    expect(['running', 'finished', 'failed', 'stopped']).toContain(body.status);
    for (const st of body.steps) {
      expect(['pending', 'accepted', 'sent', 'skipped', 'failed']).toContain(st['status']);
    }
    expect(body.steps[0]).toMatchObject({
      index: 1, status: 'sent', clientMsgId: 'cm-1',
      resolvedVars: { event: '发布会' }, varSources: { event: 'default' },
    });
    expect(body.steps[1]).toMatchObject({
      index: 2, status: 'accepted', sentAt: null, // accepted 未发出 → sentAt null
      resolvedVars: { event: '发布会', loc: 'B' }, varSources: { event: 'default', loc: 'step:2' },
    });
    expect(body.steps[2]).toMatchObject({
      index: 3, status: 'pending', scheduledAt: null, sentAt: null, clientMsgId: null,
    });
    // ISO 8601 UTC
    expect(body.steps[0]?.['scheduledAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.steps[0]?.['sentAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('stopped run → status=stopped（群 unreachable 级联语义透出）', async () => {
    await db.pool.query(`UPDATE sequence_run SET status='stopped', ended_at=now() WHERE id=$1`, [runId]);
    const res = await app.inject({ method: 'GET', url: `/api/sequence-runs/${runId}`, headers: auth });
    expect((res.json() as { status: string }).status).toBe('stopped');
  });

  it('未知 run → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sequence-runs/00000000-0000-0000-0000-000000000000', headers: auth });
    expect(res.statusCode).toBe(404);
  });
});
