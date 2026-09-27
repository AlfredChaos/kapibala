// 效果型工具的审计门禁（T-P4-07；DES/06 §8.1/§8.3 逐字 + REQ A5-4 + 解读 #8 单次 5s）。
// 语义逐字：
// - send_message 的 text=待发文本；kick_user 的 text=JSON.stringify({action:'kick',platform_user_id,reason})；
// - verdict 恰为 'pass'（合法 JSON 且字段精确匹配）才执行；'fail' → AUDIT_REJECTED（is_error
//   tool_result 返回 agent，run 继续，幂等 key 不消耗）；其他值一律视为无结论；
// - 无结论（非 2xx/坏 JSON/无 verdict/超时）→ 同一次工具调用重试至多 3 次；
//   单次失败不返回 agent、不计步、不计协议错误；耗时计入 60s 墙钟；
// - 3 次都无结论 → run blocked / audit_blocked，工具不执行，推 ws_event 通知操作员；
// - 每次重试前先查墙钟：中途到期 → wall_clock 而非 audit_blocked（DES/06 §12 风险 2 的交错）。
import type { AgentClient } from '../../agentclient/index.js';
import { AUDIT_SINGLE_TIMEOUT_MS } from '../../constants.js';

export { AUDIT_SINGLE_TIMEOUT_MS };

export type AuditGateOutcome =
  | 'pass' // verdict 恰为 pass → 可执行
  | 'rejected' // verdict=fail → AUDIT_REJECTED 返回 agent（不消耗 key）
  | 'blocked' // 3 次都无结论 → run blocked/audit_blocked（§8.3）
  | 'wall_clock'; // 重试中途墙钟到期 → wall_clock 优先（§12 风险 2）

export const AUDIT_MAX_ATTEMPTS = 3; // A5-4「对同一次工具调用最多尝试 3 次」

/** 各工具的送审 text（§8.1 逐字定义） */
export function auditTextForTool(name: string, input: unknown): string | undefined {
  const rec = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (name === 'send_message') {
    return typeof rec['text'] === 'string' ? rec['text'] : undefined;
  }
  if (name === 'kick_user') {
    return JSON.stringify({
      action: 'kick',
      platform_user_id: rec['platform_user_id'],
      reason: rec['reason'],
    });
  }
  return undefined; // 非效果型工具不送审
}

export function isEffectTool(name: string): boolean {
  return name === 'send_message' || name === 'kick_user';
}

export interface AuditGateDeps {
  readonly agentClient: AgentClient;
  readonly groupId: string;
  /** run 的 wall_deadline_at（绝对时刻；每次重试前与其比较，§5 审计重试前判定逐字） */
  readonly wallDeadlineAt: Date | null;
  /** 测试注入时钟；缺省 Date.now */
  readonly now?: () => number;
}

/**
 * 审计门禁主循环：至多 3 次，重试前先查墙钟。
 * 纯判定——不落库；blocked/rejected/wall_clock 的 step/run 终态化由调用方事务承担。
 */
export async function runAuditGate(deps: AuditGateDeps, text: string): Promise<AuditGateOutcome> {
  const now = deps.now ?? (() => Date.now());
  for (let attempt = 0; attempt < AUDIT_MAX_ATTEMPTS; attempt++) {
    // 墙钟先于本次审计尝试（§5「审计每次重试前」判定时机逐字；含第一次——deadline 已过立即 wall_clock）
    if (deps.wallDeadlineAt !== null && now() >= deps.wallDeadlineAt.getTime()) {
      return 'wall_clock';
    }
    const res = await deps.agentClient.callAudit({ text, groupId: deps.groupId });
    if (res.verdict === 'pass') return 'pass';
    if (res.verdict === 'fail') return 'rejected';
    // unresolved：不返回 agent、不计步——继续重试
  }
  return 'blocked'; // 3 次都无结论（§8.1 逐字）
}
