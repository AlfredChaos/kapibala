# 00 · SPEC 规范书（kapibala）

> 本文是全部实现任务的**规范真值来源**：系统边界、四包职责、模块级规格、质量规范、验收总表、裁剪预案。
> 规范源优先链（上位覆盖下位，冲突时按此裁决）：
> 1. `/Users/alfredchaos/home/work/kapibala/docs/requirement.md`（契约，只读）
> 2. `/Users/alfredchaos/home/work/kapibala/AGENTS.md`（项目宪法）
> 3. `/Users/alfredchaos/home/work/kapibala/docs/analysis/10-quick-reference.md`（契约数字/错误码速查，只读）
> 4. `/Users/alfredchaos/home/work/kapibala/docs/design/`（README 契约解释声明 25+ 条 + 01–15）
> 5. `/Users/alfredchaos/home/work/kapibala/docs/review/01-design-review-2026-09-27.md`（作战图与残留项）
> 6. `/Users/alfredchaos/home/work/kapibala/server/VITEST_PLAN.md`（测试映射总表）
>
> 本文不复制设计文档全文，只固化**实现必须遵守的接口、方向、边界与验收归属**；细节以引用章节为准。

---

## 1. 系统边界与包职责

```
控制台前端 web (React18+TS+Vite, :5173)
      │ REST(/api/*) + WebSocket(/ws)
server (Node≥22 + TS strict + Fastify + pg + ws, :3000)
 ├── 账号管理(A1) ├ 群/成员/时间线(A2-A4) ├ 定时序列(B1) ├ Agent 接入(A5)
 │        │ HTTP                        │ HTTP
 │   mock-gateway (:4100)         mock-agent (:4200 scripted / :4300 anthropic)
 │   (HTTP + SSE, 28 故障开关)     (POST /agent/turn|audit, 19 故障开关)
 └── PostgreSQL ≥16 (:5432, docker compose, 唯一真值)
```

### 1.1 包职责表

| 包 | 职责 | 规范源 | 明确不做 |
|---|---|---|---|
| `server` | 全部业务规则：账号状态机、群生命周期 job、消息出站/入站管线、agent 编排、序列调度、SSE 消费、WS 推送、认证会话。唯一触碰 `DATABASE_URL` 的包 | design/01 §2、03–10 | 不做视觉；不引入 ORM/Redis/MQ；不实现 design/13 扩容触发器 |
| `web` | 五页面控制台：登录、账号列表、群详情/时间线、agent run 详情、序列。WS 客户端（seq 去重/sinceSeq 补齐）、401 单飞续期、keyset×WS 时间线合并 | design/15 | 不做 i18n/主题/响应式；只写第 1/2 层测试；E2E 仅 C3 一条 |
| `mock-gateway` | §2.1 网关契约的保真模拟器：内存状态 + append-only 事件账本 + `/_test` 控制平面 + 28 项故障开关；`GET /_test/counters` 是 S1–S8 断言真值 | design/14 | 不做任何业务决策（重发控制/幂等/限流回避全在 server）；契约行为禁止弱化（宪法 §3-8） |
| `mock-agent` | §2.2 Agent 契约模拟：单包双 provider（scripted 剧本引擎默认 / anthropic=C2）；`AGENT_MODE` 切换；19 项故障开关；无状态全量历史规约 | design/12 | 不做业务决策（账号选择/审计门禁/幂都在 server） |
| `packages/contract`（内部共享类型包，非交付服务） | §2.2 协议形状类型、网关错误码类型、自有 API 错误码、WS 事件 payload 类型。零运行时依赖，仅类型与字符串字面量联合 | design/12 §2「workspace 共享类型」、design/06 §12 风险 1 | 不含任何契约数字（数字常量只在 `server/src/constants.ts`，见 §4.5） |

**【共享类型位置裁决】** design/12 §2 要求「server 的 agentclient 与两个 provider 用同一份类型」的 workspace 共享模块。两个候选（`server/src/contract/` vs 独立小包）中取 **`packages/contract`**（无聊、标准的选择）：mock 包不得依赖 server 包（mock 是独立交付物，模拟的是外部服务）；pnpm workspace 需在 `pnpm-workspace.yaml` 同时收录四个服务目录与 `packages/*`。落地次序（F1）：T-P0-01 建立**占位骨架**（`packages/contract` 的 package.json/tsconfig/index.ts 空导出 + `pnpm-workspace.yaml` 预收录 `packages/*` + 四包预声明 `@kapibala/contract: workspace:*`，否则前向声明的依赖使 `pnpm install` 在 T-P0-02 之前失败）→ T-P0-02 只填充 src 类型文件与 index.ts 导出（不动包配置）。下游任务对其**只读**；变更必须回到 owning 任务（T-P0-02，包配置回 T-P0-01）串行处理并通知全部消费者。

### 1.2 端口与环境变量

