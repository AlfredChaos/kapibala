# kapibala — 多账号群组消息平台（笔试题）

后端 Node.js + TypeScript + PostgreSQL；前端 React 18 + TypeScript + Vite；pnpm workspace monorepo。
**行为基准是契约，不是直觉**：所有时序数字、错误码、状态转移以
[docs/analysis/10-quick-reference.md](docs/analysis/10-quick-reference.md) 为速查、
[docs/requirement.md](docs/requirement.md) 为最终依据。

## 快速开始

```bash
pnpm install                          # workspace 依赖（pnpm ≥ 9，Node ≥ 22）
docker compose up -d                  # PostgreSQL 16（容器 kapibala-postgres，:5432）
pnpm -F server db:migrate             # 迁移（幂等；dev 启动时也自动跑）
pnpm -F server db:seed                # 预置 admin/viewer + acc-01..04 服务账号（幂等）
pnpm dev                              # 并行起 server:3000 + web:5173 + mock-gateway:4100 + mock-agent:4200

# 可选：给 dev 栈灌一批演示数据（2 个群 + 2 条序列；经公共 API 建真群，幂等）
pnpm -F server db:seed-demo
```

然后打开控制台 `http://localhost:5173`，以 `admin` / `admin` 登录。

> `pnpm dev` 只读各包 `.env`（仓库已带 `server/.env` 指向本地默认；
> 其余包默认值即是这四个端口）。自定义见各包 `.env.example`。
> **`pnpm e2e` 会占用 `:3000`/`:5173`**——跑 E2E 前先停掉 `pnpm dev`。

## 架构一段图

```
浏览器 ──► web (vite :5173, /api·/ws 同源代理)
            │
            ▼
         server :3000 ──► PostgreSQL :5432（真相唯一账本）
            │  ├─ REST /api/*（auth·accounts·groups·messages·sequences·agent-runs·jobs）
            │  ├─ WS /ws（ws_event 表驱动广播 + sinceSeq 补发）
            │  ├─ SSE 消费循环（GET mock-gateway /events，advisory lock 单飞）
            │  └─ 调度器（每 1s 扫表：unknown 判定/序列推进/死信重试/孤儿观测）
            ├──► mock-gateway :4100（出站发送/建群/踢人 + SSE 事件流 + /_test 故障开关）
            └──► mock-agent :4200（/agent/turn·/agent/tools·/agent/audit，scripted 剧本）
                 └──► （C2）同包第二实例 :4300 AGENT_MODE=anthropic → 真 LLM
```

## 演示（S1–S8 场景）

每条 `pnpm demo:sN` 自带隔离环境（随机端口 + 模板克隆测试库 + 同进程 mock），
**与正在跑的 `pnpm dev` 互不干扰**——可以并行开着：

| 命令 | 场景（REQ §2.4） | 预期输出 |
|---|---|---|
| `pnpm demo:s1` | S1 正常收发 | `PASS s1 — checks=10` |
| `pnpm demo:s2` | S2 断线重推/乱序 | `PASS s2 — checks=6` |
| `pnpm demo:s3` | S3 回流合并一行 | `PASS s3 — checks=7` |
| `pnpm demo:s4` | S4 限流顺延 | `PASS s4 — checks=28` |
| `pnpm demo:s5` | S5 send_message 幂等 + 审计 | `[s5] PASS — 6 checks` |
| `pnpm demo:s6` | S6 Agent 坏响应三连 | `[s6] PASS — 5 checks` |
| `pnpm demo:s7` | S7 并发启动恰一 201/409 | `PASS s7 — 5 checks` |
| `pnpm demo:s8` | S8 预检 422 零副作用 | `PASS s8 — 10 checks` |

终验记录（2026-09-28 本仓库实跑）：八条全 PASS（输出摘录见 `docs/plan/JOURNAL.md` T-P6-08 条目）。

## 如何验证重启不变量（崩溃一致性套件）

一条命令跑崩溃注入用例（DES/10 §5 四点窗口：tx.commit 前后 / dispatcher.claim 前后 / agent turn 各阶段 / 序列排期边界）：

```bash
pnpm -F server exec vitest run tests/crash/ tests/agent/crash-recovery.test.ts tests/sequences/restart-reschedule.test.ts
```

崩溃点经 `CRASH_POINTS` 环境变量或 `/_test/crash` 控制端点装配（`CRASH_CONTROL=1` 时才暴露），
命中即 `process.exit(9)`；用例断言重启后「已提交的与已发事件一一对应」。

## 端到端冒烟（C3）

```bash
pnpm e2e   # = pnpm -F web exec playwright test —— 唯一一条：登录 → 打开群 → 看到 agent run 步骤
```

全栈自理（webServer 拉起真 PG 测试库 + 双 mock + server :3000 + vite :5173），
可重复运行；`web/tests/e2e/` 仅此一条，不扩面（DES/15 §6 获准例外）。

## 测试与质量门

```bash
pnpm -F server test     # 后端测试（连真实 Postgres 容器，模板库隔离，不 mock DB）
pnpm -F web test        # 前端单元/组件层（happy-dom；无浏览器）
pnpm lint && pnpm typecheck
pnpm build
```

## C2：切换真实 LLM

