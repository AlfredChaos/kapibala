// 限流到期恢复的调度器注册行（T-P2-07；DES/03 §5.3 的常驻形态）。
// 本文件只做接线：扫描体实现归 modules/accounts/rate-limit.ts（createRateLimitExpiryScan），
// 注册名恒为 RATE_LIMIT_SCAN_NAME——重名即接线错误，registry.register 启动即拒。
// 每秒 tick 语义：调度器每轮调用本扫描，条件 UPDATE WHERE status='rate_limited'
// AND until<=now() 是真值（命中空集即空转）；到期转移不依赖节拍命中。
// wakeDispatcher 缝：出站 dispatcher（T-P3-02）落地前缺省无唤醒——恢复转移本身照常发生，
// queued 消息由 dispatcher 自己的轮询节奏拾取（DB 为真值，唤醒只是加速器）。
import type { Pool } from 'pg';
import {
  createRateLimitExpiryScan,
  RATE_LIMIT_SCAN_NAME,
  type RateLimitLogger,
} from '../modules/accounts/rate-limit.js';
import type { ScanRegistry } from './registry.js';

export interface RateLimitScanDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  readonly logger: RateLimitLogger;
  /** 唤醒出站 dispatcher 重发该账号 queued（T-P3-02 接线；缺省 = 无唤醒） */
  readonly wakeDispatcher?: (accountId: string) => void;
}

/** boot 接线（index.ts 步骤 4）：registry.register('rate-limit-expiry', 到期恢复扫描) */
export function registerRateLimitScan(deps: RateLimitScanDeps): void {
  deps.registry.register(
    RATE_LIMIT_SCAN_NAME,
    createRateLimitExpiryScan({
      pool: deps.pool,
      logger: deps.logger,
      wakeDispatcher: deps.wakeDispatcher,
    }),
  );
}
