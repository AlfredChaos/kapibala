# kapibala — 多账号群组消息平台

面向运营场景的多账号群组消息系统：一组服务账号经统一消息网关收发群消息，
内置 LLM agent 编排（工具调用 + 审计）、定时消息序列、实时控制台。

- 后端：Node.js ≥ 22 + TypeScript（strict）+ PostgreSQL ≥ 16
- 前端：React 18 + TypeScript + Vite
- Monorepo：pnpm ≥ 9 workspace
- 本地依赖全部容器/进程化：PostgreSQL（docker）+ 网关模拟 + agent 模拟，零外部账号即可跑通全链路

## 跑起来长什么样

控制台 `http://localhost:5173`（`admin` / `admin`）：

| 工作台 | 群详情（时间线 + agent run） |
|---|---|
| ![工作台](docs/assets/screenshots/dashboard.png) | ![群详情](docs/assets/screenshots/group-detail.png) |

| Agent run 步骤审计 | 序列定义与启动预检 |
|---|---|
| ![agent run](docs/assets/screenshots/agent-run.png) | ![序列](docs/assets/screenshots/sequences.png) |

账号状态机与群列表见 `docs/assets/screenshots/accounts.png` / `groups.png`。

## 快速开始

```bash
pnpm install                # workspace 依赖（Node ≥ 22，pnpm ≥ 9）
docker compose up -d        # PostgreSQL 16（容器 kapibala-postgres，:5432）

cp server/.env.example server/.env   # 默认即指向本地端口，通常不用改

pnpm -F server db:migrate   # 数据库迁移（幂等，可重复执行；dev 启动时也会自动跑）
pnpm -F server db:seed      # 种子数据：admin/viewer 用户 + acc-01..04 服务账号（幂等）

pnpm dev                    # 并行启动四个进程：
                            #   server :3000 · web :5173 · mock-gateway :4100 · mock-agent :4200
```

打开 `http://localhost:5173` 登录。`db:seed` 预置两个用户（密码同用户名，笔试约定）：

| 用户名 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin` | 管理员（读写） |
| `viewer` | `viewer` | 运营（只读，写操作 403） |

```bash
pnpm -F server db:seed-demo # 可选：往正在运行的 dev 栈灌演示数据
                            #   （2 个群 + 2 条序列；走公共 API 建真群，幂等，可重复执行）
```

> **`pnpm e2e` 会占用 `:3000` / `:5173`**——跑端到端测试前请先停掉 `pnpm dev`。

## 系统架构

```mermaid
flowchart LR
    subgraph 浏览器
        UI["web 控制台<br/>React :5173"]
    end

    subgraph server["server :3000"]
        API["REST /api/*<br/>auth · accounts · groups · messages<br/>sequences · agent-runs · jobs"]
        WS["WS /ws<br/>ws_event 表驱动广播<br/>sinceSeq 断线补发"]
        SSE["SSE 消费循环<br/>连续前缀游标 + 乱序窗"]
        SCH["调度器（1s 扫表）<br/>unknown 判定 · 序列推进<br/>死信重试 · 孤儿观测"]
        AGT["agent 编排器<br/>turn 循环 · 审计闸 · 单飞行"]
        JOBS["异步 job 执行器<br/>建群 · leave-all"]
    end

    DB[("PostgreSQL :5432<br/>唯一事实账本")]
    GW["mock-gateway :4100<br/>HTTP 出站 + SSE 事件流<br/>/_test 故障开关"]
    LLM["mock-agent :4300<br/>AGENT_MODE=anthropic<br/>真实 LLM（可选）"]

    UI -->|"REST + WS（vite 同源代理）"| server
    API --> DB
    WS --> DB
    SSE -->|"GET /events?since=cursor"| GW
    SSE --> DB
    SCH --> DB
    AGT -->|"/agent/turn · /agent/audit"| AG
    AGT -.->|"只改 AGENT_URL 即切换"| LLM
    JOBS -->|"create_group · invite · join · leave"| GW
    server -->|"send · create_group · kick"| GW
