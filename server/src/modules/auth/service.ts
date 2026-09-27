// 认证领域服务（T-P0-07；DES/09 §2–§3、DES/02 §2）。
// 分层：本文件只做 DB 逻辑，返回判别联合（ok/deny），不抛 HTTP 语义错误——
// AppError/HTTP 映射归 http 层（routes/auth.ts），保持 modules → db 的依赖方向（DES/01 §2）。
// 关键不变量（B3）：
// - 轮换 = 单事务 {旧 refresh → used(条件更新 status='active') + 新 refresh(g+1) + 新 access(g+1) + session.current_generation=g+1}；
// - 复用检测（旧 token 再现，含并发重放）= 单事务把 session → revoked + 其全部 active/used token → revoked；
// - logout = 单事务 session → logged_out + 全部 token → revoked → 同一 access 立即失效。
import { randomUUID } from 'node:crypto';
import { compareSync } from 'bcryptjs';
import type { Pool, PoolClient } from 'pg';
import { tx } from '../../db/tx.js';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from '../../constants.js';
import { generateToken, hashToken } from './tokens.js';

// TTL 常量换算为秒（SQL now() + make_interval(secs => n)，DB 时钟为真值）
const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_MS / 1000; // 900s = 15min（QR §1）
const REFRESH_TOKEN_TTL_SECONDS = REFRESH_TOKEN_TTL_MS / 1000; // 604800s = 7d【设计值】

// 用户不存在时也对固定哈希做一次 compare，避免响应时间泄露用户存在性（DES/09 §5）
const DUMMY_BCRYPT_HASH = '$2b$10$A9S0Ls6m4y5YMWEASh8aGeISuPKf4g2mil43OQFZ8rxdXwTFee.IG';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'viewer';
}

interface RefreshTokenRow {
  id: string;
  session_id: string;
  status: string;
  expires_at: Date;
  generation: number;
  session_status: string;
}

export interface LoginSuccess {
  status: 'ok';
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  user: { id: string; username: string; role: 'admin' | 'viewer' };
}

export type Deny = { status: 'deny' };

export interface RefreshSuccess {
  status: 'ok';
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
}

interface TokenInsert {
  token: string;
  expiresAt: Date;
}

async function insertToken(
  client: PoolClient,
  sessionId: string,
  kind: 'access' | 'refresh',
  generation: number,
  ttlSeconds: number,
): Promise<TokenInsert> {
  const token = generateToken();
  const { rows } = await client.query<{ expires_at: Date }>(
    `INSERT INTO auth_token (id, session_id, kind, token_hash, generation, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'active', now() + make_interval(secs => $6))
     RETURNING expires_at`,
    [randomUUID(), sessionId, kind, hashToken(token), generation, ttlSeconds],
  );
  const expiresAt = rows[0]?.expires_at;
  if (!expiresAt) throw new Error(`insert auth_token (${kind}) returned no expires_at`);
  return { token, expiresAt };
}

/** 复用检测 / 登出的共同收口：session 终态 + 其全部 active/used token 吊销（B3 整会话失效） */
async function revokeAllTokens(
  pool: Pool,
  sessionId: string,
  sessionStatus: 'revoked' | 'logged_out',
): Promise<void> {
  await tx(pool, async (client) => {
    await client.query('UPDATE auth_session SET status = $2, ended_at = now() WHERE id = $1', [
      sessionId,
      sessionStatus,
    ]);
    await client.query(
      "UPDATE auth_token SET status = 'revoked' WHERE session_id = $1 AND status IN ('active','used')",
      [sessionId],
    );
  });
}

