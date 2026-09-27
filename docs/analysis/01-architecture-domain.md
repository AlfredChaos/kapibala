# 01 · 系统架构与领域模型

> 来源：原文 §1 架构图、§2.3、§3.A。实体清单与数据流注释为【解读】（帮助理解，非题目规定的表结构）。

## 1. 架构与数据流

原文架构图：

```
        控制台前端 (React + TS)
              │ REST + WebSocket
        你的后端 (Node + TS + PostgreSQL)
         ├── 账号管理
         ├── 群、成员与消息时间线
         ├── 定时序列
         └── Agent 接入
              │                          │
         消息网关（2.1）            Agent 服务（2.2）
```

【解读】按数据流方向重画：

```
                    ┌──────────────────────────────┐
                    │     控制台前端 React 18+TS     │
                    └───────────────┬──────────────┘
                        REST（查询/写操作）
                        WS /ws（实时事件，seq 单调，可 sinceSeq 补发）
                    ┌───────────────┴──────────────┐
                    │   你的后端 Node+TS+PostgreSQL  │
                    │  ┌────────────────────────┐  │
                    │  │ 账号状态机（A1）          │  │
                    │  │ 群/成员/消息时间线（A2-A4）│  │
                    │  │ 建群/退群 job（A3/B2）    │  │
                    │  │ Agent run 循环（A5）      │  │
                    │  │ 序列调度（B1）            │  │
                    │  │ 认证会话（A0/B3）         │  │
                    │  │ WS 事件广播（A4/B4）      │  │
                    │  └────────────────────────┘  │
                    └────┬───────────────────┬─────┘
          出站 HTTP │（connect/send/        │ 出站 HTTP（/agent/turn，
          join/promote/kick/leave/invite）  │ /agent/audit）
          入站 SSE ↓（GET /events 持续消费）│
              ┌─────┴──────────┐   ┌───────┴────────┐
              │   消息网关      │   │   Agent 服务    │
              └────────────────┘   └────────────────┘
```

【解读】三条数据流：

1. **下行（控制）**：前端 → 你的后端 → 网关 / Agent 服务（HTTP）。
2. **上行（观测）**：网关 →（SSE 事件）→ 你的数据库（投影）→（WS）→ 前端。**网关的一切真态变化都以事件流为准**，HTTP 202 只表示"受理"。
3. **横向（编排）**：你的后端 ↔ Agent 服务（turn 循环）；Agent 的每个工具调用由你的后端代为对网关执行。

你的数据库同时承担两个角色：**网关状态的投影**（成员、消息）+ **出站意图的记录**（queued 消息、job、run、序列排期）——后者是崩溃一致性的关键。

## 2. 领域实体清单【解读】

| 实体 | 关键字段（均来自契约） | 来源 |
|---|---|---|
| 账号 account | `id, status, platformUserId, rateLimitedUntil` | §2.3 |
| 群 group | `id, gatewayGroupId, status, creatorAccountId, agentEnabled, autoKickEnabled` | §2.3 |
| 群成员 group_member | `groupId, accountId, platformUserId, role(creator\|admin\|member)` | §2.3 |
| 消息 message | `groupId, msgId, clientMsgId, senderPlatformUserId, isOwn, text, sentAt, deliveryStatus, failCode`（+ `mediaUrl/localFilePath`，C1） | §2.3 |
| 任务 job | `status, errors[{step, code}]`（建群 / leave-all 两种） | §2.3 |
| 序列 sequence | `name, steps[{index, accountRole, text, delaySeconds}]` | B1 |
| 序列运行 sequence_run | `runId, status, currentStepIndex`；每步 `{index, status, scheduledAt, sentAt, clientMsgId, resolvedVars, varSources}` | §2.3 |
| Agent 运行 agent_run | `id(=runId), groupId, status, endReason, summary`；每步 `{kind, toolUseId, name, input, resultSummary, isError, errorCode, auditVerdict, rawResponse}` | §2.3 |
| 运营用户 user | `admin`（全部权限）/ `viewer`（只读），预置 | A0 |
| 会话 refresh token | 轮换链 + 复用检测 | B3 |
| 网关事件游标 | 已消费到的 `eventId`（SSE 断线带 `since` 补拉） | §2.1 / A2 |
| WS 事件日志 | `seq, type, payload`（支撑 `sinceSeq` 补发） | §2.3 / B4 |
| 出站发件箱 outbox | 【解读】建议模式：发送意图先落库再触达网关，支撑 A2 的崩溃一致性 | A2 |