| 变量 | 包 | 说明 |
|---|---|---|
| `PORT` / `DATABASE_URL` / `GATEWAY_URL` / `AGENT_URL` | server | 缺失即拒绝启动（design/01 §6.1）；`AGENT_URL` 单点注入支撑 C2 切换 |
| `AGENT_TURN_TIMEOUT_MS`（默认 12000）/ `AGENT_MAX_CONCURRENT_RUNS`（默认 50）/ `MEDIA_RETENTION_DAYS`（默认 30）/ `WS_EVENT_RETENTION_MINUTES`（默认 30） | server | 可选配置 |
| `PORT`（:4100）/ `GATEWAY_SEED_ACCOUNTS`（默认 `acc-01,acc-02,acc-03,acc-04`，与 server seed 对齐） | mock-gateway | design/14 §6 |
| `PORT`（:4200）/ `AGENT_MODE`（`scripted`\|`anthropic`）/ `ANTHROPIC_API_KEY`（只进本地 `.env`）/ `LLM_MODEL` | mock-agent | design/12 §6 |

默认端口：server `:3000` · web `:5173` · mock-gateway `:4100` · mock-agent `:4200`（anthropic 实例 `:4300`）· postgres `:5432`。

---

## 2. server 包模块级规格

### 2.1 模块划分与依赖方向（design/01 §2，实现不得偏离）

```
http / ws / events / scheduler / recovery          ← 入口层（请求/事件/定时驱动）
        │
        ▼
modules/*（auth accounts groups messages agent sequences）  ← 全部业务规则
        │
        ▼
db / gateway / agentclient / config                ← 基础设施
```

- 上层依赖下层，**禁止反向**；跨 modules 只经显式导出的 service 函数与 `TxContext` 协作（design/03 §7 的事务回调模式），禁止 import 内部实现。
- `gateway/` 与 `agentclient/` 是**唯一**允许触碰 `GATEWAY_URL` / `AGENT_URL` 的代码（design/01 §6.5）。

### 2.2 模块服务接口（导出面约定）

| 模块 | 导出服务（签名语义） | 规范源 |
|---|---|---|
| `config/` | `loadConfig(): Config`（缺失必填项 → 进程退出 + error 日志） | 01 §6.1 |
| `db/` | `getPool()`、`tx(fn)`（事务助手）、`migrate()`（runner：事务内「执行 SQL + 记版本」）、`ensureSchemaVersion()`（落后/超前均拒绝启动）、seed CLI | 01 §6.4、02 §1.1/§10 |
| `http/` | `buildApp(): Fastify`（requestId 中间件、统一错误映射、auth guard）、`registerRoutes`（各域路由文件注入） | 01 §6.2/§6.3 |
| `ws/` | `WsHub`：连接管理、auth 帧验证、`sinceSeq` 补发（回放 `ws_event` 表）、提交后投递 | 08 §2 |
| `events/` | SSE 消费循环（游标=连续前缀）、`dispatch(tx, event)` 事件分发、死信三写事务、死信重试 | 08 §1 |
| `scheduler/` | 1s 周期扫描注册表：限流到期、unknown 推进、join 超时、死信重试、trigger 兜底、媒体清理、ws_event/auth_token 清理 | 01 §3、各章 |
| `recovery/` | 启动恢复六扫描（design/10 §3 顺序）：出站消息→agent run→序列 run→job→账号→死信；恢复=登记+异步交接（D3-2） | 10 §3 |
| `gateway/` | `connect/disconnect/createGroup/invite/join/promote/kick/leave/send/queryByClientId/listMembers/fetchEvents(SSE)/fetchMedia`；超时与类型化错误 `{ status, code, body }` | 01 §4.4/§6.5 |
| `agentclient/` | `turn(req)/audit(req)`；三段式响应校验（HTTP 状态→JSON 含围栏/夹文→形状） | 01 §6.5、06 §4/§6 |
| `modules/auth/` | `login/refresh/logout/verifyAccessToken/requireRole`（权限矩阵：viewer 写操作 403） | 09 |
| `modules/accounts/` | `connectAccount/transitionAccount/listAccounts/enterTerminal/registerRateLimit/resumeExpiredRateLimits`；`transitions.ts` 集中定义 15 条合法边 | 03 |
| `modules/groups/` | `acceptCreateGroup/executeCreateGroupJob/acceptLeaveAll/executeLeaveAllJob/getJob/getGroup/listGroups/patchGroup/applyMemberJoined/applyMemberLeft/markGroupUnreachable` | 04 |
| `modules/messages/` | `acceptOutbound(operator/agent/sequence 三入口)/runDispatcher/adjudicateUnknown/finalizeSent/applyInboundMessage/listTimeline` | 05 |
| `modules/agent/` | `maybeTriggerRun/endRunAndChain/sweepTriggerBacklog/claimAndExecuteRun`（executor：turn 循环/协议错误分流/审计/工具/幂等 key/恢复） | 06 |
| `modules/sequences/` | `createSequence/startSequenceRun/advanceDueSteps/recoverSequenceRuns/getSequenceRun`（预检+变量合并+链式排期） | 07 |

### 2.3 事务边界（引用 design/10 §1 E1–E14；铁律：任何 Exx 执行前其意图必须已由已提交的 Txx 落库）