export async function login(pool: Pool, credentials: { username: string; password: string }): Promise<LoginSuccess | Deny> {
  const { rows } = await pool.query<UserRow>(
    'SELECT id, username, password_hash, role FROM app_user WHERE username = $1',
    [credentials.username],
  );
  const user = rows[0];
  if (!user) {
    compareSync(credentials.password, DUMMY_BCRYPT_HASH); // 恒时失败
    return { status: 'deny' };
  }
  if (!compareSync(credentials.password, user.password_hash)) return { status: 'deny' };

  const sessionId = randomUUID();
  const issued = await tx(pool, async (client) => {
    await client.query('INSERT INTO auth_session (id, user_id) VALUES ($1, $2)', [sessionId, user.id]);
    const refresh = await insertToken(client, sessionId, 'refresh', 0, REFRESH_TOKEN_TTL_SECONDS);
    const access = await insertToken(client, sessionId, 'access', 0, ACCESS_TOKEN_TTL_SECONDS);
    return { refresh, access };
  });
  return {
    status: 'ok',
    accessToken: issued.access.token,
    accessExpiresAt: issued.access.expiresAt,
    refreshToken: issued.refresh.token,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

export async function refresh(pool: Pool, refreshToken: string): Promise<RefreshSuccess | Deny> {
  const { rows } = await pool.query<RefreshTokenRow>(
    `SELECT t.id, t.session_id, t.status, t.expires_at, t.generation, s.status AS session_status
     FROM auth_token t JOIN auth_session s ON s.id = t.session_id
     WHERE t.token_hash = $1 AND t.kind = 'refresh'`,
    [hashToken(refreshToken)],
  );
  const row = rows[0];
  if (!row) return { status: 'deny' };
  if (row.status === 'used') {
    // 复用检测（B3）：整会话作废（含此前轮换出的新 refresh / 新 access）
    await revokeAllTokens(pool, row.session_id, 'revoked');
    return { status: 'deny' };
  }
  if (row.status !== 'active') return { status: 'deny' }; // revoked / expired
  if (row.expires_at.getTime() <= Date.now()) return { status: 'deny' };
  if (row.session_status !== 'active') return { status: 'deny' };

  const rotated = await tx(pool, async (client) => {
    // 并发轮换：条件更新 status='active'，恰好一个 rowcount=1（DES/09 §3.2）
    const claimed = await client.query(
      "UPDATE auth_token SET status = 'used', used_at = now() WHERE id = $1 AND status = 'active'",
      [row.id],
    );
    if ((claimed.rowCount ?? 0) === 0) return { rotated: false as const };
    const nextGeneration = row.generation + 1;
    const newRefresh = await insertToken(client, row.session_id, 'refresh', nextGeneration, REFRESH_TOKEN_TTL_SECONDS);
    const newAccess = await insertToken(client, row.session_id, 'access', nextGeneration, ACCESS_TOKEN_TTL_SECONDS);
    await client.query('UPDATE auth_session SET current_generation = $2 WHERE id = $1', [
      row.session_id,
      nextGeneration,
    ]);
    return { rotated: true as const, newRefresh, newAccess };
  });
  if (!rotated.rotated) {
    // 并发败者：重放视同复用（DES/09 §3.2 并发细节）
    await revokeAllTokens(pool, row.session_id, 'revoked');
    return { status: 'deny' };
  }
  return {
    status: 'ok',
    accessToken: rotated.newAccess.token,
    accessExpiresAt: rotated.newAccess.expiresAt,
    refreshToken: rotated.newRefresh.token,
  };
}

export async function logout(pool: Pool, sessionId: string): Promise<void> {
  await revokeAllTokens(pool, sessionId, 'logged_out');
}

export interface VerifiedAccess {
  userId: string;
  role: 'admin' | 'viewer';
  sessionId: string;
}

/** access 验证（DES/09 §3.1 note）：查表 + status='active' + 未过期 + session 仍 active */
export async function verifyAccessToken(pool: Pool, token: string): Promise<VerifiedAccess | null> {
  const { rows } = await pool.query<{ user_id: string; role: 'admin' | 'viewer'; session_id: string }>(
    `SELECT u.id AS user_id, u.role, t.session_id
     FROM auth_token t
     JOIN auth_session s ON s.id = t.session_id
     JOIN app_user u ON u.id = s.user_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.status = 'active'
       AND t.expires_at > now() AND s.status = 'active'
     LIMIT 1`,
    [hashToken(token)],
  );
  const row = rows[0];
  return row ? { userId: row.user_id, role: row.role, sessionId: row.session_id } : null;
}
