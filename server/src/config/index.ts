// 配置加载与校验（T-P0-04；变量表：DES/01 §6.1，与 server/.env.example 同源）。
// 缺失必填项 / 非法数值 → ConfigError（调用方记 error 日志后 exit(1)，见 src/index.ts）。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  AGENT_MAX_CONCURRENT_RUNS,
  AGENT_TURN_TIMEOUT_DEFAULT_MS,
  MEDIA_RETENTION_DAYS_DEFAULT,
  WS_EVENT_RETENTION_MINUTES,
} from '../constants.js';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  gatewayUrl: string;
  agentUrl: string;
  agentTurnTimeoutMs: number;
  agentMaxConcurrentRuns: number;
  mediaRetentionDays: number;
  wsEventRetentionMinutes: number;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

// dev 语义（AGENTS.md §1「读 .env」）：文件值不覆盖已存在的进程变量（显式 env 永远优先）
function loadDotEnvFile(): void {
  const path = fileURLToPath(new URL('../../.env', import.meta.url));
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (value !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}

// 可选数值字段：缺失/空串用默认值；给了但不是正整数 → 记 issue（默认值占位，最终仍会拒启）
function optionalPositiveInt(
  issues: string[],
  env: NodeJS.ProcessEnv,
  name: 'AGENT_TURN_TIMEOUT_MS' | 'AGENT_MAX_CONCURRENT_RUNS' | 'MEDIA_RETENTION_DAYS' | 'WS_EVENT_RETENTION_MINUTES',
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    issues.push(`${name} must be a positive integer (got '${raw}')`);
    return fallback;
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // 显式传入 env（测试）时不读 .env 文件；默认路径才补 dev 的 .env
  if (env === process.env) loadDotEnvFile();

  const issues: string[] = [];

  const portRaw = env.PORT;
  const port = portRaw === undefined ? Number.NaN : Number(portRaw);
  if (portRaw === undefined || portRaw === '') {
    issues.push('PORT is required');
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push(`PORT must be an integer in 1..65535 (got '${portRaw}')`);
  }
  for (const name of ['DATABASE_URL', 'GATEWAY_URL', 'AGENT_URL'] as const) {
    if (env[name] === undefined || env[name] === '') issues.push(`${name} is required`);
  }

  const agentTurnTimeoutMs = optionalPositiveInt(issues, env, 'AGENT_TURN_TIMEOUT_MS', AGENT_TURN_TIMEOUT_DEFAULT_MS);
  // 【解读】AGENT_TURN_TIMEOUT_MS 的契约区间 10–15s（QR §1）不在本任务收紧校验：
  // 区间常量归宿是 constants.ts（T-P0-05 封闭目录），消费语义归 agent client 任务串行补齐。
  const agentMaxConcurrentRuns = optionalPositiveInt(issues, env, 'AGENT_MAX_CONCURRENT_RUNS', AGENT_MAX_CONCURRENT_RUNS);
  const mediaRetentionDays = optionalPositiveInt(issues, env, 'MEDIA_RETENTION_DAYS', MEDIA_RETENTION_DAYS_DEFAULT);
  const wsEventRetentionMinutes = optionalPositiveInt(issues, env, 'WS_EVENT_RETENTION_MINUTES', WS_EVENT_RETENTION_MINUTES);

  if (issues.length > 0) throw new ConfigError(issues);

  // 到这里四项必填已保证非空；?? '' 仅为通过类型收窄，运行时不可达
  return {
    port,
    databaseUrl: env.DATABASE_URL ?? '',
    gatewayUrl: env.GATEWAY_URL ?? '',
    agentUrl: env.AGENT_URL ?? '',
    agentTurnTimeoutMs,
    agentMaxConcurrentRuns,
    mediaRetentionDays,
    wsEventRetentionMinutes,
  };
}