| # | 外部效果 | 前置持久化点 | 崩溃恢复语义 |
|---|---|---|---|
| E1 | 网关 `POST /groups` | T1: job(create)+group(creating) | 重发（旧网关群成孤儿，无害） |
| E2 | 网关 `POST invite` | T2: job(invite 意图+context) | 重发（新链接覆盖 context） |
| E3 | 网关 `POST join` | T3: job(joining, members[x]=dispatching) | **不重发**——等 member_joined 或 10s 超时 |
| E4 | 网关 `POST promote` | T4: job(promote, promoteCalls=n) | 重发（计数已持久化，总数 ≤ 2 仍成立） |
| E5 | 网关 `POST kick` | T5: step(tool_dispatched, kick_target) | **不重发**：查成员列表判定（2s 收敛） |
| E6 | 网关 `POST leave` | T6: job(current=accountId) | **不重发**：查成员列表判定 |
| E7 | 网关 `POST send` | T7: message(queued, first_attempt_at=now) | **不重发**：转 unknown 判定路径 |
| E8 | 网关 `GET by-client-id` | 无副作用，探测结果条件更新写回 | 幂等可重试 |
| E9 | 网关 `POST connect` | 无前置（网关幂等）；T9 结果事务 | 重发无害 |
| E10 | 网关 `POST disconnect` | T10: 状态已 disconnected/idle | 恢复器补调（幂等） |
| E11 | `/agent/turn` | T11: step(turn_dispatched + dispatch_payload) | 用快照重发同轮（同 runId） |
| E12 | `/agent/audit` | step 内部子步骤，重试计数落库 | 以落库值为准 |
| E13 | agent `send_message` 创建出站 | T13: step(tool_dispatched, client_msg_id)+幂等 key 行+message(queued) 同一事务 | **不重发**：按 message 现状生成 tool_result |
| E14 | 任何 WS 推送 | T14: ws_event INSERT 与业务状态同一事务 | hub 只投已提交行；sinceSeq 以表为真值 |

数据模型（20 张表 = 19 张业务表 + `schema_migrations` 账本）与全部约束以 `/Users/alfredchaos/home/work/kapibala/docs/design/02-data-model.md` 为准；关键机制：`(group_id,msg_id) WHERE msg_id IS NOT NULL` 唯一、`client_msg_id` 唯一、每群单飞行两个部分唯一索引、`sort_key = COALESCE(msg_id, client_msg_id)` 生成列、CAS 条件更新、`gateway_event.event_id` PK、`ws_event.seq BIGSERIAL`。

---

## 3. mock-gateway / mock-agent / web 模块级规格

### 3.1 mock-gateway（design/14）

- 单进程、无 DB：内存状态（accounts/groups/messages by clientMsgId **有序列表**——R-F：同 clientMsgId 两条是两条落地记录，by-client-id 返回最早一条）+ append-only 事件账本。
- **eventId 分配器进程生命周期单调、跨 `/_test/reset` 不复用**（design/14 §1 关键坑；reset 可显式 `{ startEventId }` 抬高）。
- `/_test` 控制平面：`POST /_test/scenario { switch, params?, target? }`、`POST /_test/scenario/clear`、`POST /_test/reset`、`GET /_test/counters`（`sendCallsByAccount`/`sendCallsByClientMsgId`/`landedMessages`/`kickCalls`/`framesEmitted`）、`POST /_test/emit`。命名与语义以 design/14 §4/§5 为准，**禁止自创契约**。
- 28 项故障开关（gw-1..28）逐一对应契约行为（design/14 §5 映射表）；S3 回流是默认行为非开关。
- 对外可进程内装配（测试 import `createGatewayApp()`）或子进程随机端口。

### 3.2 mock-agent（design/12）

- 一个 HTTP 契约层（tools 校验：恰好 4 个 + required 全覆盖，否则 `400 TOOLS_INVALID`）+ 双 provider（`AGENT_MODE`）。
- **无状态全量历史规约**（design/12 §2.1）：响应只由请求 `messages` 决定；同 runId 重复请求 → 新响应（开关 `same_runid_redispatch` 测试此规约）。
- scripted：剧本按 `(runId, 调用序号)` 推进，播完回落默认剧本（`get_recent_messages → send_message → finish`）；`/_test/scenario` 装剧本。
- 19 项故障开关（ag-1..19，design/12 §7）；anthropic 模式不提供故障开关。
- anthropic provider（C2）：进出各一次形状映射（多块取首个有效块、`stop_reason` 映射）；audit 用 judge prompt，解析失败 → 500（落入「无结论」契约形态）。

### 3.3 web（design/15）

- React 18 + TS strict + Vite；TanStack Query + 组件 state + React Router + fetch 封装（不引 axios/Redux）。
- `WsClient` 单例：auth 帧 → seq 去重 → 指数退避重连（500ms 起 ×2 封顶 5s）→ `lastSeq` 持久化 sessionStorage。
- 401 单飞续期：并发 401 共享同一 refresh promise；refresh 401 → 跳登录。
- 时间线合并：行键 = `msgId ?? clientMsgId`；WS `message` 事件原地 patch，`sentAt` 上移不重排。
- 五页面数据流与测试点见 design/15 §2/§6；只写第 1 层（纯函数）与第 2 层（组件/集成）测试 + C3 单条冒烟。

---

## 4. 质量规范

### 4.1 SOLID 在本项目的映射

