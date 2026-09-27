// 启动版本门（T-P0-04；DES/01 §6.4、DES/02 §1.1）。
// 为什么落后与超前【都】拒绝启动：
// - 落后：代码已依赖新版本 schema（新列/新约束/新索引缺失），继续跑要么运行时报错，
//   要么更糟——静默产生错误数据（例如缺部分唯一索引 → 每群单飞行失效）。处置：先跑 db:migrate。
// - 超前：代码回滚后，旧逻辑面对新 schema（更严的 CHECK / 新的非空列），同样属于「代码与 schema 漂移」。
// 共同本质是 DB 形态与代码假设不一致；宁可拒启，不冒静默数据损坏的风险（宪法 §3-5：真值在 DB）。
import type { Pool } from 'pg';
import { getAppliedVersions, listMigrationFiles } from './migrate.js';

export class SchemaVersionError extends Error {
  constructor(
    public readonly kind: 'behind' | 'ahead',
    public readonly dbLatest: number,
    public readonly codeLatest: number,
    public readonly missing: number[],
    public readonly extra: number[],
  ) {
    super(
      kind === 'behind'
        ? `database schema is behind code: missing versions [${missing.join(', ')}] (db latest ${dbLatest}, code latest ${codeLatest}); run 'pnpm -F server db:migrate' first`
        : `database schema is ahead of code: extra versions [${extra.join(', ')}] (db latest ${dbLatest}, code latest ${codeLatest}); code rollback suspected`,
    );
    this.name = 'SchemaVersionError';
  }
}

/** 校验 DB 版本与迁移文件一致；一致时返回最新版本号（/api/health 的 schemaVersion 同源）。 */
export async function ensureSchemaVersion(
  pool: Pool,
  files = listMigrationFiles(),
): Promise<number> {
  const codeVersions = files.map((f) => f.version);
  const codeLatest = codeVersions.at(-1) ?? 0;
  const dbVersions = await getAppliedVersions(pool);
  const dbLatest = dbVersions.at(-1) ?? 0;
  // 动态成员判定（来自 DB / 文件系统，非静态字面量表）
  const dbSet = new Set(dbVersions);
  const codeSet = new Set(codeVersions);
  const missing = codeVersions.filter((v) => !dbSet.has(v));
  const extra = dbVersions.filter((v) => !codeSet.has(v));
  if (missing.length > 0) throw new SchemaVersionError('behind', dbLatest, codeLatest, missing, extra);
  if (extra.length > 0) throw new SchemaVersionError('ahead', dbLatest, codeLatest, missing, extra);
  return dbLatest;
}
