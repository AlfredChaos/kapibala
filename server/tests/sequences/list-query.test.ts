// GET /api/sequences 定义列表测试（design/15 §2 页面 5 数据源行「GET（定义列表）」）。
// QR §1 端点表未列此端点 → 契约空隙补全（design/README 解释声明 #27）：
// 形状基准 = design/02 §8.1 sequence 表列（id/name/steps/created_at）+ design/07 §1「steps 原样存快照」；
// 包络惯例逐字对齐 GET /api/groups / GET /api/accounts（裸数组，无 { items } 包装）。
// 覆盖：空表 → 空数组；N 条定义 → N 项逐字段（name / steps / createdAt ISO 8601 UTC）；
// viewer 可读 200、无 token 401（DES/09 §4 读路径）；排序 created_at ASC, id ASC 与插入顺序无关。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import type { SequenceListItem } from '../../src/modules/sequences/query.js';

interface SeedRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

describe('GET /api/sequences（design/15 §2 页面 5 数据源；解释声明 #27）', () => {
  let db: TestDbHandle;
  let app: App;
  let admin: { authorization: string };
  let viewer: { authorization: string };

  async function login(username: string, password: string): Promise<{ authorization: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${(res.json() as { accessToken: string }).accessToken}` };
  }

  /** 直插定义行（固定 id/created_at）——排序用例需要可控值，POST 路径由 list 用例走 */
  async function insertDefinition(row: SeedRow): Promise<void> {
    await db.pool.query(
      `INSERT INTO "sequence" (id, name, steps, created_at)
       VALUES ($1, $2, '[{"index":1,"accountRole":"admin","text":"a","delaySeconds":0}]'::jsonb, $3)`,
      [row.id, row.name, row.createdAt],
    );
  }

  async function postDefinition(name: string, steps: unknown[]): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/sequences', headers: admin, payload: { name, steps } });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
    });
    admin = await login('admin', 'admin');
    viewer = await login('viewer', 'viewer');
  });
  afterAll(async () => { await app.close(); await db.close(); });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE "sequence" RESTART IDENTITY CASCADE`);
  });

  it('无定义 → 200 空数组（裸数组包络，同 GET /api/groups）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sequences', headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('N 条定义 → N 项：id/name 逐字、steps 原样快照（DES/07 §1）、createdAt = DB created_at 的 ISO 8601 UTC', async () => {
    const stepsA = [
      { index: 1, accountRole: 'admin', text: '预告{event}', delaySeconds: 0 },
      { index: 10, accountRole: 'member', text: '{event} 开始', delaySeconds: 10 },
    ];
    const stepsB = [{ index: 1, accountRole: 'member', text: 'b', delaySeconds: 3 }];
    const idA = await postDefinition('发布预告', stepsA);
    const idB = await postDefinition('补发提醒', stepsB);

    const res = await app.inject({ method: 'GET', url: '/api/sequences', headers: admin });
    expect(res.statusCode).toBe(200);
    const items = res.json() as SequenceListItem[];
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === idA)).toMatchObject({ id: idA, name: '发布预告', steps: stepsA });
    expect(items.find((item) => item.id === idB)).toMatchObject({ id: idB, name: '补发提醒', steps: stepsB });
    for (const item of items) {
      // createdAt 逐字等于库内 timestamptz 的 ISO 8601 UTC 串（宪法 §3-6：对外 ISO 字符串）
      const { rows } = await db.pool.query<{ created_at: Date }>(
        'SELECT created_at FROM "sequence" WHERE id=$1',
        [item.id],
      );
      expect(item.createdAt).toBe(rows[0]?.created_at.toISOString() ?? '');
      expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('viewer 读定义列表 → 200；无 token → 401 UNAUTHORIZED（DES/09 §4：读路径 viewer 可访问）', async () => {
    await postDefinition('仅列表可见', [{ index: 1, accountRole: 'admin', text: 'a', delaySeconds: 0 }]);
    const asViewer = await app.inject({ method: 'GET', url: '/api/sequences', headers: viewer });
    expect(asViewer.statusCode).toBe(200);
    expect((asViewer.json() as SequenceListItem[]).map((item) => item.name)).toEqual(['仅列表可见']);

    const anon = await app.inject({ method: 'GET', url: '/api/sequences' });
    expect(anon.statusCode).toBe(401);
    expect((anon.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('稳定排序：created_at ASC 主序、同刻按 id ASC，与插入顺序无关', async () => {
    const T1 = '2026-01-01T00:00:00.000Z';
    const T2 = '2026-01-02T00:00:00.000Z';
    const ID1 = '00000000-0000-0000-0000-000000000001';
    const ID2 = '00000000-0000-0000-0000-000000000002';
    const ID3 = '00000000-0000-0000-0000-000000000003';
    // 插入顺序与两轴皆相反：最晚时刻先插，同刻内大 id 先插
    await insertDefinition({ id: ID3, name: 'c2-id3', createdAt: T2 });
    await insertDefinition({ id: ID2, name: 'c1-id2', createdAt: T1 });
    await insertDefinition({ id: ID1, name: 'c1-id1', createdAt: T1 });

    const res = await app.inject({ method: 'GET', url: '/api/sequences', headers: viewer });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SequenceListItem[]).map((item) => item.id)).toEqual([ID1, ID2, ID3]);
  });
});
