// T-P0-04 c) 用例 1：迁移 runner 可重复执行（A0）+ 启动版本门（落后 / 超前均拒绝）。
// 依据 DES/01 §6.4、DES/02 §1.1；VITEST_PLAN A0 行。
// 落后用例额外 spawn 真实进程验证「拒绝启动 = 进程退出 + error 日志列缺失版本」（卡片 b）逐字语义）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBareTestDb, withTestDb, type TestDbHandle } from './helpers/db.js';
import { listMigrationFiles, migrate } from '../src/db/migrate.js';
import { ensureSchemaVersion, SchemaVersionError } from '../src/db/ensure-schema.js';

const execFileAsync = promisify(execFile);
const CODE_VERSIONS = listMigrationFiles().map((f) => f.version);
const CODE_LATEST = CODE_VERSIONS.at(-1) ?? 0;

describe('migration runner (A0)', () => {
  describe('repeatable run', () => {
    let db: TestDbHandle;
    beforeAll(async () => {
      db = await getBareTestDb(); // 空白库：从零应用，覆盖 runner 全路径
    });
    afterAll(async () => {
      await db.close();
    });

    it('applies all migration files in order on a fresh database', async () => {
      const { applied } = await migrate(db.pool);
      expect(applied).toEqual(CODE_VERSIONS);
      const { rows } = await db.pool.query<{ version: number; name: string }>(
        'SELECT version, name FROM schema_migrations ORDER BY version',
      );
      expect(rows.map((r) => r.version)).toEqual(CODE_VERSIONS);
      expect(rows.map((r) => r.name)).toEqual(listMigrationFiles().map((f) => f.name));
      const tables = await db.pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(Number(tables.rows[0]?.count)).toBe(20); // 19 业务表 + schema_migrations（T-P0-03）
    });

    it('second run is a no-op (idempotent)', async () => {
      const { applied } = await migrate(db.pool);
      expect(applied).toEqual([]);
      const { rows } = await db.pool.query<{ v: number }>(
        'SELECT max(version)::int AS v FROM schema_migrations',
      );
      expect(rows[0]?.v).toBe(CODE_LATEST);
    });

    it('version gate passes when DB matches code', async () => {
      await expect(ensureSchemaVersion(db.pool)).resolves.toBe(CODE_LATEST);
    });
  });

  describe('version gate', () => {
    // 三个用例各自独立库：改写 schema_migrations 的用例互不污染
    it('refuses when DB is behind code (lists missing versions)', async () => {
      await withTestDb(async (pool) => {
        await pool.query('DELETE FROM schema_migrations WHERE version > 3');
        const err = await ensureSchemaVersion(pool).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SchemaVersionError);
        const sve = err as SchemaVersionError;
        expect(sve.kind).toBe('behind');
        expect(sve.missing).toEqual([4, 5, 6, 7, 8, 9]);
        expect(sve.message).toContain('missing versions [4, 5, 6, 7, 8, 9]');
      });
    });

    it('refuses when DB is ahead of code (code rollback)', async () => {
      await withTestDb(async (pool) => {
        await pool.query("INSERT INTO schema_migrations (version, name) VALUES (999, '999-bogus.sql')");
        const err = await ensureSchemaVersion(pool).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SchemaVersionError);
        const sve = err as SchemaVersionError;
        expect(sve.kind).toBe('ahead');
        expect(sve.extra).toEqual([999]);
        expect(sve.message).toContain('ahead');
        expect(sve.message).toContain('999');
      });
    });

    it(
      'startup process exits 1 with error log listing missing versions (behind)',
      { timeout: 60_000 },
      async () => {
        await withTestDb(async (pool, handle) => {
          await pool.query('DELETE FROM schema_migrations WHERE version > 3');
          // 真实启动路径：index.ts 的版本门在 listen 之前退出
          const outcome: { stdout?: string; stderr?: string; code?: number } = await execFileAsync(
            'pnpm',
            ['exec', 'tsx', 'src/index.ts'],
            {
              cwd: process.cwd(),
              // 四个必填变量齐备：config 门不拦，让版本门（本次的被测对象）决定退出
              env: {
                ...process.env,
                DATABASE_URL: handle.connectionString,
                PORT: '3997',
                GATEWAY_URL: 'http://localhost:4100',
                AGENT_URL: 'http://localhost:4200',
              },
            },
          ).then(
            (r) => r,
            (e: { stdout?: string; stderr?: string; code?: number }) => e,
          );
          expect(outcome.code).toBe(1);
          const output = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`;
          expect(output).toContain('missing versions [4, 5, 6, 7, 8, 9]');
        });
      },
    );
  });
});