```

### 核心设计：先持久化，后产生效果

所有状态写入 PostgreSQL 之后才允许产生外部效果（网关调用、WS 推送、agent turn）。
任何时刻崩溃重启，已提交的状态与已发事件一一对应；恢复扫描会接管未完成的 run、job、排期步骤。

```mermaid
sequenceDiagram
    participant U as 外部用户
    participant GW as 消息网关
    participant S as server
    participant DB as PostgreSQL
    participant W as web 控制台

    U->>GW: 群消息
    GW->>S: SSE message 事件（at-least-once，可乱序）
    S->>DB: 事务：去重 (groupId,msgId) + 排序 (sentAt,msgId)<br/>+ ws_event + SSE 游标
    S-->>W: WS 推送（seq 单调递增，只推已落库事件）

    W->>S: POST /api/groups/:id/messages
    S->>DB: queued（clientMsgId 唯一）
    S->>GW: send
    alt 正常回执
        GW-->>S: 200 → accepted → SSE message_sent → sent
    else RATE_LIMITED
        GW-->>S: 429 → 账号 rate_limited，等待期内不再发该账号 send，到期按原顺序补发
    else NETWORK_TIMEOUT
        GW-->>S: 504 → unknown；5s 内必须落定
        S->>GW: by-client-id 确认未发出后，同 clientMsgId 重发一次（仅一次）
    end
    GW-->>S: SSE 回流（isOwn 标记，不再触发 agent）
```

```mermaid
sequenceDiagram
    participant GW as 消息网关
    participant S as server（agent 编排）
    participant DB as PostgreSQL
    participant AG as agent 服务
    participant AUD as /agent/audit

    GW->>S: 非本账号群消息（agentEnabled=true）
    S->>DB: 创建 run（每群单飞行，DB 唯一约束保证多实例也成立）
    loop ≤ 12 步 / ≤ 60s / 连续协议错误 < 3
        S->>AG: POST /agent/turn（单轮超时 10–15s）
        AG-->>S: tool_use / final / 坏响应
        alt send_message / kick_user
            S->>AUD: 执行前审计（最多 3 次取到明确 verdict）
            AUD-->>S: pass → 执行；fail → AUDIT_REJECTED；拿不到结论 → run blocked
            S->>GW: 经审计后发送（idempotency_key 幂等）
        end
        S->>DB: 每步落 steps[]（含协议错误步与 rawResponse）
    end
    S->>DB: 终态（finished / blocked / cancelled / failed）
    Note over S,DB: run 期间重启 → 从断点续跑同一 runId；<br/>已产生效果的工具调用绝不重放
```

## 功能实现状态

### A 组 · 核心链路

| 功能 | 状态 | 覆盖 |
|---|---|---|
| A0 基础：幂等迁移 / schema 落后拒绝启动 / 统一错误格式 / login + 角色权限 | ✅ | `server/tests/migration.test.ts`、`tests/auth/` |
| A1 账号状态机：15 边转移表 / CAS 409 / 终态六后果事务 / 限流自动恢复 | ✅ | `server/tests/accounts/` |
| A2 网关接入：出站状态机 / unknown 5s 判定 / 单次重发 / 入站去重排序 / 故障错误码全表 | ✅ | `server/tests/messages/`、`server/tests/gateway-client.test.ts` |
| A3 建群：异步 job（建群→邀请→join→promote）/ JOIN_TIMEOUT / jobs 进度查询 | ✅ | `server/tests/groups/` |
| A4 消息时间线：游标分页无重复遗漏 / WS seq 单调 | ✅ | `server/tests/messages/timeline-pagination.test.ts`、`server/tests/ws/` |
| A5 Agent：单飞行 run / 12 步 60s 预算 / 协议错误分类 / 审计闸 / 幂等 key / 断点恢复 | ✅ | `tests/agent/`、`tests/agent/crash-recovery.test.ts` |
| A6 前端页面 1–3（登录 / 账号列表 / 群详情） | ✅ | `web/tests/` |

### B 组 · 进阶能力

| 功能 | 状态 | 覆盖 |
|---|---|---|
| B1 定时序列：预检 422 零副作用 / stepVars 取值链 / 单飞行 409 / 顺延与重启重排 | ✅ | `server/tests/sequences/` |
| B2 群生命周期：invite 重试分支 / leave-all（群主最后退、部分失败记账） | ✅ | `server/tests/groups/` |
| B3 登录会话：HttpOnly refresh cookie / 轮换 / 重用即会话作废 / logout 即失效 / 前端单飞 refresh | ✅ | `server/tests/auth/`、`web/tests/` |
| B4 断线补齐：sinceSeq 重连 3s 内补齐不重复 / agent 步骤详情页 | ✅ | `server/tests/ws/backfill-e2e.test.ts` |

### C 组 · 扩展项

| 功能 | 状态 | 说明 |
|---|---|---|
| C1 媒体文件保留：下载至 `media/` / 超期清理 / 在跑引用保护 | ✅ | `server/tests/messages/media.test.ts` |
| C2 真实 LLM 接入：`AGENT_MODE=anthropic`，后端只改 `AGENT_URL` | ✅ 需自配 key | 切换通道已实现；本仓库不提交 `ANTHROPIC_API_KEY` |
| C3 Playwright 端到端冒烟 | ✅ | `pnpm e2e`（登录 → 打开群 → 看到 agent run 步骤） |
| 崩溃注入一致性：tx.commit 前后 / dispatcher.claim / turn 各阶段 / 排期边界 | ✅ | `tests/crash/`（`CRASH_POINTS` 注入 exit-9） |
| 性能压测 | ⬜ | 未纳入范围 |
| 生产化部署（镜像 / 编排 / 监控告警） | ⬜ | 未纳入范围 |
| CI/CD 流水线 | ⬜ | 未纳入范围 |
| 结构化日志规范 / 请求链路追踪 | ⬜ | 未纳入范围 |

## 测试

```bash
# 全量：后端连真实 PostgreSQL（模板库隔离，不 mock DB）；前端为单元/组件层（happy-dom）
pnpm test                 # = pnpm -r test（server 59 个测试文件 + web 组件测试）