mock-agent 单包双 provider（`scripted` 默认 / `anthropic` 真实 Claude）：

```bash
# mock-agent/.env（不提交）
AGENT_MODE=anthropic
ANTHROPIC_API_KEY=sk-ant-…
PORT=4300

# server/.env —— 契约逐字「后端只改 AGENT_URL」
AGENT_URL=http://localhost:4300
```

然后 `pnpm -F mock-agent dev`（起 anthropic 实例）+ 重启 server 即切换。
`ANTHROPIC_API_KEY` 只进本地 `.env`（已在 .gitignore），绝不提交。

## 契约解释声明

契约未明说处的取舍共 26 条，集中登记在
[docs/design/README.md §契约解释声明](docs/design/README.md)（
含 connect 前置穷举、unreachable 不可回转、503/504 区分、
limit>50 钳制、token TTL、cancelled 收窄为「从未交给网关」等）。
行为基准优先级：`requirement.md` > `docs/analysis/` > `docs/design/` 内【解读】。

## 完成度表（诚实三栏，2026-09-28）

| 项 | 状态 | 证据 / 说明 |
|---|---|---|
| 账号生命周期（状态机/终态联动/限流） | ✅ 完成 | `tests/accounts/`（15 边转移表 + 终态六动作事务 + 429 顺延）；S4 演示绿 |
| 群组（建群 job/成员投影/开关） | ✅ 完成 | `tests/groups/`（五阶段编排 + 乱序投影 + D2-1 不复活）；S1–S3 演示绿 |
| 消息（出站分发/unknown 判定/回流合并） | ✅ 完成 | `tests/messages/`；S3 回流合并演示绿 |
| SSE 消费 + 连续前缀游标 | ✅ 完成 | `tests/events/cursor-prefix|resume`；S2 断线补投演示绿 |
| Agent run（turn 循环/协议错误/审计/终态） | ✅ 完成 | `tests/agent/`；S5（幂等+审计）/S6（三连坏响应）演示绿 |
| 序列（定义/启动/预检/推进） | ✅ 完成 | `tests/sequences/`；S7（并发仲裁）/S8（预检零副作用）演示绿 |
| Web 控制台页面 1–5 | ✅ 完成 | `web/tests/*`（L2 happy-dom 52 例）+ C3 e2e |
| WS hub（广播/sinceSeq 补发） | ✅ 完成 | `tests/ws/sinceseq` + `tests/ws/backfill-e2e`（B4 端到端） |
| C1 媒体保留 | ✅ 完成 | `tests/messages/media.test.ts`（下载/清理/在跑保护） |
| C2 真实 LLM 接入 | 🟡 完成·需自配 key | `mock-agent` `AGENT_MODE=anthropic` 通道与形状映射已实现（DES/12 §4）；本仓库演示环境无 `ANTHROPIC_API_KEY`，切换路径已按「只改 AGENT_URL」实装但本机未跑真实 LLM |
| C3 Playwright 冒烟 | ✅ 完成 | `pnpm e2e` 绿（1 passed ×4 连跑）——DES/15 §6 获准例外 |
| 崩溃注入一致性 | ✅ 完成 | `tests/crash/`（exit-9/@N/tx.commit 前后窗口）+ `tests/agent/crash-recovery`（turn/tool_dispatched）+ `tests/sequences/restart-reschedule`（排期边界） |
| 死信三写（D1-1）/ 孤儿分流（D3-1） | ✅ 完成 | `tests/events/dead-letter.test.ts` |
| VITEST_PLAN 勾选簿记 | 🟡 部分 | 全部用例存在且实跑通过；矩阵 ☐→☑ 勾选列归 T-P7-05，本表生成时该任务仍在飞——**未勾≠未实现**，逐行用例名见 `server/VITEST_PLAN.md` |
| 性能压测 | ⬜ 未做 | 契约未要求，范围外 |
| 全局 UI 自动化 | ⬜ 未做 | DES/15 §6 明确禁止（C3 单条除外） |
| 生产化部署（镜像/k8s/监控） | ⬜ 未做 | 范围外：docker compose 仅起 PG |

## 目录

```
server/        后端（boot 编排 + 模块域 + 迁移 + 调度器 + SSE/WS）
web/           控制台（React；页面 1–5 + C3 e2e）
mock-gateway/  网关模拟（SSE 账本 + /_test 故障开关 gw-1..28）
mock-agent/    agent 模拟（scripted 剧本 ag-1..19 + C2 anthropic provider）
packages/contract/  共享契约类型（DTO / WS 帧 / 工具 schema）
scripts/demo/  S1–S8 演示脚本
docs/          requirement / analysis（解读权威）/ design（实现设计）/ plan（任务卡+日志）/ review
```

## 规约速览（详见各包 AGENTS.md）

- 测试连真实 PostgreSQL；mock 服务进测试进程，`/_test` 面 arrange。
- 迁移 `server/migrations/*.sql` 只增不改；提交信息 Conventional Commits。
- 契约数字逐字断言（≤1s 乱序窗、5s unknown 落定、3s WS 补齐、15min token…见 QR §1）。
- 坑位记录在根 `AGENTS.md §7`（append-only）与各任务 JOURNAL 条目。
