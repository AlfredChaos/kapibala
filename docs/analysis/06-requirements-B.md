# 06 · B 组：进阶功能需求

> 来源：原文 §3.B（B1–B4）。除【解读】块外，均为原文规范的无损重组。

## B1 定时序列（含第 4 节页面 5）

### 序列 JSON 格式

```json
{
  "name": "…",
  "steps": [
    { "index": 1, "accountRole": "admin",  "text": "{event} 将于 {time} 开始，请提前准备", "delaySeconds": 10 },
    { "index": 2, "accountRole": "member", "text": "提醒：{event} 的资料已上传到 {location}", "delaySeconds": 5 }
  ]
}
```

### 发送账号选择

- `accountRole = admin`：由群里 `role ∈ {creator, admin}` 且 `online` 的账号发（**优先 `admin`**）。
- `accountRole = member`：从 `role = member` 且 `online` 的账号中按 **`accountId` 字典序取第一个**。
- 没有匹配账号时该步 `skipped`。
- **`rate_limited` 的账号不算没有**：该步**顺延**到限流结束后发。

### 变量（占位符）解析

- 启动参数：`vars`（key-value）+ `stepVars`（按步的 key-value，如 `{ "2": { "location": "共享盘/第二季度" } }`）。
- 文本里的 `{key}` 在**发送时**解析；key 匹配 `[A-Za-z0-9_]+`。
- 取值规则：
  - 开始时的取值 = `vars`；
  - 某一步在 `stepVars` 里给了值，**从这一步起后续步骤都用新值**，直到更晚的步骤再次给值；
  - `stepVars` 里的空字符串 `""` 表示**这一步不改**；
  - `vars` 里的 `""` 视为**未提供**。
- **预检**：启动前检查**所有步骤**，任何 `{key}` 解析不到 → `422 UNRESOLVED_PLACEHOLDER`，**一条都不发，也不留下运行中的记录**（之后可以正常启动）。
- `GET /api/sequence-runs/:id` 里每步的 `resolvedVars` 为**最终取值**；`varSources` 标每个 key 来自 `default`（即 `vars`）还是 `step:<index>`——**沿用前面某步的值时，标最初给出它的那一步**。

### 并发与排期

- 同一群同一时刻至多一个 `running` 的序列运行；**并发两次启动，恰好一个 `201`、一个 `409 SEQUENCE_ALREADY_RUNNING`**。
- 排期语义（**「发出」指收到 `message_sent` 的时刻**）：
  - 第 1 步在启动后 `delaySeconds` 秒发送；
  - 第 n 步在第 n-1 步**发出后** `delaySeconds` 秒发送；
  - **跳过的步骤视为在跳过时刻「发出」**。
- 跳过的步骤状态为 `skipped`，**有时间戳**，进度照常推进。

### 重启恢复

- 重启后：**只重排最早一个已过期的步骤**（重启时刻 + 该步 `delaySeconds`），后续步骤仍按「前一步发出后」排期，**不能一次性全部发出**。

## B2 群生命周期

### 建群时的错误处理

| 错误 | 处理 |
|---|---|
| `INVITE_NOT_READY` | 等到 `readyAfterMs` 后重试 |
| `INVITE_EXPIRED` | 重新申请链接后**重试一次**，群和账号状态都不变 |
| `ALREADY_MEMBER` | **视为成功**，直接 promote |

### `leave-all`（全员退群）

- 群里**所有服务账号退群，群主最后退**（群主先退的话，剩下的账号无法再操作）。
- 非群主账号退群失败 → 记入 `errors[]`；**其余非群主账号继续退，群主不退**，job `failed`；失败的账号**在你的数据库和网关里都仍是成员**。
- 完成后，你数据库里的成员表与网关的成员列表**一致**。

## B3 登录会话

- refresh token **只通过 HttpOnly cookie 下发，不放在响应体里**。
- `POST /api/auth/refresh`（读 cookie）→ `{ accessToken }` + 新的 `Set-Cookie`。
- refresh token **每次使用后轮换**；旧的再被使用 → `401`，并且**整个会话作废**：之前换出的新 refresh token 和新 access token **都立即失效**。
- `POST /api/auth/logout` 之后，**同一个 access token 立即失效**。
- 前端：access token 过期后自动续期；**多个请求同时遇到 401 时只发一次 refresh**（单飞）。

## B4 断线补齐与 agent 步骤详情

- 前端断线期间发生的事件，重连后 **3 秒内**出现在页面上，且**不重复**。
- 第 4 节页面 4（Agent 运行详情）见 [08-frontend.md](08-frontend.md)。

## 【解读】B 组难点提示

- **B1 排期是"事件驱动链"而非固定时刻表**：每步的 `scheduledAt` 依赖前一步的 `message_sent`，所以运行中的步骤没有绝对的未来时刻可提前计算（重启恢复也因此只能"重排最早过期的一步"）。
- `stepVars` 语义是**持续生效的覆盖**（从该步起一直用新值），不是只影响该步——预检和 `varSources` 都要按这个语义实现。
- `vars` 的 `""` = 未提供（会导致 422），`stepVars` 的 `""` = 不改（继承前值）——两者语义相反，容易写反。
- B2 `leave-all` 的失败语义是"尽力而为 + 群主保底"：失败的账号留在群里（DB 与网关一致），这是为了群仍可操作。
- B3 的"复用检测"需要保存 refresh token 的**代际链**（或版本号）：任何旧 token 再出现即作废整链。
