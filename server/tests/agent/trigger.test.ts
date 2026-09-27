// agent 触发链测试（T-P4-04 c 项，先红后绿）。
// 契约出处：DES/06 §2（单飞行 I4、END2 四步、SWEEP）+ §4.4 守卫 + REQ A5-1 + §2.2 trigger_context 形状。
// 覆盖：入站触发的 run_created / queued / skipped；并发恰一个 run（I4 部分唯一索引）；
// END2 四步逐字（终态 + 删积压 + 新 run triggerMessages 升序 + ws_event×2）+ executor 拾取缝。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { tryTriggerAgentRun, type TriggerGroupContext, type TriggerMessageInput } from '../../src/modules/agent/trigger-entry.js';
import { endAgentRun } from '../../src/modules/agent/end-run.js';
import { setAgentRunStarter, startAgentRun, type AgentRunStarter } from '../../src/modules/agent/trigger.js';

describe('agent 触发链（DES/06 §2 / A5-1 / I4）', () => {
  let db: TestDbHandle;
  const started: string[] = [];
  const stubStarter: AgentRunStarter = { startRun: (id) => started.push(id) };

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    setAgentRunStarter(stubStarter);
  });
  afterAll(async () => {
    setAgentRunStarter(undefined);
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE gateway_event, group_member, "group", job, ws_event, account,
               sequence_run_step, sequence_run, sequence, agent_run_step, agent_trigger_queue,
               agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    started.length = 0;
  });

  async function seedAccount(id: string, puid = 'puid-01'): Promise<void> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ($1, 'online', $2) ON CONFLICT (id) DO UPDATE SET platform_user_id=$2`,
      [id, puid],
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

  async function makeInboundMessage(groupId: string, sentAt?: Date): Promise<TriggerMessageInput> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, text, sent_at)
       VALUES ($1, 'm-' || gen_random_uuid(), 'ext-user', false, 'hi', $2) RETURNING id`,
      [groupId, sentAt ?? new Date()],
    );
    return { id: rows[0]?.id ?? '', msgId: 'm-1', senderPlatformUserId: 'ext-user', text: 'hi', sentAt: (sentAt ?? new Date()).toISOString() };
  }

  async function trigger(groupId: string, over: Partial<TriggerGroupContext> = {}): Promise<'run_created' | 'queued' | 'skipped'> {
    const msg = await makeInboundMessage(groupId);
    const group: TriggerGroupContext = { id: groupId, status: 'active', agentEnabled: true, autoKickEnabled: false, ...over };
    return tx(db.pool, (c: PoolClient) => tryTriggerAgentRun(c, { group, message: msg }));
  }

  // ---------- 入口触发（§4.4 守卫 + 单飞行） ----------

  it('agentEnabled 群新消息且无 running run → INSERT run + ws_event + executor 拾取（占位缝）', async () => {
    const groupId = await makeGroup();
    const out = await trigger(groupId);
    expect(out).toBe('run_created');
    const { rows } = await db.pool.query(
      'SELECT status, trigger_context FROM agent_run WHERE group_id=$1',
      [groupId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('running');
    const ctx = rows[0]?.trigger_context as Record<string, unknown>;
    expect(ctx['groupId']).toBe(groupId);
    expect(Array.isArray(ctx['triggerMessages'])).toBe(true);
    expect((ctx['triggerMessages'] as unknown[]).length).toBe(1);
    expect(ctx['ownPlatformUserIds']).toContain('puid-01');
    const { rows: ev } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='agent_run'",
    );
    expect(ev.length).toBe(1);
    expect(ev[0]?.payload).toMatchObject({ groupId, status: 'running', endReason: null });
    expect(started.length).toBe(1); // executor 拾取缝被调（占位）
  });

  it('已有 running run → 消息进 trigger_queue（不建第二个 run）', async () => {
    const groupId = await makeGroup();
    await trigger(groupId); // 第一个 → running
    const out = await trigger(groupId);
    expect(out).toBe('queued');
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM agent_trigger_queue WHERE group_id=$1', [groupId]);
    expect(rows[0]?.n).toBe(1);
    const { rows: runs } = await db.pool.query('SELECT count(*)::int AS n FROM agent_run WHERE group_id=$1 AND status=$2', [groupId, 'running']);
    expect(runs[0]?.n).toBe(1);
  });

  it('守卫不过（agent_enabled=false / status≠active）→ skipped，不建 run 不入队', async () => {
    const groupId = await makeGroup({ enabled: false });
    expect(await trigger(groupId, { agentEnabled: false })).toBe('skipped');
    expect(await trigger(groupId, { status: 'unreachable' })).toBe('skipped');
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM agent_run WHERE group_id=$1', [groupId]);
    expect(rows[0]?.n).toBe(0);
  });

  it('并发触发恰一个 run（I4：部分唯一索引承担单飞行）', async () => {
    const groupId = await makeGroup();
    const results = await Promise.all([trigger(groupId), trigger(groupId), trigger(groupId)]);
    expect(results.filter((r) => r === 'run_created').length).toBe(1);
    expect(results.filter((r) => r === 'queued').length).toBe(2);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM agent_run WHERE group_id=$1 AND status=$2', [groupId, 'running']);
    expect(rows[0]?.n).toBe(1);
    const { rows: q } = await db.pool.query('SELECT count(*)::int AS n FROM agent_trigger_queue WHERE group_id=$1', [groupId]);
    expect(q[0]?.n).toBe(2);
  });

  // ---------- END2 四步（同事务原子） ----------

  it('run 结束 + 积压非空 + 守卫过 → 同事务：旧终态+删积压+新 run（triggerMessages 升序）+ ws_event×2', async () => {
    const groupId = await makeGroup();
    await trigger(groupId); // run1 running
    // 积压两条（不同 sentAt——验证升序拼装）
    const msgA = await makeInboundMessage(groupId, new Date('2026-09-28T01:00:02Z'));
    const msgB = await makeInboundMessage(groupId, new Date('2026-09-28T01:00:01Z')); // 更早但后入队
    await tx(db.pool, async (c) => {
      await c.query('INSERT INTO agent_trigger_queue (group_id, message_id) VALUES ($1,$2),($1,$3)', [groupId, msgA.id, msgB.id]);
    });
    const { rows: runRows } = await db.pool.query('SELECT id FROM agent_run WHERE group_id=$1 AND status=$2', [groupId, 'running']);
    const oldRunId = runRows[0]?.id ?? '';
    const res = await tx(db.pool, (c) =>
      endAgentRun(c, { runId: oldRunId, status: 'finished', endReason: 'final', summary: 'done' }),
    );
    expect(res.guardPassed).toBe(true);
    expect(res.nextRunId).toBeDefined();
    if (res.nextRunId !== undefined) startAgentRun(res.nextRunId); // 调用方提交后拾取（文档化缝）
    // 旧 run 终态 + 新 run running（同群仍恰一个 running——单飞行无缝交接）
    const { rows: runs } = await db.pool.query('SELECT id, status, end_reason, trigger_context, lease_until FROM agent_run WHERE group_id=$1 ORDER BY created_at', [groupId]);
    expect(runs.length).toBe(2);
    expect(runs[0]).toMatchObject({ id: oldRunId, status: 'finished', end_reason: 'final' });
    expect(runs[0]?.lease_until).toBeNull();
    expect(runs[1]?.status).toBe('running');
    const tm = (runs[1]?.trigger_context as Record<string, unknown>)['triggerMessages'] as Array<{ sentAt: string }>;
    expect(tm.length).toBe(2);
    expect(tm[0]?.sentAt).toBe('2026-09-28T01:00:01.000Z'); // sentAt 升序：先入队的不排前
    expect(tm[1]?.sentAt).toBe('2026-09-28T01:00:02.000Z');
    // 积压清零 + ws_event×2（旧终态 + 新 running）
    const { rows: q } = await db.pool.query('SELECT count(*)::int AS n FROM agent_trigger_queue WHERE group_id=$1', [groupId]);
    expect(q[0]?.n).toBe(0);
    const { rows: ev } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='agent_run' ORDER BY seq",
    );
    expect(ev.length).toBe(3); // 建 run1 + 终态 + 新 running
    expect(ev[1]?.payload).toMatchObject({ runId: oldRunId, status: 'finished', endReason: 'final' });
    expect(ev[2]?.payload).toMatchObject({ runId: res.nextRunId, status: 'running', endReason: null });
    expect(started).toContain(res.nextRunId); // 新 run 也被拾取（占位）
  });

  it('run 结束 + 积压为空 → 仅终态+一帧，不建 run', async () => {
    const groupId = await makeGroup();
    await trigger(groupId);
    const { rows } = await db.pool.query('SELECT id FROM agent_run WHERE group_id=$1', [groupId]);
    const res = await tx(db.pool, (c) =>
      endAgentRun(c, { runId: rows[0]?.id ?? '', status: 'finished', endReason: 'final' }),
    );
    expect(res.hadBacklog).toBe(false);
    const { rows: all } = await db.pool.query('SELECT status FROM agent_run WHERE group_id=$1', [groupId]);
    expect(all.length).toBe(1);
    const { rows: ev } = await db.pool.query("SELECT count(*)::int AS n FROM ws_event WHERE type='agent_run'");
    expect(ev[0]?.n).toBe(2); // 建 + 终态
  });

  it('endAgentRun 幂等：重复结束同一 run → 第二次吸收为 no-op', async () => {
    const groupId = await makeGroup();
    await trigger(groupId);
    const { rows } = await db.pool.query('SELECT id FROM agent_run WHERE group_id=$1', [groupId]);
    const id = rows[0]?.id ?? '';
    await tx(db.pool, (c) => endAgentRun(c, { runId: id, status: 'finished', endReason: 'final' }));
    const second = await tx(db.pool, (c) => endAgentRun(c, { runId: id, status: 'cancelled', endReason: 'cancelled' }));
    expect(second.hadBacklog).toBe(false);
    const { rows: run } = await db.pool.query('SELECT status, end_reason FROM agent_run WHERE id=$1', [id]);
    expect(run[0]?.status).toBe('finished'); // 不被第二次覆盖
  });
});
