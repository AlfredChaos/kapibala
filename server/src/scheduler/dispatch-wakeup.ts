// 出站 dispatcher 兜底唤醒扫描（T-P3-02；DES/10 §2 表驱动、DES/05 §2.3）。
// 本文件只做接线：每秒 tick 扫出「有 queued AND first_attempt_at IS NULL」的账号集合，
// 逐个 wake(accountId)——dispatcher 内部的 advisory lock/闸门使重复唤醒幂等。
// 为什么需要：wake 事件只在进程内存在（accept.onAccepted / registerRateLimit 的
// wakeDispatcher 回调）；崩溃漏唤醒/锁让渡后补投，全靠这个 1s 周期的 DB 扫描兜底——
// 与全仓「意图在 DB、调度器只是加速器」纪律一致。
import type { Pool } from 'pg';
import type { ScanRegistry } from './registry.js';
import type { DispatcherLogger } from '../modules/messages/dispatcher.js';

export const DISPATCH_WAKEUP_SCAN_NAME = 'dispatch-wakeup';

export interface DispatchWakeupDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  readonly logger: DispatcherLogger;
  /** dispatcher.wake——出站 dispatcher 本体归 modules/messages/dispatcher.ts */
  readonly wake: (accountId: string) => void;
}

/** boot 接线（index.ts 步骤 4）：registry.register('dispatch-wakeup', 每秒扫待发账号) */
export function registerDispatchWakeupScan(deps: DispatchWakeupDeps): void {
  deps.registry.register(DISPATCH_WAKEUP_SCAN_NAME, async () => {
    const { rows } = await deps.pool.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM message
       WHERE delivery_status='queued' AND first_attempt_at IS NULL AND account_id IS NOT NULL`,
    );
    for (const row of rows) {
      deps.wake(row.account_id);
    }
    return rows.length;
  });
}
