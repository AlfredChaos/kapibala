// 三重预算测试（T-P4-05 c 项，先红后绿）。
// 契约出处：DES/06 §5 表逐字 + REQ A5-2：12 步含结束步 / 60s 墙钟含审计等待、停机不计
// （恢复时 wall_deadline_at = now() + (60000 - consumed)）/ 连续 3 次协议错误；
// turn 超时区间 10–15s 可配（QR §1）。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import {
  checkBudget,
  clampTurnTimeoutMs,
  resumedWallDeadline,
} from '../../src/modules/agent/budget.js';
import {
  AGENT_MAX_STEPS,
  AGENT_WALL_CLOCK_MS,
  AGENT_TURN_TIMEOUT_DEFAULT_MS,
  PROTOCOL_ERROR_STREAK_LIMIT,
} from '../../src/constants.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import type { AgentClient } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

class FinishClient implements AgentClient {
  calls = 0;
  async rawTurn() {
    this.calls += 1;
    return {
      status: 200,
      raw: JSON.stringify({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu_${this.calls}`, name: 'finish', input: { summary: 's' } }],
      }),
    };
  }
  async callAudit() { return { verdict: 'pass' as const }; }
}

describe('三重预算（DES/06 §5 / A5-2 / QR §1）', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE gateway_event, group_member, "group", job, ws_event, account,
               sequence_run_step, sequence_run, sequence, agent_run_step, agent_trigger_queue,
               agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
  });

  async function makeRun(over: { stepCount?: number; deadline?: string; streak?: number } = {}): Promise<string> {
    const { rows: g } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, 'gw-1') RETURNING id`,
    );
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, step_count, protocol_error_streak,
                              wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, $2, $3, $4) RETURNING id`,
      [g[0]?.id ?? '', over.stepCount ?? 0, over.streak ?? 0,
       over.deadline === undefined ? new Date(Date.now() + 60000) : over.deadline === 'past' ? new Date(Date.now() - 1000) : null],
    );
    return rows[0]?.id ?? '';
  }

  async function waitDone(runId: string): Promise<Record<string, unknown>> {
    let row: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query('SELECT status, end_reason, step_count FROM agent_run WHERE id=$1', [runId]);
      row = rows[0];
      expect(row?.['status']).not.toBe('running');
    }, { interval: 20, timeout: 5000 });
    return row ?? {};
  }

  // ---------- 判定纯函数 ----------

  it('checkBudget：步数/墙钟/连续协议错误三闸逐字', () => {
    const now = new Date();
    const base = { stepCount: 0, wallConsumedMs: 0, wallDeadlineAt: new Date(now.getTime() + 60_000), protocolErrorStreak: 0 };
    expect(checkBudget(base, now).ok).toBe(true);
    expect(checkBudget({ ...base, stepCount: AGENT_MAX_STEPS }, now)).toMatchObject({ ok: false, endReason: 'budget_exhausted' });
    expect(checkBudget({ ...base, wallDeadlineAt: new Date(now.getTime() - 1) }, now)).toMatchObject({ ok: false, endReason: 'wall_clock' });
    expect(checkBudget({ ...base, protocolErrorStreak: PROTOCOL_ERROR_STREAK_LIMIT }, now)).toMatchObject({ ok: false, endReason: 'protocol_errors' });
    // 步数闸先于墙钟判定（第 12 步恰 finish 不被墙钟抢先——表内顺序即判定顺序）
    expect(checkBudget({ ...base, stepCount: AGENT_MAX_STEPS, wallDeadlineAt: new Date(now.getTime() - 1) }, now))
      .toMatchObject({ endReason: 'budget_exhausted' });
  });

  it('turn 超时钳到 10–15s 区间（默认 12s）', () => {
    expect(clampTurnTimeoutMs(undefined)).toBe(AGENT_TURN_TIMEOUT_DEFAULT_MS); // 12000
    expect(clampTurnTimeoutMs(5_000)).toBe(10_000); // 下限
    expect(clampTurnTimeoutMs(99_000)).toBe(15_000); // 上限
    expect(clampTurnTimeoutMs(13_000)).toBe(13_000);
  });

  it('恢复重建：wall_deadline_at = now() + (60000 - consumed)（停机不计，A5-2 逐字）', () => {
    const now = new Date('2026-09-28T02:00:00Z');
    expect(resumedWallDeadline(0, now).getTime()).toBe(now.getTime() + AGENT_WALL_CLOCK_MS);
    expect(resumedWallDeadline(45_000, now).getTime()).toBe(now.getTime() + 15_000);
    expect(resumedWallDeadline(70_000, now).getTime()).toBe(now.getTime()); // 已耗尽 → 0 剩余
  });

  // ---------- 集成：预算终结 run ----------

  it('第 12 步恰 finish → finished/final（上限含结束步，REQ A5-2 逐字）', async () => {
    const runId = await makeRun({ stepCount: AGENT_MAX_STEPS - 1 });
    createAgentExecutor({ pool: db.pool, agentClient: new FinishClient(), logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'finished', end_reason: 'final', step_count: AGENT_MAX_STEPS });
  });

  it('step_count=12 且无结束 → 下轮预检即 failed/budget_exhausted（不再发 HTTP）', async () => {
    const runId = await makeRun({ stepCount: AGENT_MAX_STEPS });
    const client = new FinishClient();
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'failed', end_reason: 'budget_exhausted' });
    expect(client.calls).toBe(0); // 预检拦截：根本没发请求
  });

  it('wall_deadline_at 已过 → failed/wall_clock（60s 上限含审计等待路径由 T-P4-07 测交错）', async () => {
    const runId = await makeRun({ deadline: 'past' });
    const client = new FinishClient();
    createAgentExecutor({ pool: db.pool, agentClient: client, logger: silent, instanceId: 't' }).startRun(runId);
    const run = await waitDone(runId);
    expect(run).toMatchObject({ status: 'failed', end_reason: 'wall_clock' });
    expect(client.calls).toBe(0);
  });

  it('恢复后 wall_deadline 已重建且 wall_consumed 保留（停机不计的落库形态）', async () => {
    // 停机不计 = deadline 按「剩余」重锚：consumed=45s 的 run 恢复后应还有 ~15s
    const runId = await makeRun({ stepCount: 0 });
    await db.pool.query('UPDATE agent_run SET wall_consumed_ms=45000 WHERE id=$1', [runId]);
    const rebuilt = resumedWallDeadline(45_000, new Date());
    await db.pool.query('UPDATE agent_run SET wall_deadline_at=$2 WHERE id=$1', [runId, rebuilt]);
    const { rows } = await db.pool.query<{ wall_deadline_at: Date; wall_consumed_ms: string }>(
      'SELECT wall_deadline_at, wall_consumed_ms FROM agent_run WHERE id=$1', [runId]);
    expect(rows[0]?.wall_deadline_at.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]?.wall_deadline_at.getTime()).toBeLessThan(Date.now() + 20_000); // 剩余 ~15s
    expect(Number(rows[0]?.wall_consumed_ms)).toBe(45_000); // 累计不丢
  });
});
