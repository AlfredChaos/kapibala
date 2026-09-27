# 11 · 陷阱与易漏细节清单（衍生视图）

> 【解读】按主题归类的易翻车点，提交前逐条自查。每条标注来源。

## 事件流（§2.1 / A2）

1. **补投事件不受 1 秒乱序窗口限制**：离线账号旧消息可能以任意早的 `sentAt` 迟到——时间线不能用「到达顺序」或 eventId 排序。
2. **去重键是 `(groupId, msgId)`**，且 `message_sent` / `message_failed` / `member_joined` 等事件同样会被重复推送（at-least-once 覆盖**所有**事件类型，不只是 `message`）。
3. `sentAt` 毫秒精度、同毫秒多条 → 排序与游标需要 `(sentAt, msgId)` 复合键。
4. **SSE 消费游标要持久化**：断连 / 停机期间的事件恢复后要全部补处理；重连带 `since`（独占语义：`eventId > since`）。
5. 事件流从网关启动就开始推，**与你是否 connect 账号无关**——消费要在服务启动即开始。
6. **自己的消息回流**：要靠 `message_sent.clientMsgId → msgId` 与出站记录**合并成一行**，不能插两条。
7. 事件处理中 DB 写入失败：**不中断、不丢事件、推 `inconsistency`**——需要某种重试 / 死信队列机制。

## 发送与 504（§2.1 / A2）

8. **429 计时重置**：等待期内任何一次 send 试探都会把限流期重新续满——限流判断必须挡在出站之前。
9. 202 只表示受理；`message_failed` 与同步错误码同语义（`GROUP_WRITE_FORBIDDEN` / `ACCOUNT_SUSPENDED`）。
10. **504 → `unknown` → 5 秒内落定**；判定路径：`message_sent`（2s）/ by-client-id（超 2s 仍 404 = 确认未发出）。
11. **重发规则极严**：仅在**确认未发出后**、用**同一 `clientMsgId`**、**总共一次**；重发仍失败 → `failed(NETWORK_TIMEOUT)`。
12. by-client-id 查询**本身会 503**：不可用期间保持 `unknown`，恢复后 2s 内定状态。
13. 网关**不按 clientMsgId 去重**：「一条出站记录 = 至多一条网关消息」完全由你保证（崩溃一致性：不能网关发了 DB 没记录）。

## 账号状态机（A1）

14. **同状态 → 同状态也是 `ILLEGAL_TRANSITION`**；`rateLimitedUntil` 刷新**不是**状态转移。
15. 终态无出边、重连不能恢复；**重复进入同一终态静默忽略**（不能因此报错或重放副作用）。
16. 终态副作用**原子**：移出所有群 + 排队消息 `cancelled(ACCOUNT_TERMINAL)` + 序列步骤 `skipped` + `account_terminal` 事件——要么全生效要么都不生效。
17. **推给前端的状态事件必须对应已保存的状态**（先写库后推送，顺序不能反）。
18. `rate_limited` 到期时若账号已不是 `rate_limited`（如被标记离线），**不执行**自动回 `online`。
19. CAS：并发 transition 至多一个成功，另一个 `409 CAS_CONFLICT`——不能靠读后写（read-modify-write），要靠条件更新 / 乐观锁。

## 建群 / 群生命周期（§2.1 / A3 / B2）

20. 创建者**响应返回即已是成员**，不会有 `member_joined`——成员表写入时机对 creator 和其他成员不同。
21. join 的 `member_joined` **可能永不到**（10s → `JOIN_TIMEOUT`，job failed）。
22. **promote 不推事件**、可能 `NOT_MEMBER_YET`，调用总数 ≤ 2。
23. 邀请链接：可能未就绪（`INVITE_NOT_READY`，等 `readyAfterMs` 重试）、可能任意时刻过期（`410`，重新申请后**只重试一次**）。
24. `ALREADY_MEMBER` = 成功，直接 promote。
25. **leave-all：群主最后退**；有人失败 → 其他人继续退、**群主不退**、job failed、失败账号 DB 与网关保持一致。
26. kick：响应 1–5s 或 504（用成员列表收敛判断，2s）；`OWNER_LEFT` / `NO_PERMISSION` 原样透传给 `kick_user` 工具。
27. leave 可能 500（没退成）——不是幂等成功。

## Agent 编排（A5 / §2.2）

