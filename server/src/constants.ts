// constants.ts —— 全仓唯一常量归宿（T-P0-05，I14）。
// 规约（宪法 §3-2 / 任务卡 d 项）：
// - 契约数字逐字取自 QR §1（docs/analysis/10-quick-reference.md），禁止取整、禁止无出处魔数；
// - 设计值一律标【设计值】并给出设计文档出处；
// - 此后任何任务不得在别处新增常量：需要新常量 → 回本任务串行变更并补断言。
// 单位约定：时间一律毫秒（字符数/字节数/天数除外），与宪法 §3-6 的「内部 epoch 毫秒」一致。

// ============================================================================
// 一、网关契约时序（QR §1，来源 REQ §2.1）
// ============================================================================

/** 事件流相邻事件乱序窗口 ≤1s；离线补投不受此限（QR §1） */
export const EVENT_REORDER_WINDOW_MS = 1000;

/** join 受理后 member_joined 通常 100–1500ms 到达（也可能永不到）（QR §1） */
export const MEMBER_JOINED_DELAY_MS_MIN = 100;
export const MEMBER_JOINED_DELAY_MS_MAX = 1500;

/** member_joined 超时 10s → 建群 job failed（JOIN_TIMEOUT）（QR §1，A2） */
export const JOIN_TIMEOUT_MS = 10000;

/** 建群 job 中 promote 调用总数上限 ≤2 次（QR §1，A2） */
export const PROMOTE_MAX_CALLS = 2;

/** kick 响应可能耗时 1–5s（QR §1） */
export const KICK_LATENCY_MIN_MS = 1000;
export const KICK_LATENCY_MAX_MS = 5000;

/** kick 504 后网关成员列表收敛时限 2s（QR §1） */
export const KICK_CONVERGE_MS = 2000;

/** send 的 202 本身可能耗时 1–2s（QR §1） */
export const SEND_ACCEPT_MIN_MS = 1000;
export const SEND_ACCEPT_MAX_MS = 2000;

/** message_sent 通常 50–2000ms 到达（QR §1） */
export const MESSAGE_SENT_MIN_MS = 50;
export const MESSAGE_SENT_MAX_MS = 2000;

/** send 504 后：若已被接收，落地并推 message_sent 的时限 2s；超 2s 仍 404 = 确认未发出（QR §1） */
export const SEND504_LAND_MS = 2000;

// ============================================================================
// 二、消息投递与 unknown 判定（QR §1，A2）
// ============================================================================

/** unknown 从收到 504 起的落定期限 5s（QR §1，A2） */
export const UNKNOWN_SETTLE_MS = 5000;

/** send_message 工具等待 accepted/sent 的上限 5s，超时 → SEND_TIMEOUT（QR §1，REQ §2.2） */
export const SEND_MESSAGE_WAIT_MS = 5000;

// ============================================================================
// 三、认证（QR §1，REQ §2.3）
// ============================================================================

/** access token 有效期 15min（QR §1） */
export const ACCESS_TOKEN_TTL_MS = 900000;

/** refresh token 有效期 7 天（题目未规定）【设计值】（DES/02 §2.3 / README 解释声明 #23） */
export const REFRESH_TOKEN_TTL_MS = 604800000;

// ============================================================================
// 四、Agent 预算与协议（QR §1，A5 / REQ §2.2）
// ============================================================================

/** agent run 步数上限 12（含结束步；审计重试不计步）（QR §1，A5） */
export const AGENT_MAX_STEPS = 12;

/** agent run 墙钟上限 60s（含审计等待；重启后停机时间不计）（QR §1，A5） */
export const AGENT_WALL_CLOCK_MS = 60000;

/** /agent/turn 单轮超时 10–15s 可配，默认 12s（QR §1；DES/01 §4.4「默认 12s」） */
export const AGENT_TURN_TIMEOUT_DEFAULT_MS = 12000;

/** 连续协议错误上限 3 次（合法响应清零）（QR §1，A5） */
export const PROTOCOL_ERROR_STREAK_LIMIT = 3;

