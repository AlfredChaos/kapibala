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

// ---------- kill -9 级崩溃注入（T-P7-04；VITEST_PLAN §4 ④；I11/B1 逐字）----------
// 真实子进程 + 真 mock + 真 PG。窗口：
//   A 链头在途：gateway.call.send.after（消息已发、步骤未落定）→ 重启 WAIT 分支：等落定推进；
//   B 链头已排期未创建消息即崩：start-run tx 提交后（tx.commit.after）→ 重启 H1c：只重排链头。
// 断言：同一 runId；其后 pending 步骤 scheduled_at=NULL；counters 恰一次发送（不一次性全发）。
import { assertPostCrashHealth, crashGatewayCounters } from '../helpers/crash.js';
import { startCrashServer, type CrashServerHandle } from '../helpers/server-process.js';

async function k9Connect(h: CrashServerHandle, token: string, accountId: string): Promise<void> {
  const res = await fetch(`${h.baseUrl}/api/accounts/${accountId}/connect`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`connect ${accountId}: ${res.status}`);
}

async function k9CreateGroup(h: CrashServerHandle, token: string): Promise<string> {
  const res = await fetch(`${h.baseUrl}/api/groups`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ creatorAccountId: 'acc-01', memberAccountIds: ['acc-02'] }),
  });
  if (!res.ok) throw new Error(`POST /api/groups: ${res.status}`);
  const { jobId } = (await res.json()) as { jobId: string };
  for (let i = 0; i < 400; i += 1) {
    const jr = await fetch(`${h.baseUrl}/api/jobs/${jobId}`, { headers: { authorization: `Bearer ${token}` } });
    const job = (await jr.json()) as { status: string };
    if (job.status === 'finished') {
      const { rows } = await h.db.pool.query<{ group_id: string }>(`SELECT group_id FROM job WHERE id=$1`, [jobId]);
      if (rows[0]?.group_id === undefined) throw new Error('job has no group_id');
      return rows[0].group_id;
    }
    if (job.status === 'failed') throw new Error('create-group job failed');
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('create-group job timeout');
}

