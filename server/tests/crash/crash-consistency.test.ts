// 崩溃点 ①：出站一致性 I1/I2（T-P7-02；DES/10 E7/I1/I2 行 + DES/05 §2.3 + VITEST_PLAN §4①）。
// 注入窗口：first_attempt_at 落库前（dispatcher.claim.before）/ 落库后 send 前（claim.after）/
//   网关 send 前（gateway.call.send.before）/ send 响应后写回前（gateway.call.send.after）。
// 断言：重启后「网关已发、DB 无记录」不存在（I1）+ 同 client_msg_id 网关至多一条消息
//   （I2：sendCallsByClientMsgId ≤1）；恢复路径：first_attempt_at 非空 → sweep 转 unknown →
//   判定器落定（404→2s 确认→补发，200→finalizeSent）。
// 变异检查（卡 d）：注释掉 claimAttempt 的 `AND first_attempt_at IS NULL` 条件守卫，
//   崩溃+重启后 sendCallsByClientMsgId 变 2（重复发送）→ 用例变红。
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { assertPostCrashHealth, crashGatewayCounters, withCrashPoint } from '../helpers/crash.js';
import { startCrashServer, type CrashServerHandle } from '../helpers/server-process.js';

interface SendResult {
  readonly clientMsgId: string;
}

async function connectAccount(handle: CrashServerHandle, token: string, accountId: string): Promise<void> {
  const res = await fetch(`${handle.baseUrl}/api/accounts/${accountId}/connect`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`connect ${accountId}: ${res.status} ${await res.text()}`);
}