| 原则 | 本项目落地 |
|---|---|
| S 单一职责 | `modules/*` 按域分包（一域一目录）；每域一个 `transitions.ts` 集中状态机（design/01 §4.3）；`finalizeSent` 是出站确认唯一收口（design/05 §4.3）；mock 只按契约响应不做业务决策 |
| O 开闭 | 故障开关以 `/_test/scenario` 参数化注入而非分支复制；新增事件类型只扩 `ws_event.type` 联合与 handler 注册表 |
| L 里氏替换 | `packages/contract` 的协议类型是 server/mock-agent(C2) 双方共同基型；anthropic provider 与 scripted 对契约层完全可替换（只改 `AGENT_URL`） |
| I 接口隔离 | 模块间只依赖窄接口：`TxContext`、导出 service 函数；gateway/agentclient client 不暴露 HTTP 细节给 modules |
| D 依赖倒置 | 入口层（http/ws/events/scheduler/recovery）依赖 modules 接口而非实现；modules 依赖 db/gateway/agentclient 抽象边界；方向图见 §2.1，禁止反向 |

### 4.2 注释标准

- 关键函数（状态转移、事务边界、崩溃恢复分支、协议校验、合并路径）必须有**中文注释说明「为什么」**；契约行为注明出处章节（例：`// 先删占位行再更新 M 行：直接补另一侧身份会撞唯一索引（design/05 §4.3, D1-3）`）。
- 日志、错误信息、commit message 一律**英文**；错误日志必须带 `err`（含 stack）与上下文字段（eventId/runId/clientMsgId）。

### 4.3 错误处理标准

- 对外统一 `{ error: { code, message, requestId, ...业务字段 } }`；`401 → UNAUTHORIZED`、`403 → FORBIDDEN` 固定；schema 校验失败 → `400 VALIDATION_ERROR`；未知异常 → `500 INTERNAL` + error 日志（design/01 §6.3）。
- 领域层抛带 `code` 的 `AppError`（code ∈ 速查表 §4 枚举）；gateway client 抛类型化 `{ status, code, body }` 异常；**禁止静默吞错**。
- 时间对外 ISO 8601 UTC 字符串、无值 `null`；内部比较 epoch 毫秒；禁止本地时区。

### 4.4 测试标准（TDD）

- 三层：**单测**（纯函数/状态机/合并逻辑）→ **集成**（连真实 PostgreSQL + mock 进程内装配/子进程随机端口）→ **崩溃注入**（`withCrashPoint` + 子进程 kill -9 重启断言，design/10 §5）。
- 红-绿-重构：先写测试并确认**因正确的原因失败**，失败输出摘录进 JOURNAL；每个任务一个逻辑变更一个 commit。
- 测试资源隔离：每个连 PG 的 Vitest 文件独立 database（模板库 + 随机后缀）；mock 用例间 `/_test/reset`（eventId 计数器不回退，design/14 §1）。
- UI 只写第 1/2 层 + C3 单条 Playwright 冒烟（已授权，DRIVER-PROMPT 授权声明 2）。
- 断言必须指向行为与契约数字；变异抽查不变红 = 假绿 = reject（DRIVER-PROMPT §11-5）。

### 4.5 常量标准（I14）

- 全部契约数字（5s / 2s / 10s / 12 步 / 60s / 10–15s / 3 次 / ≤2 次 / 15min / 50 / 500 字 / 8KB / 200 字 / 2KB / 100–1500ms / 50–2000ms / 1–2s / 1–5s / ≤1s / 3s / 30 天）集中定义于 `server/src/constants.ts`，逐个标注出处；`server/tests/constants.test.ts` 逐个断言与 `/Users/alfredchaos/home/work/kapibala/docs/analysis/10-quick-reference.md` 一致。禁止无出处魔数、禁止取整。mock 与 web 的契约数字同样以命名常量定义并注明出处。

### 4.6 工程红线（DRIVER-PROMPT §11，审查发现即 reject）

`any`/非受控断言/静默吞错/本地时区/无出处魔数；违反「先持久化后外部效果」（§2.3 E1–E14）；进程内存承担唯一性/互斥；弱化 mock 契约行为；假绿测试；关键函数无注释；越界修改；修改 requirement/analysis（11-gotchas 追加除外）/已应用迁移。

---

## 5. 验收总表（可勾选清单；「任务」列 = 02-TASKS.md 归属任务）

> 需求矩阵编号与摘要以 `/Users/alfredchaos/home/work/kapibala/docs/design/11-verification.md` 为准（125 条：A21+B8+C21+D13+E39+F19+G3+H1）；本表只登记归属与验证载体。勾选状态在阶段门统一维护（与 `server/VITEST_PLAN.md` 同步）。

### 5.1 需求矩阵（design/11）

