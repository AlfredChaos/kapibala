# 15 · 控制台前端设计（web 包）

> 覆盖：A6（五个页面）、B3 会话（登录/续期/登出的前端半边）、B4 实时（WS 客户端）、A4 的时间线交互半边。
> 定位：轻量设计——确定**数据流与状态正确性**（G2，审查报告 §2.1），不做视觉规范（题目明说不需要 i18n/主题/响应式；全局 UI 测试策略只要求状态正确性）。
> 测试边界（全局 UI 测试策略）：只写第 1 层（纯函数）与第 2 层（组件/集成）测试；E2E（C3）仅在明确要求时做；感官验收由作者人工完成。

## 1. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | React 18 + TypeScript strict + Vite | AGENTS.md 既定 |
| 服务端状态 | TanStack Query（Query/Series per key） | REST 数据的缓存、失效、重试开箱即用；本项目几乎全部状态是服务端状态 |
| 本地状态 | 组件 `useState` + 少量 Context（auth 会话） | 无跨页复杂客户端状态，不引入 Redux/Zustand |
| WS | 单例 `WsClient` + hook `useWsEvent(type, handler)` | §3 |
| 路由 | React Router（6 页 + 登录） | 常规 |
| HTTP | fetch 封装 + 拦截器（401 单飞续期，§4） | 不引 axios |

## 2. 页面 × 数据流

| 页面 | 路由 | 数据源（REST + WS） | 关键交互与状态规则 |
|---|---|---|---|
| 1 登录 | `/login` | `POST /api/auth/login` | 存 access（refresh 由 HttpOnly cookie 承载）；错误按 `error.code` 显示（`UNAUTHORIZED`）；登录后跳 `/dashboard`（工作台；初版写 `/accounts`，c922c92 起落地页为工作台） |
| 0 工作台 | `/dashboard` | `GET /api/accounts` + `GET /api/groups` + `GET /api/groups/:id/agent-runs` + `GET /api/messages/activity` + WS 全量 | 健康总览：账号在线/风险计数、群数、活跃 run 指针；近 30 分钟消息柱状图（服务端分桶基线 + WS 实时叠加）；「需要注意的 run」（blocked/failed）+ 实时事件流 |
| 2 账号列表 | `/accounts` | `GET /api/accounts` + WS `account_status_changed` / `account_terminal` | 每行：状态徽标、`platformUserId`、`rateLimitedUntil`（倒计时）。**connect 按钮**：仅 `idle/disconnected` 可见可用（[03](03-account-module.md) §2 前置集合）；**transition 面板**：`expectedFrom` 取当前状态，`to` 只列转移表上该状态的合法目标（静态表与 03 §1 同源；`to='rate_limited'` 时必须填 `rateLimitedUntil`，D3-4）——**非法目标不出现在 UI**，把 `ILLEGAL_TRANSITION` 留给并发竞争。viewer：写操作按钮不渲染（`role` 来自会话） |
| 3 群详情/时间线 | `/groups/:id` | `GET /api/groups/:id`、`GET /api/groups/:id/messages?before=` + WS `message` / `sequence_run` / `agent_run` / `inconsistency` / `job` | 时间线 = keyset 分页（§5）+ WS 原地更新；自己消息按 `clientMsgId` 显示 `deliveryStatus` 徽标（queued→accepted→sent / failed(failCode) / cancelled）；**agent run blocked 醒目提示**（顶部横幅 + run 区块标红，A5 audit_blocked 可操作员可见）；发送表单（选账号 + text，前端先做非空与 `TEXT_MAX_LENGTH` 校验）；开关 `agentEnabled`/`autoKickEnabled`（viewer 只读）；页面含最近 run 列表入口 |
| 4 Agent run 详情 | `/agent-runs/:id` | `GET /api/agent-runs/:id` + WS `agent_run` | steps 时间线：每步 `kind`/工具名/`input`/`resultSummary`/`isError+errorCode`/`auditVerdict`/`rawResponse`（折叠展示，2KB 截断已由后端做）；协议错误步显示 `errorCode`（`toolUseId/name/input=null`）；blocked/failed 的 `endReason` 徽标 |
| 5 序列 | `/sequences` | `GET`（定义列表）、`POST /api/sequences`、`POST /api/groups/:id/sequence-runs`、`GET /api/sequence-runs/:id` + WS `sequence_run` | 定义表单（steps 编辑：index/accountRole/text/delaySeconds，校验同 [07](07-sequence-module.md) §1）；启动表单（选群 + `vars`/`stepVars` JSON 编辑器）；**预检失败 422 展示**：`stepIndex` + `key` 定位到出错的步骤行高亮；**预检成功弹窗**：复用该 run steps 的 `resolvedVars`/`varSources` 逐步展示（值 + 来源 `default`/`step:<i>`）供确认后提交；运行视图：每步 `status`/`scheduledAt`/`sentAt`，`currentStepIndex` 跟随 WS 推进 |

