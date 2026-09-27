// 崩溃测试子进程入口（T-P7-01）：`node --import tsx tests/helpers/crash-server-entry.ts`。
// 环境契约：PORT / DATABASE_URL / GATEWAY_URL / AGENT_URL（父进程注入随机端口+独立库）；
// CRASH_POINTS（可选，预 arm）/ CRASH_CONTROL=1（控制端点面）。
// 与场景环境同构：seed（boot 不做——CLI 职责）→ boot → 监听 → stdout 一行就绪哨兵。
import pino from 'pino';
import { Pool } from 'pg';
import { boot } from '../../src/index.js';
import { loadConfig } from '../../src/config/index.js';
import { seed } from '../../src/db/seed.js';

const config = loadConfig();

// seed 是 CLI 职责（boot 不做）：独立建连接跑 seed，跑完归还
const seedPool = new Pool({ connectionString: config.databaseUrl });
await seed(seedPool);
await seedPool.end();

const handle = await boot({ config, logger: pino({ level: 'silent' }) });
const address = handle.app.server.address();
const port = typeof address === 'object' && address !== null ? address.port : config.port;
process.stdout.write(`CRASH_CHILD_READY ${port}\n`);
