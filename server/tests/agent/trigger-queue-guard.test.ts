// R-B 守卫回归测试（T-P4-04 e 项名义用例文件；VITEST_PLAN §5 R-B 行）。
// R-B 定稿（DES/06 §2 修订语义）：补建 run 前复查 group.status='active' AND agent_enabled=true；
// 守卫不过时积压行保留不删、不补建 run（避免 cancelled 后「出生即取消」的 run 连环催生）；
// agentEnabled 重新打开后由 SWEEP 用积压补建——「重新启用后补处理」（README 解释声明 #26）。
// 覆盖：END2 守卫不过（unreachable / 开关关）→ 积压保留；END2 与 SWEEP 两处守卫缺一即违约；
// SWEEP 补建 + 重新启用后 SWEEP 补处理闭环；SWEEP 对 running 群不动。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { tryTriggerAgentRun, type TriggerGroupContext, type TriggerMessageInput } from '../../src/modules/agent/trigger-entry.js';
import { endAgentRun } from '../../src/modules/agent/end-run.js';
import { registerTriggerSweepScan, TRIGGER_SWEEP_SCAN_NAME } from '../../src/scheduler/trigger-sweep.js';
import { createScanRegistry, type ScanRegistry } from '../../src/scheduler/registry.js';

const silent = { info() {}, warn() {}, error() {} };

