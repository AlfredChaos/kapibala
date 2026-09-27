# 04 · 你的服务要暴露的 API

> 来源：原文 §2.3。除【解读】块外，均为原文规范的无损重组。

## 0. 通用约定

- **环境变量**：`PORT` / `DATABASE_URL` / `GATEWAY_URL` / `AGENT_URL`。
- 下列端点与字段**按约定命名**；其余 API 自由设计；响应里多出的字段不影响。
- **时间字段**：ISO 8601 UTC 字符串（如 `2026-09-26T08:00:00.000Z`），无值时为 `null`。
- **错误响应统一**为 `{ error: { code, message, requestId, ...业务字段 } }`；`401` 的 `code = UNAUTHORIZED`，`403` 的 `code = FORBIDDEN`。

## 1. 认证

```
POST /api/auth/login { username, password } → { accessToken }
```

- 预置两个用户：`admin/admin`（全部权限）、`viewer/viewer`（只读）。
- access token 有效期 **15 分钟**。
- refresh 机制见 B3（[06-requirements-B.md](06-requirements-B.md)）。

## 2. 健康检查

```
GET /api/health → { ok, schemaVersion }
```

## 3. 账号

### 列表

```
GET /api/accounts → [{ id, status, platformUserId, rateLimitedUntil }]
```

### 连接

```
POST /api/accounts/:id/connect → 200 { status, platformUserId }
```

- 调网关 connect，保存 `platformUserId`；账号从 `idle` / `disconnected` 变为 `online`。

### 手动状态转移

```
POST /api/accounts/:id/transition { to, expectedFrom }
→ 200 { status }
/ 400 VALIDATION_ERROR / 404 ACCOUNT_NOT_FOUND
/ 409 ILLEGAL_TRANSITION / 409 CAS_CONFLICT
```

- 操作员手动标记状态；`expectedFrom` **必填**。
- 账号不存在 → 404；`expectedFrom → to` 不在转移表上 → `ILLEGAL_TRANSITION`；账号当前状态已不是 `expectedFrom` → `CAS_CONFLICT`。
- 标为 `disconnected` / `idle` 时调网关 `disconnect`。

## 4. 群

### 建群

```
POST /api/groups { creatorAccountId, memberAccountIds[] }
→ 202 { jobId } / 422 ACCOUNT_NOT_ONLINE / 400 VALIDATION_ERROR
```

- 语义：建群 + 拉人 + 把 `memberAccountIds[0]` 提升为管理员（流程见 A3）。
- 所有账号必须 `online`；`memberAccountIds` **至少 1 个且不含群主**。
- 新建群默认 `agentEnabled = false`、`autoKickEnabled = false`。

### 查询

```
GET /api/groups
GET /api/groups/:id
→ { id, gatewayGroupId, status, creatorAccountId, agentEnabled, autoKickEnabled,
    members: [{ accountId, platformUserId, role }], activeSequenceRunId, activeAgentRunId }
```

- `status: active | unreachable | left`（`leave-all` 完成后 `left`、`members = []`）。
- `role: creator | admin | member`——建群后创建者是 `creator`，`memberAccountIds[0]` 是 `admin`，其余 `member`。
- `activeAgentRunId` 只在有 `running` 的 run 时非空；`activeSequenceRunId` 只在有 `running` 的序列运行时非空。

### 修改开关

```
PATCH /api/groups/:id { agentEnabled?, autoKickEnabled? } → 200
```

### 发消息

```
POST /api/groups/:id/send { accountId, text }
→ 202 { clientMsgId } / 409 ACCOUNT_NOT_IN_GROUP / 409 ACCOUNT_UNAVAILABLE
```

- 操作员以某服务账号身份发一条消息，遵守 A2 的发送规则。
- 账号为 `idle` / `disconnected` / 终态时 → `409 ACCOUNT_UNAVAILABLE`。
- `rate_limited` 时**照常受理**、保持 `queued`，到期后按顺序发出。

### 全员退群

```
POST /api/groups/:id/leave-all → 202 { jobId }
```

- 语义见 B2（[06-requirements-B.md](06-requirements-B.md)）。

## 5. 任务

```
GET /api/jobs/:jobId → { status: running | finished | failed, errors: [{ step, code }] }
```

- `errors` 非空即 `failed`。
- `step ∈ create | invite | join:<accountId> | promote | leave:<accountId>`。

