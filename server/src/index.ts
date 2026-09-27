// server 入口（T-P0-04 重写 T-P0-01 占位）。启动时序（DES/01 §7）：
//   1. 连接 + 迁移版本门：落后/超前都拒绝启动（为什么两个方向都拒 → db/ensure-schema.ts 头注）
//   2. [T-P2-02 接线点] 恢复扫描登记 → SSE 消费异步启动 → 调度器——都在 listen 之前插入；
//      登记完成即监听（D3-2：/api/health 随监听即可用，不等 SSE 追平，进度由常驻组件按 DB 真值追赶）
//   3. HTTP 监听（最后；「先恢复世界一致性，再开放流量」）
// 迁移本身不在此执行：由 `pnpm -F server db:migrate` 显式先行（AGENTS.md §1），
// 入口只做「代码版本 == DB 版本」的守门。
import pino from 'pino';
import { ConfigError, loadConfig } from './config/index.js';
import { createPool } from './db/pool.js';
import { ensureSchemaVersion } from './db/ensure-schema.js';
import { buildApp } from './http/app.js';

const logger = pino();

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const schemaVersion = await ensureSchemaVersion(pool); // 不匹配 → throw → 下方 catch → exit(1)
  logger.info({ schemaVersion, port: config.port }, 'schema version verified, starting http server');

  const app = await buildApp({ pool });
  // —— [T-P2-02 接线点] 恢复登记 / SSE 异步消费 / 调度器，插在 listen 之前 ——
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    logger.error({ issues: err.issues }, 'invalid configuration, refusing to start');
  } else {
    // 版本门拒绝也走这里：err.message 列出缺失/多余版本（English，DES/01 §6.2）
    logger.error({ err }, 'startup failed');
  }
  process.exit(1);
});