pnpm -F server test                          # 只跑后端
pnpm -F server test src/path/to/file.test.ts # 单文件
pnpm -F web test                             # 只跑前端
```

### 冒烟测试（S1–S8 场景脚本）

每条 `pnpm demo:sN` 自带隔离环境（随机端口 + 模板克隆测试库 + 同进程 mock），
**与正在跑的 `pnpm dev` 互不干扰**，可并行执行：

| 命令 | 场景 | 预期输出 |
|---|---|---|
| `pnpm demo:s1` | 正常收发全链路 | `PASS s1` |
| `pnpm demo:s2` | 断线重推 / 乱序补投 | `PASS s2` |
| `pnpm demo:s3` | 自己的消息回流合并一行 | `PASS s3` |
| `pnpm demo:s4` | 限流顺延不跳步 | `PASS s4` |
| `pnpm demo:s5` | send_message 幂等 + 审计 | `[s5] PASS` |
| `pnpm demo:s6` | agent 连续坏响应终止 | `[s6] PASS` |
| `pnpm demo:s7` | 并发启动序列恰一 201/409 | `PASS s7` |
| `pnpm demo:s8` | 预检 422 零副作用 | `PASS s8` |

### 端到端测试（E2E）

```bash
pnpm e2e   # Playwright：登录 → 打开群 → 看到 agent run 步骤
           # 全栈自理（自动拉起测试库 + 双 mock + server + vite），可重复运行
           # 注意先停 pnpm dev（占用 :3000/:5173）
```

### 崩溃一致性套件

```bash
pnpm -F server exec vitest run tests/crash/ tests/agent/crash-recovery.test.ts tests/sequences/restart-reschedule.test.ts
```

经 `CRASH_POINTS` 环境变量在事务提交前后、事件认领前后、turn 各阶段注入
`process.exit(9)`，断言重启后「已提交状态与已发事件一一对应」。

### 质量门

```bash
pnpm lint && pnpm typecheck && pnpm build
```

## 目录结构

```
server/                    后端服务（:3000）
  migrations/              SQL 迁移，只增不改；schema 落后时拒绝启动
  src/
    index.ts               启动编排 boot()：迁移校验 → 恢复扫描 → 各循环 → HTTP 监听
    config/                .env 加载与强校验（缺必填项拒绝启动）
    db/                    连接池 / 迁移执行器 / seed / seed-demo
    http/                  Fastify：路由 + 统一错误格式 + auth 插件
      routes/              auth·accounts·groups·messages·sequences·agent-runs·jobs·health
    modules/
      accounts/            账号状态机（15 边转移表、CAS、终态六后果、限流计时）
      groups/              建群 job 五阶段编排、leave-all、成员投影
      messages/            出站分发器、unknown 判定、入站去重排序、时间线分页
      agent/               run 编排：turn 循环、协议错误、审计闸、幂等、预算、恢复
      sequences/           序列定义 CRUD、预检、排期推进、重启重排
      auth/                access/refresh token、轮换、会话作废
    events/                SSE 消费：连续前缀游标、乱序窗、死信三写、孤儿分流
    gateway/               网关客户端（send/create/invite/join/leave/kick/by-client-id）
    agentclient/           agent 服务客户端（turn/tools/audit）
    scheduler/             1s 调度循环：unknown 落定、限流到期、序列推进、媒体清理
    recovery/              重启恢复扫描：接管 running run/job、重排过期步骤、重连 SSE
    ws/                    WS hub：ws_event 表驱动广播、sinceSeq 断线补发
  tests/                   Vitest，连真实 PG（含 crash/ 崩溃注入套件）

