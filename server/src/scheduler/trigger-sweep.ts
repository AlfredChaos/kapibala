// agent_trigger_queue 兜底扫描的调度器注册行（T-P4-04；DES/06 §2 SWEEP 框逐字 + R-B）。
// 每 5s（§2「调度器兜底(每 5s)」为契约数字——registry 1s 节拍，此处内部节流）扫：
// 有积压但无 running run 的群 → 补建 run（防 run 结束事务外崩溃导致的漏建）。
// 补建前同守卫 group.status='active' AND agent_enabled=true（与 END2 第 3 步同一判据，
// trigger.ts 同源）；守卫不过则积压行保留不删，下轮再查——这正是 R-B 定稿的
// 「重新启用后补处理」通道：agentEnabled 重开 + 群 active 后，下轮 SWEEP 用积压补建。
import type { Pool } from 'pg';
import type { ScanRegistry } from './registry.js';
import { tx } from '../db/tx.js';
import { createRunFromBacklog, fetchGroupAgentContext, guardPasses, startAgentRun } from '../modules/agent/trigger.js';

export const TRIGGER_SWEEP_SCAN_NAME = 'agent-trigger-sweep';
/** §2 SWEEP 框：「调度器兜底（每 5s）」——契约数字，独立于 registry 1s 节拍 */
const TRIGGER_SWEEP_INTERVAL_MS = 5_000;

export interface TriggerSweepLogger {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface TriggerSweepDeps {
  readonly pool: Pool;
  readonly registry: ScanRegistry;
  readonly logger: TriggerSweepLogger;
  /** 测试覆盖：默认 5s（契约值） */
  readonly intervalMs?: number;
}

/** boot 接线（index.ts 步骤 4）：registry.register('agent-trigger-sweep', …) */
export function registerTriggerSweepScan(deps: TriggerSweepDeps): void {
  const interval = deps.intervalMs ?? TRIGGER_SWEEP_INTERVAL_MS;
  let lastRun = 0;
  deps.registry.register(TRIGGER_SWEEP_SCAN_NAME, async () => {
    const now = Date.now();
    if (now - lastRun < interval) {
      return 0;
    }
    lastRun = now;
    // lane 0（BUGFIX 2026-09-28）：status='running' 但 executor 已不在位（lease 过期/未认领）→
    //   重新 startAgentRun。场景：事务内直调拾取导致 COMMIT 前读不到行的 run（已实证 e8553884
    //   永久卡 running 并堵死单飞行）。重拾取靠 executor advisory lock 互斥，重复唤醒幂等。
    const { rows: stale } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM agent_run
       WHERE status='running' AND (lease_until IS NULL OR lease_until < now())`,
    );
    for (const r of stale) {
      deps.logger.warn({ runId: r.id }, 'trigger sweep: re-queuing unclaimed/stale-lease run');
      startAgentRun(r.id);
    }
    // 本轮目标集：有积压且无 running run 的群（每群独立事务——一群失败不拖整轮）
    let created = 0;
    const { rows: groups } = await deps.pool.query<{ group_id: string }>(
      `SELECT DISTINCT q.group_id
       FROM agent_trigger_queue q
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_run r WHERE r.group_id = q.group_id AND r.status = 'running'
       )`,
    );
    for (const { group_id: groupId } of groups) {
      const nextRunId = await tx(deps.pool, async (client) => {
        // R-B 守卫（SWEEP 必在，与 END2 第 3 步同判）：不过 → 积压保留不删
        const group = await fetchGroupAgentContext(client, groupId);
        if (!guardPasses(group)) {
          return undefined;
        }
        return createRunFromBacklog(client, {
          id: groupId,
          auto_kick_enabled: group?.auto_kick_enabled ?? false,
        });
      });
      if (nextRunId !== undefined) {
        deps.logger.warn({ runId: nextRunId, groupId }, 'trigger sweep backfilled agent run');
        startAgentRun(nextRunId);
        created += 1;
      }
    }
    return created;
  });
}
