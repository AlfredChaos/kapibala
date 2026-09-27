# 03 · 外部服务 B：Agent 服务契约

> 来源：原文 §2.2。除【解读】块外，均为原文规范的无损重组。
> 定位：Agent 服务扮演一个**只能通过工具调用与外界交互的"大脑"**——它不直接碰你的数据库或网关，一切外界操作（读消息、发消息、踢人）都由你的后端代为执行。

## 1. 协议形状（Anthropic Messages API 的 tool use 形式）

- `content` 是**块数组**；`tool_result` 放在 `role: "user"` 的消息里；用 `stop_reason` 区分轮次结果。

### `POST /agent/turn` 请求

```json
{
  "runId": "…",
  "tools": [ { "name", "description", "input_schema" } ],
  "messages": [
    { "role": "user",      "content": [ { "type": "text", "text": "<触发上下文 JSON 串，格式见 §3>" } ] },
    { "role": "assistant", "content": [ { "type": "tool_use", "id": "tu_1", "name": "get_recent_messages", "input": { "limit": 10 } } ] },
    { "role": "user",      "content": [ { "type": "tool_result", "tool_use_id": "tu_1", "content": "{\"messages\":[…],\"truncated\":false}" } ] }
  ]
}
```

- `runId`：**由你生成**，与 `GET /api/agent-runs/:id` 的 id 相同；Agent 服务按 runId 维护会话状态，**同一个 run 的所有请求必须使用同一个 runId**。
- `tools`：必须**恰好是下表 4 个工具**；`input_schema` 是合法 JSON Schema，且 `required` **覆盖全部入参**，否则 `400 TOOLS_INVALID`。

### 响应（合法形状，每轮恰好一个块）

```
200 { "stop_reason": "tool_use", "content": [ { "type": "tool_use", "id": "tu_2", "name": "send_message", "input": { … } } ] }
200 { "stop_reason": "end_turn", "content": [ { "type": "text", "text": "…" } ] }
```

补充：`tool_result` 的 `is_error` 可省略，省略视为 `false`。

## 2. 响应合法性判定（`BAD_JSON` 的定义）

`/agent/turn` 出现以下任一情况，记为 `BAD_JSON` 协议错误（处理方式见 A5 第 3 条，[05-requirements-A.md](05-requirements-A.md)）：

1. 返回**非 2xx**；
2. 响应体**不是合法 JSON**——外面套了 markdown 代码围栏、或前后夹着文字，**也算不合法**；
3. JSON 合法但**形状不符**：缺 `stop_reason`、块数不等于 1、`stop_reason` 与块类型不一致。

## 3. 触发上下文（`messages[0]` 的 text，JSON 串）

```json
{
  "groupId": "…",
  "triggerMessages": [ { "msgId", "senderPlatformUserId", "text", "sentAt" } ],
  "policy": { "autoKickEnabled": false },
  "ownPlatformUserIds": [ "…" ]
}
```

- `triggerMessages` 按 `sentAt` **升序**。

## 4. 工具（名字与入参固定，恰好 4 个）

| 工具 | 入参 | 成功时 tool_result 的 content（JSON 串） |
|---|---|---|
| `get_recent_messages` | `{ limit: number }` | `{ messages: [{ msgId, senderPlatformUserId, isOwn, text, sentAt }], truncated }`——按 `sentAt` 升序，**包含触发消息本身和 run 期间新到的消息**；`limit` 上限 50（超过按 50 处理）；单条 `text` 超过 500 字截断并置 `truncated: true` |
| `send_message` | `{ text: string, idempotency_key: string }` | `{ clientMsgId, deliveryStatus }`——在该消息变为 `accepted` 或 `sent` 后返回（**最多等 5 秒**）。消息变为 `failed` 时返回错误：群不可写 → `GROUP_UNREACHABLE`；账号停用、失效或中途变终态 → `SEND_FAILED`。5 秒后仍无法确认是否发出 → `SEND_TIMEOUT` |
| `kick_user` | `{ platform_user_id: string, reason: string }` | `{ kicked: true }` |
| `finish` | `{ summary: string }` | 记一步 `{ ok: true }`，**不再调 `/agent/turn`** |

## 5. 错误 tool_result

- 形状：`is_error: true`，content 为 JSON 串 `{ "code", "message", "hint"? }`。
- 码表（13 个）：

  `UNKNOWN_TOOL` / `INVALID_INPUT` / `DUPLICATE_TOOL_USE_ID` / `BAD_JSON` / `TURN_TIMEOUT` / `AUDIT_REJECTED` / `POLICY_DENIED` / `SEND_TIMEOUT` / `SEND_FAILED` / `NO_AVAILABLE_ACCOUNT` / `GROUP_UNREACHABLE` / `OWNER_LEFT` / `NO_PERMISSION`

- Agent 服务根据 `is_error` 与 `code` 决定下一步；`message` / `hint` 供模型理解。
- 它的重试会使用**新的 `tool_use.id`**；`tool_use.id` 重复时**先按协议错误处理**。

## 6. 结束语义

- 收到 `finish` 工具 → run `finished`，`endReason = final`，`input.summary` 存为 run 的 `summary`。
- 收到 `stop_reason: end_turn` → 同样结束，`text` 存为 `summary`，**不发到群里**。

## 7. 审计端点

```
POST /agent/audit { "text": "…", "groupId": "…" }
→ 200 { "verdict": "pass" | "fail", "reason": "…" }
```

## 8. Agent 服务可能出现的（恶劣）行为

这是你需要防御的行为全集，也是 mock agent 要内置的故障开关：

- 响应体不是合法 JSON，或 JSON 外面套了 markdown 代码围栏，或前后夹着一段文字。
- 调用**不在 `tools` 里**的工具；或入参不符合 `input_schema`。
- 同一个 `tool_use.id` 用**两次**。
- 拿到 `send_message` 的结果后（成功或错误，**尤其 `SEND_TIMEOUT`**），用**同一个 `idempotency_key`** 再调一次 `send_message`。
- 一直调工具不结束；或连续多次用**同样的入参**调 `get_recent_messages`。
- 调 `get_recent_messages { limit: 100000 }`。
- 响应很慢：可能 8 秒左右，也可能更久，**甚至不返回**。
- `audit` 端点：返回 `500`；或返回 `200` 但 body 不是合法 JSON、没有 `verdict` 字段、`verdict` 是别的值；或响应很慢、不返回。

## 9.【解读】对实现的直接启示

- **会话历史由你持久化**（`messages` 数组每轮追加），Agent 服务只按 runId 记状态——run 崩溃恢复（A5-8）时用同一 runId 续传同一份历史即可。
- BAD_JSON 要分三层识别：HTTP 层（非 2xx）、JSON 解析层（含围栏 / 夹文）、形状校验层（stop_reason / 块数 / 类型一致性）。
- `send_message` 工具的 5 秒等待窗口与 A2 的 504 判定窗口（5 秒）对齐：`SEND_TIMEOUT` 对应你的 `deliveryStatus = unknown` 场景，此时消息**可能已发出**——绝不能当失败处理，这正是幂等 key 存在的理由。
- §8 的坏行为清单 = 自测清单：每一条都应有一个对应测试（mock agent 开关打开 → 观察你的 run 结束状态与 steps 记录）。
