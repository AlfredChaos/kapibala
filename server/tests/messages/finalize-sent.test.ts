// finalizeSent 唯一收口 + message_sent/message_failed 事件测试（T-P3-04 c 项，先红后绿）。
// 契约出处：DES/05 §4.3 逐字（预检 → 2a 常规回填 / 2b 先删占位行再改 M 行[次序不可换]
// → 序列联动 → ws_event）；§2.5（message_failed 按码分流）；DES/02 §9 一行原则（D3-5 稳态一行）；
// A2 分流表；D1-3（确认途径唯一收口——事件/by-client-id 共用同函数）。
// 形态：handler 级（构造 EventDispatchContext，事务内执行）+ finalizeSent 直接断言 outcome 三分支。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { finalizeSent } from '../../src/modules/messages/finalize-sent.js';
import {
  createMessageSentHandler,
  createMessageFailedHandler,
} from '../../src/events/handlers/confirm.js';
import type { EventDispatchContext } from '../../src/events/dispatch.js';

const logger = { info() {}, warn() {}, error() {} };

describe('finalizeSent 收口 + message_sent/failed 事件（DES/05 §2.5/§4.3）', () => {
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
               sequence_run_step, sequence_run, sequence, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
  });

  async function seedAccount(id: string, status = 'online'): Promise<void> {
    await db.pool.query(
      `INSERT INTO account (id, status, platform_user_id) VALUES ($1, $2, 'puid-' || $1) ON CONFLICT (id) DO UPDATE SET status=$2`,
      [id, status],
    );
  }

  async function makeGroup(): Promise<string> {
    await seedAccount('acc-01');
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', 'gw-1') RETURNING id`,
    );
    return rows[0]?.id ?? '';
  }

  /** 占位行（出站受理态；msg_id NULL） */
  async function makePlaceholder(
    groupId: string,
    opts: { clientMsgId?: string; status?: string; source?: string; resendCount?: number } = {},
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO message (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source,
                            text, sent_at, delivery_status, account_id, first_attempt_at, last_attempt_at, resend_count)
       VALUES ($1, NULL, $2, 'puid-01', true, $4, 'hi', now(), $3, 'acc-01', now(), now(), $5)`,
      [groupId, opts.clientMsgId ?? 'cm-1', opts.status ?? 'accepted', opts.source ?? 'operator', opts.resendCount ?? 0],
    );
  }

  /** 回流 M 行（乱序窗口内 message 先到：is_own=true, client_msg_id=NULL, sent 态） */
  async function makeMergedRow(groupId: string, msgId: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO message (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source,
                            text, sent_at, delivery_status)
       VALUES ($1, $2, NULL, 'puid-01', true, 'inbound', 'hi', now() - interval '1 second', 'sent')`,
      [groupId, msgId],
    );
  }

  /** 事件事务内驱动 handler（与消费层同事务语义） */
  async function handleInTx(
    handler: (ctx: EventDispatchContext) => Promise<void>,
    type: string,
    payload: Record<string, unknown>,
    eventId = 1,
  ): Promise<void> {
    await tx(db.pool, async (client: PoolClient) => {
      await handler({
        client,
        event: { eventId, type, payload },
        logger,
      });
    });
  }

  async function rowsBy(groupId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await db.pool.query(
      'SELECT msg_id, client_msg_id, delivery_status, account_id, source, is_own, resend_count FROM message WHERE group_id=$1 ORDER BY id',
      [groupId],
    );
    return rows;
  }

  // ---------- 2a 常规路径 ----------

  it('message_sent 常规路径：占位行 accepted→sent，回填 msg_id+网关 sentAt + ws_event', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId);
    const handler = createMessageSentHandler(logger);
    const sentAt = new Date('2026-09-28T01:00:00Z');
    await handleInTx(handler, 'message_sent', { clientMsgId: 'cm-1', msgId: 'M-9', sentAt });
    const rows = await rowsBy(groupId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      msg_id: 'M-9',
      client_msg_id: 'cm-1',
      delivery_status: 'sent',
      account_id: 'acc-01',
    });
    const { rows: st } = await db.pool.query('SELECT sent_at FROM message WHERE group_id=$1', [groupId]);
    expect(new Date(st[0]?.sent_at as string).toISOString()).toBe('2026-09-28T01:00:00.000Z');
    const { rows: ev } = await db.pool.query(
      "SELECT payload FROM ws_event WHERE type='message' AND payload->>'deliveryStatus'='sent'",
    );
    expect(ev.length).toBe(1);
    expect(ev[0]?.payload).toMatchObject({ msgId: 'M-9', clientMsgId: 'cm-1' });
  });

  it('queued/unknown 占位同样可确认（前置态集合守卫）', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId, { status: 'unknown' });
    const out = await tx(db.pool, (c) => finalizeSent(c, 'cm-1', 'M-1', new Date()));
    expect(out).toBe('regular');
    const rows = await rowsBy(groupId);
    expect(rows[0]?.delivery_status).toBe('sent');
  });

  // ---------- 2b 乱序合并（D1-3：先删占位行再 UPDATE M 行） ----------

  it('回流先到（M 行存在）→ 先删占位行再 UPDATE M：恰好一行含双侧身份 + 审计字段迁移', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId, { source: 'sequence', resendCount: 1 });
    await makeMergedRow(groupId, 'M-7');
    const out = await tx(db.pool, (c) => finalizeSent(c, 'cm-1', 'M-7', '2026-09-28T02:00:00Z'));
    expect(out).toBe('merged');
    const rows = await rowsBy(groupId);
    expect(rows.length).toBe(1); // D3-5 稳态一行（窗口结束后占位行已删）
    expect(rows[0]).toMatchObject({
      msg_id: 'M-7',
      client_msg_id: 'cm-1', // 双侧身份同存
      delivery_status: 'sent',
      is_own: true,
      account_id: 'acc-01', // 审计字段随行迁移
      source: 'sequence',
      resend_count: 1,
    });
    const { rows: st } = await db.pool.query('SELECT sent_at FROM message WHERE group_id=$1', [groupId]);
    expect(new Date(st[0]?.sent_at as string).toISOString()).toBe('2026-09-28T02:00:00.000Z');
  });

  it('by-client-id 200 补投场景（M 行早已在）→ 走同一合并分支（D1-3 唯一收口）', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId, { status: 'unknown' }); // 504 后 unknown 判定路径
    await makeMergedRow(groupId, 'M-8'); // 网关侧其实早发出——回流先行
    const out = await tx(db.pool, (c) => finalizeSent(c, 'cm-1', 'M-8', new Date()));
    expect(out).toBe('merged'); // 与事件路径同一函数、同一分支
    expect((await rowsBy(groupId)).length).toBe(1);
  });

  // ---------- 幂等 ----------

  it('重复 message_sent（S2）幂等吸收：第二次 noop，行仍恰一条', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId);
    const first = await tx(db.pool, (c) => finalizeSent(c, 'cm-1', 'M-3', new Date()));
    expect(first).toBe('regular');
    const second = await tx(db.pool, (c) => finalizeSent(c, 'cm-1', 'M-3', new Date()));
    expect(second).toBe('noop');
    const { rows: ev } = await db.pool.query("SELECT count(*)::int AS n FROM ws_event WHERE type='message'");
    expect(ev[0]?.n).toBe(1); // 第二次不重复发帧
    expect((await rowsBy(groupId)).length).toBe(1);
  });

  it('message_sent 但占位行不存在（外部消息/无出站对象）→ noop 无副作用', async () => {
    const groupId = await makeGroup();
    const out = await tx(db.pool, (c) => finalizeSent(c, 'cm-absent', 'M-x', new Date()));
    expect(out).toBe('noop');
    expect((await rowsBy(groupId)).length).toBe(0);
  });

  // ---------- 序列联动（步骤 3：sent + 下一步排期钩子） ----------

  it('序列联动：sequence_run_step pending/accepted → sent + sent_at=网关值', async () => {
    const groupId = await makeGroup();
    const { rows: seq } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence (id, name, steps) VALUES (gen_random_uuid(), 's', '[]'::jsonb) RETURNING id`,
    );
    const { rows: run } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status) VALUES (gen_random_uuid(), $1, $2, 'running') RETURNING id`,
      [groupId, seq[0]?.id ?? ''],
    );
    await db.pool.query(
      `INSERT INTO sequence_run_step (run_id, "index", status, account_role, text_template, delay_seconds, client_msg_id, resolved_vars, var_sources)
       VALUES ($1, 0, 'accepted', 'member', 'hi', 0, 'cm-1', '{}'::jsonb, '{}'::jsonb)`,
      [run[0]?.id ?? ''],
    );
    await makePlaceholder(groupId);
    const sentAt = new Date('2026-09-28T03:00:00Z');
    await tx(db.pool, (c) => finalizeSent(c, 'cm-1', 'M-5', sentAt));
    const { rows: step } = await db.pool.query(
      'SELECT status, sent_at FROM sequence_run_step WHERE client_msg_id=$1',
      ['cm-1'],
    );
    expect(step[0]?.status).toBe('sent');
    expect(new Date(step[0]?.sent_at as string).toISOString()).toBe('2026-09-28T03:00:00.000Z');
  });

  // ---------- message_failed 按码分流（§2.5/A2） ----------

  it('message_failed GROUP_WRITE_FORBIDDEN → 群 unreachable 级联 + 该条 failed（§04 §5 同事务）', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId, { status: 'queued' });
    const { rows: seq } = await db.pool.query<{ id: string }>(
      `INSERT INTO sequence (id, name, steps) VALUES (gen_random_uuid(), 's', '[]'::jsonb) RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO sequence_run (id, group_id, sequence_id, status) VALUES (gen_random_uuid(), $1, $2, 'running')`,
      [groupId, seq[0]?.id ?? ''],
    );
    const handler = createMessageFailedHandler(logger);
    await handleInTx(handler, 'message_failed', { clientMsgId: 'cm-1', code: 'GROUP_WRITE_FORBIDDEN' });
    const rows = await rowsBy(groupId);
    expect(rows[0]?.delivery_status).toBe('failed');
    const { rows: g } = await db.pool.query('SELECT status FROM "group" WHERE id=$1', [groupId]);
    expect(g[0]?.status).toBe('unreachable');
    const { rows: sr } = await db.pool.query('SELECT status FROM sequence_run WHERE group_id=$1', [groupId]);
    expect(sr[0]?.status).toBe('stopped');
    const { rows: ev } = await db.pool.query("SELECT type FROM ws_event WHERE type IN ('sequence_run','message')");
    expect(ev.some((e) => e.type === 'sequence_run')).toBe(true); // 级联帧同事务
  });

  it('message_failed ACCOUNT_SUSPENDED → enterTerminal(suspended) + 该条 failed', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId, { status: 'queued' });
    const handler = createMessageFailedHandler(logger);
    await handleInTx(handler, 'message_failed', { clientMsgId: 'cm-1', code: 'ACCOUNT_SUSPENDED' });
    const { rows: acc } = await db.pool.query('SELECT status, terminal_at FROM account WHERE id=$1', ['acc-01']);
    expect(acc[0]?.status).toBe('suspended');
    expect(acc[0]?.terminal_at).not.toBeNull();
    const rows = await rowsBy(groupId);
    expect(rows[0]?.delivery_status).toBe('failed');
  });

  it('message_failed 契约表外码 → 仅该条 failed + 序列步联动（不猜额外副作用）', async () => {
    const groupId = await makeGroup();
    await makePlaceholder(groupId, { status: 'queued' });
    const handler = createMessageFailedHandler(logger);
    await handleInTx(handler, 'message_failed', { clientMsgId: 'cm-1', code: 'SOME_UNKNOWN_CODE' });
    const rows = await rowsBy(groupId);
    expect(rows[0]?.delivery_status).toBe('failed');
    const { rows: g } = await db.pool.query('SELECT status FROM "group" WHERE id=$1', [groupId]);
    expect(g[0]?.status).toBe('active'); // 无群级联
  });
});