/** audit 无结论重试上限 3 次 → blocked（QR §1，A5） */
export const AUDIT_MAX_ATTEMPTS = 3;

/** get_recent_messages 的 limit 上限 50（超过按 50 处理）（QR §1，REQ §2.2） */
export const GET_RECENT_LIMIT_MAX = 50;

/** get_recent_messages 单条 text 截断阈值 500 字（置 truncated=true）（QR §1，REQ §2.2） */
export const TEXT_TRUNCATE_CHARS = 500;

/** 单个 tool_result content 上限 8KB（截断 + truncated=true）（QR §1，A5） */
export const TOOL_RESULT_MAX_BYTES = 8192;

/** resultSummary 上限 200 字（QR §1，A5 / REQ §2.3） */
export const RESULT_SUMMARY_CHARS = 200;

/** rawResponse 截断长度 2KB（QR §1，REQ §2.3） */
export const RAW_RESPONSE_MAX_BYTES = 2048;

// ============================================================================
// 五、前端 / 时间线 / 媒体（QR §1）
// ============================================================================


/** 前端重连后事件补齐时限 3s（QR §1，B4） */
export const WS_BACKFILL_MS = 3000;

/** 消息分页默认 limit 50（QR §1，REQ §2.3） */
export const TIMELINE_PAGE_SIZE = 50;

/** 媒体文件保留期默认 30 天（可配）（QR §1，C1） */
export const MEDIA_RETENTION_DAYS_DEFAULT = 30;

// ============================================================================
// 六、外部 HTTP 超时预算（【设计值】DES/01 §4.4：契约响应区间 + 余量）
// ============================================================================

/** 网关普通调用超时 10s【设计值】（DES/01 §4.4） */
export const GATEWAY_TIMEOUT_DEFAULT_MS = 10000;

/** kick 调用超时 6s = 契约 1–5s 响应 + 余量【设计值】（DES/01 §4.4） */
export const KICK_TIMEOUT_MS = 6000;

/** send 调用超时预算 8s = 202 本身可能 1–2s + 余量【设计值】（DES/01 §4.4） */
export const SEND_TIMEOUT_BUDGET_MS = 8000;

/** by-client-id 查询超时 5s【设计值】（DES/01 §4.4） */
export const BY_CLIENT_ID_TIMEOUT_MS = 5000;

/** /agent/audit 单次超时 5s（契约无数字，必须有界）【设计值】（README 解释声明 #8 → DES/01 §4.4） */
export const AUDIT_SINGLE_TIMEOUT_MS = 5000;

// ============================================================================
// 七、SSE 消费与死信（【设计值】DES/08 §1.1 / §1.4）
// ============================================================================

/** SSE 断连退避重连：500ms 起【设计值】（DES/08 §1.1） */
export const SSE_RECONNECT_BACKOFF_START_MS = 500;

/** SSE 重连退避上限 5s【设计值】（DES/08 §1.1） */
export const SSE_RECONNECT_BACKOFF_MAX_MS = 5000;

/** 死信调度器扫描周期 5s【设计值】（DES/08 §1.4） */
export const DEADLETTER_SCAN_INTERVAL_MS = 5000;

/** 死信指数退避上限 5min（300000ms）【设计值】（DES/08 §1.4） */
export const DEADLETTER_BACKOFF_MAX_MS = 300000;

/** 死信累计失败阈值 20 次 → inconsistency(dead_letter_stuck)【设计值】（DES/08 §1.4） */
export const DEADLETTER_STUCK_THRESHOLD = 20;

/** 死信 pending_event 已完成行（status='done'）的审计保留 7 天，调度器定期清理【设计值】（DES/02 §1.4） */
export const PENDING_EVENT_RETENTION_DAYS = 7;

// ============================================================================
// 八、消息发送 unknown 探测 / 文本约束（【设计值】DES/05 §2.1.1 / §2.4）
// ============================================================================

/** unknown 判定器 404 后退避 500ms 再探【设计值】（DES/05 §2.4） */
export const UNKNOWN_PROBE_BACKOFF_MS = 500;

