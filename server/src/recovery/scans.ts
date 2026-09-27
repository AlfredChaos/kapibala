// 启动恢复六扫描（T-P2-02 骨架；清单与顺序逐字 DES/10 §3 汇总图）。
// 顺序原则（DES/10 §3）：先恢复出站与运行中的编排（世界状态收敛），再恢复账号侧收口，最后开流量。
// 本任务只落「登记 + 交接」的骨架：每个扫描体是 stub（恒返回 0 = 零工作项），真实扫描体由归属
// 任务在其扩展点插入（T-P4-11 = agent 段、T-P6-04 = 序列段等，见各 stub 注释）；
// 插入时保持本清单顺序不变（boot-order.test.ts 钉死名单与次序）。
// 宪法 §3-5：扫描体必须全部条件更新、可重复触发（幂等吸收）——本骨架不含任何进程内正确性判定。
import { recoverAgentRuns } from '../modules/agent/recovery.js';
import { recoverSequenceRuns } from '../modules/sequences/recovery.js';
import type { Pool } from 'pg';
import { retryDeadLettersOnce } from '../events/deadletter.js';
import { runAccountsRecoveryScan } from '../modules/accounts/transitions.js';
import { runCreateGroupJob } from '../modules/groups/create-job.js';
import { UNKNOWN_SETTLE_MS } from '../constants.js';
import type { DispatchRegistry } from '../events/dispatch.js';
import type { GatewayClient } from '../gateway/client.js';

/** 最小日志面（info/warn/error）：pino Logger 结构兼容，测试可用普通对象 fake */
export interface RecoveryLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface RecoveryDeps {
  readonly pool: Pool;
  readonly logger: RecoveryLogger;
  /** 扫描 5b「补调 disconnect」用（E10 收口）；client 自身不做业务决策（T-P2-01） */
  readonly gateway: GatewayClient;
  /** 扫描 6 死信重放分发用（§1.4 重试 = 重放分发步骤 b)；与消费循环共用同一注册表） */
  readonly dispatch: DispatchRegistry;
  /** 扫描 1：queued 未尝试行唤醒出站 dispatcher（T-P3-02/03）；缺省 = dispatch-wakeup 扫描 1s 内兜底 */
  readonly wakeDispatcher?: (accountId: string) => void;
}

export interface RecoveryScan {
  /** 清单名（日志与登记用；DES/10 §3 扫描 1–6） */
  name: string;
  /** 返回登记/交接的工作项数；stub 恒 0（D3-2：交接给常驻组件异步接管，不同步等完成） */
  run(deps: RecoveryDeps): Promise<number>;
}

export const RECOVERY_SCANS: readonly RecoveryScan[] = [
  {
    // 扫描 1：出站消息 message WHERE delivery_status IN ('queued','unknown')——
    // queued 且 first_attempt_at IS NULL → 交给出站 dispatcher 正常首发（从未尝试，安全）；
    // queued 但尝试过（结果未知）→ 条件 UPDATE 转 unknown（unknown_since=now、deadline=now+5s，
    // E7 崩溃窗口收口，DES/05 §2.4）；unknown 行 → 交判定器（探测节奏从恢复时刻起算）。
    // T-P3-03 已接线（des/10 §3 SWEEP1 逐字）：三步同一批 SELECT 驱动——
    //   a) queued ∧ 未尝试 → wakeDispatcher（dispatcher 内 advisory lock 消化重复唤醒）；
    //   b) queued ∧ 已尝试 → 转 unknown（条件更新守卫；幂等：重复跑无事）；
    //   c) unknown → 判定器扫描（调度器 unknown-settle）自然接手，本扫描不重复处理。
    name: 'outbound-messages',
    async run(deps) {
      const { rows } = await deps.pool.query<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM message
         WHERE delivery_status='queued' AND first_attempt_at IS NULL AND account_id IS NOT NULL`,
      );
      for (const row of rows) {
        deps.wakeDispatcher?.(row.account_id);
      }
      const converted = await deps.pool.query(
        `UPDATE message SET delivery_status='unknown',
                            unknown_since=now(),
                            unknown_deadline_at=now() + $1 * interval '1 millisecond',
                            updated_at=now()
         WHERE delivery_status='queued' AND first_attempt_at IS NOT NULL`,
        [UNKNOWN_SETTLE_MS],
      );
      return rows.length + (converted.rowCount ?? 0);
    },
  },
  {
    // 扫描 2：agent_run WHERE status='running'——advisory lock 抢占，按 step.status 断点续传
    // （done→预算判定续轮 / turn_dispatched→快照重发同轮 / turn_received→续推进 /
    // tool_dispatched→反查外部现状不重发）；wall_deadline_at = now + 剩余预算（DES/06 §9）。
    // 【扩展点：T-P4-11（agent 段充实，共享串行文件）】已接线
    name: 'agent-runs',
    async run(deps) {
      return recoverAgentRuns({ pool: deps.pool });
    },
  },
  {
    // 扫描 3：sequence_run WHERE status='running'——链头判定四分支：在途消息→等落定；
    // 未排期→等前驱；过期未创建→只重排链头（now+delay，其后全部 scheduled_at=NULL）；
    // 未到期→保持（DES/07 §5）。
    // 【扩展点：T-P6-04（序列段充实，共享串行文件）】已接线
    name: 'sequence-runs',
    async run(deps) {
      return recoverSequenceRuns({ pool: deps.pool });
    },
  },
  {
    // 扫描 4：job WHERE status='running'——按 phase/context 续传
    // （join/leave 不重发，查外部现状判定；DES/04）。
    // T-P3-06 已接线（create_group 段）：逐 job fire-and-forget 交执行器续传——
    // advisory lock 单飞（D3-2：交接不同步等完成）；leave_all 段归 T-P3-07。
    name: 'jobs',
    async run(deps) {
      const { rows } = await deps.pool.query<{ id: string }>(
        "SELECT id FROM job WHERE status='running' AND type='create_group'",
      );
      for (const row of rows) {
        void runCreateGroupJob({ pool: deps.pool, gateway: deps.gateway, logger: deps.logger }, row.id).catch(
          (err: unknown) => {
            deps.logger.error({ err, jobId: row.id }, 'job resume failed; will retry on next boot');
          },
        );
      }
      return rows.length;
    },
  },
  {
    // 扫描 5：账号——a) rate_limited 到期未转移 → 条件 UPDATE 补转移（DES/03 §5.3）；
    // b) status ∈ idle/disconnected 但网关侧可能仍在线 → 补调 gateway.disconnect（E10 收口）。
    // T-P2-05 已接线：模块函数 runAccountsRecoveryScan（条件更新 + 幂等外呼，宪法 §3-5）。
    name: 'accounts',
    async run(deps) {
      return runAccountsRecoveryScan(deps.pool, { disconnect: (id) => deps.gateway.disconnect(id) });
    },
  },
  {
    // 扫描 6：pending_event 死信立即重试一轮（status='pending' AND next_retry_at<=now()）——
    // T-P2-04 已接线：与调度器 5s 周期扫描共用同一实现（重放分发 + done/退避/stuck 告警）；
    // 常态周期重试的节流归调度器侧扫描（§1.4），恢复扫描永远立即跑一轮（DES/10 §3 逐字）。
    name: 'pending-events',
    async run(deps) {
      return retryDeadLettersOnce({ pool: deps.pool, registry: deps.dispatch, logger: deps.logger });
    },
  },
];