| 编号 | 摘要 | 任务 | 验证载体 |
|---|---|---|---|
| A-01 | login → accessToken；admin/viewer；15min | T-P0-07 | tests/auth/session.test.ts |
| A-02 | health → {ok, schemaVersion} | T-P0-04 | tests/health.test.ts |
| A-03 | GET /api/accounts 字段 | T-P2-05 | tests/accounts/state-machine.test.ts |
| A-04 | connect 端点语义 | T-P2-05 | tests/accounts/transition.test.ts |
| A-05 | transition 三段式错误码 | T-P2-05 | tests/accounts/transition.test.ts |
| A-06 | POST /api/groups 受理校验 | T-P3-05 | tests/groups/create-group-job.test.ts |
| A-07 | GET groups 全字段 | T-P3-08 | tests/groups/group-state.test.ts |
| A-08 | PATCH groups | T-P3-08 | tests/groups/group-state.test.ts |
| A-09 | POST send 受理 | T-P3-01 | tests/messages/outbound-dispatcher.test.ts |
| A-10 | leave-all 受理 | T-P3-07 | tests/groups/leave-all.test.ts |
| A-11 | GET /api/jobs/:jobId | T-P3-05 | tests/groups/create-group-job.test.ts |
| A-12 | messages 分页字段/一行原则 | T-P2-11, T-P3-04 | tests/messages/timeline-pagination.test.ts |
| A-13 | agent-runs/:id 字段 | T-P4-13 | tests/agent/turn-loop.test.ts |
| A-14 | agent-runs 列表 | T-P4-13 | tests/agent/turn-loop.test.ts |
| A-15 | POST /api/sequences | T-P6-01 | tests/sequences/precheck.test.ts |
| A-16 | sequence-runs 201/409/422 | T-P6-02 | tests/sequences/start-mutex.test.ts |
| A-17 | sequence-runs/:id 字段 | T-P6-05 | tests/sequences/run-query.test.ts |
| A-18 | WS auth/seq/sinceSeq | T-P2-10 | tests/ws/hub.test.ts |
| A-19 | WS 六类事件 payload | T-P2-10 | tests/ws/hub.test.ts |
| A-20 | 字段约定/错误体 | T-P0-04 | tests/health.test.ts + 各域 |
| A-21 | 环境变量 | T-P0-04, T-P8-02 | tests/migration.test.ts + C2 演示 |
| S-01 | S1 accepted→sent | T-P3-11 | tests/scenarios/s1.test.ts |
| S-02 | S2 双推无重复 | T-P3-11 | tests/scenarios/s2.test.ts |
| S-03 | S3 回流合并 | T-P3-11 | tests/scenarios/s3.test.ts |
| S-04 | S4 限流零试探 | T-P3-11 | tests/scenarios/s4.test.ts |
| S-05 | S5 同 key 重试 | T-P4-15 | tests/scenarios/s5.test.ts |
| S-06 | S6 坏响应 | T-P4-15 | tests/scenarios/s6.test.ts |
| S-07 | S7 并发启动 | T-P6-08 | tests/scenarios/s7.test.ts |
| S-08 | S8 预检 | T-P6-08 | tests/scenarios/s8.test.ts |
| G-01 | connect 同 platformUserId | T-P1-01, T-P2-05 | mock 契约测试 + state-machine |
| G-02 | ACCOUNT_OFFLINE 五操作 | T-P1-01/03/04, T-P3-02 | tests/messages/outbound-dispatcher.test.ts |
| G-03 | 离线补投语义 | T-P2-12, T-P2-11 | tests/messages/timeline-pagination.test.ts |
| G-04 | account_status + 自动移群 | T-P2-06, T-P2-09 | tests/accounts/terminal-side-effects.test.ts |
| G-05 | creator 即成员无事件 | T-P3-05 | tests/groups/create-group-job.test.ts |
| G-06 | invite 就绪/过期 | T-P3-06 | tests/groups/create-group-job.test.ts |
| G-07 | join 202/事件或永不到/ALREADY_MEMBER | T-P3-05, T-P3-06 | tests/groups/create-group-job.test.ts |
| G-08 | promote ≤2 / NO_PERMISSION | T-P3-06 | tests/groups/create-group-job.test.ts |
| G-09 | kick 1–5s/504 收敛/透传 | T-P4-10 | tests/agent/tools-kick.test.ts |
| G-10 | leave 200/500 | T-P3-07 | tests/groups/leave-all.test.ts |
| G-11 | 外部成员不建行 | T-P2-09 | tests/groups/member-projection.test.ts |
| G-12 | GET members 即时性 | T-P3-07, T-P4-10 | leave-all / tools-kick |
| G-13 | send 202 1–2s / sent 50–2000ms | T-P3-02 | tests/messages/outbound-dispatcher.test.ts |
| G-14 | 同步错误七种分流 | T-P3-02 | tests/messages/outbound-dispatcher.test.ts |
| G-15 | 429 计时重置 | T-P2-07 | tests/accounts/rate-limit.test.ts |
| G-16 | 网关不按 clientMsgId 去重 | T-P1-04, T-P3-02 | tests/messages/unknown-adjudicator.test.ts |
| G-17 | by-client-id 最早一条/2s 落地 | T-P1-04, T-P3-03 | tests/messages/unknown-adjudicator.test.ts |
| G-18 | 503 全端点 | T-P3-03 | tests/messages/unknown-adjudicator.test.ts |
| G-19 | SSE 六类/单调/since 独占/全历史 | T-P1-02, T-P2-03 | tests/events/cursor-prefix.test.ts |
| G-20 | message 事件字段/毫秒精度 | T-P2-08 | tests/messages/timeline-pagination.test.ts |
| G-21 | seed 预置 idle/null | T-P0-06 | tests/seed.test.ts |
| T-01 | turn 请求形状/同 runId | T-P4-05 | tests/agent/turn-loop.test.ts |
| T-02 | tools 恰 4/required 全覆盖 | T-P4-05 | tests/agent/turn-loop.test.ts（ag-19 反测） |
| T-03 | 恰一块/stop_reason/is_error 省略 | T-P4-06 | tests/agent/protocol-errors.test.ts |
| T-04 | BAD_JSON 三层定义 | T-P4-06 | tests/agent/protocol-errors.test.ts |
| T-05 | 触发上下文格式/升序 | T-P4-04 | tests/agent/trigger.test.ts |
| T-06 | get_recent_messages 语义 | T-P4-08 | tests/agent/budget.test.ts |
| T-07 | send_message 5s 等待/错误码 | T-P4-09 | tests/agent/tools-send-message.test.ts |
| T-08 | kick_user/finish 语义 | T-P4-08, T-P4-10 | tools-kick / budget |
| T-09 | 错误码表 13 个全覆盖 | T-P4-06..10 | protocol-errors + tools-* |
| T-10 | 重复 tool_use.id | T-P4-06 | tests/agent/protocol-errors.test.ts |
| T-11 | finish/end_turn 结束语义 | T-P4-05, T-P4-08 | turn-loop / budget |
| T-12 | 恶劣行为清单 | T-P4-02, T-P4-03 | mock 开关 ↔ 用例映射 |
| T-13 | audit 契约/3 次 blocked | T-P4-07 | tests/agent/tools-send-message.test.ts |
| A0-1 | 迁移可重复/落后拒启 | T-P0-04 | tests/migration.test.ts |
| A0-2 | 错误响应格式 | T-P0-04 | tests/health.test.ts |
| A0-3 | viewer 403 | T-P0-07 | tests/auth/session.test.ts |
| A1-1 | 转移表 15 边 | T-P2-05 | tests/accounts/state-machine.test.ts |
| A1-2 | 终态无出边/幂等 | T-P2-05, T-P2-06 | state-machine / terminal |
| A1-3 | until 刷新不算转移 | T-P2-07 | tests/accounts/rate-limit.test.ts |
| A1-4 | CAS 后写不覆盖 | T-P2-05 | tests/accounts/state-machine.test.ts |
| A1-5 | 终态副作用原子 | T-P2-06 | tests/accounts/terminal-side-effects.test.ts |
| A1-6 | WS 事件对应已保存状态 | T-P2-10 | tests/ws/hub.test.ts |
| A1-7 | 到期自动回 online | T-P2-07 | tests/accounts/rate-limit.test.ts |
| A2-1 | 出站全链不变量 | T-P3-02, T-P7-02 | crash-consistency |
| A2-2 | unknown 5s/重发一次 | T-P3-03 | tests/messages/unknown-adjudicator.test.ts |
| A2-3 | 入站去重/排序 | T-P2-08, T-P2-11 | timeline-pagination |
| A2-4 | isOwn 不触发 | T-P2-08 | tests/scenarios/s3.test.ts |
| A2-5 | 写失败不中断不丢 | T-P2-04 | tests/events/dead-letter.test.ts |
| A2-6 | 停机事件补处理 | T-P2-03 | tests/events/resume.test.ts |
| A2-7 | RATE_LIMITED 顺延 | T-P3-02 | tests/scenarios/s4.test.ts |
| A2-8 | 终态两码 | T-P2-06 | terminal-side-effects |
| A2-9 | GROUP_WRITE_FORBIDDEN 级联 | T-P3-08 | tests/groups/group-state.test.ts |
| A2-10 | SENDER_NOT_IN_GROUP/OFFLINE | T-P3-02 | outbound-dispatcher |
| A2-11 | NOT_MEMBER_YET ≤2/JOIN_TIMEOUT | T-P3-06 | create-group-job |
| A2-12 | OWNER_LEFT/NO_PERMISSION 透传 | T-P4-10 | tools-kick |
| A3-1 | 建群五段异步 | T-P3-05 | create-group-job |
| A3-2 | 成员表写入时机 | T-P3-05, T-P2-09 | create-group-job / member-projection |
| A4-1 | 分页不重不漏 | T-P2-11, T-P5-05 | timeline-pagination + web 层 1 |
| A4-2 | WS seq 单调 | T-P2-10 | tests/ws/sinceseq.test.ts |
| A5-1 | 触发/单飞行/积压合并 | T-P4-04 | tests/agent/trigger.test.ts |
| A5-2 | 循环/三重预算 | T-P4-05 | tests/agent/budget.test.ts |
| A5-3 | 协议错误两类 | T-P4-06 | tests/agent/protocol-errors.test.ts |
| A5-4 | 审计门禁 | T-P4-07 | tools-send-message |
| A5-5 | 执行账号 | T-P4-09, T-P4-10 | tools-* |
| A5-6 | POLICY_DENIED | T-P4-10 | tools-kick |
| A5-7 | 幂等 key | T-P4-09 | tests/agent/idempotency.test.ts |
| A5-8 | 恢复同 runId | T-P4-11, T-P7-03 | crash-recovery |
| A5-9 | 8KB/200 字截断 | T-P4-08 | budget |
| A5-10 | cancelled 当前步后 | T-P4-12 | turn-loop（X-2 回归） |
| A5-11 | 重复调用预算兜底 | T-P4-08 | budget |
| A5-12 | 每步可查看 | T-P4-13 | turn-loop |
| A6 | 前端页面 1–3 | T-P5-01..05 | web 第 1/2 层 + 人工清单 |
| B1-1 | 序列 JSON 校验 | T-P6-01 | precheck |
| B1-2 | 选账号规则 | T-P6-03 | scheduling |
| B1-3 | skipped/顺延 | T-P6-03 | scheduling |
| B1-4 | vars/stepVars 双语义 | T-P6-01 | precheck（推演表） |
| B1-5 | 预检 422 零副作用 | T-P6-02 | start-mutex（S8） |
| B1-6 | resolvedVars/varSources | T-P6-02 | precheck |
| B1-7 | 单飞行/S7 | T-P6-02 | start-mutex |
| B1-8 | 链式排期锚点 | T-P6-03 | scheduling |
| B1-9 | skipped 时间戳 | T-P6-03 | scheduling |
| B1-10 | 重启只重排最早 | T-P6-04, T-P7-04 | restart-reschedule |
| B2-1 | 建群错误三行 | T-P3-06 | create-group-job |
| B2-2 | leave-all 编排 | T-P3-07 | leave-all |
| B2-3 | 完成后两端一致 | T-P3-07 | leave-all |
| B3-1 | refresh HttpOnly cookie | T-P0-07 | tests/auth/session.test.ts |
| B3-2 | 复用作废整会话 | T-P0-07 | tests/auth/session.test.ts |
| B3-3 | logout 即失效 | T-P0-07 | tests/auth/session.test.ts |
| B3-4 | 前端单飞续期 | T-P5-01 | web 层 2 |
| B4-1 | 断线 3s 补齐 | T-P2-10, T-P5-02, T-P6-08 | sinceseq + web 层 1 |
| B4-2 | 页面 4 | T-P6-06 | web 层 2 |
| C1 | 媒体落盘/清理 | T-P8-01 | tests/messages/media.test.ts |
| C2 | 真实 LLM 切换 | T-P8-02 | C2 演示记录 |
| C3 | Playwright 冒烟 | T-P8-03 | web e2e smoke |
| H-1 | 重启不变量总则 | T-P7-02..04（+各域恢复任务） | 崩溃注入套件 |

