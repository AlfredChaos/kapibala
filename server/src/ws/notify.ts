// ws_event 提交后的进程内通知钩子（T-P2-10；DES/08 §2.2「单实例:进程内通知」）。
// 形状：单槽 notifier——hub attach 时注册、close 时摘除；业务事务在 COMMIT 之后调用
// notifyWsEventCommitted() 立即唤醒一轮同步（无 hook 注册 = 无 hub 实例，调用为 no-op，
// 语义上退化为「只靠兜底轮询」，ws_event 表仍是投递真值——多实例 NOTIFY 预留的同一推论）。
// 宪法 §3-5 注：本钩子不承载正确性（丢通知只损失毫秒级时延，轮询兜底收敛），
// 因此单进程变量合法——这与「唯一性/互斥靠 DB」的约束无关，纯加速通道。
type Notifier = () => void;

let notifier: Notifier | undefined;

/** hub attach/close 接线点（同进程至多一个 hub 生效；重复 attach 后者覆盖） */
export function setWsEventNotifier(fn: Notifier | undefined): void {
  notifier = fn;
}

/**
 * 业务事务提交 ws_event 后调用（先持久化后推送：调用点必须在 COMMIT 成功之后——
 * 提前调用会让 hub 读不到未提交行，等于静默吞掉这次唤醒，只剩轮询兜底）。
 * 失败绝不上抛：通知只是加速器。
 */
export function notifyWsEventCommitted(): void {
  try {
    notifier?.();
  } catch {
    // 通知失败 ≠ 投递失败：轮询兜底收敛
  }
}