describe('R-B 守卫：END2/SWEEP 两处守卫 + 积压保留 + 重新启用补处理', () => {
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

  async function seedAccount(id: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ($1, 'online', 'puid-' || $1) ON CONFLICT (id) DO NOTHING`,
      [id],
    );
  }

  async function makeGroup(over: { status?: string; enabled?: boolean } = {}): Promise<string> {
    await seedAccount('acc-01');
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', $1, $2, 'gw-1') RETURNING id`,
      [over.status ?? 'active', over.enabled ?? true],
    );
    return rows[0]?.id ?? '';
  }

  async function makeMessage(groupId: string): Promise<TriggerMessageInput> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
       VALUES ($1, 'm-' || gen_random_uuid(), 'ext', false, 'hi', now()) RETURNING id`,
      [groupId],
    );
    return { id: rows[0]?.id ?? '', msgId: 'm-1', senderPlatformUserId: 'ext', text: 'hi', sentAt: new Date().toISOString() };
  }

  async function enqueue(groupId: string): Promise<void> {
    const msg = await makeMessage(groupId);
    await db.pool.query('INSERT INTO agent_trigger_queue (group_id, message_id) VALUES ($1,$2)', [groupId, msg.id]);
  }

  async function backlogCount(groupId: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM agent_trigger_queue WHERE group_id=$1', [groupId]);
    return rows[0]?.n ?? 0;
  }

  /** 手动跑一轮 sweep（intervalMs=0 免节流） */
  async function runSweep(): Promise<void> {
    const registry: ScanRegistry = createScanRegistry();
    registerTriggerSweepScan({ pool: db.pool, registry, logger: silent, intervalMs: 0 });
    const scans = registry.scans();
    expect(scans.map((s) => s.name)).toContain(TRIGGER_SWEEP_SCAN_NAME);
    for (const s of scans) await s.scan();
  }

  it('END2 守卫不过（群 unreachable）→ 积压保留不删、不建 run、无第二帧', async () => {
    const groupId = await makeGroup();
    const group: TriggerGroupContext = { id: groupId, status: 'active', agentEnabled: true, autoKickEnabled: false };
    await tx(db.pool, (c: PoolClient) => makeMessage(groupId).then((m) => tryTriggerAgentRun(c, { group, message: m })));
    await enqueue(groupId); // run 期间到达 → 积压
    const { rows: runs } = await db.pool.query('SELECT id FROM agent_run WHERE group_id=$1', [groupId]);
    // run 期间群变 unreachable（GWF 级联后形态）
    await db.pool.query("UPDATE \"group\" SET status='unreachable' WHERE id=$1", [groupId]);
    const res = await tx(db.pool, (c) =>
      endAgentRun(c, { runId: runs[0]?.id ?? '', status: 'cancelled', endReason: 'cancelled' }),
    );
    expect(res.guardPassed).toBe(false);
    expect(res.nextRunId).toBeUndefined();
    expect(await backlogCount(groupId)).toBe(1); // R-B：积压保留不删
    const { rows: all } = await db.pool.query('SELECT status FROM agent_run WHERE group_id=$1', [groupId]);
    expect(all.length).toBe(1); // 不补建
    const { rows: ev } = await db.pool.query("SELECT payload FROM ws_event WHERE type='agent_run' ORDER BY seq");
    expect(ev.length).toBe(2); // 建 + 终态；无新 running 帧
    expect(ev[1]?.payload).toMatchObject({ status: 'cancelled' });
  });

  it('END2 守卫不过（agent_enabled 关）→ 同样积压保留', async () => {
    const groupId = await makeGroup();
    const group: TriggerGroupContext = { id: groupId, status: 'active', agentEnabled: true, autoKickEnabled: false };
    await tx(db.pool, (c) => makeMessage(groupId).then((m) => tryTriggerAgentRun(c, { group, message: m })));
    await enqueue(groupId);
    const { rows: runs } = await db.pool.query('SELECT id FROM agent_run WHERE group_id=$1', [groupId]);
    await db.pool.query('UPDATE "group" SET agent_enabled=false WHERE id=$1', [groupId]);
    const res = await tx(db.pool, (c) =>
      endAgentRun(c, { runId: runs[0]?.id ?? '', status: 'cancelled', endReason: 'cancelled' }),
    );
    expect(res.guardPassed).toBe(false);
    expect(await backlogCount(groupId)).toBe(1);
  });

  it('R-B 闭环：重新启用（active+enabled）后 SWEEP 用保留积压补建 run', async () => {
    const groupId = await makeGroup();
    const group: TriggerGroupContext = { id: groupId, status: 'active', agentEnabled: true, autoKickEnabled: false };
    await tx(db.pool, (c) => makeMessage(groupId).then((m) => tryTriggerAgentRun(c, { group, message: m })));
    await enqueue(groupId);
    const { rows: runs } = await db.pool.query('SELECT id FROM agent_run WHERE group_id=$1', [groupId]);
    await db.pool.query("UPDATE \"group\" SET status='unreachable', agent_enabled=false WHERE id=$1", [groupId]);
    await tx(db.pool, (c) => endAgentRun(c, { runId: runs[0]?.id ?? '', status: 'cancelled', endReason: 'cancelled' }));
    // 期间 SWEEP 扫过：守卫不过 → 不动
    await runSweep();
    expect(await backlogCount(groupId)).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM agent_run WHERE group_id=$1', [groupId])).rows[0]?.n).toBe(1);
    // 操作员重新启用
    await db.pool.query("UPDATE \"group\" SET status='active', agent_enabled=true WHERE id=$1", [groupId]);
    await runSweep();
    expect(await backlogCount(groupId)).toBe(0); // 积压被消费
    const { rows: all } = await db.pool.query('SELECT status FROM agent_run WHERE group_id=$1 ORDER BY created_at', [groupId]);
    expect(all.length).toBe(2);
    expect(all[1]?.status).toBe('running');
    const { rows: ev } = await db.pool.query("SELECT payload FROM ws_event WHERE type='agent_run' ORDER BY seq");
    expect(ev[ev.length - 1]?.payload).toMatchObject({ status: 'running' });
  });

  it('SWEEP 有 running run 的群不动；无积压群不动', async () => {
    const groupId = await makeGroup();
    const group: TriggerGroupContext = { id: groupId, status: 'active', agentEnabled: true, autoKickEnabled: false };
    await tx(db.pool, (c) => makeMessage(groupId).then((m) => tryTriggerAgentRun(c, { group, message: m })));
    await enqueue(groupId); // running run 存在时的积压——SWEEP 不归它管（END2 管）
    await runSweep();
    expect(await backlogCount(groupId)).toBe(1); // 保留（NOT EXISTS running 谓词挡住）
    const { rows: all } = await db.pool.query('SELECT count(*)::int AS n FROM agent_run WHERE group_id=$1', [groupId]);
    expect(all[0]?.n).toBe(1);
  });

  it('SWEEP 事务边界外崩溃补偿：无 END2 参与的孤立积压 → 守卫过时补建', async () => {
    const groupId = await makeGroup();
    await enqueue(groupId); // 直接造积压（模拟 END2 事务外崩溃留下的漏建）
    await runSweep();
    expect(await backlogCount(groupId)).toBe(0);
    const { rows: runs } = await db.pool.query('SELECT status, trigger_context FROM agent_run WHERE group_id=$1', [groupId]);
    expect(runs.length).toBe(1);
    expect((runs[0]?.trigger_context as Record<string, unknown>)['triggerMessages']).toHaveLength(1);
  });
});
