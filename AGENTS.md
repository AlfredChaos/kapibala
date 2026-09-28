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
pnpm -F server db:seed-demo  # 往运行中的 dev 栈写演示数据（2 群 + 2 序列；走公共 API，幂等；需 pnpm dev 在跑）
pnpm demo:s1 … demo:s8      # 场景演示（独立隔离环境，可与之并行；见 scripts/README.md）
pnpm e2e                    # C3 单条 Playwright 冒烟（占 :3000/:5173——先停 pnpm dev）
```

> 脚手架落地后**必须逐条运行验证**；命令、脚本名、端口变化时同步更新本文件。
> 脚本预注册（SP-5）：`demo:s1..s8` / `e2e` 在 T-P0-01 一次性注册进根 package.json；脚本文件与编排细节见 `scripts/README.md`。使用入口与预期输出见根 README.md「演示（S1–S8）」。

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

### 2026-09-27 WS sinceSeq 水位自陷（超前 → 永久不投递）
- 症状：`sinceSeq` 大于现存 `max(seq)` 的连接此后收不到任何事件（测试 waitFor 超时）
- 根因：连接水位直接采信客户端 sinceSeq；回放集为空时水位停在未来 seq，后续所有提交 seq < 水位永远被过滤——自陷死锁
- 修复：`lastSentSeq = min(sinceSeq, maxSeq)`（钳制到真实 max；最坏多收 ≤ 窗口行，幂等吸收）
- 防再犯：回归测试 server/tests/ws/sinceseq.test.ts（「sinceSeq beyond current max」用例）；同提交修复 sinceSeq=0 误报 ws_backlog_expired（0 是全量回放哨兵不是被清行，BIGSERIAL 从 1 起）

### 2026-09-28 agent run 建而未拾取 → 永久卡 running 堵死单飞行
- 症状：`activeAgentRunId` 长期非空、`agent_trigger_queue` 积压只增不减、run 永远 `step_count=0`
- 根因：`trigger-entry.ts` 在事件事务内（COMMIT 前）调 `startAgentRun` → executor 抢到 advisory lock 但读不到未提交的 run 行，`precheck` 静默退出；`uq_agent_run_single_flight` 又阻止补建，run 永久卡死（竞态窗口极小，偶发）
- 修复：`EventDispatchContext.defer` 提交后副作用缝（consumer 在 commit 后统一触发）；`trigger-sweep` 加 stale-run lane：`status='running' AND (lease_until IS NULL OR lease_until < now())` 重新 `startAgentRun`（advisory lock 互斥，幂等）
- 防再犯：事务内禁止直接触发「需要读到本事务行」的异步动作，一律经 defer；executor/恢复路径对 `precheck` 读不到行的 run 要 log 不能静默 return

### 2026-09-28 leave-all job 崩溃后不恢复
- 症状：server 重启后 `type='leave_all'` 且 `status='running'` 的 job 永久停摆，群成员表与网关不再收敛
- 根因：恢复扫描「jobs」只查 `type='create_group'`，注释写着「leave_all 段归 T-P3-07」但该接线从未做；`runLeaveAllJob` 唯一调用点是 HTTP 路由，执行器本身可恢复、缺的是重启再驱动
- 修复：`scans.ts` jobs 扫描改为 `type IN ('create_group','leave_all')`，按 type 分发到 `runCreateGroupJob` / `runLeaveAllJob`（advisory lock 幂等）
- 防再犯：「归 XX 任务」类占位注释完成后必须回收接线点；新增 job 类型时同步扩展本扫描的 type 白名单

### 2026-09-28 dup tool_use.id 覆盖既有 raw_response
- 症状：`GET /api/agent-runs/:id` 里 DUPLICATE_TOOL_USE_ID 协议错误步的 rawResponse 为 NULL，看不到原始响应体
- 根因：dup-id 在 `turn_received`（步 3 已把响应体落 raw_response）之后才判定，`recordProtocolErrorStep` 不传 rawResponse 时 UPDATE 无条件覆写 `$4` → 冲成 NULL
- 修复：UPDATE 改 `raw_response=COALESCE($4, raw_response)`——未给新值时保留既有体；BAD_JSON/TURN_TIMEOUT 路径仍显式传入不受影响
- 防再犯：同列「记录后改写」的 UPDATE 一律考虑既有值是否需要 COALESCE 保留

### 2026-09-28 测试伪造 member_joined 早于网关真实入群 → promote 竞态
- 症状：`create-group-job.test.ts` 全量并行运行时偶发 failed（job errors=promote/NOT_MEMBER_YET），单跑必过
- 根因：测试绕过 SSE 手工投 `handleEventFrame` 伪帧，job context 立即全 joined → 转 promote；而 mock 的真实入群在 `setTimeout(100–1500ms)` 里才 add 成员。promote 先撞 NOT_MEMBER_YET，重试 1s 内定时器未 fire（并行负载放大延迟）→ calls≥2 → failed。真实部署该序天然成立（发帧即已入群），伪帧打破了序前提
- 修复：投递伪帧前轮询 mock `GET /groups/:id/members` 等真实入群落地（`waitGatewayMember`），序与真实路径一致
- 防再犯：回归 = 原用例（并行负载下复现）；凡「手工投事件帧 + 依赖网关内部状态时序」的测试，先确认事件序的前提状态已在网关侧成立

### 2026-09-28 WS auth→水位间隙被兜底同步灌全表
- 症状：`sinceseq.test.ts` 并行负载下偶发收到 `sinceSeq` 之前的行（如 sinceSeq=1 却收到 seq 1）
- 根因：`handleFrame` 里 `conn.authed=true` 后、`lastSentSeq` 还需一次 `min/max` 聚合查询才落定；该窗口内 `syncAll`（poll/notify）对 conn 只检 `authed`，以初值 `lastSentSeq=0` 把全表灌入——authed 语义只管「能不能推」，不管「水位是不是真值」
- 修复：Connection 加 `ready` 字段，`sync()` 首行 `if (!conn.ready) return`；auth 路径在 `lastSentSeq` 赋值完成后才置 `ready=true` 再自启首轮 `sync`
- 防再犯：回归测试 server/tests/ws/sinceseq.test.ts（并行负载下复现）；凡「状态分多步异步初始化」的连接/实体，中间态必须对兜底路径不可见——加独立闸门字段，勿复用上一个语义近似但覆盖不全的标志位
