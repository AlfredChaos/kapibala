// GET /api/health（DES/01 §6.4）：`{ ok: true, schemaVersion }`，schemaVersion = schema_migrations
// 最新版本（DES/02 §10）。匿名（auth: 'public'）；随 HTTP 监听即可用，不等 SSE 追平（D3-2）。
import type { App } from '../app.js';
import type { RouteDeps } from './index.js';

export async function registerHealthRoutes(app: App, deps: RouteDeps): Promise<void> {
  app.get(
    '/api/health',
    { config: { auth: 'public' } },
    async () => {
      const { rows } = await deps.pool.query<{ schema_version: number }>(
        'SELECT COALESCE(max(version), 0)::int AS schema_version FROM schema_migrations',
      );
      return { ok: true, schemaVersion: rows[0]?.schema_version ?? 0 };
    },
  );
}