async function k9DefineSequence(h: CrashServerHandle, token: string, delays: number[]): Promise<string> {
  const res = await fetch(`${h.baseUrl}/api/sequences`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'k9-seq',
      steps: delays.map((d, i) => ({
        index: i + 1,
        accountRole: i === 0 ? 'admin' : 'member',
        text: `k9 step ${i + 1}`,
        delaySeconds: d,
      })),
    }),
  });
  if (!res.ok) throw new Error(`define sequence: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function k9StartRun(h: CrashServerHandle, token: string, dbGroupId: string, sequenceId: string): Promise<string> {
  const res = await fetch(`${h.baseUrl}/api/groups/${dbGroupId}/sequence-runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequenceId, vars: {}, stepVars: {} }),
  });
  if (!res.ok) throw new Error(`start sequence run: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { runId: string }).runId;
}

interface K9Step {
  readonly index: number;
  readonly status: string;
  readonly scheduled_at: string | null;
  readonly client_msg_id: string | null;
}

async function k9Step(h: CrashServerHandle, runId: string, index: number): Promise<K9Step | undefined> {
  const { rows } = await h.db.pool.query<K9Step>(
    `SELECT "index", status, scheduled_at::text AS scheduled_at, client_msg_id
     FROM sequence_run_step WHERE run_id=$1 AND "index"=$2`,
    [runId, index],
  );
  return rows[0];
}

async function k9WaitStep(h: CrashServerHandle, runId: string, index: number, want: readonly string[], timeoutMs = 60_000): Promise<K9Step> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await k9Step(h, runId, index);
    if (s !== undefined && want.includes(s.status)) return s;
    if (Date.now() > deadline) throw new Error(`step ${index} stuck at ${s?.status ?? 'none'}; wanted ${want.join('/')}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('序列 kill -9 崩溃恢复（T-P7-04；I11/B1）', () => {
  it('④-A 链头在途崩溃（send.after）→ 重启等落定推进，不重排不重复发，后续仍 NULL', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await k9Connect(h, token, 'acc-01');
      await k9Connect(h, token, 'acc-02');
      const groupId = await k9CreateGroup(h, token);
      const sequenceId = await k9DefineSequence(h, token, [1, 60, 60]);

      const arm = await fetch(`${h.baseUrl}/_test/crash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'gateway.call.send.after', hit: 1 }),
      });
      expect(arm.status).toBe(200);
      const runId = await k9StartRun(h, token, groupId, sequenceId);
      // 步1 1s 后排期到期 → dispatch → send 落地后崩溃（响应已收、写回前窗口）
      await new Promise((r) => setTimeout(r, 4000));
      expect(await h.awaitExit()).toBe(9);

      await assertPostCrashHealth(h);
      // 恢复：链头消息在途 → WAIT；判定器落定 sent → 步1 sent → 步2 scheduled=sent+60s
      const step1 = await k9WaitStep(h, runId, 1, ['sent']).catch(async (e) => {
        console.log('STEPS@fail', JSON.stringify((await h.db.pool.query(`SELECT "index",status,client_msg_id,scheduled_at::text FROM sequence_run_step WHERE run_id=$1`, [runId])).rows));
        console.log('MSGS@fail', JSON.stringify((await h.db.pool.query(`SELECT client_msg_id,delivery_status,source FROM message`)).rows));
        throw e;
      });
      expect(step1.client_msg_id).not.toBeNull();
      const step2 = await k9Step(h, runId, 2);
      const step3 = await k9Step(h, runId, 3);
      // I11/B1：步2 排到 sent_at+60s（未来），步3 NULL——不一次性全发
      expect(step2?.scheduled_at).not.toBeNull();
      const s2delta = new Date(step2?.scheduled_at ?? '').getTime() - Date.now();
      expect(s2delta).toBeGreaterThan(40_000); // 60s 档（容许处理耗时）
      expect(s2delta).toBeLessThan(90_000);
      expect(step3?.scheduled_at).toBeNull();
      const counters = await crashGatewayCounters(h);
      expect(counters.landedMessages).toBe(1); // 恰一条（同 clientMsgId 至多一）
      expect(counters.sendCallsByClientMsgId[step1.client_msg_id ?? '']).toBe(1);
      // 同 runId：无新 run
      const { rows: runs } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sequence_run WHERE group_id=$1`, [groupId]);
      expect(runs[0]?.n).toBe(1);
    } finally {
      await h.stop();
    }
  }, 180000);

  it('④-B 链头已排期（start tx 提交后崩）→ 重启只重排链头(now+delay)，其后 NULL', async () => {
    const h = await startCrashServer();
    try {
      const token = await h.login();
      await k9Connect(h, token, 'acc-01');
      await k9Connect(h, token, 'acc-02');
      const groupId = await k9CreateGroup(h, token);
      const sequenceId = await k9DefineSequence(h, token, [0, 60, 60]); // 步1 delay 0 → start 即到期

      const arm = await fetch(`${h.baseUrl}/_test/crash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'tx.commit.after', hit: 1 }),
      });
      expect(arm.status).toBe(200);
      await k9StartRun(h, token, groupId, sequenceId).catch(() => undefined); // 响应因崩溃断裂属预期
      expect(await h.awaitExit()).toBe(9);

      const { rows: runs } = await h.db.pool.query<{ id: string }>(
        `SELECT id FROM sequence_run WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1`, [groupId]);
      const runId = runs[0]?.id ?? '';
      expect(runId).not.toBe('');

      await assertPostCrashHealth(h);
      // H1c：链头过期 → 只重排它（delay 0 → now+0 → 立即补发落定）；其后 NULL
      const step1 = await k9WaitStep(h, runId, 1, ['sent']);
      const step2 = await k9Step(h, runId, 2);
      const step3 = await k9Step(h, runId, 3);
      expect(step3?.scheduled_at).toBeNull();
      expect(step2?.scheduled_at).not.toBeNull(); // sent+60s 已排未来
      const counters = await crashGatewayCounters(h);
      expect(counters.landedMessages).toBe(1); // 只链头发出——B1「不一次性全发」
      expect(counters.sendCallsByClientMsgId[step1.client_msg_id ?? '']).toBe(1);
    } finally {
      await h.stop();
    }
  }, 180000);
});
