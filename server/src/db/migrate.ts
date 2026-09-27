// 自研迁移 runner（T-P0-04；DES/01 §6.4「约 100 行」、DES/02 §1.1/§10）。
// 语义：按版本序应用未执行的迁移文件，每个文件一个事务内「执行 SQL + 记 schema_migrations 版本」
// 原子完成；已应用版本跳过 → 可重复执行（A0）。SQL 文件本身不做幂等（由 runner 的只跑一次保证）。
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { loadConfig } from '../config/index.js';
import { createPool } from './pool.js';
import { tx } from './tx.js';

export interface MigrationFile {
  version: number;
  /** 文件名（含扩展名，如 001-infra.sql）——schema_migrations.name 的记录值 */
  name: string;
  path: string;
  sql: string;
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const MIGRATION_FILE_PATTERN = /^(\d{3})-(.+)\.sql$/;

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();
  const files = names.map((name) => {
    const version = Number(MIGRATION_FILE_PATTERN.exec(name)?.[1]);
    return { version, name, path: `${dir}/${name}`, sql: readFileSync(`${dir}/${name}`, 'utf8') };
  });
  // 版本号必须恰为 1..N 连续无空洞无重复（任务卡 d；DES/02 §10「只增不改」的目录封闭前提）
  for (const [i, file] of files.entries()) {
    if (file.version !== i + 1) {
      throw new Error(`migration versions must be contiguous 1..N: got ${file.version} at position ${i + 1} (${file.name})`);
    }
  }
  return files;
}

export async function getAppliedVersions(db: Pool | PoolClient): Promise<number[]> {
  // schema_migrations 本身由 001 创建：表不存在 = 空库 → 空集（首个迁移事务里建表+记版本）
  const exists = await db.query<{ ok: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS ok",
  );
  if (exists.rows[0]?.ok !== true) return [];
  const applied = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return applied.rows.map((row) => row.version);
}

export async function migrate(
  pool: Pool,
  files: MigrationFile[] = listMigrationFiles(),
): Promise<{ applied: number[]; appliedNames: string[] }> {
  const appliedSet = new Set(await getAppliedVersions(pool));
  const newlyApplied: number[] = [];
  const newlyAppliedNames: string[] = [];
  for (const file of files) {
    if (appliedSet.has(file.version)) continue;
    // 「执行 + 记版本」同事务：半途崩溃两者皆不存在 → 重启重跑；这是可重复执行的根基
    await tx(pool, async (client) => {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        file.version,
        file.name,
      ]);
    });
    newlyApplied.push(file.version);
    newlyAppliedNames.push(file.name);
  }
  return { applied: newlyApplied, appliedNames: newlyAppliedNames };
}

// —— CLI 入口：pnpm -F server db:migrate（package.json 预注册，AGENTS.md §1）——
async function runCli(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: 1 });
  try {
    const { applied, appliedNames } = await migrate(pool);
    if (applied.length === 0) {
      console.log('no pending migrations');
    } else {
      appliedNames.forEach((name, i) => console.log(`applied migration v${applied[i]}: ${name}`));
    }
  } finally {
    await pool.end();
  }
}

// 直接执行本文件时才跑 CLI（被 import 时不跑）——argv[1] 经 realpath 归一后与 import.meta.url 比对
function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runCli().catch((err: unknown) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
}
