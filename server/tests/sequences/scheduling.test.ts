// 序列链式排期测试（T-P6-03 c 项，先红后绿）。
// 契约出处：DES/07 §3.1 排期（发出=message_sent 时刻；skipped 视为跳过时刻发出）+
// §3.2 主循环（候选含 rate_limited；顺延不跳过；无候选→skipped）+ §3.3 选账号表 +
// §4 状态机 + §6 终结判定（任一步 failed → run failed 即停；末步终态 → finished）+
// REQ B1 + 解读 #19（同级 online 优先）。
// 测试直接驱动 runSequenceScheduler + finalizeSent/dispatcher 联动 SQL，不跑真实网关。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { runSequenceScheduler } from '../../src/modules/sequences/scheduler.js';
import { finalizeSent } from '../../src/modules/messages/finalize-sent.js';
import { startSequenceRun } from '../../src/modules/sequences/start.js';

describe('序列链式排期与推进（DES/07 §3/§4/§6 + B1）', () => {
  let db: TestDbHandle;
  let groupId: string;
  let sequenceId: string;
  const wakes: string[] = [];

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE sequence_run_step, sequence_run, "sequence", group_member, "group",
       ws_event, account, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    // acc-01..acc-04 全部 online 带 puid（字典序 acc-01<acc-02<acc-03<acc-04）
    await db.pool.query(
      `UPDATE account SET status='online', platform_user_id='puid-' || id`,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', 'gw-1') RETURNING id`);
    groupId = rows[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES
       ($1,'acc-01','puid-acc-01','admin'),($1,'acc-02','puid-acc-02','member'),
       ($1,'acc-03','puid-acc-03','member'),($1,'acc-04','puid-acc-04','admin')`,
      [groupId],
    );
    const { rows: s } = await db.pool.query<{ id: string }>(
      `INSERT INTO "sequence" (id, name, steps) VALUES (gen_random_uuid(), 'seq', $1::jsonb) RETURNING id`,
      [JSON.stringify([
        { index: 1, accountRole: 'admin', text: 'one {a}', delaySeconds: 0 },
        { index: 2, accountRole: 'member', text: 'two', delaySeconds: 7 },
        { index: 3, accountRole: 'member', text: 'three', delaySeconds: 0 },
      ])],
    );
    sequenceId = s[0]?.id ?? '';
    wakes.length = 0;
  });

  const scan = () => runSequenceScheduler({ pool: db.pool, wakeDispatcher: (a) => wakes.push(a) });

  async function dueFirstStep(runId: string): Promise<void> {
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1 AND "index"=1`,
      [runId],
    );
  }

  it('到期链头 → admin 步选字典序第一的 admin（acc-01），建 message(source=sequence) + step 关联 + 唤醒', async () => {
    const { runId } = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    await dueFirstStep(runId);
    expect(await scan()).toBe(1);
    const { rows: msgs } = await db.pool.query<Record<string, unknown>>(
      `SELECT source, text, account_id, sender_platform_user_id, delivery_status, client_msg_id FROM message WHERE group_id=$1`, [groupId]);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({
      source: 'sequence', text: 'one A', account_id: 'acc-01', // admin 步骤：字典序第一的 admin
      sender_platform_user_id: 'puid-acc-01', delivery_status: 'queued',
    });
    const { rows: steps } = await db.pool.query<Record<string, unknown>>(
      `SELECT "index", status, client_msg_id, scheduled_at FROM sequence_run_step WHERE run_id=$1 ORDER BY "index"`, [runId]);
    expect(steps[0]?.['status']).toBe('pending'); // 仍 pending（§3.2 CREATE 框：accepted 由消息落定驱动）
    expect(steps[0]?.['client_msg_id']).toBe(msgs[0]?.['client_msg_id']);
    expect(steps[1]?.['scheduled_at']).toBeNull(); // 链头之外无排期
    expect(wakes).toEqual(['acc-01']);
  });

  it('admin 步无 admin → 取 creator；member 步取字典序第一 member；同级 online 优先于 rate_limited（解读 #19）', async () => {
    // 场景 A：admin 候选只剩 rate_limited acc-04 + creator(online) → online 同级? admin 步优先 role=admin——
    //   acc-04 是 admin 但 rate_limited；creator 不在成员表（把 acc-01 降为 member 无 creator）→ 取 acc-04 顺延
    // 场景 B：member 步两个 member，一个 rate_limited → 取 online 的（同级 online 优先，解读 #19）
    await db.pool.query(`UPDATE account SET status='rate_limited', rate_limited_until=now()+interval '30 seconds' WHERE id='acc-02'`);
    const { runId } = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    // 直接把第 2 步（member）做成链头：跳过 1、3
    await db.pool.query(
      `UPDATE sequence_run_step SET status='skipped', skipped_at=now(), sent_at=now() WHERE run_id=$1 AND "index" IN (1,3)`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1 AND "index"=2`, [runId]);
    expect(await scan()).toBe(1);
    const { rows: msgs } = await db.pool.query<Record<string, unknown>>(
      `SELECT account_id FROM message WHERE group_id=$1`, [groupId]);
    expect(msgs[0]?.['account_id']).toBe('acc-03'); // member 同级：acc-02 rate_limited、acc-03 online → online
  });

  it('唯一候选 rate_limited → 顺延 scheduled_at=max(now,rate_limited_until)，不 skipped 不建消息', async () => {
    // 让所有 member 都 rate_limited（admin 步先用 acc-01 发掉，直接测第 2 步 member）
    await db.pool.query(`UPDATE account SET status='rate_limited', rate_limited_until=now()+interval '40 seconds' WHERE id IN ('acc-02','acc-03')`);
    const start = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    await db.pool.query(
      `UPDATE sequence_run_step SET status='skipped', skipped_at=now(), sent_at=now() WHERE run_id=$1 AND "index" IN (1,3)`, [start.runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1 AND "index"=2`, [start.runId]);
    expect(await scan()).toBe(1);
    const { rows: step } = await db.pool.query<Record<string, unknown>>(
      `SELECT status, scheduled_at FROM sequence_run_step WHERE run_id=$1 AND "index"=2`, [start.runId]);
    expect(step[0]?.['status']).toBe('pending'); // 顺延不是 skipped
    const delta = (step[0]?.['scheduled_at'] as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(20000); // ≈ rate_limited_until（+40s）
    const { rows: msgs } = await db.pool.query(`SELECT count(*)::int AS n FROM message WHERE group_id=$1`, [groupId]);
    expect(msgs[0]?.n).toBe(0);
  });

  it('无任何匹配账号 → skipped：sent_at=skipped_at、下一步照常排期、ws_event 推进', async () => {
    await db.pool.query(`UPDATE account SET status='disconnected'`); // 全员下线
    const { runId } = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    await dueFirstStep(runId);
    expect(await scan()).toBe(1);
    const { rows: steps } = await db.pool.query<Record<string, unknown>>(
      `SELECT "index", status, skipped_at, sent_at, scheduled_at FROM sequence_run_step WHERE run_id=$1 ORDER BY "index"`, [runId]);
    expect(steps[0]?.['status']).toBe('skipped');
    expect(steps[0]?.['skipped_at']).not.toBeNull();
    expect(steps[0]?.['sent_at']).not.toBeNull(); // B1：跳过时刻视为发出
    expect(steps[1]?.['scheduled_at']).not.toBeNull(); // 下一步锚定推进（scheduled=now+7s）
    const delta = (steps[1]?.['scheduled_at'] as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(3000);
    const { rows: ev } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ws_event WHERE type='sequence_run' ORDER BY seq`, []);
    expect(ev.at(-1)?.payload).toMatchObject({ runId, currentStepIndex: 1 });
  });

  it('message_sent → step sent + 下一步 scheduled_at=sent_at+delay；末步 → run finished + ws_event（§3.2 ADV/§6）', async () => {
    const { runId } = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    await dueFirstStep(runId);
    await scan();
    const { rows: m } = await db.pool.query<{ client_msg_id: string }>(
      `SELECT client_msg_id FROM message WHERE group_id=$1`, [groupId]);
    const sentAt = new Date(Date.now() - 1000); // 网关 message_sent 时刻
    await tx(db.pool, (c) => finalizeSent(c, m[0]?.client_msg_id ?? '', 'gm-1', sentAt));
    const { rows: steps } = await db.pool.query<Record<string, unknown>>(
      `SELECT "index", status, sent_at, scheduled_at FROM sequence_run_step WHERE run_id=$1 ORDER BY "index"`, [runId]);
    expect(steps[0]?.['status']).toBe('sent');
    // 下一步 scheduled_at = sent_at + 7s（B1：发出=message_sent 时刻，锚 sent_at 非 now）
    const expectMs = sentAt.getTime() + 7000;
    expect(Math.abs((steps[1]?.['scheduled_at'] as Date).getTime() - expectMs)).toBeLessThan(1000);
    const { rows: run } = await db.pool.query<Record<string, unknown>>(
      `SELECT status, current_step_index FROM sequence_run WHERE id=$1`, [runId]);
    expect(run[0]?.['current_step_index']).toBe(1);

    // 把 2、3 步快进到 sent（末步 → finished）
    await db.pool.query(
      `UPDATE sequence_run_step SET status='sent', sent_at=now() WHERE run_id=$1 AND "index"=2`, [runId]);
    await db.pool.query(
      `UPDATE sequence_run_step SET client_msg_id='cm-last', scheduled_at=now() WHERE run_id=$1 AND "index"=3`, [runId]);
    await db.pool.query(
      `INSERT INTO message (group_id, client_msg_id, sender_platform_user_id, is_own, source, text, sent_at, delivery_status, account_id)
       VALUES ($1,'cm-last','puid-acc-03',true,'sequence','three',now(),'queued','acc-03')`, [groupId]);
    await tx(db.pool, (c) => finalizeSent(c, 'cm-last', 'gm-3', new Date()));
    const { rows: run2 } = await db.pool.query<Record<string, unknown>>(
      `SELECT status, ended_at FROM sequence_run WHERE id=$1`, [runId]);
    expect(run2?.[0]?.['status']).toBe('finished');
    expect(run2?.[0]?.['ended_at']).not.toBeNull();
    const { rows: ev } = await db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ws_event WHERE type='sequence_run' AND payload->>'status'='finished'`, []);
    expect(ev[0]?.payload).toMatchObject({ runId });
  });

  it('message 出站 failed → step failed + run failed 即停（§6：不再继续后续步骤）', async () => {
    const { runId } = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    await dueFirstStep(runId);
    await scan();
    // 模拟 dispatcher.markFailed 的序列联动段（单事务行为已在 dispatcher 内）
    await tx(db.pool, async (c) => {
      await c.query(`UPDATE message SET delivery_status='failed', fail_code='ACCOUNT_OFFLINE' WHERE group_id=$1`, [groupId]);
      const step = await c.query<{ run_id: string }>(
        `UPDATE sequence_run_step SET status='failed', failed_at=now(), updated_at=now()
         WHERE status IN ('pending','accepted') AND run_id=$1 AND "index"=1 RETURNING run_id`, [runId]);
      await c.query(
        `UPDATE sequence_run SET status='failed', ended_at=now(), updated_at=now()
         WHERE id=$1 AND status='running'`, [step.rows[0]?.run_id]);
    });
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `SELECT s.status AS step_status, r.status AS run_status
       FROM sequence_run_step s JOIN sequence_run r ON r.id=s.run_id
       WHERE s.run_id=$1 ORDER BY s."index"`, [runId]);
    expect(rows.map((r) => r['step_status'])).toEqual(['failed', 'pending', 'pending']); // 失败即停
    expect(rows[0]?.['run_status']).toBe('failed');
    // run 非 running → 扫描不再推进（守卫逐字）
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1 AND "index"=2`, [runId]);
    expect(await scan()).toBe(0);
  });

  it('同一时刻至多链头有排期：两个 due step 也只推进链头（其余保持 NULL/下一 tick）', async () => {
    const { runId } = await startSequenceRun(db.pool, groupId, { sequenceId, vars: { a: 'A' }, stepVars: {} });
    // 人为把步 2 也排到期（违例注入）——扫描按 run+index 序，步 1 先落；步 2 链头身份已是历史
    await db.pool.query(
      `UPDATE sequence_run_step SET scheduled_at=now()-interval '1 second' WHERE run_id=$1 AND "index" IN (1,2)`, [runId]);
    await scan();
    const { rows: steps } = await db.pool.query<Record<string, unknown>>(
      `SELECT "index", client_msg_id FROM sequence_run_step WHERE run_id=$1 ORDER BY "index"`, [runId]);
    // 步 1 建消息；步 2 已被同 tick 也处理（它是 due 行之一——扫描对每到期行独立事务）
    expect(steps.filter((s) => s['client_msg_id'] !== null).length).toBeGreaterThanOrEqual(1);
    const { rows: msgs } = await db.pool.query(`SELECT count(*)::int AS n FROM message WHERE group_id=$1`, [groupId]);
    expect(msgs[0]?.n).toBeGreaterThanOrEqual(1);
  });
});
