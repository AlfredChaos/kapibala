// 启动恢复器（T-P2-02；DES/01 §7 步骤 3、DES/10 §3）。
// D3-2 精确语义：恢复在启动路径上完成的只是「登记与交接」——startRecovery 同步登记扫描清单
// （names + 日志），扫描体在异步序列中执行；boot 不 await done 即继续（consumer seam → 调度器 →
// 监听）。真实扫描体（T-P4-11/T-P6-04 等插入）同样必须「登记后交常驻组件异步接管」，
// 不得同步等待长任务——扫描完成 = 世界一致（意图都在 DB），进度由 DB 驱动的组件追赶。
// 单扫描失败不阻断其余扫描：各自独立收敛，DB 真值兜底（宪法 §3-5）。
import type { RecoveryDeps, RecoveryScan } from './scans.js';
import { RECOVERY_SCANS } from './scans.js';

export interface RecoveryHandle {
  /** 登记的扫描名（DES/10 §3 顺序）——同步可得，即「登记完成」的凭据 */
  readonly names: readonly string[];
  /** 全部扫描执行完（含各自错误已记日志）后 resolve；boot 不 await（D3-2），测试/关停可 await */
  readonly done: Promise<void>;
}

export interface StartRecoveryOptions {
  deps: RecoveryDeps;
  /** 测试注入缝：仪表化扫描清单；缺省 RECOVERY_SCANS（六扫描骨架） */
  scans?: readonly RecoveryScan[];
}

export function startRecovery(options: StartRecoveryOptions): RecoveryHandle {
  const scans = options.scans ?? RECOVERY_SCANS;
  const { logger } = options.deps;
  const names = scans.map((scan) => scan.name);
  logger.info({ scans: names }, 'recovery scans registered'); // 登记 = 同步完成的观测点
  const done = (async () => {
    for (const scan of scans) {
      try {
        const handedOff = await scan.run(options.deps);
        logger.info({ scan: scan.name, handedOff }, 'recovery scan handed off');
      } catch (err) {
        logger.error({ err, scan: scan.name }, 'recovery scan failed; continuing with remaining scans');
      }
    }
  })();
  return { names, done };
}
