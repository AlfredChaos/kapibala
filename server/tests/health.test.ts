// T-P0-04 c) 用例 2：/api/health 形状 + 统一错误形状（DES/01 §6.3/§6.4）。
// - health：`200 { ok: true, schemaVersion: <int> }`（= schema_migrations 最新版本，DES/02 §10）
// - 未知路由 / 未知异常：统一 `{ error: { code, message, requestId } }`；500 INTERNAL 且日志含 err stack。
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from './helpers/db.js';
import { buildApp } from '../src/http/app.js';
import { listMigrationFiles } from '../src/db/migrate.js';
import type { App } from '../src/http/app.js';

const CODE_LATEST = listMigrationFiles().at(-1)?.version ?? 0;

describe('GET /api/health + unified error shape', () => {
  let db: TestDbHandle;
  let app: App;
  let logLines: string[];

  beforeAll(async () => {
    db = await getTestDb();
    logLines = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logLines.push(chunk.toString('utf8'));
        cb();
      },
    });
    app = await buildApp({ pool: db.pool, logger: pino({ level: 'error' }, stream) });
    // 500 路径探针：抛出非 AppError 的未知异常
    app.get('/api/__boom', { config: { auth: 'public' } }, async () => {
      throw new Error('boom-for-test');
    });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('health returns ok + schemaVersion = latest applied migration', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, schemaVersion: CODE_LATEST });
  });

  it('health is anonymous (no Authorization header needed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('unknown route → unified 404 error shape with requestId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it('unknown exception → 500 INTERNAL with requestId and error log containing stack', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/__boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.message).toContain('boom-for-test');
    const logged = logLines.find((line) => line.includes('boom-for-test'));
    expect(logged).toBeDefined();
    expect(logged).toContain('stack'); // pino 序列化的 err 对象含 stack（DES/01 §6.3）
  });

  it('X-Request-ID is passed through to response header and error body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/definitely-not-a-route',
      headers: { 'x-request-id': 'rid-fixed-123' },
    });
    expect(res.headers['x-request-id']).toBe('rid-fixed-123');
    const body = res.json() as { error: { requestId: string } };
    expect(body.error.requestId).toBe('rid-fixed-123');
  });

  it('requests without X-Request-ID get a generated one', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    const body = res.json() as { error: { requestId: string } };
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/); // uuid v4
  });
});
