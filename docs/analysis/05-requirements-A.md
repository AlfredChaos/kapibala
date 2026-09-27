# 05 · A 组：核心功能需求

> 来源：原文 §3.A（A0–A6）。除【解读】块外，均为原文规范的无损重组。

> **总则（适用于 A / B / C 全部需求）**：
> 「下面每一条行为，在服务**任意时刻重启**前后都必须成立。」

## A0 基础

- 数据库迁移**可重复执行**；数据库 schema 落后于代码时服务**拒绝启动**。
- 错误响应格式见 §2.3（[04-api-spec.md](04-api-spec.md) §0）。
- `login` 返回 access token；`viewer` 对**所有写操作**得到 `403`。

## A1 账号状态

状态与允许的转移（行 = 当前状态，列 = 目标状态）：

| 从 \ 到 | idle | online | rate_limited | disconnected | suspended | session_expired |
|---|---|---|---|---|---|---|
| idle | | ✔ | | | ✔ | ✔ |
| online | ✔ | | ✔ | ✔ | ✔ | ✔ |
| rate_limited | | ✔ | | ✔ | ✔ | ✔ |
| disconnected | ✔ | ✔ | | | ✔ | ✔ |
| suspended | | | | | | |
| session_expired | | | | | | |

规则：

- `suspended` / `session_expired` 是**终态**，没有出边，**重连也不能恢复**。重复进入同一终态时**静默忽略**，不影响后续事件处理。
- 表上没有的转移（**包括同状态到同状态**）一律 `ILLEGAL_TRANSITION`；`rateLimitedUntil` 的刷新不算状态转移。
- **并发**变更同一账号时至多一个成功，另一个得到 `409 CAS_CONFLICT`，**不能后写覆盖先写**。
- **进入终态时**（无论来源：发送错误、网关事件、操作员标记，结果都一样）：
  - 该账号从**所有群**的成员表中移除；
  - 它排队中的发送变为 `cancelled`（`failCode = ACCOUNT_TERMINAL`），对应的序列步骤变为 `skipped`；
  - 推 `account_terminal` 事件；
  - **原子性**：状态和这些后果**要么都生效，要么都不生效**。
- 推给前端的状态事件**必须对应已经保存的状态**（先持久化再推送）。
- `rate_limited` 由 `RATE_LIMITED` 触发，`retryAfterSeconds` 后**自动**回到 `online`；到期时账号已不是 `rate_limited`（例如已被操作员标记离线）则**不做转移**。

## A2 网关接入

### 出站消息（你的服务 → 网关）

- 出站消息在你的数据库里有记录和 `deliveryStatus`：`queued → accepted → sent | failed | unknown | cancelled`。
- 服务在任何时刻崩溃重启，都不能出现「**网关发出了、数据库里却没有记录**」，也不能出现同一条出站记录在网关里对应**多条**消息。
- 收到 `NETWORK_TIMEOUT` 后 `deliveryStatus = unknown`，**从收到 504 起 5 秒内**必须变为 `accepted` / `sent` / `failed` 之一。
  - 确认没有发出时，可以用**同一个 `clientMsgId` 重发一次，总共只允许重发一次**；重发后仍未发出 → `failed`（`failCode = NETWORK_TIMEOUT`）。
  - **在确认消息没有发出之前不能重发**。
  - by-client-id 查询不可用期间保持 `unknown`，恢复后 **2 秒内**确定状态。

### 入站消息与事件

- 入站 `message` 事件按 `(groupId, msgId)` **去重**，按 `sentAt` 排序展示。
- 服务账号自己发出的消息回流时标 `isOwn = true`，**不触发 agent**。
- 处理网关事件时如果**自己的数据库写入失败**：不能让事件处理中断，也不能让这个事件的内容丢失；同时推 `inconsistency` 事件，让操作员看到。
- 服务停机或事件流断开期间网关产生的事件，**恢复后都要处理到**。

### 网关错误 → 系统行为对照表

| 网关返回 | 处理 |
|---|---|
| `RATE_LIMITED` | 账号 → `rate_limited`；等待期内**不再向网关发该账号的 `send`**（`disconnect` / `leave` 不受限）；该账号排队中的消息保持 `queued`，到期后按**原顺序**发出；序列步骤**顺延，不跳过** |
| `ACCOUNT_SUSPENDED` | 账号 → `suspended` |
| `SESSION_EXPIRED` | 账号 → `session_expired` |
| `GROUP_WRITE_FORBIDDEN` | 群 → `unreachable`；该群的序列运行 → `stopped`，agent 不再触发，正在运行的 agent run 在**当前步后** `cancelled`；**账号状态不变** |
| `SENDER_NOT_IN_GROUP` / `ACCOUNT_OFFLINE` | 该条 `failed`（`failCode` 为同名码）；账号、群状态不变 |
| `NETWORK_TIMEOUT` | 见上文出站规则 |
| `NOT_MEMBER_YET` | 建群完成时 `memberAccountIds[0]` 已是管理员，**对 promote 的调用总数 ≤ 2**；`member_joined` 超过 **10 秒**未到 → job `failed`，`errors[].code = JOIN_TIMEOUT` |
| `OWNER_LEFT` / `NO_PERMISSION` | `kick_user` 返回同名错误；账号、群状态不变 |

（`INVITE_NOT_READY` / `INVITE_EXPIRED` / `ALREADY_MEMBER` 见 B2。）

## A3 建群

