# 10 · 速查表（衍生视图）

> 本文是**汇总视图**，非规范源；每项标注来源，冲突时以 02–08 / 原文为准。

## 1. 全部时序数字

| 数字 | 含义 | 来源 |
|---|---|---|
| ≤ 1s | 事件流相邻事件乱序窗口（**离线补投不受此限**） | §2.1 |
| 100–1500ms | join 受理后 `member_joined` 通常到达时间（**也可能永不到**） | §2.1 |
| 10s | `member_joined` 超时 → 建群 job `failed`（`JOIN_TIMEOUT`） | A2 |
| ≤ 2 次 | 建群 job 中 promote 调用总数上限 | A2 |
| 1–5s | kick 响应可能耗时 | §2.1 |
| 2s | kick 504 后网关成员列表收敛时限 | §2.1 |
| 1–2s | send 的 202 本身可能耗时 | §2.1 |
| 50–2000ms | `message_sent` 通常到达时间 | §2.1 |
| 2s | send 504 后：若已被接收，落地并推 `message_sent` 的时限；超过 2s 仍 404 = 确认未发出 | §2.1 |
| 5s | ① A2：`unknown` 从收到 504 起的落定期限 ② `send_message` 工具等待 `accepted/sent` 的上限（超 → `SEND_TIMEOUT`） | A2 / §2.2 |
| 15min | access token 有效期 | §2.3 |
| 12 步 | agent run 步数上限（含结束步；审计重试不计步） | A5 |
| 60s | agent run 墙钟上限（**含审计等待**；重启后停机时间不计） | A5 |
| 10–15s（可配） | `/agent/turn` 单轮超时（`TURN_TIMEOUT`；超时后到的响应丢弃） | A5 |
| 3 次 | ① 连续协议错误上限（合法响应清零） ② audit 无结论重试上限（→ `blocked`） | A5 |
| 50 | `get_recent_messages` 的 limit 上限（超过按 50 处理） | §2.2 |
| 500 字 | `get_recent_messages` 单条 text 截断阈值（置 `truncated: true`） | §2.2 |
| 8KB | 单个 tool_result `content` 上限（截断 + `truncated: true`） | A5 |
| 200 字 | `resultSummary` 上限 | A5 / §2.3 |
| 2KB | `rawResponse` 截断长度 | §2.3 |
| ~8s 或更久 / 不返回 | Agent 响应可能很慢 | §2.2 |
| 3s | 前端重连后事件补齐时限（B4） | B4 |
| 50 | 消息分页默认 limit | §2.3 |
| 30 天（默认，可配） | 媒体文件保留期（C1） | C1 |

## 2. 网关错误码 → 系统行为

| 网关返回 | 系统行为 | 来源 |
|---|---|---|
| `429 RATE_LIMITED { retryAfterSeconds }` | 账号 → `rate_limited`；期内不发该账号 send（**计时重置**）；排队消息保持 `queued` 到期按序发；序列顺延不跳过 | A2 / §2.1 |
| `403 ACCOUNT_SUSPENDED` | 账号 → `suspended`（终态 + 原子副作用） | A2 |
| `401 SESSION_EXPIRED` | 账号 → `session_expired`（终态 + 原子副作用） | A2 |
| `403 GROUP_WRITE_FORBIDDEN` | 群 → `unreachable`；序列 → `stopped`；agent run 当前步后 `cancelled`；账号不变 | A2 |
| `403 SENDER_NOT_IN_GROUP` | 该条 `failed`（同名 failCode）；状态不变 | A2 |
| `409 ACCOUNT_OFFLINE` | 该条 `failed`（同名 failCode）；状态不变 | A2 |
| `504 NETWORK_TIMEOUT`（send） | → `unknown`；5s 内落定；确认未发出才可重发一次（同 `clientMsgId`）；再失败 → `failed(NETWORK_TIMEOUT)` | A2 |
| `504 NETWORK_TIMEOUT`（kick） | 结果未知；用成员列表判断（2s 收敛） | §2.1 |
| `409 INVITE_NOT_READY` | 等 `readyAfterMs` 后重试 | B2 |
| `410 INVITE_EXPIRED` | 重新申请链接，重试**一次** | B2 |
| `409 ALREADY_MEMBER` | 视为成功，直接 promote | B2 |
| `409 NOT_MEMBER_YET` | promote 调用总数 ≤ 2 | A2 |
| `409 OWNER_LEFT` / `403 NO_PERMISSION` | `kick_user` 返回同名错误；状态不变 | A2 |
| `500`（leave） | 没退成（leave-all 记 `errors[]`） | §2.1 / B2 |
| `503`（任何端点，含 by-client-id） | 整体不可用；by-client-id 不可用期间保持 `unknown` | §2.1 / A2 |

