// I14 对照测试：契约时序数字不取整（VITEST_PLAN §1 I14 行）。
// 期望值逐字来自 docs/analysis/10-quick-reference.md §1（24 行 → 29 个常量，min/max 成对展开）
// 与各设计文档的设计值（25 个）；出处同步写在 constants.ts 的逐行注释里。
// 防再犯：速查表新增行而常量未跟上 → 表长/总数断言变红；值被取整 → 逐项断言变红。
import { describe, expect, it } from 'vitest';
import * as C from '../src/constants.js';

// —— QR §1 契约数字（29 项；顺序同速查表行序）——
const QR_TABLE: ReadonlyArray<readonly [keyof typeof C, number]> = [
  ['EVENT_REORDER_WINDOW_MS', 1000], // ≤1s 乱序窗口（离线补投不受此限）
  ['MEMBER_JOINED_DELAY_MS_MIN', 100], // 100–1500ms
  ['MEMBER_JOINED_DELAY_MS_MAX', 1500],
  ['JOIN_TIMEOUT_MS', 10000], // member_joined 超时 → JOIN_TIMEOUT
  ['PROMOTE_MAX_CALLS', 2], // ≤2 次
  ['KICK_LATENCY_MIN_MS', 1000], // 1–5s
  ['KICK_LATENCY_MAX_MS', 5000],
  ['KICK_CONVERGE_MS', 2000], // kick 504 后成员列表收敛
  ['SEND_ACCEPT_MIN_MS', 1000], // 1–2s
  ['SEND_ACCEPT_MAX_MS', 2000],
  ['MESSAGE_SENT_MIN_MS', 50], // 50–2000ms
  ['MESSAGE_SENT_MAX_MS', 2000],
  ['SEND504_LAND_MS', 2000], // 504 后落地时限
  ['UNKNOWN_SETTLE_MS', 5000], // ① unknown 落定期限
  ['SEND_MESSAGE_WAIT_MS', 5000], // ② 工具等待 accepted/sent 上限
  ['ACCESS_TOKEN_TTL_MS', 900000], // 15min
  ['AGENT_MAX_STEPS', 12], // 含结束步；审计重试不计步
  ['AGENT_WALL_CLOCK_MS', 60000], // 含审计等待
  ['AGENT_TURN_TIMEOUT_DEFAULT_MS', 12000], // 10–15s 可配，默认 12s
  ['PROTOCOL_ERROR_STREAK_LIMIT', 3], // ① 连续协议错误（合法响应清零）
  ['AUDIT_MAX_ATTEMPTS', 3], // ② audit 无结论重试 → blocked
  ['GET_RECENT_LIMIT_MAX', 50],
  ['TEXT_TRUNCATE_CHARS', 500], // 500 字 + truncated
  ['TOOL_RESULT_MAX_BYTES', 8192], // 8KB
  ['RESULT_SUMMARY_CHARS', 200], // 200 字
  ['RAW_RESPONSE_MAX_BYTES', 2048], // 2KB
  ['WS_BACKFILL_MS', 3000], // 3s 补齐
  ['TIMELINE_PAGE_SIZE', 50],
  ['MEDIA_RETENTION_DAYS_DEFAULT', 30], // 默认，可配
];

// —— 设计值（25 项，出处见 constants.ts 注释）——
const DESIGN_TABLE: ReadonlyArray<readonly [keyof typeof C, number | boolean]> = [
  ['GATEWAY_TIMEOUT_DEFAULT_MS', 10000], // DES/01 §4.4
  ['KICK_TIMEOUT_MS', 6000], // DES/01 §4.4
  ['SEND_TIMEOUT_BUDGET_MS', 8000], // DES/01 §4.4
  ['BY_CLIENT_ID_TIMEOUT_MS', 5000], // DES/01 §4.4
  ['AUDIT_SINGLE_TIMEOUT_MS', 5000], // README 解释声明 #8
  ['DEADLETTER_SCAN_INTERVAL_MS', 5000], // DES/08 §1.4
  ['DEADLETTER_BACKOFF_MAX_MS', 300000], // DES/08 §1.4（5min）
  ['DEADLETTER_STUCK_THRESHOLD', 20], // DES/08 §1.4
  ['UNKNOWN_PROBE_BACKOFF_MS', 500], // DES/05 §2.4
  ['INVITE_NOT_READY_RETRY_UNLIMITED', true], // DES/04 §2.2
  ['PROMOTE_RETRY_WAIT_MS', 1000], // DES/04 §2.2
  ['WS_HEARTBEAT_MS', 30000], // DES/08 §2.4
  ['WS_EVENT_RETENTION_MINUTES', 30], // DES/02 §1.5
  ['WS_SEND_QUEUE_LIMIT', 1000], // DES/08 §2.4
  ['LEAVE_ALL_CONFIRM_TIMEOUT_MS', 5000], // DES/04 §3.2
  ['AGENT_MAX_CONCURRENT_RUNS', 50], // DES/01 §6.1
  ['AGENT_LEASE_RENEW_MS', 2000], // DES/06 §2.1
  ['AGENT_LEASE_TTL_MS', 10000], // DES/06 §2.1
  ['SCHEDULER_TICK_MS', 1000], // DES/01 §3
  ['SSE_RECONNECT_BACKOFF_START_MS', 500], // DES/08 §1.1
  ['SSE_RECONNECT_BACKOFF_MAX_MS', 5000], // DES/08 §1.1
  ['TOKEN_CLEANUP_RETENTION_DAYS', 1], // DES/09 §5
  ['TEXT_MAX_LENGTH', 2000], // DES/05 §2.1.1（D3-6 / 声明 #15）
  ['AGENT_RUN_LIST_LIMIT', 20], // README 解释声明 #22
  ['TRIGGER_SWEEP_INTERVAL_MS', 5000], // DES/06 §2
];

describe('I14 · QR §1 契约数字逐字断言', () => {
  it.each(QR_TABLE)('%s === %s', (key, value) => {
    expect(C[key]).toBe(value);
  });

  it('QR §1 全表均已展开为常量（24 行 → 29 项，无缺行）', () => {
    expect(QR_TABLE).toHaveLength(29);
  });
});

describe('设计值常量逐个断言（【设计值】+ 出处）', () => {
  it.each(DESIGN_TABLE)('%s === %s', (key, value) => {
    expect(C[key]).toBe(value);
  });

  it('常量总数守恒：29 契约 + 25 设计 = 54，禁止静默增删', () => {
    expect(Object.keys(C)).toHaveLength(54);
    expect(DESIGN_TABLE).toHaveLength(25);
  });
});
