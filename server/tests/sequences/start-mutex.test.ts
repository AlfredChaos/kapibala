// 序列启动互斥 + 快照测试（T-P6-02 c 项，先红后绿）。
// 契约出处：DES/07 §2.4 启动事务逐字（预检 → run+steps 快照 → step1 scheduled_at → ws_event）+
// §2.4 群前置（非 active → 409 GROUP_UNREACHABLE）+ REQ §2.3 sequence-runs 行 + B1 + S7/S8。
// S7 并发仲裁 = uq_sequence_run_single_flight 部分唯一索引（DB 仲裁，多实例成立，不进程内锁）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';

const SEQ_STEPS = [
  { index: 1, accountRole: 'admin', text: '预告{event}', delaySeconds: 5 },
  { index: 2, accountRole: 'member', text: '{event} 在 {location}', delaySeconds: 10 },
  { index: 3, accountRole: 'member', text: '地点 {location}', delaySeconds: 0 },
  { index: 4, accountRole: 'admin', text: '{time} 开始', delaySeconds: 0 },
];

describe('序列启动互斥 + 快照（DES/07 §2.4 + S7/S8）', () => {
  let db: TestDbHandle;
  let app: App;
  let auth: { authorization: string };
  let groupId: string;
  let sequenceId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
    });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } });
    auth = { authorization: `Bearer ${(res.json() as { accessToken: string }).accessToken}` };
  });
  afterAll(async () => { await app.close(); await db.close(); });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE sequence_run_step, sequence_run, "sequence", "group", ws_event, message RESTART IDENTITY CASCADE`,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status) VALUES (gen_random_uuid(), 'acc-01', 'active') RETURNING id`,
    );
    groupId = rows[0]?.id ?? '';
    const res = await app.inject({
      method: 'POST', url: '/api/sequences', headers: auth,
      payload: { name: '发布预告', steps: SEQ_STEPS },
    });
    sequenceId = (res.json() as { id: string }).id;
  });

  function start(gid: string = groupId, vars: Record<string, string> = { event: '发布会', location: '主会场', time: '10:00' }) {
    return app.inject({
      method: 'POST', url: `/api/groups/${gid}/sequence-runs`, headers: auth,
      payload: { sequenceId, vars, stepVars: {} },
    });
  }

  it('201 {runId}：run + 4 步快照同事务，第 1 步 scheduled_at = now()+delaySeconds，ws_event 落库', async () => {
    const res = await start();
    expect(res.statusCode).toBe(201);
    const { runId } = res.json() as { runId: string };
    const { rows: runs } = await db.pool.query<Record<string, unknown>>(
      'SELECT status, vars, current_step_index FROM sequence_run WHERE id=$1', [runId]);
    expect(runs[0]).toMatchObject({ status: 'running', vars: { event: '发布会', location: '主会场', time: '10:00' } });
    const { rows: steps } = await db.pool.query<Record<string, unknown>>(
      `SELECT "index", status, resolved_vars, var_sources, scheduled_at FROM sequence_run_step WHERE run_id=$1 ORDER BY "index"`, [runId]);
    expect(steps.length).toBe(4);
    // 快照逐字：resolved_vars/var_sources 落库（第 2 步 location 已是启动参数值）
    expect(steps[1]?.['resolved_vars']).toMatchObject({ event: '发布会', location: '主会场' });
    expect(steps[1]?.['var_sources']).toMatchObject({ event: 'default', location: 'default' });
    // 只有链头有 scheduled_at（§3.1：后续步骤 NULL 等前步发出再排）
    expect(steps[0]?.['scheduled_at']).not.toBeNull();
    for (const s of steps.slice(1)) expect(s['scheduled_at']).toBeNull();
    // 第 1 步 scheduled_at ≈ now + 5s（容差 ±3s）
    const t = (steps[0]?.['scheduled_at'] as Date).getTime() - Date.now();
    expect(t).toBeGreaterThan(1500);
    expect(t).toBeLessThan(8500);
    const { rows: ev } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ws_event WHERE type='sequence_run'`, []);
    expect(ev[0]?.payload).toMatchObject({ runId, groupId, status: 'running' });
  });

  it('S7：并发两次启动 → 恰好一个 201、一个 409 SEQUENCE_ALREADY_RUNNING（DB 仲裁）', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect((loser.json() as { error: { code: string } }).error.code).toBe('SEQUENCE_ALREADY_RUNNING');
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM sequence_run WHERE group_id=$1`, [groupId]);
    expect(rows[0]?.n).toBe(1);
  });

  it('S8：第 4 步 {time} 无值 → 422 stepIndex=4/key=time，零 run/step/message 行，之后可正常启动', async () => {
    const res = await start(groupId, { event: '发布会', location: '主会场', time: '' }); // vars "" = 未提供
    expect(res.statusCode).toBe(422);
    const err = (res.json() as { error: Record<string, unknown> }).error;
    expect(err).toMatchObject({ code: 'UNRESOLVED_PLACEHOLDER', stepIndex: 4, key: 'time' });
    expect(typeof err['requestId']).toBe('string');
    const { rows: counts } = await db.pool.query<{ r: number; s: number; m: number }>(
      `SELECT (SELECT count(*) FROM sequence_run)::int AS r,
              (SELECT count(*) FROM sequence_run_step)::int AS s,
              (SELECT count(*) FROM message)::int AS m`);
    expect(counts[0]).toEqual({ r: 0, s: 0, m: 0 }); // 零运行记录、网关零消息（S8 逐字）
    // 之后同一群可正常启动（无残留状态）
    const ok = await start();
    expect(ok.statusCode).toBe(201);
  });

  it('S8 对照：index 升序首个失败步骤（第 3 步引用未提供 key → stepIndex=3）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sequences', headers: auth,
      payload: { name: 'p', steps: [
        { index: 1, accountRole: 'admin', text: '{event}', delaySeconds: 0 },
        { index: 3, accountRole: 'member', text: '{missing}', delaySeconds: 0 },
        { index: 4, accountRole: 'member', text: '{also_missing}', delaySeconds: 0 },
      ] },
    });
    const seqId = (res.json() as { id: string }).id;
    const res2 = await app.inject({
      method: 'POST', url: `/api/groups/${groupId}/sequence-runs`, headers: auth,
      payload: { sequenceId: seqId, vars: { event: 'x' }, stepVars: {} },
    });
    expect(res2.statusCode).toBe(422);
    expect((res2.json() as { error: Record<string, unknown> }).error).toMatchObject({ stepIndex: 3, key: 'missing' });
  });

  it('unreachable 群启动 → 409 GROUP_UNREACHABLE（解读 #3）；群不存在 → 404', async () => {
    await db.pool.query(`UPDATE "group" SET status='unreachable' WHERE id=$1`, [groupId]);
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('GROUP_UNREACHABLE');
    const res2 = await start('00000000-0000-0000-0000-000000000000');
    expect(res2.statusCode).toBe(404);
    expect((res2.json() as { error: { code: string } }).error.code).toBe('GROUP_NOT_FOUND');
  });
});
