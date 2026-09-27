# AGENTS.md — kapibala

多账号群组消息平台（笔试题）：后端 + 操作控制台 + 两个外部服务的 mock。
后端 Node.js + TypeScript + PostgreSQL；前端 React 18 + TypeScript + Vite；pnpm workspace monorepo。

**行为基准是契约，不是直觉**：所有时序数字、错误码、状态转移，以 [docs/analysis/10-quick-reference.md](docs/analysis/10-quick-reference.md) 为速查、[docs/analysis/](docs/analysis/README.md) 为详解、[docs/requirement.md](docs/requirement.md) 为最终依据。改任何契约相关逻辑前，先读对应章节。

## 1. 环境与命令

工具链：Node ≥ 22 · pnpm ≥ 9（**禁止 npm / yarn**）· PostgreSQL ≥ 16（docker compose 起）· Vitest · ESLint + `tsc --noEmit`。

```bash
pnpm install                # 安装全部 workspace 依赖
docker compose up -d        # PostgreSQL
pnpm dev                    # 并行启动 server + web + mock-gateway + mock-agent
pnpm -F server dev          # 只跑后端（读 .env：PORT / DATABASE_URL / GATEWAY_URL / AGENT_URL）
pnpm -F server test         # 后端测试（连真实 Postgres，不 mock DB）
pnpm -F server test src/path/to/file.test.ts   # 单文件
pnpm -F web test            # 前端测试（仅单元 / 组件层，见 §4）
pnpm lint && pnpm typecheck # 全仓 lint + 类型检查
pnpm build                  # 全仓构建
pnpm -F server db:migrate   # 执行迁移（dev 启动时自动跑；此命令用于显式排查）
pnpm -F server db:seed      # 预置服务账号与 admin / viewer 用户（幂等）
```

> 脚手架落地后**必须逐条运行验证**；命令、脚本名、端口变化时同步更新本文件。
> 脚手架阶段（T-P0-01）补充：`db:migrate` / `db:seed` 的实现分别在 T-P0-04 / T-P0-06 落地（脚本名已预注册）；`pnpm demo:s1..s8` / `pnpm e2e` 的预注册说明见 `scripts/README.md`。

默认端口：server `:3000` · web `:5173` · mock-gateway `:4100` · mock-agent `:4200`（scripted；anthropic 实例 `:4300`，C2 按需）· postgres `:5432`（各包 `.env.example` 为准）。

## 2. 目录结构

```
server/          后端：REST + WS + SSE 消费 + 状态机 + agent 编排 + 序列调度
web/             控制台前端（React 18 + Vite）
mock-gateway/    消息网关模拟：HTTP + SSE + 故障开关（契约见 docs/analysis/02-*.md）
mock-agent/      Agent 服务（单包双 provider：scripted 剧本+故障开关，默认 / anthropic 真实 LLM=C2；AGENT_MODE 切换，设计见 docs/design/12-agent-service.md）
docs/            需求与拆解
```

- 各包脚手架落地时，在包内新建 `AGENTS.md`（就近覆盖：只写该包特有内容，不重复本文件）。
- **不要碰**：`server/migrations/` 里已应用的迁移（只新增）、`docs/requirement.md`（原始考题，只读）、构建生成物、`.env`。

## 3. 硬性规约（项目宪法）

按重要性排序，违反任何一条都算 bug：

1. **先持久化，后产生外部效果**。任何网关调用、WS 推送、agent turn 发出之前，对应状态（queued 消息 / run 步骤 / SSE 游标 / 状态转移）必须已落库。写每段代码前先问：**这一行执行完就崩溃，重启后世界还一致吗？**
2. **契约数字与错误码不可改写**。504 后 2s 判定、unknown 5s 落定、turn 10–15s、12 步、60s、连续 3 次协议错误……一律照抄 [速查表](docs/analysis/10-quick-reference.md)；禁止取整、禁止无出处的魔数。
3. **入站事件一律幂等**：去重键 `(groupId, msgId)`，排序键 `(sentAt, msgId)` 复合。不信任到达顺序，不信任 eventId 顺序（at-least-once + 乱序 ≤1s + 补投不受窗口限制）。
4. **限流是硬闸门**：账号 `rate_limited` 期间绝不向网关发该账号的 `send`——一次试探就会重置计时。判断必须挡在出站路径最外层。
5. **唯一性靠数据库，不靠进程内存**：每群单飞行（agent run / 序列）、CAS、`clientMsgId` 唯一——多实例部署也要成立，进程内变量不算数。
6. **时间一律 UTC**：对外 ISO 8601 字符串、无值为 `null`；内部比较用 epoch 毫秒。禁止本地时区。
7. TypeScript `strict`；禁止 `any` 与非受控断言。错误显式处理或带上下文上抛，绝不静默吞；对外错误统一 `{ error: { code, message, requestId, … } }`。
8. **mock 的故障开关是验收资产**：S1–S8 场景靠它们复现。禁止为了让测试变绿而弱化 mock 的契约行为。

## 4. 测试

- 后端：Vitest，连真实 PostgreSQL（API / SSE / 调度行为不 mock DB）。
- 修 bug：先写能命中根因的回归测试，确认它因正确的原因失败，再修复、再确认通过。
- 前端：只写单元（纯函数）与组件 / 集成层测试，不测视觉样式。
- **E2E（Playwright，对应选做 C3）仅在明确要求时编写与运行**；平时验证用上面两层。
- 提交前必跑：`pnpm lint && pnpm typecheck && pnpm test`。

## 5. 禁区 / Never

- Never 修改已应用的迁移——只允许新增迁移文件。
- Never 提交 `.env`、密钥；C2 的真实 LLM key 只放本地 `.env`。
- Never 用 npm / yarn 安装依赖或生成 lockfile。
- Never 修改 `docs/requirement.md`；`docs/analysis/` 是衍生物，修订结论必须回原文核对。
- Never 删库、drop schema、重置 docker 卷——先确认再动手。
- Never 在 mock 里「顺手修好」正在被测试的异常路径。

## 6. Git

- 仅在明确要求时 commit / push。提交信息英文、Conventional Commits（`type(scope): subject`），一个提交一个逻辑变更。
- 默认分支 `main`；较大改动先开 `feat/*` 或 `fix/*` 分支。

## 7. 踩坑记录（append-only）

开发中定位到**非显而易见**的根因（并发、时序、契约语义、环境差异——从报错一眼看不出来的），**在修复的同一提交里**追加条目到这里，防止再犯：

- 条目格式：`### YYYY-MM-DD 标题`，正文四行：症状 / 根因 / 修复 / 防再犯（对应回归测试路径，或升入 §3/§5 的条目编号）。
- 只追加，不删除，不改写历史条目。
- **同类坑第二次出现 → 把结论升级成 §3/§5 的正式规约**，原条目保留。
- 分工：契约语义层面的坑记 [docs/analysis/11-gotchas.md](docs/analysis/11-gotchas.md)（静态清单）；这里只记**开发过程**中的坑（动态日志）。

<!-- 示例条目（写出首条真实记录后删除本块）
### 2026-09-27 SSE 重连丢事件
- 症状：重启 server 后，停机期间网关产生的 message 事件未进时间线
- 根因：eventId 消费游标只存进程内存，重启后从当前时刻开始消费
- 修复：游标持久化到 DB；重连固定带 `since=<cursor>`（独占语义，eventId > cursor）
- 防再犯：回归测试 server/src/events/resume.test.ts；对应 §3 第 1 条
-->