28. 同一群至多一个 running run——**多实例部署也成立**（DB 层约束，不能靠进程内变量）。
29. run 结束时若有待处理消息 → **立即**创建下一次 run，`triggerMessages` 包含**全部**待处理消息（升序）。
30. 步数 = `/agent/turn` 往返次数（协议错误步也计）；**审计重试不计步**。
31. 60 秒**含审计等待**；重启后从恢复时刻继续累计（停机时间不计）。
32. 连续 **3 次**协议错误才结束——任何一次合法响应**清零**计数。
33. turn 超时（10–15s 可配，`TURN_TIMEOUT`）后**迟到的响应要丢弃**（否则会破坏会话历史一致性）。
34. 两类协议错误处理不同：未知工具 / schema 不符 → **追加 assistant tool_use + is_error tool_result**；坏 JSON / 重复 id / 超时 → **不追加 assistant 块**，追加 `role: user` text 块 `PROTOCOL_ERROR <code>: …`。
35. 审计：`verdict` 恰为 `pass` 才执行；拿不到结论重试 ≤ 3 次（不返回给 agent、不计步）；3 次失败 → `blocked`，**工具不执行**。`fail` → `AUDIT_REJECTED`（返回给 agent，run 继续）。
36. **幂等 key 不被 `AUDIT_REJECTED` / `POLICY_DENIED` 消耗**——只有真正过审执行过的 key 才算用过。
37. `kick_user` 双重门槛：`autoKickEnabled=true`（否则 `POLICY_DENIED`）+ 执行账号 `role ∈ {creator, admin}`。
38. `NO_AVAILABLE_ACCOUNT` **不算协议错误**（计入步数）；执行中途账号变终态 → 该步 `SEND_FAILED`，**run 继续**。
39. run 恢复：同一 `runId` 续传；**已产生外部效果的工具不重放、也不记失败**——依赖持久化的会话历史与步骤状态。
40. 群 `unreachable` 或 `agentEnabled` 关闭 → run 在**当前这一步结束后**才终止（不是立即掐断）。
41. `end_turn` 的 text 存为 `summary` 但**不发到群里**。
42. 结果大小：tool_result ≤ 8KB（截断 + `truncated: true`）；`resultSummary` ≤ 200 字；`rawResponse` ≤ 2KB。

## 定时序列（B1）

43. 排期锚点是「**收到 `message_sent` 的时刻**」，不是发送时刻——每步依赖上一步的事件确认。
44. **skipped 步骤视为在跳过时刻"发出"**（带时间戳，进度照常推进）。
45. `rate_limited` 账号**不算无可用账号**：顺延，不 skipped。
46. `vars` 的 `""` = 未提供（会引发 422）；`stepVars` 的 `""` = 不改（继承前值）——语义相反。
47. `stepVars` 的值**从该步起持续生效**直到更晚的步骤再给值；`varSources` 标**最初给出**该值的步（沿用时不是标当前步）。
48. 预检失败：**一条都不发、不留运行记录**、之后可正常启动；错误带 `stepIndex` + `key`。
49. 并发启动：恰好一个 201 一个 409（原子性检查）。
50. **重启后只重排最早一个过期步骤**（重启时刻 + delaySeconds），后续仍链式——防止重启风暴一次性轰炸群消息。

## 消息时间线 / WS（A4 / B4 / §2.3）

51. 「加载更早」与实时写入并发 → 无重复无遗漏；且自己消息的 `sentAt` 会从受理时刻**改为**网关时刻（行位置会移动）——游标设计要扛得住。
52. 自己的消息从 `queued` 起就在列表里；`deliveryStatus` 仅对自己的消息有意义。
53. WS：先 auth 帧再推事件；`seq` 全局单调；`sinceSeq` 补发（B4：3 秒内、不重复）。

## 会话与权限（A0 / B3）

54. viewer 的 403 要在**接口层**兜底，前端隐藏按钮只是展示层。
55. refresh token 只走 HttpOnly cookie；每次使用轮换；**旧 token 复用 → 整会话作废**（含已轮换出的新 refresh / 新 access）。
56. logout 后**同一个 access token 立即失效**（需要服务端 token 状态，不能纯 JWT 无状态）。
57. 前端多请求并发 401 → 只发一次 refresh（单飞）。

## 工程基座（A0 / §5）

58. 迁移可重复执行；**schema 落后于代码拒绝启动**（`/api/health` 暴露 `schemaVersion`）。
59. 错误格式统一 `{ error: { code, message, requestId, … } }`；时间字段 ISO 8601 UTC、无值为 `null`。
60. **总则兜底**：以上每一条，在服务任意时刻重启前后都必须成立——所有外部效果（网关调用 / WS 推送）之前状态必须已持久化。
