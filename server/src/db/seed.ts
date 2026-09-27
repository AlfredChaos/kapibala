// seed（T-P0-06；DES/02 §10、DES/09 §5、REQ §2.1）：
// - app_user 恰两行：admin/admin、viewer/viewer（密码=用户名，笔试约定；生产不可用），
//   bcrypt cost 10，只落哈希；T-P0-07 的 login 测试以同一约定取密码。
// - account 恰四行：acc-01..acc-04，status='idle'、platform_user_id=NULL（REQ §2.1 预置账号行）。
// 幂等靠 INSERT ... ON CONFLICT DO NOTHING（卡片 d：禁止先查后插）；重跑 rowcount=0 → no-op。
// 明文密码不打印、不落库、不进日志（宪法 §5）。
import { hashSync } from 'bcryptjs';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { loadConfig } from '../config/index.js';
import { createPool } from './pool.js';

// bcrypt cost 10（DES/09 §5）
const BCRYPT_COST = 10;

/** 预置用户（用户名即密码，DES/09 §5 笔试约定） */
const SEED_USERS: ReadonlyArray<{ username: string; role: 'admin' | 'viewer' }> = [
  { username: 'admin', role: 'admin' },
  { username: 'viewer', role: 'viewer' },
];

/** 预置服务账号（REQ §2.1：初始 status = idle、platformUserId = null） */
const SEED_ACCOUNT_IDS = ['acc-01', 'acc-02', 'acc-03', 'acc-04'] as const;

export interface SeedResult {
  insertedUsers: number;
  insertedAccounts: number;
}

export async function seed(pool: Pool): Promise<SeedResult> {
  let insertedUsers = 0;
  for (const user of SEED_USERS) {
    const hash = hashSync(user.username, BCRYPT_COST);
    const result = await pool.query(
      'INSERT INTO app_user (username, password_hash, role) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
      [user.username, hash, user.role],
    );
    insertedUsers += result.rowCount ?? 0;
  }

  let insertedAccounts = 0;
  for (const id of SEED_ACCOUNT_IDS) {
    const result = await pool.query(
      'INSERT INTO account (id, status, platform_user_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, 'idle', null],
    );
    insertedAccounts += result.rowCount ?? 0;
  }

  return { insertedUsers, insertedAccounts };
}

// —— CLI 入口：pnpm -F server db:seed（package.json 预注册，AGENTS.md §1）——
// 幂等语义：已存在的行（含手工改过密码的）一律不动，只补缺失行。
async function runCli(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: 1 });
  try {
    const { insertedUsers, insertedAccounts } = await seed(pool);
    console.log(`seed done: inserted ${insertedUsers} users, ${insertedAccounts} accounts (missing rows only)`);
  } finally {
    await pool.end();
  }
}

// 直接执行本文件时才跑 CLI（被 import 时不跑）；判定方式与 db/migrate.ts 相同
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
    console.error('seed failed:', err);
    process.exit(1);
  });
}