路由守卫：未登录 → `/login`；viewer 访问写操作页不受限（按钮级控制），服务端仍是权威（403 处理为提示）。

## 3. WS 客户端（B4 的前端半边）

```
WsClient（单例，模块级）:
  connect():
    new WebSocket('/ws')
    on open → 发 { type:'auth', accessToken, sinceSeq: lastSeq }
    on auth success → 进入实时模式；auth 失败(token 过期) → 走 §4 刷新后重连
  on message(frame { seq, type, payload }):
    if frame.seq <= lastSeq → 丢弃（seq 去重，补发与实时交叠不重复）
    lastSeq = frame.seq; dispatch(frame)
  on close → 指数退避重连（500ms 起 ×2，上限 5s），重连成功即补齐（断线 ≤3s 的验收
            依赖服务端补发，前端职责是不丢 lastSeq、不重复应用事件）
  lastSeq 持久化: sessionStorage（刷新页面用旧 seq 补发换取不漏事件，重复由 seq 去重）
```

- 事件分发：`useWsEvent(type, handler)` 订阅；handler 里对 Query 缓存做**精确 patch**（如 `message` 事件 → 更新对应 `['group', id, 'messages']` 缓存里的行）或 `invalidateQueries`（如 `agent_run` 终态 → 重拉 run 详情一次拿全量 steps）。
- `inconsistency` 事件：全局 toast（kind 分类着色），`ws_backlog_expired` → 触发当前页全量 refetch（页面级兜底，对齐 [08](08-realtime-module.md) §2.2）。

## 4. 401 单飞续期（B3 前端半边）

fetch 封装拦截：任一请求 401 → 若无进行中的刷新则 `POST /api/auth/refresh`（共享同一个 promise，并发 401 只发一次刷新）→ 成功后重放原请求；刷新也 401（会话已被复用作废/登出）→ 清空会话跳 `/login`。WS auth 失败同路径。

## 5. 时间线合并（A4「不重不漏」的前端半边）

- 列表状态：`items: Map<messageId, Row>`（行键 = `msgId ?? clientMsgId`——queued 阶段 `msgId=null`，`message` 事件回填 `msgId` 后**沿用同一行**原地更新键值，不插入新行，对应后端一行原则 [05](05-messaging-module.md) §4）；
- WS `message` 事件（payload 含 `clientMsgId?/deliveryStatus?`，[08](08-realtime-module.md) §2.3）：按 `msgId ?? clientMsgId` 定位行 → 原地更新（`deliveryStatus` 流转、`sentAt` 变化）；查无此行且为首屏上方新消息 → 插入顶部；
- 「加载更早」：`before` 游标栈，只向前翻页；WS 增量与翻页正交（后端 [05](05-messaging-module.md) §5.2 两通道职责分离的前端配合面：keyset 边界内的行只 patch 不重排，`sentAt` 上移的行留在原位仅更新字段——排序以服务端查询为准，避免前端重排抖动）。

## 6. 组件 / 集成测试点（第 1/2 层）

| 测试对象 | 层 | 断言 |
|---|---|---|
| `wsClient` 帧处理纯函数（`applyFrame(lastSeq, frame)`） | 1 | seq 去重（旧帧丢弃）、lastSeq 单调推进 |
| `mergeTimelineItem(map, wsEvent)` | 1 | msgId 回填沿用同一行键；deliveryStatus 只前进不倒退；unknown→sent 更新 |
| 重连退避计算 `nextBackoff(attempt)` | 1 | 500ms 起 ×2 封顶 5s |
| 401 单飞：并发两请求 + 刷新端点 mock | 2 | refresh 恰好调用一次、两请求均重放成功；刷新 401 → 跳登录 |
| 账号页 transition 面板 | 2 | 合法目标集合随当前状态变化（online → idle/disconnected/…）；`to='rate_limited'` 缺 `rateLimitedUntil` 时提交禁用；viewer 无写按钮 |
| 序列预检 422 展示 | 2 | `stepIndex`/`key` 高亮对应步骤行；成功弹窗渲染 `resolvedVars`/`varSources` |

不写：视觉快照、布局断言、Playwright（除非 C3 获准）。

## 7. 人工验收清单（交付时 README 同步）

断线 3s 补齐（拔网/杀 WS）、queued→accepted→sent 徽标流转、blocked 横幅、viewer 只读、预检弹窗与 422 高亮、登录过期跳转——以上感官路径由作者人工过一遍并在完成度表勾选。