## 3. Agent 工具错误码（tool_result 的 code）

`UNKNOWN_TOOL` · `INVALID_INPUT` · `DUPLICATE_TOOL_USE_ID` · `BAD_JSON` · `TURN_TIMEOUT` · `AUDIT_REJECTED` · `POLICY_DENIED` · `SEND_TIMEOUT` · `SEND_FAILED` · `NO_AVAILABLE_ACCOUNT` · `GROUP_UNREACHABLE` · `OWNER_LEFT` · `NO_PERMISSION`

## 4. 自有 API 错误码

| code | HTTP | 场景 | 来源 |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | 未认证 / token 失效（含 refresh 复用后整会话作废） | §2.3 / B3 |
| `FORBIDDEN` | 403 | viewer 写操作 | §2.3 / A0 |
| `VALIDATION_ERROR` | 400 | transition 入参 / 建群参数不合法 | §2.3 |
| `ACCOUNT_NOT_FOUND` | 404 | transition 目标账号不存在 | §2.3 |
| `ILLEGAL_TRANSITION` | 409 | 转移不在表上（含同态→同态） | §2.3 / A1 |
| `CAS_CONFLICT` | 409 | `expectedFrom` 与当前状态不符 | §2.3 / A1 |
| `ACCOUNT_NOT_IN_GROUP` | 409 | 发送账号不在此群 | §2.3 |
| `ACCOUNT_UNAVAILABLE` | 409 | 账号 `idle` / `disconnected` / 终态 | §2.3 |
| `SEQUENCE_ALREADY_RUNNING` | 409 | 该群已有 running 序列 | §2.3 / B1 |
| `UNRESOLVED_PLACEHOLDER` | 422 | 预检失败（带 `stepIndex`、`key`） | §2.3 / B1 |
| `ACCOUNT_NOT_ONLINE` | 422 | 建群账号非 online | §2.3 |
| `JOIN_TIMEOUT` | job error | `member_joined` 10s 未到 | A2 |
| `TOOLS_INVALID` | 400（对 Agent 服务的请求） | tools 数组不合规 | §2.2 |

## 5. 消息 failCode（自己的消息 `failed` / `cancelled` 时必填）

网关错误码（如 `SENDER_NOT_IN_GROUP` / `ACCOUNT_OFFLINE` / `NETWORK_TIMEOUT` / `GROUP_WRITE_FORBIDDEN` / `ACCOUNT_SUSPENDED`），或 `ACCOUNT_TERMINAL`（终态取消排队）/ `GROUP_UNREACHABLE`。

## 6. 状态机一览

| 实体 | 状态 | 关键规则 |
|---|---|---|
| 账号 | idle / online / rate_limited / disconnected / **suspended / session_expired（终态）** | 严格转移表（A1）；CAS；终态原子副作用 |
| 消息投递 | queued → accepted → sent；failed / unknown / cancelled | unknown 5s 内落定；重发仅一次 |
| 群 | active / unreachable / left | leave-all 完成 → left（members=[]） |
| agent run | running → finished / failed / blocked / cancelled | endReason 映射：final / budget_exhausted / wall_clock / protocol_errors / audit_blocked / cancelled |
| 序列 run | running / finished / failed / stopped | stopped = 群 unreachable |
| 序列 step | pending / accepted / sent / skipped / failed | skipped 视为在跳过时刻"发出" |
| job | running / finished / failed | errors 非空即 failed |

## 7. 端点清单

**网关（外部，需 mock）**：`POST /accounts/:id/connect|disconnect` · `POST /groups` · `POST /groups/:id/invite|join|promote|kick|leave` · `POST /groups/:id/send` · `GET /groups/:id/members` · `GET /groups/:id/messages/by-client-id/:clientMsgId` · `GET /events?since=`（SSE）· `GET /media/:id`（C1）

**Agent 服务（外部，需 mock）**：`POST /agent/turn` · `POST /agent/audit`

**自有服务**：`POST /api/auth/login|refresh|logout` · `GET /api/health` · `GET /api/accounts` · `POST /api/accounts/:id/connect|transition` · `POST /api/groups` · `GET /api/groups(/:id)` · `PATCH /api/groups/:id` · `POST /api/groups/:id/send|leave-all` · `GET /api/jobs/:jobId` · `GET /api/groups/:id/messages` · `GET /api/agent-runs/:id` · `GET /api/groups/:id/agent-runs` · `POST /api/sequences` · `POST /api/groups/:id/sequence-runs` · `GET /api/sequence-runs/:id` · `WS /ws`
