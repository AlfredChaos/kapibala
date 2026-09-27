// 测试库隔离基建（T-P0-04，DAG 规则 5）：每个测试文件独立 database（随机后缀），worker 间不争用。
// 形态：一次性建「模板库」（跑全量迁移）+ 每个测试文件 CREATE DATABASE ... TEMPLATE 克隆，teardown DROP。
// 模板库跨 worker 复用：创建/校验由 advisory lock 串行（宪法 §3-5：唯一性靠数据库，不靠进程内存时序）。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Pool } from 'pg';
import { listMigrationFiles, migrate } from '../../src/db/migrate.js';

export { migrate as migrateTestDb } from '../../src/db/migrate.js';

export interface TestDbHandle {
  /** 随机后缀的独立测试库名 */
  readonly name: string;
  readonly pool: Pool;
  /** 指向该库的连接串（spawn 子进程用，如版本门拒启用例） */
  readonly connectionString: string;
  close(): Promise<void>;
}

const TEMPLATE_NAME = 'kapibala_test_template';

function resolveBaseUrl(): string {
  // 显式 env 优先；其次 server/.env（与 src/config/ 的 dev 语义一致）；都没有 → 明确报错
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const dotEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(dotEnvPath)) {
    const env = parseEnv(readFileSync(dotEnvPath, 'utf8'));
    if (env.DATABASE_URL) return env.DATABASE_URL;
  }
  throw new Error(
    'DATABASE_URL is not set: export it or create server/.env (see server/.env.example) before running tests',
  );
}

// 库名替换（连接串其余部分：主机/端口/用户/密码原样保留）；三处调用点锁步行为
function replaceDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function withMaintenance<T>(fn: (client: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: replaceDatabase(resolveBaseUrl(), 'postgres'), max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function templateVersion(baseUrl: string): Promise<number> {
  const pool = new Pool({ connectionString: replaceDatabase(baseUrl, TEMPLATE_NAME), max: 1 });
  try {
    const { rows } = await pool.query<{ v: number }>(
      'SELECT COALESCE(max(version), 0)::int AS v FROM schema_migrations',
    );
    return rows[0]?.v ?? 0;
  } finally {
    await pool.end();
  }
}

/** 模板库就绪（存在且已应用到代码最新版本）；过期则重建。advisory lock 保证多 worker 串行。 */
async function ensureTemplate(codeLatest: number): Promise<void> {
  const base = resolveBaseUrl();
  await withMaintenance(async (pool) => {
    const client = await pool.connect();
    try {
      // 会话级 advisory lock：跨 worker 的「检查 + 重建」临界区（DAG 规则 5：worker 间不争用）
      await client.query("SELECT pg_advisory_lock(hashtext('kapibala:test:template'))");
      const { rows } = await client.query<{ ok: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS ok',
        [TEMPLATE_NAME],
      );
      let fresh = false;
      if (rows[0]?.ok === true) {
        fresh = (await templateVersion(base)) === codeLatest;
        if (!fresh) {
          // 迁移目录前进而模板落后（开发期常态）→ 强制重建；FORCE 踢掉遗留连接
          await client.query(`DROP DATABASE ${TEMPLATE_NAME} WITH (FORCE)`);
        }
      }
      if (!fresh) {
        await client.query(`CREATE DATABASE ${TEMPLATE_NAME}`);
        const templatePool = new Pool({
          connectionString: replaceDatabase(base, TEMPLATE_NAME),
          max: 1,
        });
        try {
          await migrate(templatePool);
        } finally {
          await templatePool.end();
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('kapibala:test:template'))");
      client.release();
    }
  });
}

async function createTestDatabase(options: { fromTemplate: boolean }): Promise<TestDbHandle> {
  const base = resolveBaseUrl();
  const latest = listMigrationFiles().at(-1);
  if (!latest) throw new Error('no migration files found under server/migrations');
  if (options.fromTemplate) await ensureTemplate(latest.version);
  const name = `kapibala_test_${randomBytes(4).toString('hex')}`;
  const suffix = options.fromTemplate ? ` TEMPLATE ${TEMPLATE_NAME}` : '';
  await withMaintenance((pool) => pool.query(`CREATE DATABASE ${name}${suffix}`));
  const connectionString = replaceDatabase(base, name);
  const pool = new Pool({ connectionString });
  return {
    name,
    pool,
    connectionString,
    async close() {
      await pool.end();
      await withMaintenance((m) => m.query(`DROP DATABASE ${name} WITH (FORCE)`));
    },
  };
}

/** 独立测试库（已按模板应用全量迁移）——常规行为测试用。 */
export function getTestDb(): Promise<TestDbHandle> {
  return createTestDatabase({ fromTemplate: true });
}

/** 空白独立测试库（未迁移）——迁移 runner 自身的测试用。 */
export function getBareTestDb(): Promise<TestDbHandle> {
  return createTestDatabase({ fromTemplate: false });
}

/** 一次性建库 → 跑用例 → 拆库的便捷包装。 */
export async function withTestDb(
  fn: (pool: Pool, handle: TestDbHandle) => Promise<void>,
  options: { fromTemplate?: boolean } = {},
): Promise<void> {
  const handle = await createTestDatabase({ fromTemplate: options.fromTemplate ?? true });
  try {
    await fn(handle.pool, handle);
  } finally {
    await handle.close();
  }
}
