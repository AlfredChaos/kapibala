// unknown 判定器的调度器注册行（T-P3-03；DES/05 §2.4 + §8「判定器轮询而非常驻 timer」）。
// 本文件只做接线：每秒 tick 调 adjudicator.sweep()——扫 unknown_deadline_at<=now() 的行。
// 探测节拍（2s 起 500ms）由 deadline 字段驱动：判定器每轮把未决行的 deadline 顺到
// now()+PROBE_BACKOFF；tick 粒度是兜底节拍而非判定节奏（漏拍由下一 tick 补）。
// 注册名恒为 UNKNOWN_SETTLE_SCAN_NAME——重名即接线错误，registry.register 启动即拒。
import type { ScanRegistry } from './registry.js';
import {
  createUnknownAdjudicator,
  type AdjudicatorDeps,
} from '../modules/messages/adjudicator.js';

export const UNKNOWN_SETTLE_SCAN_NAME = 'unknown-settle';

export interface UnknownScanDeps extends Pick<AdjudicatorDeps, 'pool' | 'gateway' | 'logger' | 'wakeDispatcher'> {
  readonly registry: ScanRegistry;
}

/** boot 接线（index.ts 步骤 4）：registry.register('unknown-settle', 每秒扫到期 unknown) */
export function registerUnknownSettleScan(deps: UnknownScanDeps): void {
  const adjudicator = createUnknownAdjudicator({
    pool: deps.pool,
    gateway: deps.gateway,
    logger: deps.logger,
    wakeDispatcher: deps.wakeDispatcher,
  });
  deps.registry.register(UNKNOWN_SETTLE_SCAN_NAME, () => adjudicator.sweep());
}
