// 序列重启恢复测试（T-P6-04 c 项，先红后绿）。
// 契约出处：DES/07 §5 恢复流程图四分支逐字 + B1「只重排最早一个过期步骤，其后全部
// scheduled_at=NULL——不能一次性全部发出」（I11）+ DES/10 扫描 3。
// 状态注入级：直接改 sequence_run_step 行模拟崩溃点（kill -9 级归 T-P7-04）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { recoverSequenceRuns } from '../../src/modules/sequences/recovery.js';
import { startSequenceRun } from '../../src/modules/sequences/start.js';

describe('序列重启恢复（DES/07 §5 + B1/I11）', () => {
  let db: TestDbHandle;
  let groupId: string;
  let sequenceId: string;
  let runId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE sequence_run_step, sequence_run, "sequence", group_member, "group", ws_event, account, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    await db.pool.query(`UPDATE account SET status='online', platform_user_id='puid-' || id`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id) VALUES (gen_random_uuid(), 'acc-01', 'active', 'gw-1') RETURNING id`);
    groupId = rows[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES
       ($1,'acc-01','puid-acc-01','admin'),($1,'acc-02','puid-acc-02','member')`, [groupId]);
    const { rows: s } = await db.pool.query<{ id: string }>(
      `INSERT INTO "sequence" (id, name, steps) VALUES (gen_random_uuid(), 'seq', $1::jsonb) RETURNING id`,
      [JSON.stringify([
        { index: 1, accountRole: 'admin', text: 'one', delaySeconds: 11 },
        { index: 2, accountRole: 'member', text: 'two', delaySeconds: 22 },
        { index: 3, accountRole: 'member', text: 'three', delaySeconds: 33 },
      ])],
    );
    sequenceId = s[0]?.id ?? '';
    const r = await startSequenceRun(db.pool, groupId, { sequenceId, vars: {}, stepVars: {} });
    runId = r.runId;
  });

  async function stepRow(index: number): Promise<Record<string, unknown>> {
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT "index", status, scheduled_at, client_msg_id, delay_seconds FROM sequence_run_step WHERE run_id=$1 AND "index"=$2`,
      [runId, index],
    );
    return rows[0] ?? {};
  }

  it('H1c 链头过期未创建消息 → 只重排链头(now+其delay)，其后 pending 全 NULL（I11 逐字）', async () => {
    // 注入崩溃态：步1 done、步2 链头已过期、步3 带着（违例的）未来排期——恢复必须清掉
    await db.pool.query(
      `UPDATE sequence_run_step SET status='sent', sent_at=now() WHERE run_id=$1 AND "index"=1`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '5 seconds' WHERE run_id=$1 AND "index"=2`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()+interval '99 seconds' WHERE run_id=$1 AND "index"=3`, [runId]);
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(1);
    const head = await stepRow(2);
    const tail = await stepRow(3);
    // 链头：now + 22s（其自身 delaySeconds，非固定值）
    const delta = (head['scheduled_at'] as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(15000);
    expect(delta).toBeLessThan(30000);
    expect(tail['scheduled_at']).toBeNull(); // 其后未终态步骤全部 NULL（B1 逐字）
    // 幂等：重跑无事（链头已重新排到未来 → H1d 保持）
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(0);
  });

  it('H1a 链头消息在途（queued/unknown）→ 不重排等落定', async () => {
    await db.pool.query(
      `INSERT INTO message (group_id, client_msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, account_id)
       VALUES ($1,'cm-inflight','puid-acc-02',true,'sequence','two',now(),'queued','acc-02')`, [groupId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET status='sent', sent_at=now() WHERE run_id=$1 AND "index"=1`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET client_msg_id='cm-inflight', scheduled_at=now()-interval '5 seconds' WHERE run_id=$1 AND "index"=2`, [runId]);
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(0);
    const head = await stepRow(2);
    expect(head['scheduled_at']).not.toBeNull(); // 原样保持（过期也不动——等消息落定）
  });

  it('H1b 链头未排期（scheduled_at NULL）→ 保持等前驱', async () => {
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=NULL WHERE run_id=$1 AND "index"=1`, [runId]);
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(0);
    expect((await stepRow(1))['scheduled_at']).toBeNull();
  });

  it('H1d 链头未到期 → 保持原排期不漂移', async () => {
    const before = await stepRow(1);
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(0);
    const after = await stepRow(1);
    expect((after['scheduled_at'] as Date).getTime()).toBe((before['scheduled_at'] as Date).getTime());
  });

  it('skipped 链头已在崩溃前落终态 → 链头顺延到下一 pending 步并恢复重排', async () => {
    await db.pool.query(
      `UPDATE sequence_run_step SET status='skipped', skipped_at=now(), sent_at=now() WHERE run_id=$1 AND "index"=1`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET status='skipped', skipped_at=now(), sent_at=now() WHERE run_id=$1 AND "index"=2`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1 AND "index"=3`, [runId]);
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(1);
    const tail = await stepRow(3);
    const delta = (tail['scheduled_at'] as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(25000); // now + 33s
  });

  it('finished/failed run 不在扫描范围（status 守卫）', async () => {
    await db.pool.query(`UPDATE sequence_run SET status='failed', ended_at=now() WHERE id=$1`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1`, [runId]);
    expect(await recoverSequenceRuns({ pool: db.pool })).toBe(0);
  });
});
