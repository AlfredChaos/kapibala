// 序列链推进扫描的调度器注册行（T-P6-03；DES/07 §3.2 SWEEP 框：每秒扫到期链头）。
// 注册名恒为 SEQUENCE_SCAN_NAME——重名即接线错误，registry.register 启动即拒。
// 到期条件 = DB 时间戳（scheduled_at<=now()）；扫描只是加速器（DES/01 §4.6）。
import type { Pool } from 'pg';
import type { ScanRegistry } from './registry.js';
import { runSequenceScheduler } from '../modules/sequences/scheduler.js';

export const SEQUENCE_SCAN_NAME = 'sequence-chain';

export interface SequenceScanDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  /** 出站唤醒缝；缺省 = dispatch-wakeup 扫描兜底 */
  readonly wakeDispatcher?: (accountId: string) => void;
}

export function registerSequenceScan(deps: SequenceScanDeps): void {
  deps.registry.register(SEQUENCE_SCAN_NAME, () =>
    runSequenceScheduler({ pool: deps.pool, wakeDispatcher: deps.wakeDispatcher }));
}
