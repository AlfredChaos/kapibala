# 02 · 外部服务 A：消息网关契约

> 来源：原文 §2.1。除【解读】块外，均为原文规范的无损重组。
> 原文声明：**「其中的时序数字也是约定的一部分」**——下列所有毫秒 / 秒数都是硬性契约，不是建议值。

## 1. 账号

### 端点

| 端点 | 请求 | 成功响应 | 语义 |
|---|---|---|---|
| `POST /accounts/:accountId/connect` | — | `{ platformUserId }` | 同一 `accountId` **每次 connect 返回同一个** `platformUserId` |
| `POST /accounts/:accountId/disconnect` | — | — | 账号离线；离线账号的 `send` / `join` / `promote` / `kick` / `leave` → `409 ACCOUNT_OFFLINE` |

### 规则

- 账号由你在 **migration / seed 里预置**（数量、id 自定），初始 `status = idle`、`platformUserId = null`。
- **离线补投**：离线账号之前发过的消息，仍可能在之后通过事件流补投：
  - 补投事件带**新的（更大的）** `eventId`；
  - `msgId` / `sentAt` 为**原值**；
  - 因此补投消息的 `sentAt` 可能比已收到的消息早**任意时长**，**不受下文 1 秒乱序窗口限制**。
- 网关会主动推 `account_status` 事件：`{ accountId, status: 'suspended' | 'session_expired' }`。
  - 账号进入这两种状态后，网关会**自动把它移出所有群**并推 `member_left`。

## 2. 群与成员

### 端点

| 端点 | 请求 | 成功响应 | 关键语义与失败模式 |
|---|---|---|---|
| `POST /groups` | `{ creatorAccountId }` | `{ groupId }` | 创建者账号成为**群主**；**响应返回时即已是成员**，网关不会为它推 `member_joined` |
| `POST /groups/:groupId/invite` | — | `{ inviteLink, readyAfterMs }` | `readyAfterMs` 可能是 0，也可能几秒；就绪前用链接 → `409 INVITE_NOT_READY`；链接**任意时刻可能过期** → `410 INVITE_EXPIRED`，再申请一个新链接即可 |
| `POST /groups/:groupId/join` | `{ accountId, inviteLink }` | `202 { accepted: true }` | 仅表示申请已受理；**真正入群以随后的 `member_joined` 事件为准**（通常 100–1500ms 后；**也可能永远不来**——此时账号并未入群）。已在群里的账号再 join → `409 ALREADY_MEMBER`，此时**不会再推** `member_joined` |
| `POST /groups/:groupId/promote` | `{ byAccountId, accountId }` | `200 {}` | `byAccountId` 必须是群主，否则 `403 NO_PERMISSION`；对方 `member_joined` 之前调用 → `409 NOT_MEMBER_YET`；**promote 不推事件** |
| `POST /groups/:groupId/kick` | `{ byAccountId, targetPlatformUserId }` | `200 { kicked: true }` | 目标在 **200 返回前**已从成员列表移除，随后推 `member_left`。群主已退群后任何 kick → `409 OWNER_LEFT`；非群主且未被 promote 的账号 → `403 NO_PERMISSION`。**响应可能需要 1–5 秒**，也可能返回 `504 NETWORK_TIMEOUT`（结果未知：可用成员列表判断是否已移除，网关保证 **2 秒内收敛**） |
| `POST /groups/:groupId/leave` | `{ accountId }` | `200` | 随后推 `member_left` 事件；**也可能返回 `500`（没退成）** |
| `GET /groups/:groupId/members` | — | `[{ platformUserId }]` | 网关视角的当前成员；账号实际入群 / 离群的**那一刻**成员列表就已变化，对应的 `member_joined` / `member_left` 在**其后**才推出 |

### 成员事件

- `member_joined` / `member_left`：`{ groupId, platformUserId }`。
- **外部用户**（非服务账号）进出群也会推这两种事件。

## 3. 发消息

`POST /groups/:groupId/send { accountId, clientMsgId, text }` → `202 { accepted: true }`

- 202 只表示**已受理**；**202 本身可能要一两秒才返回**。
- 消息真正发出以 `message_sent { clientMsgId, msgId, sentAt }` 事件为准（通常 50–2000ms 后）。
- 也可能收到 `message_failed { clientMsgId, code }`，`code` 为 `GROUP_WRITE_FORBIDDEN` 或 `ACCOUNT_SUSPENDED`，含义与下面的同步错误相同。

