// 崩溃注入极薄 hook（T-P7-01；DES/10 §5「崩溃注入」行、DES/14 §7）。
// 生产路径只调 `checkCrashPoint(name)`：进程环境 `CRASH_POINTS`（逗号分隔，可加 `@N`
// 限定第 N 次命中才崩；TEST_COUNT=当前位）或 `CRASH_CONTROL=1` 时经
// `POST /_test/crash` 运行时装配——两者都只服务测试，默认全开关=零成本返回。
// 命中即 `process.exit(9)`（9 = 注入崩溃哨兵码，与信号/SIGINT 区分），同步调用、
// 不抛异常——调用点不需要任何崩溃感知逻辑（never pollute prod paths）。
import { setTimeout as sleep } from 'node:timers/promises';

const ENV_POINTS = 'CRASH_POINTS';
const ENV_CONTROL = 'CRASH_CONTROL';
const ENV_DELAY = 'CRASH_DELAY_MS';
const EXIT_CODE = 9;

/** 已 arm 的点名 -> 剩余命中次数（@N 语义；缺省 1）。控制端点/环境双通道共用。 */
const armed = new Map<string, number>();
const parsed = new Set<string>();

function parseEnv(): void {
  // 进程内只解析一次；运行时装配走 armCrashPoint（控制端点）
  const raw = process.env[ENV_POINTS];
  if (raw === undefined || parsed.has('done')) return;
  parsed.add('done');
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split('@');
    const name = parts[0] ?? '';
    const hit = parts[1];
    if (name === '') continue;
    const n = hit === undefined ? 1 : Number.parseInt(hit, 10);
    armed.set(name, Number.isFinite(n) && n > 0 ? n : 1);
  }
}

/**
 * 装配崩溃点（测试控制面）。`hit` = 第几次命中才崩（1 = 立即）。
 * 可在运行中随时装配（控制端点调用）；`CRASH_CONTROL=1` 时才暴露 HTTP 面。
 */
export function armCrashPoint(name: string, hit = 1): void {
  armed.set(name, hit);
}

/** 是否启用控制端点（仅在 index.ts 装配期读一次）。 */
export function crashControlEnabled(): boolean {
  return process.env[ENV_CONTROL] === '1';
}

/**
 * 崩溃点检查（薄 hook）。命中 → `process.exit(9)`（可配 CRASH_DELAY_MS 让「外部调用
 * 已发出/响应在途」窗口变宽）。未命中零分配返回（热路径成本 = 一次 Map 查找）。
 */
export function checkCrashPoint(name: string): void {
  parseEnv();
  const remaining = armed.get(name);
  if (remaining === undefined) return;
  armed.set(name, remaining - 1);
  if (remaining - 1 > 0) return; // 还没到第 N 次
  const delay = process.env[ENV_DELAY];
  const ms = delay === undefined ? 0 : Number.parseInt(delay, 10);
  if (Number.isFinite(ms) && ms > 0) {
    // 同步退出前的小延迟（「已发出」窗口）——仍走 process.exit，只是延后
    void sleep(ms).then(() => process.exit(EXIT_CODE));
    return;
  }
  process.exit(EXIT_CODE);
}