async function createGroup(handle: CrashServerHandle, token: string): Promise<{ dbGroupId: string; gwGroupId: string }> {
  const res = await fetch(`${handle.baseUrl}/api/groups`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ creatorAccountId: 'acc-01', memberAccountIds: ['acc-02'] }),
  });
  if (!res.ok) throw new Error(`POST /api/groups: ${res.status} ${await res.text()}`);
  const { jobId } = (await res.json()) as { jobId: string };
  // 轮询 job finished（真实 I/O，无 fake 时钟）
  for (let i = 0; i < 400; i += 1) {
    const jr = await fetch(`${handle.baseUrl}/api/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const job = (await jr.json()) as { status: string };
    if (job.status === 'finished') {
      // /api/jobs 只回 {status, errors}——group 归属走 DB（读面同款）
      const { rows } = await handle.db.pool.query<{ group_id: string }>(
        `SELECT group_id FROM job WHERE id=$1`, [jobId]);
      const dbGroupId = rows[0]?.group_id;
      if (dbGroupId === undefined) throw new Error(`job ${jobId} has no group_id`);
      const gr = await fetch(`${handle.baseUrl}/api/groups/${dbGroupId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const group = (await gr.json()) as { gatewayGroupId: string };
      return { dbGroupId, gwGroupId: group.gatewayGroupId };
    }
    if (job.status === 'failed') throw new Error(`create-group job failed`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('create-group job timeout');
}

async function send(handle: CrashServerHandle, token: string, dbGroupId: string, text: string): Promise<SendResult> {
  const res = await fetch(`${handle.baseUrl}/api/groups/${dbGroupId}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'acc-01', text }),
  });
  if (!res.ok) throw new Error(`send: ${res.status} ${await res.text()}`);
  return (await res.json()) as SendResult;
}

interface MessageRow {
  readonly delivery_status: string;
  readonly first_attempt_at: string | null;
}

async function messageRow(pool: Pool, clientMsgId: string): Promise<MessageRow | undefined> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT delivery_status, first_attempt_at::text AS first_attempt_at FROM message WHERE client_msg_id=$1`,
    [clientMsgId],
  );
  return rows[0];
}

async function waitMessageStatus(pool: Pool, clientMsgId: string, want: readonly string[], timeoutMs = 30_000): Promise<MessageRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await messageRow(pool, clientMsgId);
    if (row !== undefined && want.includes(row.delivery_status)) return row;
    if (Date.now() > deadline) {
      throw new Error(`message ${clientMsgId} stuck at ${row?.delivery_status ?? 'missing'}; wanted ${want.join('/')}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 起环境到可发消息：connect + 建群完成 */
async function setupReady(handle: CrashServerHandle): Promise<{ token: string; dbGroupId: string; gwGroupId: string }> {
  const token = await handle.login();
  await connectAccount(handle, token, 'acc-01');
  await connectAccount(handle, token, 'acc-02'); // 建群成员须 online（ACCOUNT_NOT_ONLINE）
  const group = await createGroup(handle, token);
  return { token, ...group };
}

/** I1+I2 通用断言：终态后网关与 DB 一致性 */
async function assertConsistency(handle: CrashServerHandle, clientMsgId: string): Promise<void> {
  const counters = await crashGatewayCounters(handle);
  // I1：网关侧发出的每条我方消息 DB 必有记录（反向：DB 有记录且终态）
  const row = await messageRow(handle.db.pool, clientMsgId);
  expect(row, 'message row must exist').toBeDefined();
  expect(['sent', 'accepted']).toContain(row?.delivery_status);
  expect(row?.first_attempt_at).not.toBeNull(); // 尝试过才可能有网关消息
  // I2：同 client_msg_id 在网关至多一条消息——send 调用至多 1 次且落地至多 1 条
  expect(counters.sendCallsByClientMsgId[clientMsgId] ?? 0).toBeLessThanOrEqual(1);
  expect(counters.landedMessages).toBeLessThanOrEqual(1);
  expect(counters.landedMessages).toBe(1); // 该消息最终落定（恢复路径送达）
}

describe('crash point ① outbound consistency I1/I2 (T-P7-02)', () => {
  it('claim.before：first_attempt_at 未落库崩溃 → 重启正常首发，I1/I2 满足', async () => {
    const handle = await startCrashServer();
    try {
      const { token, dbGroupId } = await setupReady(handle);
      let clientMsgId = '';
      await withCrashPoint(handle, 'dispatcher.claim.before', async () => {
        clientMsgId = (await send(handle, token, dbGroupId, 'crash@claim.before')).clientMsgId;
        // 让 dispatcher tick 拾取（send 202 返回后后台循环才跑到 claim）
        await new Promise((r) => setTimeout(r, 400));
      });
      // 崩溃发生在落库前：重启后行仍 queued/first_attempt_at NULL → 正常首发
      await assertPostCrashHealth(handle);
      expect(clientMsgId).not.toBe('');
      const row = await waitMessageStatus(handle.db.pool, clientMsgId, ['sent']);
      expect(row.delivery_status).toBe('sent');
      await assertConsistency(handle, clientMsgId);
    } finally {
      await handle.stop();
    }
  }, 120000);

  it('claim.after：first_attempt_at 已落库、send 未发崩溃 → sweep 转 unknown → 判定器补发', async () => {
    const handle = await startCrashServer();
    try {
      const { token, dbGroupId } = await setupReady(handle);
      let clientMsgId = '';
      await withCrashPoint(handle, 'dispatcher.claim.after', async () => {
        clientMsgId = (await send(handle, token, dbGroupId, 'crash@claim.after')).clientMsgId;
        await new Promise((r) => setTimeout(r, 400));
      });
      await assertPostCrashHealth(handle);
      // 恢复：first_attempt_at 非空 → unknown → 判定器 404→2s 确认→补发 → sent
      const row = await waitMessageStatus(handle.db.pool, clientMsgId, ['sent'], 45_000);
      expect(row.delivery_status).toBe('sent');
      await assertConsistency(handle, clientMsgId);
    } finally {
      await handle.stop();
    }
  }, 150000);

  it('gateway.call.send.before：send 请求未离进程崩溃 → 判定器 404 补发仅一次（I2）', async () => {
    const handle = await startCrashServer();
    try {
      const { token, dbGroupId } = await setupReady(handle);
      let clientMsgId = '';
      await withCrashPoint(handle, 'gateway.call.send.before', async () => {
        clientMsgId = (await send(handle, token, dbGroupId, 'crash@send.before')).clientMsgId;
        await new Promise((r) => setTimeout(r, 600));
      });
      await assertPostCrashHealth(handle);
      await waitMessageStatus(handle.db.pool, clientMsgId, ['sent'], 45_000);
      await assertConsistency(handle, clientMsgId);
      // 网关仅见一次 send（崩溃时第一次没发出去；补发一次）
      const counters = await crashGatewayCounters(handle);
      expect(counters.sendCallsByClientMsgId[clientMsgId]).toBe(1);
    } finally {
      await handle.stop();
    }
  }, 150000);

  it('gateway.call.send.after：send 已受理、写回前崩溃 → 判定器 by-client-id 200 落定，不重发（I2）', async () => {
    const handle = await startCrashServer();
    try {
      const { token, dbGroupId } = await setupReady(handle);
      let clientMsgId = '';
      await withCrashPoint(handle, 'gateway.call.send.after', async () => {
        clientMsgId = (await send(handle, token, dbGroupId, 'crash@send.after')).clientMsgId;
        await new Promise((r) => setTimeout(r, 600));
      });
      // 崩溃在响应已收、markAccepted 前：send 调用已到网关一次；
      // 落地帧（message_sent 延迟 ~100-1500ms）在 mock 侧稍后到达——mock 活在测试进程，不受崩溃影响
      const crashedCounters = await crashGatewayCounters(handle);
      expect(crashedCounters.sendCallsByClientMsgId[clientMsgId]).toBe(1);

      await assertPostCrashHealth(handle);
      // 恢复：unknown → by-client-id 返回 200 → finalizeSent（不重发）
      await waitMessageStatus(handle.db.pool, clientMsgId, ['sent'], 45_000);
      const counters = await crashGatewayCounters(handle);
      expect(counters.sendCallsByClientMsgId[clientMsgId]).toBe(1); // I2：至多一条
      expect(counters.landedMessages).toBe(1);
      await assertConsistency(handle, clientMsgId);
    } finally {
      await handle.stop();
    }
  }, 150000);
});