### 5.2 VITEST_PLAN 条目归属（`/Users/alfredchaos/home/work/kapibala/server/VITEST_PLAN.md` 全量）

**不变量 I1–I14**：

| # | 用例文件 | 落地任务 |
|---|---|---|
| I1 | tests/crash/crash-consistency.test.ts | T-P7-02 |
| I2 | tests/messages/unknown-adjudicator.test.ts（gw-7/8）+ crash ① | T-P3-03, T-P7-02 |
| I3 | tests/messages/finalize-sent.test.ts | T-P3-04 |
| I4 | tests/agent/trigger.test.ts、tests/sequences/start-mutex.test.ts | T-P4-04, T-P6-02 |
| I5 | tests/accounts/state-machine.test.ts | T-P2-05 |
| I6 | tests/accounts/terminal-side-effects.test.ts | T-P2-06 |
| I7 | tests/ws/hub.test.ts | T-P2-10 |
| I8 | tests/events/cursor-prefix.test.ts + tests/events/resume.test.ts | T-P2-03 |
| I9 | tests/messages/unknown-adjudicator.test.ts（gw-9） | T-P3-03 |
| I10 | tests/agent/crash-recovery.test.ts | T-P4-11, T-P7-03 |
| I11 | tests/sequences/restart-reschedule.test.ts | T-P6-04, T-P7-04 |
| I12 | tests/ws/sinceseq.test.ts | T-P2-10 |
| I13 | tests/auth/session.test.ts | T-P0-07 |
| I14 | tests/constants.test.ts | T-P0-05 |

