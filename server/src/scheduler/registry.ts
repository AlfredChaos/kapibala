// 调度扫描注册表（T-P2-02；DES/01 §4.6：DB 驱动调度——触发时刻全部持久化在业务表，
// 扫描只是「每秒扫描到期行并触发」的加速器；进程暂停/重启的漏拍由重启后第一轮扫描补上）。
// 各域扫描函数由其归属任务注册（如 T-P2-04 的 deadletter-scan 注册行）；本文件只做注册与枚举。
// 宪法 §3-5：注册表只是接线表不是真值——扫描体必须全部条件更新、可重复触发（幂等吸收），
// 不做任何进程内正确性判定（卡片 d）。

/** 单次扫描：处理到期行，返回处理/交接的工作项数（日志与观测用；骨架 stub 恒 0） */
export type SchedulerScan = () => Promise<number> | number;

export interface RegisteredScan {
  readonly name: string;
  readonly scan: SchedulerScan;
}

export interface ScanRegistry {
  /** 重名直接拒绝：重复注册是接线错误，必须启动即炸而不是静默覆盖 */
  register(name: string, scan: SchedulerScan): void;
  /** 注册顺序的快照（Map 保序）；每轮 tick 重新获取，运行中注册的新扫描从下一轮生效 */
  scans(): readonly RegisteredScan[];
}

export function createScanRegistry(): ScanRegistry {
  const scans = new Map<string, SchedulerScan>();
  return {
    register(name, scan) {
      if (scans.has(name)) throw new Error(`scheduler scan already registered: ${name}`);
      scans.set(name, scan);
    },
    scans() {
      return [...scans].map(([name, scan]) => ({ name, scan }));
    },
  };
}