## 6. 消息时间线

```
GET /api/groups/:id/messages?before=<cursor>&limit=50
→ { items: [{ msgId, clientMsgId, senderPlatformUserId, isOwn, text, sentAt, deliveryStatus, failCode }], nextCursor }
```

- 按 `sentAt` **倒序**。
- 自己发的消息**从 `queued` 起就在列表里**（`sentAt` 先用受理时刻，发出后改为网关的 `sentAt`）；**一条消息只有一行**。
- `deliveryStatus` 仅对自己的消息有意义：`queued | accepted | sent | failed | unknown | cancelled`。
- `failed` / `cancelled` 时 `failCode` **必填**（网关错误码，或 `ACCOUNT_TERMINAL` / `GROUP_UNREACHABLE`）。

## 7. Agent 运行

### 单次运行详情

```
GET /api/agent-runs/:id
→ { id, groupId, status, endReason, summary,
    steps: [{ kind, toolUseId, name, input, resultSummary, isError, errorCode, auditVerdict, rawResponse }] }
```

- `status: running | finished | failed | blocked | cancelled`。
- `endReason`（仅 `status ≠ running` 时有值）：`final → finished`；`budget_exhausted | wall_clock | protocol_errors → failed`；`audit_blocked → blocked`；`cancelled → cancelled`。
- `kind: tool_use | final | protocol_error`（**协议错误步的 `toolUseId` / `name` / `input` 为 null**）。
- `rawResponse` 为 Agent 服务**原始响应体，截断到 2KB**。
- `isError = true` 时 `errorCode` 必填；`resultSummary` ≤ 200 字。

### 群的运行列表

```
GET /api/groups/:id/agent-runs → 最近的运行列表（字段同上，可不含 steps）
```

## 8. 序列

### 定义序列

```
POST /api/sequences (序列 JSON) → { id }
```

- 格式见 B1（[06-requirements-B.md](06-requirements-B.md)）。

### 启动运行

```
POST /api/groups/:id/sequence-runs { sequenceId, vars, stepVars }
→ 201 { runId }
/ 409 SEQUENCE_ALREADY_RUNNING
/ 422 { error: { code: 'UNRESOLVED_PLACEHOLDER', message, requestId, stepIndex, key } }
```

### 运行详情

```
GET /api/sequence-runs/:id
→ { status, currentStepIndex,
    steps: [{ index, status, scheduledAt, sentAt, clientMsgId, resolvedVars, varSources }] }
```

- run `status ∈ running | finished | failed | stopped`（`stopped` = 群变 `unreachable`）。
- 步骤 `status ∈ pending | accepted | sent | skipped | failed`。

## 9. WebSocket

```
WS /ws
```

- 连接后**先发** `{ type: 'auth', accessToken, sinceSeq? }`；服务端回 `{ type: 'auth', success: true }` 后开始推事件。
- 事件帧 `{ seq, type, payload }`；`seq` **全局单调递增**。
- 带 `sinceSeq` 时从该 seq 之后补发（可选实现，见 B4）。

### 事件类型（至少包括）

| type | payload |
|---|---|
| `account_status_changed` | `{ accountId, from, to }` |
| `account_terminal` | `{ accountId, status }` |
| `inconsistency` | `{ kind, ref, message }` |
| `message` | `{ groupId, msgId, isOwn }` |
| `agent_run` | `{ runId, groupId, status, endReason }` |
| `sequence_run` | `{ runId, groupId, status, currentStepIndex }` |

## 10.【解读】实现提示

- **messages 分页的稳定性**（A4：加载更早时新消息并发写入，不能重复或遗漏）+ 自己消息的 `sentAt` 会从受理时刻**改为**网关时刻（行位置会移动）→ 建议 keyset 分页（`sentAt, msgId` 复合游标），且要考虑 sentAt 变化对游标的影响。
- 自己的消息「一条只有一行」：出站记录（带 `clientMsgId`）与回流的 `message` 事件（带 `msgId`）要用 `message_sent.clientMsgId → msgId` 关联合并，不能插两行。
- WS `seq` 单调 + `sinceSeq` 补发 → 需要一张 WS 事件日志表（保留窗口够 3 秒补齐即可，见 B4）。
- `inconsistency` 事件的 `kind / ref / message` 字段结构题目未规定，自由设计（A2：DB 写入失败时推，让操作员看到）。