## 3. 状态机汇总（规范内容，来源已标注）

### 3.1 账号（A1，原文 §3.A1）

状态集：`idle / online / rate_limited / disconnected / suspended / session_expired`

允许的转移（行 = 当前状态，列 = 目标状态）：

| 从 \ 到 | idle | online | rate_limited | disconnected | suspended | session_expired |
|---|---|---|---|---|---|---|
| idle | | ✔ | | | ✔ | ✔ |
| online | ✔ | | ✔ | ✔ | ✔ | ✔ |
| rate_limited | | ✔ | | ✔ | ✔ | ✔ |
| disconnected | ✔ | ✔ | | | ✔ | ✔ |
| suspended | | | | | | |
| session_expired | | | | | | |

- `suspended` / `session_expired` 是**终态**，没有出边，重连也不能恢复。
- 表上没有的转移（**包括同状态到同状态**）一律 `ILLEGAL_TRANSITION`；`rateLimitedUntil` 的刷新不算状态转移。
- 重复进入同一终态时静默忽略，不影响后续事件处理。
- 并发变更同一账号：至多一个成功，另一个 `409 CAS_CONFLICT`，不能后写覆盖先写。
- 进入终态时的副作用（**原子**，见 05 文件 A1）。

### 3.2 消息投递 deliveryStatus（§2.3 + A2）

```
queued ──→ accepted ──→ sent
   │           │
   │           └──→ failed（failCode 必填）
   ├──→ cancelled（failCode = ACCOUNT_TERMINAL）
   └──→ unknown ──→ accepted / sent / failed（收到 504 起 5 秒内必须落定）
              └──→ failed（重发一次后仍未发出，failCode = NETWORK_TIMEOUT）
```

- `queued`：出站消息已被你的服务受理（API / 工具 / 序列）。
- `accepted`：网关 send 返回 202。
- `sent`：收到 `message_sent` 事件。
- `failed`：终局失败，`failCode` 必填（网关错误码，或 `ACCOUNT_TERMINAL` / `GROUP_UNREACHABLE`）。
- `unknown`：send 返回 504 后的待判定态。
- `cancelled`：账号进入终态时取消排队中的发送。

注：入站消息（非自己发的）没有 deliveryStatus 语义（仅对自己的消息有意义）。

### 3.3 群 status（§2.3）

| 状态 | 含义 |
|---|---|
| `active` | 正常 |
| `unreachable` | 群不可写（`GROUP_WRITE_FORBIDDEN`） |
| `left` | `leave-all` 完成后（此时 `members = []`） |

### 3.4 Agent run（§2.3）

| status | ← endReason |
|---|---|
| `running` | （无 endReason） |
| `finished` | `final`（收到 finish 或 end_turn） |
| `failed` | `budget_exhausted`（12 步用尽）/ `wall_clock`（60s）/ `protocol_errors`（连续 3 次协议错误） |
| `blocked` | `audit_blocked`（审计 3 次拿不到结论） |
| `cancelled` | `cancelled`（群 unreachable / agentEnabled 关闭） |

### 3.5 序列运行（§2.3）

- run：`running / finished / failed / stopped`（`stopped` = 群变 `unreachable`）
- step：`pending / accepted / sent / skipped / failed`

### 3.6 任务 job（§2.3）

- `running / finished / failed`；`errors` 非空即 `failed`
- `step ∈ create | invite | join:<accountId> | promote | leave:<accountId>`

## 4.【解读】贯穿全局的四条不变量

这四条是全题的"宪法"，所有功能设计都围绕它们：

1. **重启不变量**（§3 总则）：每一条行为在服务**任意时刻**重启前后都必须成立 → 任何外部效果（网关调用、WS 推送）发生之前，对应状态必须已持久化。
2. **事件投影不变量**（A2）：网关事件 at-least-once + 乱序（≤1s）+ 离线补投（不受窗口限制）→ 入站处理必须幂等：按 `(groupId, msgId)` 去重、按 `sentAt` 排序，不能用到达顺序或 eventId 排序展示。
3. **出站唯一性不变量**（A2）：不能出现「网关发出了、数据库里却没有记录」，也不能同一条出站记录在网关里对应多条消息（网关不按 clientMsgId 去重，唯一性完全由你保证）。
4. **单飞行不变量**（A5 / B1）：同一群同一时刻至多一个 `running` 的 agent run（**多实例部署也成立**）；同一群同一时刻至多一个 `running` 的序列运行。
