// ws_event 保留窗口清理（T-P2-10；DES/02 §1.5「保留窗口默认 30 分钟，调度器删除过期行」、
// DES/08 §2.2 末尾）。注册名恒为 'ws-event-retention'；boot 在调度器注册表接线（index.ts）。
// 幂等条件 DELETE（宪法 §3-5：唯一性/幂等靠 DB）——重复触发只是多扫一次空集。
import type { Pool } from 'pg';
import { WS_EVENT_RETENTION_MINUTES } from '../constants.js';
import type { SchedulerScan } from '../scheduler/registry.js';

/** 调度器注册名（boot 接线处） */
export const WS_EVENT_RETENTION_SCAN_NAME = 'ws-event-retention';

export interface WsEventRetentionDeps {
  readonly pool: Pool;
}

/** 调度器扫描体：删除超过保留窗口的 ws_event 行；返回删除行数 */
export function createWsEventRetentionScan(
  deps: WsEventRetentionDeps,
  options: { retentionMinutes?: number } = {},
): SchedulerScan {
  const retentionMinutes = options.retentionMinutes ?? WS_EVENT_RETENTION_MINUTES;
  return async () => {
    const res = await deps.pool.query(
      "DELETE FROM ws_event WHERE created_at < now() - ($1 || ' minutes')::interval",
      [retentionMinutes],
    );
    return res.rowCount ?? 0;
  };
}
