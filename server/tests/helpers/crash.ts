// 崩溃注入测试助手（T-P7-01；DES/10 §5「withCrashPoint」+ DES/14 §7）。
// 形态：withCrashPoint(handle, name, fn) → `/_test/crash` arm → fn 触发 →
//   断言子进程 exit 9 + fn 的连接级错误被吸收（崩溃本身就是被测对象）。
// 恢复断言通用器 assertPostCrashHealth：restart 后 /api/health + mock counters 可达，
//   供每类崩溃用例后接「DB 状态」断言（具体不变量由用例断言）。
import type { CrashServerHandle } from './server-process.js';
import { CRASH_EXIT_CODE } from './server-process.js';

export interface GatewayCounters {
  readonly sendCallsByAccount: Record<string, number>;
  readonly sendCallsByClientMsgId: Record<string, number>;
  readonly landedMessages: number;
  readonly kickCalls: number;
  readonly framesEmitted: number;
}

/** mock-gateway 计数面快照（重启后不变量断言的输入之一）。 */
export async function crashGatewayCounters(handle: CrashServerHandle): Promise<GatewayCounters> {
  const res = await fetch(`${handle.gatewayUrl}/_test/counters`);
  if (!res.ok) throw new Error(`gateway counters: ${res.status}`);
  return (await res.json()) as GatewayCounters;
}

/**
 * DES/10 §5 `withCrashPoint(name, fn)`：
 *  1) `POST /_test/crash` arm `name`（第 `hit` 次命中才崩，默认 1）；
 *  2) 执行 `fn`——崩溃导致的连接错误被吸收（用例只关心进程退出，不关心请求返回）；
 *  3) 断言子进程以哨兵码 9 退出（非 9 = 未崩/信号杀 → 测试红）。
 * 返回 fn 的错误（若有）；成功分支返回 undefined。
 */
export async function withCrashPoint(
  handle: CrashServerHandle,
  name: string,
  fn: () => Promise<unknown>,
  options: { hit?: number } = {},
): Promise<unknown> {
  const token = await handle.login();
  const arm = await fetch(`${handle.baseUrl}/_test/crash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, hit: options.hit ?? 1 }),
  });
  if (!arm.ok) throw new Error(`arm crash point failed: ${arm.status} ${await arm.text()}`);

  let fnError: unknown;
  try {
    await fn();
  } catch (err) {
    fnError = err; // 崩溃断链是预期路径——不吞非崩溃错误，由用例自行判
  }
  const code = await Promise.race<number | null>([
    handle.awaitExit(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
  ]);
  if (code !== CRASH_EXIT_CODE) {
    throw new Error(`expected crash exit code ${CRASH_EXIT_CODE}, got ${String(code)} (point=${name}, fnError=${String(fnError)})`);
  }
  return fnError;
}

/**
 * 崩溃后通用断言器：restart → `/api/health` 200 + mock counters 可达。
 * 不变量（I1–I14 级）由用例随后对 DB / counters 断言——本函数只收口「进程可重启、
 * 外部依赖仍可达、库与 mock 仍同一实例」这条公共前置。
 */
export async function assertPostCrashHealth(handle: CrashServerHandle): Promise<GatewayCounters> {
  await handle.restart();
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${handle.baseUrl}/api/health`);
      if (res.ok) break;
    } catch {
      // 未就绪
    }
    if (Date.now() > deadline) throw new Error('restarted server not healthy in 15s');
    await new Promise((r) => setTimeout(r, 50));
  }
  return crashGatewayCounters(handle);
}
