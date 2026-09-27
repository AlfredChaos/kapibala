// 成员投影测试（T-P2-09 c 项，先红后绿）。
// 契约出处：DES/04 §4 成员拓扑投影（事件驱动、乱序防线 D2-1、墓碑行、复活先查终态 R-A、
// TOMB 分支 ON CONFLICT GREATEST、外部成员不建行）；DES/02 §4.2（成员表只投影服务账号、
// 活跃 = left_at IS NULL）；REQ A1（终态账号从所有群成员表移除）；S2（重复推送幂等）。
// 事件层只负责投影：事件事务由测试以 tx() 承载（与 consumer.ts 的用法同形）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { createMemberHandler } from '../../src/events/handlers/member.js';
import type { GatewayEventEnvelope } from '../../src/events/dispatch.js';

const logger = { warn() {} };

describe('member_joined / member_left 投影（DES/04 §4：last_event_id 单调 + 墓碑 + R-A 终态防线）', () => {
  let db: TestDbHandle;
  let groupId: string;

  // 事件里带的是网关群 id；memberRow 查询用本地 group.id
  function ev(type: 'member_joined' | 'member_left', eventId: number, puid: string, gwGroupId = 'gw-g-1') {
    const event: GatewayEventEnvelope = {
      eventId,
      type,
      payload: { type, eventId, groupId: gwGroupId, platformUserId: puid },
    };
    return event;
  }

  async function deliver(event: GatewayEventEnvelope): Promise<void> {
    const handler = createMemberHandler(logger);
    await tx(db.pool, (c) => handler({ client: c, event, logger }));
  }

  async function memberRow(puid: string, gid = groupId) {
    const { rows } = await db.pool.query<{
      account_id: string;
      role: string;
      joined_at: Date | null;
      left_at: Date | null;
      last_event_id: string; // bigint → string
    }>(
      'SELECT account_id, role, joined_at, left_at, last_event_id FROM group_member WHERE group_id=$1 AND platform_user_id=$2',
      [gid, puid],
    );
    return rows[0];
  }

  async function setAccountPuid(accountId: string, puid: string): Promise<void> {
    await db.pool.query('UPDATE account SET platform_user_id=$2 WHERE id=$1', [accountId, puid]);
  }

  async function makeTerminal(accountId: string): Promise<void> {
    await db.pool.query(
      "UPDATE account SET status='suspended', terminal_at=now() WHERE id=$1",
      [accountId],
    );
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.pool.query(
      'TRUNCATE ws_event, gateway_event, message, group_member, "group", account RESTART IDENTITY CASCADE',
    );
    await seed(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, gateway_group_id, creator_account_id)
       VALUES (gen_random_uuid(), 'gw-g-1', 'acc-01') RETURNING id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('group insert failed');
    groupId = row.id;
    // 服务账号 ↔ puid 绑定（等价 connect 后的落库状态；投影只认 puid 反查）
    await setAccountPuid('acc-01', 'puid-01');
    await setAccountPuid('acc-02', 'puid-02');
  });

  it('正常序：joined(E1) → 活跃行；left(E2) → left_at + last_event_id 推进', async () => {
    await deliver(ev('member_joined', 10, 'puid-02'));
    const joined = await memberRow('puid-02');
    expect(joined).toMatchObject({ account_id: 'acc-02', role: 'member' });
    expect(joined?.left_at).toBeNull();
    expect(joined?.joined_at).not.toBeNull();
    expect(BigInt(joined?.last_event_id ?? '0')).toBe(10n);

    await deliver(ev('member_left', 20, 'puid-02'));
    const left = await memberRow('puid-02');
    expect(left?.left_at).not.toBeNull();
    expect(BigInt(left?.last_event_id ?? '0')).toBe(20n);
  });

  it('乱序 D2-1：left(E2) 先到建墓碑、joined(E1) 后到只补 joined_at 不复活', async () => {
    await deliver(ev('member_left', 20, 'puid-02')); // 无行 → 墓碑
    const tomb = await memberRow('puid-02');
    expect(tomb?.left_at).not.toBeNull();
    expect(tomb?.joined_at).toBeNull();
    expect(BigInt(tomb?.last_event_id ?? '0')).toBe(20n);

    await deliver(ev('member_joined', 10, 'puid-02')); // E1 < last_event_id → STALE
    const stale = await memberRow('puid-02');
    expect(stale?.left_at).not.toBeNull(); // 不复活
    expect(stale?.joined_at).not.toBeNull(); // 只补 joined_at
    expect(BigInt(stale?.last_event_id ?? '0')).toBe(20n); // 不回退
  });

  it('R-A：join 在途账号已终态 → joined 到达 INSERT 即墓碑（left_at 非空）', async () => {
    await makeTerminal('acc-02'); // join 发出后、事件到达前账号终态
    await deliver(ev('member_joined', 30, 'puid-02'));
    const row = await memberRow('puid-02');
    expect(row?.left_at).not.toBeNull(); // INSERT 即墓碑
    expect(BigInt(row?.last_event_id ?? '0')).toBe(30n);
  });

  it('R-A：迟到 joined（E3 > last_event_id）撞上终态账号 → STALE 不复活（终态防线优先于单调推进）', async () => {
    await deliver(ev('member_joined', 10, 'puid-02')); // 活跃行
    await makeTerminal('acc-02'); // 终态副作用把活跃行置 left_at（等价 account_status 已处理）
    const { rows } = await db.pool.query(
      'UPDATE group_member SET left_at=now(), last_event_id=15 WHERE group_id=$1 AND platform_user_id=$2 RETURNING *',
      [groupId, 'puid-02'],
    );
    expect(rows.length).toBe(1);
    // 终态后迟到的 joined（E3=30 > 15）：若不查终态会复活——必须按 STALE 处理
    await deliver(ev('member_joined', 30, 'puid-02'));
    const row = await memberRow('puid-02');
    expect(row?.left_at).not.toBeNull(); // 不复活
    expect(BigInt(row?.last_event_id ?? '0')).toBe(15n); // STALE 不改 last_event_id
    expect(row?.joined_at).not.toBeNull();
  });

  it('复活合法路径：left(E2) → 非终态账号 rejoin(E3 > E2) → left_at=NULL 复活', async () => {
    await deliver(ev('member_joined', 10, 'puid-02'));
    await deliver(ev('member_left', 20, 'puid-02'));
    await deliver(ev('member_joined', 30, 'puid-02')); // 真重入群
    const row = await memberRow('puid-02');
    expect(row?.left_at).toBeNull(); // 复活
    expect(BigInt(row?.last_event_id ?? '0')).toBe(30n);
  });

  it('left 早于既有行的 last_event_id（迟到 left）→ 不置 left_at（单调防线对称）', async () => {
    await deliver(ev('member_joined', 50, 'puid-02'));
    await deliver(ev('member_left', 40, 'puid-02')); // E 比行上还小——迟到的旧 left
    const row = await memberRow('puid-02');
    expect(row?.left_at).toBeNull(); // 仍是活跃
    expect(BigInt(row?.last_event_id ?? '0')).toBe(50n);
  });

  it('双 leave 防线：tombstone 上再 hit left(E4) → ON CONFLICT DO UPDATE GREATEST 推进', async () => {
    await deliver(ev('member_left', 20, 'puid-02')); // 墓碑 last_event_id=20
    await deliver(ev('member_joined', 10, 'puid-02')); // STALE：补 joined_at
    await deliver(ev('member_left', 40, 'puid-02')); // 第二次 leave（更晚）
    const row = await memberRow('puid-02');
    expect(BigInt(row?.last_event_id ?? '0')).toBe(40n); // GREATEST 推进
    expect(row?.left_at).not.toBeNull();
    // 现在迟到的 joined(30) 撞上 last_event_id=40 → 仍 STALE（无法越过第二道防线）
    await deliver(ev('member_joined', 30, 'puid-02'));
    const after = await memberRow('puid-02');
    expect(after?.left_at).not.toBeNull();
  });

  it('外部成员（puid ∉ 服务账号）joined/left → 不建行（G-11；账本行归属上游消费层）', async () => {
    await deliver(ev('member_joined', 10, 'puid-external'));
    await deliver(ev('member_left', 20, 'puid-external'));
    expect(await memberRow('puid-external')).toBeUndefined();
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM group_member');
    expect(rows[0]?.n).toBe(0);
  });

  it('重复 member_joined（S2/at-least-once）→ 幂等：仍一行、活跃、last_event_id 不后退', async () => {
    await deliver(ev('member_joined', 10, 'puid-02'));
    await deliver(ev('member_joined', 10, 'puid-02')); // 完全重复
    const { rows } = await db.pool.query(
      'SELECT count(*)::int AS n FROM group_member WHERE platform_user_id=$1',
      ['puid-02'],
    );
    expect(rows[0]?.n).toBe(1);
    const row = await memberRow('puid-02');
    expect(row?.left_at).toBeNull();
    expect(BigInt(row?.last_event_id ?? '0')).toBe(10n);
  });

  it('同账号多群隔离：joined 只投影到事件指定的群', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, gateway_group_id, creator_account_id)
       VALUES (gen_random_uuid(), 'gw-g-2', 'acc-01') RETURNING id`,
    );
    const g2 = rows[0]?.id;
    if (g2 === undefined) throw new Error('group2 insert failed');
    await deliver(ev('member_joined', 10, 'puid-02')); // 默认 groupId
    await deliver(ev('member_joined', 11, 'puid-02', 'gw-g-2'));
    const r1 = await memberRow('puid-02', groupId);
    const r2 = await memberRow('puid-02', g2);
    expect(r1?.last_event_id).toBe('10');
    expect(r2?.last_event_id).toBe('11');
    expect(r1?.left_at).toBeNull();
    expect(r2?.left_at).toBeNull();
  });
});