web/                       控制台前端（:5173）
  src/
    pages/                 登录 / 工作台 / 账号 / 群列表 / 群详情 / agent run / 序列
    api/                   REST 客户端（401 自动续期，单飞 refresh）
    ws/                    WS 客户端（重连 + sinceSeq 补齐）
    auth/                  会话与角色（viewer 隐藏写操作）
    timeline/              消息时间线（游标分页、实时追加、own 消息 deliveryStatus）
    dashboard/             工作台：账号分布、消息活动、风险 run、实时事件
  tests/e2e/               Playwright 冒烟（C3）

mock-gateway/              消息网关模拟（:4100）
                         HTTP 出站 + SSE 事件账本 + /_test 故障开关（gw-1..28）

mock-agent/                Agent 服务模拟（单包双 provider）
                         :4200 scripted 剧本（ag-1..19 + 故障开关）
                         :4300 AGENT_MODE=anthropic 接真实 LLM

packages/contract/         共享契约类型：DTO / WS 帧 / agent 工具 schema

scripts/demo/              S1–S8 冒烟场景脚本（独立隔离环境）

docs/
  requirement.md           原始需求（只读，最终依据）
  analysis/                需求拆解与契约解读（10-quick-reference.md 为数字速查）
  design/                  各模块实现设计（DES/01–15）
  plan/                    任务卡与开发日志
  assets/screenshots/      控制台截图（本 README 引用）
```

## 配置

`server/.env` 必填四项（缺失拒绝启动）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP/WS 监听端口 |
| `DATABASE_URL` | `postgres://kapibala:kapibala@localhost:5432/kapibala` | PostgreSQL 连接串 |
| `GATEWAY_URL` | `http://localhost:4100` | 消息网关地址 |
| `AGENT_URL` | `http://localhost:4200` | agent 服务地址 |

可选调参（默认值与出处见 `server/.env.example` 注释）：
`AGENT_TURN_TIMEOUT_MS`（10–15s 区间）、`AGENT_MAX_CONCURRENT_RUNS`、
`MEDIA_RETENTION_DAYS`、`WS_EVENT_RETENTION_MINUTES`。

### 切换真实 LLM

mock-agent 是单包双 provider：`scripted`（默认剧本）/ `anthropic`（真实 Claude）。

```bash
# mock-agent/.env（不提交）
AGENT_MODE=anthropic
ANTHROPIC_API_KEY=sk-ant-…
PORT=4300

# server/.env —— 只需改一行
AGENT_URL=http://localhost:4300
```

`pnpm -F mock-agent dev` 起 anthropic 实例后重启 server 即完成切换。
`ANTHROPIC_API_KEY` 只进本地 `.env`（已在 .gitignore）。

## 关键不变量（维护者须知）

- **先持久化，后产生效果**：网关调用 / WS 推送 / agent turn 之前，对应状态必须已落库。
- **限流是硬闸门**：账号 `rate_limited` 期间绝不向网关发该账号的 `send`——一次试探就会重置计时。
- **唯一性靠数据库**：每群单飞行（agent run / 序列）、CAS、`clientMsgId` 唯一，多实例部署同样成立。
- **入站事件一律幂等**：去重 `(groupId, msgId)`，排序 `(sentAt, msgId)`；不信任到达顺序。
- **时间一律 UTC**：对外 ISO 8601，内部 epoch 毫秒。
- **迁移只增不改**；事务内禁止直接触发需要读到本事务行的异步动作（走提交后 defer）。

行为契约的数字与错误码以 [docs/requirement.md](docs/requirement.md) 为最终依据、
[docs/analysis/10-quick-reference.md](docs/analysis/10-quick-reference.md) 为速查；
实现细节见 [docs/design/](docs/design/README.md)；
开发期踩坑记录见 [AGENTS.md §7](AGENTS.md)（append-only）。
