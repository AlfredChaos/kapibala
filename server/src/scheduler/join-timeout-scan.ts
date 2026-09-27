// member_joined 10s 超时的调度器注册行（T-P3-06；DES/04 §2.2 TMO 支路、A2）。
// 本文件只做接线：扫描体归 modules/groups/create-job-branches.ts（runJoinTimeoutScan）。
// 注册名恒为 JOIN_TIMEOUT_SCAN_NAME——重名即接线错误，registry.register 启动即拒。
// 每 tick 全量条件 UPDATE 命中空集即空转；执行器存活期间自身轮询已到点收口（更快），
// 本扫描承接执行器崩溃后 waiting_joins 的超时兜底（恢复后 deadline 不重置）。
import type { Pool } from 'pg';
import {
  JOIN_TIMEOUT_SCAN_NAME,
  runJoinTimeoutScan,
} from '../modules/groups/create-job-branches.js';
import type { ScanRegistry } from './registry.js';

export interface JoinTimeoutScanDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
}

/** boot 接线（index.ts 步骤 4）：registry.register('join-timeout', 超时收口扫描) */
export function registerJoinTimeoutScan(deps: JoinTimeoutScanDeps): void {
  deps.registry.register(JOIN_TIMEOUT_SCAN_NAME, () => runJoinTimeoutScan({ pool: deps.pool }));
}