**场景 S1–S8**：S1–S4 → T-P3-11；S5/S6 → T-P4-15；S7/S8 → T-P6-08（用例文件 `tests/scenarios/s1..s8.test.ts`）。

**mock-gateway 开关 gw-1..28**（落地任务 = 开关实现；测试任务 = 代表用例）：

| 开关 | 落地 | 测试 | 开关 | 落地 | 测试 |
|---|---|---|---|---|---|
| gw-1/2 | T-P1-05 | T-P3-11 | gw-15 | T-P3-09 | T-P3-02 |
| gw-3 | T-P1-05 | T-P3-11 | gw-16 | T-P3-09 | T-P3-02 |
| gw-4 | T-P2-12 | T-P3-04 | gw-17 | T-P3-09 | T-P3-02 |
| gw-5 | T-P2-12 | T-P2-11 | gw-18 | T-P3-10 | T-P3-06 |
| gw-6 | T-P3-09 | T-P3-11 | gw-19 | T-P2-12 | T-P2-09 |
| gw-7 | T-P3-09 | T-P3-03 | gw-20 | T-P3-10 | T-P3-06 |
| gw-8 | T-P3-09 | T-P3-03 | gw-21 | T-P3-10 | T-P3-06 |
| gw-9 | T-P3-09 | T-P3-03 | gw-22 | T-P3-10 | T-P3-06 |
| gw-10 | T-P3-09 | T-P3-02 | gw-23 | T-P3-10 | T-P3-06 |
| gw-11/12/13 | T-P3-09 | T-P2-06 | gw-24 | T-P4-14 | T-P4-10 |
| gw-14 | T-P3-09 | T-P3-08 | gw-25 | T-P4-14 | T-P4-10 |
| gw-27 | T-P3-09 | T-P8-01 | gw-26 | T-P3-10 | T-P3-07 |
|  |  |  | gw-28 | T-P2-12 | T-P2-09 |

**mock-agent 开关 ag-1..19**：

