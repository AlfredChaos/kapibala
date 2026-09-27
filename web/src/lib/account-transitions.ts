// 账号状态转移表面（T-P5-03；DES/15 §2 页面 2、DES/03 §1、REQ A1）。
// 真值在 server/src/modules/accounts/transitions.ts 的 LEGAL_TRANSITIONS（15 条合法边；
// disconnected→online 属 connect 专属不在表内）；这里是纯数据镜像——
// tests/accounts-page.test.tsx 直接 import 服务端表做逐边对照（卡片 d：同源校验）。
// UI 只用两个导出：legalTargets(from) 列出转移面板可选目标；CONNECT_FROM 控 connect 可见性。
import type { AccountStatus } from '@kapibala/contract';

/** A1 合法边（与 server LEGAL_TRANSITIONS 逐边同构；parity 测试钉死漂移） */
export const LEGAL_TRANSITIONS_WEB: ReadonlySet<string> = new Set(
  (
    [
      ['idle', 'online'],
      ['idle', 'suspended'],
      ['idle', 'session_expired'],
      ['online', 'idle'],
      ['online', 'rate_limited'],
      ['online', 'disconnected'],
      ['online', 'suspended'],
      ['online', 'session_expired'],
      ['rate_limited', 'online'],
      ['rate_limited', 'disconnected'],
      ['rate_limited', 'suspended'],
      ['rate_limited', 'session_expired'],
      ['disconnected', 'idle'],
      ['disconnected', 'suspended'],
      ['disconnected', 'session_expired'],
    ] as const
  ).map(([from, to]) => `${from}->${to}`),
);

/** connect 按钮可见状态（DES/15 §2 页面 2：仅 idle/disconnected——与 server CONNECT_FROM 同义） */
export const CONNECT_FROM_WEB = ['idle', 'disconnected'] as const;

/** 转移面板可选目标：DES/15「to 只列合法目标；非法目标不出现在 UI（ILLEGAL_TRANSITION 留给并发）」 */
export function legalTargets(from: AccountStatus): AccountStatus[] {
  const out: AccountStatus[] = [];
  for (const edge of LEGAL_TRANSITIONS_WEB) {
    const sep = edge.indexOf('->');
    if (edge.slice(0, sep) === from) out.push(edge.slice(sep + 2) as AccountStatus);
  }
  return out;
}

/** connect 前置判定（按钮可见+可用共用） */
export function canConnect(status: AccountStatus): boolean {
  return (CONNECT_FROM_WEB as readonly string[]).includes(status);
}