- `POST /api/groups` 的执行流程：网关建群 → 申请邀请链接 → 各成员 join → 等 `member_joined` → 把 `memberAccountIds[0]` 提升为管理员。
- **异步执行**，`GET /api/jobs/:jobId` 可看进度与失败步骤。
- 成员表写入时机：创建者在**建群成功后**写入（`role = creator`）；其他成员在**收到 `member_joined` 后**写入。

## A4 消息时间线与实时推送

- 消息列表按**游标分页**。「加载更早」时即使同时有新消息写入，**也不能出现重复或遗漏**。
- WebSocket 认证通过后推送事件，`seq` 单调递增。

## A5 Agent 接入

（工具与协议细节见 [03-agent-contract.md](03-agent-contract.md)；此处为编排规则，保留原编号。）

1. **触发**：`agentEnabled=true` 的群里出现一条**非自己的**消息 → 创建一次 agent run。同一群同一时刻**至多一个** `running` 的 run（**服务多实例部署时也成立**）。run 进行期间到达的非自己消息记为待处理；run 结束时若有待处理消息，立即创建下一次 run，把这些消息**全部**放进 `triggerMessages`。
2. **循环与上限**：组装 `messages` → 调 `/agent/turn` → 校验响应 → 执行工具 → 把 `tool_result` 追加进历史 → 继续。
   - 一步 = 一次 `/agent/turn` 往返（无论返回的是什么）；**审计重试不算步**。
   - 上限 **12 步**（含结束那一步）。
   - 从 run 创建起 **60 秒**（**含等审计的时间**；重启后从恢复时刻继续累计，**停机时间不计**）。
   - **连续 3 次协议错误**结束（任何一次合法响应清零）。
   - `/agent/turn` 每轮超时 **10–15 秒（可配）**，超时记一次协议错误（`TURN_TIMEOUT`），**超时后才到的响应丢弃**。
3. **协议错误**：
   - 未知工具 / 入参不合 schema → **正常追加** assistant 的 tool_use 块，再追加 `is_error: true` 的 tool_result（`UNKNOWN_TOOL` / `INVALID_INPUT`）。
   - 坏响应（`BAD_JSON`，定义见 §2.2）/ 重复 `tool_use.id` / 超时 → **不追加** assistant 块，改为追加一条 `role: user` 的 text 块 `PROTOCOL_ERROR <code>: <一句话>`；**这一步计入步数**，记录在 `steps[]`（`kind = protocol_error`，`rawResponse` 为原始响应体）。
4. **审计**：`send_message` / `kick_user` 执行前**必须**经过 `/agent/audit`：
   - `send_message` 的 `text` 为待发文本；`kick_user` 的 `text` 为 `JSON.stringify({ action: 'kick', platform_user_id, reason })`。
   - 只有审计返回**合法 JSON 且 `verdict` 恰为 `pass`** 时才执行。`fail` → 不执行，返回 `AUDIT_REJECTED`。
   - **拿不到明确结论时（含超时）**：对同一次工具调用**最多尝试 3 次**（耗时计入 60 秒；**单次失败不返回给 agent、不计步**）；3 次都拿不到 → run `blocked`，`endReason = audit_blocked`，该工具**不执行**，推事件通知操作员。
5. **执行账号**：选哪个账号执行由你决定（只能用 `online` 的**群成员**；`kick_user` 需要 `role ∈ {creator, admin}`）。没有可用账号 → `NO_AVAILABLE_ACCOUNT`（**不算协议错误，计入步数**）；账号在执行中途变终态 → 该步 `SEND_FAILED`，**run 继续**。
6. `kick_user` 还要求群 `autoKickEnabled=true`，否则返回 `POLICY_DENIED`。
7. **幂等**：同一个 run 里**相同 `idempotency_key`** 的 `send_message`，第二次及以后**不再发送、不再审计**，返回那条消息的当前状态。被 `AUDIT_REJECTED` / `POLICY_DENIED` 拒绝的调用**不算用过**这个 key。
8. **恢复**：服务在 run 进行中的任意时刻重启，run 都要从中断处继续（**使用同一个 `runId`**）并正常结束；已经对外产生效果的工具调用（发消息、移除成员）**不能再执行一次，也不能被记成失败**。
9. **结果大小**：单个 tool_result `content` ≤ **8KB**，超出截断并置 `truncated: true`；`resultSummary` ≤ 200 字。
10. **外部状态变化**：群变 `unreachable`、或 `agentEnabled` 被关闭时，正在运行的 run 在**当前这一步结束后**终止，`endReason = cancelled`。
11. **重复调用**：模型连续用同样入参调 `get_recent_messages` 时的处理方式**由你决定**；run 必须在 12 步内以合理的方式结束。
12. **可查看**：每一步（含协议错误步）都在 `GET /api/agent-runs/:id` 里可见。

## A6 前端（第 4 节页面 1–3）

见 [08-frontend.md](08-frontend.md)（登录 / 账号列表 / 群详情）。

## 【解读】A 组内部依赖与实现顺序

- A1 是地基：A2 的错误表、A5 的执行账号选择、B1 的账号挑选全部依赖状态机正确性。
- A2 出站方向建议用**发件箱（outbox）模式**：发送意图先落库（`queued`）再调网关，任何崩溃都能恢复出发送记录；504 → `unknown` 的判定与单次重发逻辑是 A2 最难的点。
- A5-8（run 恢复）的正确姿势：run 的会话历史、每步执行状态都持久化；重启后扫描 `running` 的 run，用同一 runId 续传；已执行成功的工具调用在历史里已有 `tool_result`，自然不会重放。
- 「审计重试不算步 / 单次审计失败不返回给 agent」意味着审计是**对模型透明的**：模型只看到最终审计结论（pass 执行 / AUDIT_REJECTED），看不到重试过程。