### 同步错误

| 错误 | 语义 |
|---|---|
| `429 RATE_LIMITED { retryAfterSeconds }` | 该账号被限流。**等待期内该账号的任何 `send` 都会再次得到同样错误，并且计时重置** |
| `403 ACCOUNT_SUSPENDED` | 账号已被平台停用；之后该账号的**所有请求（含 connect）**都返回同样错误。网关也可能（**不保证**）再推一条 `account_status: suspended` |
| `401 SESSION_EXPIRED` | 会话失效，**永久不可用**；之后该账号的所有请求都返回同样错误。网关也可能（不保证）再推 `account_status: session_expired` |
| `403 GROUP_WRITE_FORBIDDEN` | 该群不可写（群被解散或被禁言），**与账号无关** |
| `403 SENDER_NOT_IN_GROUP` | 该账号不在这个群里 |
| `409 ACCOUNT_OFFLINE` | 该账号未 connect 或已 disconnect |
| `504 NETWORK_TIMEOUT` | **结果未知**：消息可能已发出，也可能没有。可用 `GET /groups/:groupId/messages/by-client-id/:clientMsgId` 查询该 `clientMsgId` 是否已落地（`200 { msgId, sentAt }` / `404`；同一 `clientMsgId` 落地多条时返回**最早**一条）。如果返回 504 时消息其实已被接收，网关会在 **2 秒内落地并推 `message_sent`**；504 之后**超过 2 秒仍是 404**，即可确定没有发出 |

### 其他

- **网关不按 `clientMsgId` 去重**：同一个 `clientMsgId` 发两次，会发出**两条**消息。
- 任何端点（**包括 by-client-id 查询**）都可能整体不可用（`503`）。

## 4. 事件流（SSE）

`GET /events?since=<eventId>`

### 帧格式

每个帧为 `id: <eventId>`、`event: <type>`、`data: <JSON>`；`data` 里同时带 `eventId` 与 `type`。

### 约定

| 项 | 约定 |
|---|---|
| 事件类型 | `message` / `message_sent` / `message_failed` / `member_joined` / `member_left` / `account_status` |
| `eventId` | 全局单调递增 |
| `since` | **独占**（返回 `eventId > since` 的事件） |
| 历史 | 网关保留**全部**历史事件 |
| 投递语义 | **at-least-once**：同一事件可能重复推送 |
| 乱序 | 相邻事件可能乱序，**乱序窗口 ≤ 1 秒** |
| 断连 | 连接可能随时断开；重连时带 `since` 可以补拉，不带则从当前时刻开始 |
| 启动 | 事件流从服务启动那一刻起就会推送事件，**与是否已 connect 任何账号无关** |

### `message` 事件

`{ groupId, msgId, senderPlatformUserId, text, sentAt, mediaUrl? }`

- **包括服务账号自己发出的消息**（其 `msgId` 与对应 `message_sent` 里的相同），网关不区分消息来自谁。
- `sentAt` 毫秒精度，**同一毫秒可能有多条**。
- `mediaUrl`（可选）指向网关的 `GET /media/:id`：返回文件字节，**过期后返回 404**。

## 5.【解读】对实现的直接启示

- **去重键 = `(groupId, msgId)`，排序键 = `sentAt`**。不能用到达顺序或 eventId 做展示排序：补投事件的 sentAt 可以任意早、相邻事件可乱序 1 秒。
- 同一毫秒多条 → 排序与分页游标需要 `(sentAt, msgId)` 复合键，不能只靠 sentAt。
- **限流的「计时重置」**意味着限流期内绝不能向网关发该账号的 send——连试探性的重发都不行，否则等待期被无限续期。
- 504 后的两条判定路径要并行考虑：等 `message_sent`（2s 内）与 by-client-id 查询（超 2s 仍 404 = 确认未发出）；而 by-client-id 查询**本身会 503**，不可用期间保持 `unknown`。
- 网关不去重 `clientMsgId` + A2 要求「一条出站记录只对应一条网关消息」→ **重发控制完全在你这一侧**，且总共只允许一次、必须先确认未发出。
- SSE 消费端需要持久化「已消费到的 eventId」游标：停机期间的事件恢复后要全部补处理（A2）。
- 建群的确认链是「事件驱动」的：join 202 ≠ 入群，要等 `member_joined`（10s 超时 → JOIN_TIMEOUT）；promote 又不推事件，只能靠返回值确认。