| 开关 | 落地 | 测试 | 开关 | 落地 | 测试 |
|---|---|---|---|---|---|
| ag-1–4 | T-P4-02 | T-P4-06 | ag-12/13 | T-P4-02 | T-P4-05 |
| ag-5/6 | T-P4-02 | T-P4-06 | ag-14–16 | T-P4-03 | T-P4-07 |
| ag-7 | T-P4-02 | T-P4-06 | ag-17 | T-P4-03 | T-P4-15 |
| ag-8 | T-P4-03 | T-P4-09 | ag-18 | T-P4-03 | T-P4-11 |
| ag-9/10/11 | T-P4-03 | T-P4-08 | ag-19 | T-P4-02 | T-P4-05 |

**崩溃注入 4 点**：① queued 未发 → T-P7-02；② turn 已发未收 → T-P7-03；③ tool_dispatched → T-P7-03；④ 序列排期中 → T-P7-04。

**审查回归 10 项 + R-B 新增行**：D1-1 → T-P2-04；D1-2 → T-P2-06；D1-3 → T-P3-04；D2-1（含 R-A 复活分支场景）→ T-P2-09；D2-2 → T-P3-06；D2-5 → T-P2-07；X-1 → T-P4-10；X-2 → T-P4-12；D3-1 → T-P2-04；D3-4 → T-P2-05；**R-B（END2/SWEEP 守卫 + 积压保留）→ T-P4-04**。

### 5.3 交付面验收（DoD 摘引）

- 干净环境按 README 跑起四服务；`pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全绿。
- `pnpm demo:s1`…`pnpm demo:s8` 每场景一条命令，断言用 `GET /_test/counters`（S4 零试探、S5 恰一条、S8 零落地）。
- 一条命令跑崩溃测试套件（README「如何验证重启不变量」章）。
- C3 冒烟可重复；C2 切换演示记录；README 完成度三栏表；根/包内 AGENTS.md 与实际命令一致。

> **映射范围注记（F11）**：交付/基建类任务（脚手架 T-P0-01、contract 包 T-P0-02、mock 骨架 T-P1-01/T-P4-01、crash 基建 T-P7-01、README/DoD T-P8-04/05）不参与矩阵行映射，由各卡 acceptance 自证。另：页面 5（T-P6-07）在 design/11 矩阵中本无独立行（A6 只覆盖页面 1–3、B4-2 覆盖页面 4）——其验收以 B1 行为矩阵（B1-4/5/6）+ 02-TASKS 该卡 acceptance 为准。

---

## 6. 裁剪预案（照抄 review §3.3 与 DRIVER-PROMPT §7，顺序不可变）

**裁剪顺序**（时间不足时按此固定顺序减配，每次裁剪 JOURNAL + README 完成度表双登记）：

> O1–O4（已建议并回写设计）→ C1 媒体 → leave-all 的 5s 核对/终局对账装饰（保留契约最小行为）→ 页面 5 的预检弹窗美化（保留 422 的 stepIndex/key 展示）。

**永不裁剪**：

> A5 崩溃恢复路径、P7 崩溃注入测试套件、mock 的任何契约行为、审查环节。

**负面清单**（全程禁止）：引入 Redis/MQ/BullMQ/ORM；实现 design/13 的任何扩容触发器（分区/缓存/对象存储/多租户）；UI 视觉打磨、i18n、主题、响应式；扩写设计文档（只允许 patch 式修订）；用 npm/yarn。

---

## 7. SPEC 空隙的保守解释（本轮计划期裁决，实现期新空隙按 DRIVER-PROMPT §8 登记）

| # | 空隙 | 保守解释 |
|---|---|---|
| SP-1 | 共享契约类型位置未定（driver prompt 给两个候选） | 取 `packages/contract` 独立小包（§1.1 裁决）；pnpm-workspace 收录 `packages/*`；T-P0-01 先落占位骨架（避免前向声明依赖使 install 失败），T-P0-02 只填充类型（F1） |
| SP-2 | design/README 称「19 张表」而 design/02 实际定义 20 个表 | 19 张业务表 + `schema_migrations` 账本；全部 DDL 由单一迁移任务 T-P0-03 串行落地（迁移只增不改） |
| SP-3 | gw-5 `offline_backlog` 语义（review R-G 修订中） | 按 R-G 定稿语义实现：SSE 断线回放是默认行为（无需开关）；开关只注入「账号离线补投」（新 eventId、原 msgId/sentAt），帧生成走 `/_test/emit` 配方 |
| SP-4 | mock 开关的落地阶段 design/14 §8 只给粗序 | 按 VITEST_PLAN 用例阶段精确分配（见 §5.2 表）；mock-gateway 在 P4 末达到 28 开关全量 |
| SP-5 | 根 package.json 的 demo 脚本注册权 | T-P0-01 一次性预注册 `demo:s1..s8` / `e2e` / `db:migrate` / `db:seed` 等全部脚本入口（指向 `scripts/` 约定路径），后续任务只创建脚本文件，避免并行写根 package.json |
| SP-6 | `server/VITEST_PLAN.md` 勾选是跨泳道共享写 | 任务完成时在 JOURNAL 登记应勾行；实际勾选在阶段门（串行汇合点）由编排者统一执行 |
| SP-7 | lane-A 内部共享文件（`src/index.ts`、`events/dispatch.ts`、路由注册表） | lane-A 严格串行；共享文件出现在多个任务的 owned 中时，必须存在依赖边串行化（02-TASKS §0 规则 7） |
