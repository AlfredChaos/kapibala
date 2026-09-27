// 死信重试的调度器注册行（T-P2-04；DES/08 §1.4、DES/10 §3 扫描 6 的常驻形态）。
// 本文件只做接线：扫描体实现归 events/deadletter.ts（retryDeadLettersOnce / createDeadLetterScan），
// 注册名恒为 DEAD_LETTER_SCAN_NAME——重名即接线错误，registry.register 启动即拒（registry.ts）。
// 5s 节拍语义：调度器每 tick 调用本扫描，节流窗口在 createDeadLetterScan 内部
// （next_retry_at 到期判定才是真值；节流只省 DB 往返，正确性不依赖节拍命中）。
import type { Pool } from 'pg';
import {
  createDeadLetterScan,
  DEAD_LETTER_SCAN_NAME,
  type DeadLetterLogger,
} from '../events/deadletter.js';
import type { DispatchRegistry } from '../events/dispatch.js';
import type { ScanRegistry } from './registry.js';

export interface DeadLetterScanDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  readonly dispatch: DispatchRegistry;
  readonly logger: DeadLetterLogger;
}

/** boot 接线（index.ts 步骤 4）：registry.register('dead-letter', 5s 节流的重试扫描) */
export function registerDeadLetterScan(deps: DeadLetterScanDeps): void {
  deps.registry.register(
    DEAD_LETTER_SCAN_NAME,
    createDeadLetterScan({ pool: deps.pool, registry: deps.dispatch, logger: deps.logger }),
  );
}