/** 消息 text 长度上限 2000 字符（操作员/序列/agent 共用；D3-6）【设计值】（DES/05 §2.1.1 / 声明 #15） */
export const TEXT_MAX_LENGTH = 2000;

// ============================================================================
// 九、建群 / 退群流程（【设计值】DES/04 §2.2 / §3.2）
// ============================================================================

/**
 * INVITE_NOT_READY 等待时长 = 网关响应的 readyAfterMs（非本地常量）；重试不设上限
 * （链接就绪是网关保证的必然事件）【设计值】（DES/04 §2.2）
 */
export const INVITE_NOT_READY_RETRY_UNLIMITED = true;

/** promote 遇 NOT_MEMBER_YET 后等 1s 重试（总调用仍受 PROMOTE_MAX_CALLS 约束）【设计值】（DES/04 §2.2） */
export const PROMOTE_RETRY_WAIT_MS = 1000;

/** leave 后 member_left 确认超时 5s → 查 GET /members 核对【设计值】（DES/04 §3.2） */
export const LEAVE_ALL_CONFIRM_TIMEOUT_MS = 5000;

// ============================================================================
// 十、WS 网关与事件保留（【设计值】DES/08 §2.4 / DES/02 §1.5）
// ============================================================================

/** WS 心跳 ping/pong 30s，僵死连接清理【设计值】（DES/08 §2.4） */
export const WS_HEARTBEAT_MS = 30000;

/** 每连接发送队列上限 1000 条，超限断开（客户端重连带 sinceSeq 恢复）【设计值】（DES/08 §2.4） */
export const WS_SEND_QUEUE_LIMIT = 1000;

/** ws_event 保留窗口默认 30 分钟（远大于 B4 的 3s 补齐要求）【设计值】（DES/02 §1.5） */
export const WS_EVENT_RETENTION_MINUTES = 30;

/** ws_event 兜底轮询节拍 250ms【设计值】：进程内通知（DES/08 §2.2 单实例直推）之外的
 *  拉取保险丝——事务内写表但无通知路径的行（死信事务等）至多滞后一个节拍 */
export const WS_EVENT_POLL_MS = 250;

// ============================================================================
// 十一、Agent 编排与调度（【设计值】DES/06 §2 / §2.1，DES/01 §3 / §6.1）
// ============================================================================

/** agent run 全局并发闸 50（进程内信号量；系统真实并发容量）【设计值】（DES/01 §6.1） */
export const AGENT_MAX_CONCURRENT_RUNS = 50;

/** agent run 租约续租间隔 2s【设计值】（DES/06 §2.1） */
export const AGENT_LEASE_RENEW_MS = 2000;

/** agent run 租期 10s（> 2× 续租间隔，容忍一次续租抖动）【设计值】（DES/06 §2.1） */
export const AGENT_LEASE_TTL_MS = 10000;

/** trigger_queue 积压补建 SWEEP 周期 5s【设计值】（DES/06 §2） */
export const TRIGGER_SWEEP_INTERVAL_MS = 5000;

/** 进程内调度器 tick 1s（周期扫描只是加速器，真值在 DB 时间戳）【设计值】（DES/01 §3） */
export const SCHEDULER_TICK_MS = 1000;

/** 出站 send 遇 503/网络不可达的指数退避起点 500ms【设计值】（DES/05 §2.3 解读 #17；节奏沿用 SSE 退避档，契约未给数字） */
export const SEND_RETRY_BACKOFF_START_MS = 500;

/** 出站 send 退避上限 5s【设计值】（DES/05 §2.3 解读 #17；同 SSE 档） */
export const SEND_RETRY_BACKOFF_MAX_MS = 5000;

// ============================================================================
// 十二、清理与列表（【设计值】DES/09 §5，声明 #22）
// ============================================================================

/** auth token 过期行清理窗口 1 天（expires_at < now() - 1d）【设计值】（DES/09 §5） */
export const TOKEN_CLEANUP_RETENTION_DAYS = 1;

/** GET /api/groups/:id/agent-runs 最近列表长度 20 条（分页可选）【设计值】（README 解释声明 #22 → DES/06 §11） */
export const AGENT_RUN_LIST_LIMIT = 20;
