# 09 · 验收场景 S1–S8

> 来源：原文 §2.4。表格为原文无损复制；每个场景下的「怎么验收」为【解读】。

## 场景表（原文）

| # | 场景 | 外部服务的表现 | 期望结果 |
|---|---|---|---|
| S1 | 受理与发出 | 网关对 send 先回 202，过一会儿再推 `message_sent` | `message_sent` 之前 `deliveryStatus = accepted`，之后为 `sent` |
| S2 | 事件重复 | 网关把**每个事件都推两次** | 时间线**无重复行**；agent **不被重复触发** |
| S3 | 自己的消息回流 | 网关把服务账号发出的消息作为 `message` 事件推回来 | `isOwn = true`；**不产生新的 agent run** |
| S4 | 限流 | 网关对 send 回 `429 RATE_LIMITED { retryAfterSeconds: N }` | 账号进入 `rate_limited`；**到期前网关收不到该账号的 `send`**；到期自动恢复 |
| S5 | Agent 重试同一个 key | 网关对第一次 send 回 504、**1.5 秒后消息落地**；Agent 服务拿到结果后用**同一个 `idempotency_key`** 再调一次 | 网关里**恰好一条**消息；第二次调用返回这条消息的当前状态（`sent`），**不再调审计**；run 正常结束 |
| S6 | Agent 坏响应 | Agent 服务依次返回坏 JSON、一个未知工具调用，然后正常结束 | run 以 `final` / `budget_exhausted` / `protocol_errors` 之一结束；**服务不崩**；每一步都有 `kind` 和 `rawResponse` |
| S7 | 序列并发启动 | — | 并发两次启动，**恰好一个 `201`、一个 `409`** |
| S8 | 序列预检 | — | 第 3 步有解析不了的占位符 → `422`，`error.code = UNRESOLVED_PLACEHOLDER`，`error.stepIndex = 3`，`error.key` 为该占位符名；**网关收不到任何消息** |

## 【解读】每个场景怎么验收（也是 mock 的故障开关清单）

- **S1**：mock 网关的 send 延迟推送 `message_sent`（如 1s）。验收：时间线 API / 页面上该消息先显示 `accepted`，事件到达后变 `sent`，且只有一行。
- **S2**：mock 网关对每个 SSE 帧重复推送一次。验收点有两个：**数据层**去重（`(groupId, msgId)`，含 `message_sent` 重复不把 accepted 重复处理）和 **agent 触发层**去重（重复的 `message` 事件不得创建第二个 run——配合"每群至多一个 running run"双重保险）。
- **S3**：mock 网关按契约把服务账号发的消息也推成 `message` 事件。验收：该消息与出站记录**合并为一行**（`isOwn = true`），`agentEnabled=true` 的群也不因此触发 run。
- **S4**：mock 网关按 `retryAfterSeconds` 回 429。验收：账号状态变 `rate_limited` 且 `rateLimitedUntil` 正确；**期间对网关的抓包/计数为零次该账号 send**（注意 429 会重置计时，一次试探就会前功尽弃）；排队消息到期后**按原顺序**发出；到期自动回 `online`。
- **S5**：这是幂等 + 504 判定的组合拳。mock 网关对第一次 send 回 504、1.5s 后落地并推 `message_sent`；mock agent 拿到结果（`SEND_TIMEOUT` 或 `sent`）后用同一 `idempotency_key` 重调。验收：网关消息数 = 1；第二次工具调用返回第一次那条消息的当前状态；**审计只发生一次**（A5-7：第二次不再审计）；run 走到 `finished/final`。
- **S6**：mock agent 按序返回坏 JSON → 未知工具 → 正常 finish。验收：run 结束状态合法、三种之一；steps 里坏 JSON 那步 `kind = protocol_error` 且有 `rawResponse`，未知工具那步是 `tool_use` + `isError` + `UNKNOWN_TOOL`；服务进程无未捕获异常。
- **S7**：并发两次 `POST /api/groups/:id/sequence-runs`。验收：恰好一个 201 一个 409（数据库唯一约束 / 行锁是稳妥解法）。
- **S8**：构造第 3 步含未定义 `{key}` 的启动。验收：422 响应字段齐全（`stepIndex = 3`、`key`）；**没有任何消息发出**（网关计数为零）；**不留下运行记录**（之后能正常启动）。

## 【解读】场景之外的补充自检

S1–S8 只覆盖了部分行为，以下是原文有明确要求、但不在场景表里的高频翻车点，建议同样写成可演示用例：

1. **重启一致性**（§3 总则）：在「queued 消息未发 / agent run 进行中 / 序列运行中 / 建群 job 进行中」四个时刻各杀一次进程重启，行为均保持。
2. **离线补投**（§2.1）：补投消息 sentAt 早于已有消息，时间线排序仍正确、无重复。
3. **群不可写**（A2）：`GROUP_WRITE_FORBIDDEN` → 群 `unreachable`、序列 `stopped`、agent run 当前步后 `cancelled`、账号状态不变。
4. **终态原子性**（A1）：账号进终态瞬间——成员表移除、排队消息 `cancelled`、序列步骤 `skipped`、`account_terminal` 事件，要么全发生要么都不发生。
5. **leave-all**（B2）：群主最后退；中途失败时群主留下、失败账号在 DB 与网关侧一致。
6. **会话安全**（B3）：旧 refresh token 复用 → 整会话（新旧 token 全部）作废；logout 后 access token 立即失效。
