// 孤儿 agent run 观测扫描的调度器注册行（T-P4-12；DES/06 §9.4 O1 裁剪后形态逐字）。
// O1 定稿：租约过期仍 running = executor 挂死的信号——本扫描只做**观测**：
//   error 日志（runId / claimed_by / 挂起时长）+ ws_event inconsistency{kind:'orphan_run', ref:runId}
//   「同一 run 只推一次」——去重闸是 ws_event 自身（payload ref=runId 已推过即不再插）。
// **不做** pg_terminate_backend 强杀 / 自动接管（O1 删除的 exotic 编排）：
// 处置 = 重启进程 → §9.1 恢复扫描接管（wall_deadline_at 按剩余预算重锚）。
// 注册名恒为 ORPHAN_RUN_SCAN_NAME——重名即接线错误，registry.register 启动即拒。
import type { Pool } from 'pg';
import type { ScanRegistry } from './registry.js';

export const ORPHAN_RUN_SCAN_NAME = 'agent-orphan-runs';

export interface OrphanRunScanLogger {
  error(obj: unknown, msg?: string): void;
}

export interface OrphanRunScanDeps {
  readonly pool: Pool;
  readonly logger: OrphanRunScanLogger;
}

/**
 * 扫描体（每 tick 全量读；lease 由 executor 每秒续租，过期即挂死候选）。
 * 返回观测到的孤儿数（日志与观测用；0 = 空转）。
 */
export async function runOrphanRunScan(deps: OrphanRunScanDeps): Promise<number> {
  const { rows } = await deps.pool.query<{
    id: string;
    claimed_by: string | null;
    lease_until: Date | null;
    created_at: Date;
  }>(
    `SELECT id, claimed_by, lease_until, created_at FROM agent_run
     WHERE status='running' AND lease_until IS NOT NULL AND lease_until < now()`,
  );
  let observed = 0;
  for (const run of rows) {
    const staleMs =
      run.lease_until === null ? 0 : Math.max(0, Date.now() - run.lease_until.getTime());
    // 「同一 run 只推一次」：WHERE NOT EXISTS 使重复扫描天然幂等（行在则不插）
    const pushed = await deps.pool.query(
      `INSERT INTO ws_event (type, payload)
       SELECT 'inconsistency', $2::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM ws_event
         WHERE type='inconsistency' AND payload->>'kind'='orphan_run' AND payload->>'ref'=$1
       )`,
      [
        run.id,
        JSON.stringify({
          kind: 'orphan_run',
          ref: run.id,
          message: `agent run lease expired while still running (claimed_by=${run.claimed_by ?? 'none'}, stale ${staleMs}ms); remedy = restart process to trigger recovery scan`,
        }),
      ],
    );
    if ((pushed.rowCount ?? 0) > 0) observed += 1;
    deps.logger.error(
      { runId: run.id, claimedBy: run.claimed_by, leaseUntil: run.lease_until, staleMs },
      'orphan agent run: lease expired while status=running; no takeover (O1) — restart process to recover',
    );
  }
  return observed;
}

/** boot 接线（index.ts 步骤 4）：registry.register('agent-orphan-runs', 孤儿观测扫描) */
export function registerOrphanRunScan(deps: OrphanRunScanDeps & { registry: ScanRegistry }): void {
  deps.registry.register(ORPHAN_RUN_SCAN_NAME, () => runOrphanRunScan(deps));
}
