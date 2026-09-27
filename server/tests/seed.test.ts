// T-P0-06 c)：seed 幂等（连跑两次无变化）+ 行集精确断言（卡片 b 逐字）。
// 依据 DES/02 §10、DES/09 §5（bcrypt cost 10、admin/admin + viewer/viewer 笔试约定）、REQ §2.1
// （「初始 status = idle、platformUserId = null」）。VITEST_PLAN G-21 行。
import { compareSync } from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDb, type TestDbHandle } from './helpers/db.js';
import { seed } from '../src/db/seed.js';

interface UserRow {
  username: string;
  password_hash: string;
  role: string;
}

interface AccountRow {
  id: string;
  status: string;
  platform_user_id: string | null;
}

describe('db:seed (T-P0-06)', () => {
  let db: TestDbHandle;

  beforeAll(async () => {
    db = await getTestDb(); // 模板库已迁移（seed 前置：schema 存在）
  });
  afterAll(async () => {
    await db.close();
  });

  it('seeds exactly admin/viewer users and acc-01..04 idle accounts', async () => {
    const first = await seed(db.pool);
    expect(first.insertedUsers).toBe(2);
    expect(first.insertedAccounts).toBe(4);

    const users = await db.pool.query<UserRow>(
      'SELECT username, password_hash, role FROM app_user ORDER BY username',
    );
    expect(users.rows.map((u) => u.username)).toEqual(['admin', 'viewer']);
    expect(users.rows.map((u) => u.role)).toEqual(['admin', 'viewer']); // ORDER BY username 后对位

    const accounts = await db.pool.query<AccountRow>(
      'SELECT id, status, platform_user_id FROM account ORDER BY id',
    );
    expect(accounts.rows.map((a) => a.id)).toEqual(['acc-01', 'acc-02', 'acc-03', 'acc-04']);
    expect(accounts.rows.every((a) => a.status === 'idle')).toBe(true);
    expect(accounts.rows.every((a) => a.platform_user_id === null)).toBe(true);
  });

  it('passwords are bcrypt hashes (cost 10), not plaintext', async () => {
    const { rows } = await db.pool.query<UserRow>('SELECT username, password_hash FROM app_user');
    const byName = new Map(rows.map((u) => [u.username, u.password_hash]));
    for (const [username, hash] of byName) {
      expect(hash).not.toBe(username); // 非明文（卡片 b）
      expect(hash).toMatch(/^\$2[aby]\$10\$/); // bcrypt cost 10（DES/09 §5）
      expect(compareSync(username, hash)).toBe(true); // 密码 = 用户名（admin/admin、viewer/viewer）
    }
  });

  it('second seed run is a no-op (ON CONFLICT DO NOTHING, not check-then-insert)', async () => {
    const second = await seed(db.pool);
    expect(second.insertedUsers).toBe(0);
    expect(second.insertedAccounts).toBe(0);

    const users = await db.pool.query<{ count: string }>('SELECT count(*) AS count FROM app_user');
    const accounts = await db.pool.query<{ count: string }>('SELECT count(*) AS count FROM account');
    expect(Number(users.rows[0]?.count)).toBe(2);
    expect(Number(accounts.rows[0]?.count)).toBe(4);
  });
});
