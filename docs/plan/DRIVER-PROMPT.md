# kapibala 长程自主开发驱动提示词（v1.0 · 2026-09-27）

> **用法**：将本文档全文作为首条指令，投递给一个具备自主执行权限的长程 coding Agent（新会话）。本文档自包含，不依赖任何会话历史。
> **授权声明**（下发本提示词即视为项目所有者明确授权）：
> 1. `git init` 并在任务边界持续**本地** commit（不含 push——未授权 push 到任何远端）；
> 2. 编写并运行 C3 对应的**单条** Playwright 冒烟测试（考题原文选做项，构成全局 UI 测试策略所要求的「明确指令」）；
> 3. 长时运行 docker compose（PostgreSQL）、mock 服务与测试进程；
> 4. 在 `/Users/alfredchaos/home/work/kapibala` 内创建/修改代码与计划文档。
> **未授权**：push、删除数据库/卷/schema、修改 `docs/requirement.md` 与 `docs/analysis/`、提交 `.env` 或任何密钥。

---

## 1. 使命（北极星目标）

把 kapibala 项目从当前状态——**文档完备、零代码、非 git 仓库**——自主迭代开发到**完整交付**，满足 §9 的 Definition of Done 后停止。

项目本体：多账号群组消息平台（48h 笔试题）的后端 + 操作控制台 + 两个外部服务 mock。技术栈：Node ≥22 + TypeScript strict + PostgreSQL ≥16（后端）、React 18 + TS + Vite（前端）、pnpm workspace monorepo（**禁止 npm / yarn**）。四个包：`server` / `web` / `mock-gateway` / `mock-agent`。

你是长程自主 Coding Agent：**运行期间没有人会回答问题**。除 §8 的升级条件外，持续调度、持续实现、持续审查，直到 DoD 全部满足。每个动作都要留下可复核的证据（测试输出、命令结果、JOURNAL 记录）——**人类会随时阅读代码与 git 历史，代码质量与历史质量本身就是交付物**。

时间纪律：考题评分是「做到哪算哪」的完成度制，优先级 **A 组 > B 组 > C 组**。若进度明显落后，按 §7 的固定裁剪顺序减配，**绝不平均用力、绝不为了收尾牺牲 A 组正确性**。

## 2. 规范源与优先链（SPEC 基准）

冲突时按以下顺序裁决（上位覆盖下位）：

| 级 | 文档（绝对路径） | 角色 |
|---|---|---|
| 1 | `/Users/alfredchaos/home/work/kapibala/docs/requirement.md` | 契约，最终依据。**只读，永不修改** |
| 2 | `/Users/alfredchaos/home/work/kapibala/AGENTS.md` | 项目宪法：8 条硬性规约、禁区、测试策略、踩坑记录义务（§7） |
| 3 | `/Users/alfredchaos/home/work/kapibala/docs/analysis/10-quick-reference.md` 与 `11-gotchas.md` | 契约数字 / 错误码 / 状态机速查 + 60 条陷阱清单（衍生物，存疑回 1 核对；**只读**） |
| 4 | `/Users/alfredchaos/home/work/kapibala/docs/design/`（README + 01–15） | 实现设计。**实现不得偏离；偏离必须先改文档再写代码**。`design/README.md` 的「契约解释声明」（25+ 条）是契约空隙的唯一权威解释 |
| 5 | `/Users/alfredchaos/home/work/kapibala/docs/review/01-design-review-2026-09-27.md` | Leader 审查报告：缺陷修复记录、§3.3 作战图（P0–P8 与裁剪顺序）、§5.2 残留项 |
| 6 | `/Users/alfredchaos/home/work/kapibala/server/VITEST_PLAN.md` | 测试映射总表：I1–I14 × S1–S8 × gw-1..28 × ag-1..19 × 崩溃 4 点 × 审查回归 10 条。**写完一个勾一个，编号引用关系不许丢** |

硬性规则：
- **契约数字零改写**：5s / 2s / 10s / 12 步 / 60s / 10–15s / 3 次 / ≤2 次 / 15min / 50 / 500 字 / 8KB / 200 字 / 2KB…全部集中定义为命名常量（`server/src/constants.ts` 或等价位置），并有 `tests/constants.test.ts` 逐个断言与速查表一致（I14）。禁止无出处魔数、禁止取整。
- **注释中文**（跟随考题语言，便于评审）；**日志、错误信息、commit message 一律英文**。
- 对外错误统一 `{ error: { code, message, requestId, ...业务字段 } }`；时间对外 ISO 8601 UTC 字符串、无值 `null`，内部比较用 epoch 毫秒。
- TypeScript `strict`，禁止 `any` 与非受控断言；错误显式处理或带上下文上抛，绝不静默吞。

## 3. 阶段 0（必须先做）：设计收口 + SPEC 建立

### 3.1 修复审查残留（P0 的前置，全部是文档小修）

按 `/Users/alfredchaos/home/work/kapibala/docs/review/01-design-review-2026-09-27.md` §5.2 逐条执行：
- **R-A**：`docs/design/04-group-module.md` §4——U1「复活」分支先查账号 `terminal_at`，非空则按 STALE 处理（只补 joined_at 不复活）；TOMB 分支改 `ON CONFLICT ... DO UPDATE SET last_event_id = GREATEST(last_event_id, EXCLUDED.last_event_id)`。同步扩写 `server/VITEST_PLAN.md` §5 的 D2-1 回归行（补「迟到 joined 不得复活终态账号」场景）。
- **R-B**：`docs/design/06-agent-module.md` §2——END2 第 3 步与 SWEEP 补建 run 前，加守卫 `group.status='active' AND agent_enabled=true`；守卫不过时**保留**积压行（agentEnabled 重新打开后由 SWEEP 补处理），该语义登记进 `docs/design/README.md` 契约解释声明（新增第 26 条）。VITEST_PLAN 增加对应回归行。
- **R-C…R-G**（编辑性，位置见报告 §5.2 表）：04 §2.2 旧句、13 §3「租约回收」、15 §2「存 refresh」措辞、14 §2 clientMsgId 改有序列表、14 gw-5 区分「SSE 断线回放（默认）」与「账号离线补投（显式注入）」。
- 完成后在审查报告 §4 清单追加一行：`15. ☑ R-A/R-B/R-C…R-G 复核残留修复（本轮）`。

### 3.2 环境自检与 git 初始化

- 逐项验证：`node -v`（≥22）、`pnpm -v`（≥9）、`docker`（可起 postgres:16）、`git`。任何一项缺失 → JOURNAL 记 BLOCKED + 尝试替代方案（如本机已有 PG16 则用之），替代不成立才升级。
- `git init`；`.gitignore` 至少含：`node_modules/`、`dist/`、`coverage/`、`.env`、`media/`、`*.tsbuildinfo`。
- 首个 commit 收录现有全部文档：`docs: initial analysis, design, and review corpus`。

### 3.3 用 SPEC 方法建立规范（建议依次调用 skills：`to-spec` → `writing-plans` → `to-tickets`）

产出三份文件（这是你后续一切调度的真值来源）：

1. **`/Users/alfredchaos/home/work/kapibala/docs/plan/00-SPEC.md`** —— 规范书：
   - 系统边界与四包职责（照 design/01 §2、design/12、design/14、design/15）；
   - 每包的模块级规格（对外接口、依赖方向、事务边界引用 design/10 §1 E1–E14）；
   - 质量规范：SOLID 在本项目的具体映射（依赖方向=design/01 §2 分层图；接口=各模块导出的 service 函数；单一职责=modules/* 按域分包）、注释标准（关键函数必须有中文注释说明「为什么」，契约行为注明出处章节）、错误处理标准、测试标准（TDD 三层：单测/集成/崩溃注入，UI 仅第 1/2 层 + C3 冒烟）；
   - 验收总表：把 design/11-verification.md 的 125 条矩阵 + VITEST_PLAN 全量条目汇总为可勾选清单；
   - 裁剪预案：照抄 review 报告 §3.3 的裁剪顺序与「永不砍」清单。
2. **`/Users/alfredchaos/home/work/kapibala/docs/plan/01-PLAN.md`** —— 阶段计划：以 review 报告 §3.3 作战图（P0–P8 + 缓冲）为基线细化；每阶段写明：目标、包含任务组、阶段验收（全仓 lint/typecheck/test/build 绿 + 该阶段「累计产出」列的可演示能力）、退出条件。**允许细化任务，不允许改变阶段依赖与裁剪顺序。**
3. **`/Users/alfredchaos/home/work/kapibala/docs/plan/02-TASKS.md`** —— 原子任务 DAG（格式见 §4）。任务粒度：S ≤2h / M ≤6h；预估超过 6h 的任务必须再拆。全项目预计 60–90 个原子任务。

另建两份运行文档：**`docs/plan/JOURNAL.md`**（append-only 执行日志：每任务一条——做了什么、验证命令与输出摘录、偏差与【解读】、踩坑）与 **`docs/plan/HANDOFF.md`**（交接快照：目标 / 已完成 / 进行中 / 剩余 / 风险 / 验证状态；在阶段边界与任何可能被中断的时刻更新；**会话恢复后的第一动作 = 读 HANDOFF + TASKS 状态 + JOURNAL 末尾，不信任会话记忆**）。

### 3.4 计划评审门（不通过不进入执行）

起 2–3 个独立上下文的审查子代理，分别评审 SPEC / PLAN / TASKS，检查点：
- design/11 矩阵 125 条与 VITEST_PLAN 全部条目都能在 TASKS 中找到归属任务（无漏项）；
- DAG 无环；每个任务 depends 完整；并行任务的 owned files 零交集；迁移与共享类型任务在串行主干上；
- 每个任务的验收标准可机检（命令 + 预期输出 + GWT 断言），审查者无需口头信任；
- 契约数字在任务卡中逐字引用速查表，无凭记忆转述。
评审发现缺陷 → 修订计划文件 → 复审。通过后 commit：`docs(plan): spec, plan, and task DAG`，随后进入执行。

## 4. 原子任务卡格式与 DAG 防竞态规则

`02-TASKS.md` 中每个任务卡**必须**包含以下字段（缺一即计划评审不通过）：

```
### T-<阶段>-<序号> <标题>            [status: TODO|ACTIVE|REVIEW|DONE|BLOCKED|REJECTED-n]
- goal: 1–3 句，做什么、为什么
- refs: 规范引用的绝对路径 + 章节（例：/Users/alfredchaos/home/work/kapibala/docs/design/05-messaging-module.md §4.3；requirement A2）
- owned: 本任务唯一有权创建/修改的文件与目录清单
- depends: 前置任务 ID 列表；lane: 所属并行泳道
- size: S|M（L 必须拆）
- acceptance:
  a) 验证命令与预期输出（例：pnpm -F server test src/messages/finalize-sent.test.ts → 全绿；pnpm typecheck → 0 错）
  b) 行为断言 Given/When/Then，每条标注契约出处与数字（例：Given 504 后 1.5s 落地（gw-7），When unknown 判定，Then ≤5s 内 deliveryStatus=sent，出处 A2/§2.1）
  c) 测试先行证据：新增测试文件清单 + 「先红后绿」的 JOURNAL 记录引用
  d) 负面检查：不得出现 any / 魔数 / owned 之外文件的改动 / mock 契约弱化 / 跳过审查
  e) 文档联动：VITEST_PLAN 勾选行、根 AGENTS.md 命令同步、解释声明登记（如涉及）
```

**DAG 硬规则（防竞态，违反即调度错误）：**
1. **单写者原则**：任意时刻两个 ACTIVE 任务的 `owned` 不得相交。触碰 `server/migrations/**`、共享契约类型、`docs/plan/**`、根 `AGENTS.md` 的任务**全局串行**。
2. **迁移串行流**：迁移文件只由串行主干任务新增，版本号由编排者按完成顺序单调分配；禁止并行分支预占版本号；已应用的迁移永不修改（宪法 §5）。
3. **共享契约类型先行**：§2.2 Agent 协议类型、网关错误码类型、WS 事件 payload 类型在最早的公共任务落地（workspace 共享包或 `server/src/contract/`），下游任务只读；变更必须回到 owning 任务串行处理并通知全部消费者任务。
4. **泳道划分**（推荐基线，最终以你的 DAG 为准）：
   - lane-A `server` 主干：严格按 P0→P2→P3→P4→P6 的域依赖串行（db/迁移→events/accounts→groups/messages→agent→sequences）；
   - lane-B `mock-gateway`（spec=design/14）与 lane-C `mock-agent`（spec=design/12）：在共享类型任务完成后即可与 lane-A 并行；两者的 `/_test` 控制平面与开关命名以设计文档为准，禁止自创契约；
   - lane-D `web`（spec=design/15）：在 server 的 REST/WS 接口面冻结（P3 结束）后启动；
   - **跨泳道集成任务 = 串行汇合点**，由编排者单独调度。
5. **测试资源隔离**：每个连 PG 的 Vitest 文件使用独立 schema 或独立 database（模板库 + 随机后缀），测试文件间无共享可变状态；Vitest 并行的 worker 不得争用同一 DB。mock 服务在测试内以进程内装配或子进程 + 随机端口启动，用例间必须 `/_test/reset`（注意 design/14 §1：eventId 计数器跨 reset 不复用）。
6. **调度不变量**：只调度「depends 全部 DONE 且 owned 与所有 ACTIVE 任务零交集」的任务；上下文被压缩后的第一动作是重读 HANDOFF/TASKS 恢复调度状态，然后才继续。

## 5. 每任务执行循环（TDD + 双重校验 + 打回重做）

建议调用 skills：`executing-plans` / `subagent-driven-development` / `tdd`（或 `test-driven-development`）。

1. **派发**：编排者把完整任务卡交给实现子代理（后端任务可用 backend-architect / ai-engineer 类子代理，前端用 frontend-developer 类；审查一律用全新上下文的独立子代理）。实现者动手前先读任务卡 refs 里的设计章节原文。
2. **红**：先写测试（来源 = VITEST_PLAN 对应行 + 任务卡 GWT），运行并确认**因正确的原因失败**；失败输出摘录进 JOURNAL。
3. **绿**：最小实现通过测试；随后 **Refactor**：对照 SOLID 与 design/01 §2 依赖方向消除重复、校正分层；关键函数补中文注释（写「为什么」，契约行为注明出处）。
4. **自验**：任务卡全部验证命令 + `pnpm lint` + `pnpm typecheck`；结果贴 JOURNAL。**无法验证时如实记录缺什么，禁止假绿。**
5. **提交**：本地 commit（英文 Conventional Commits，body 引用任务与设计章节，例：`feat(agent): triple-budget checks in turn loop (T-P4-03, design/06 §5)`）。一个任务一个逻辑变更。
6. **独立审查（不可跳过）**：编排者起全新上下文审查子代理，输入 = 任务卡 + `git show <sha>` 完整 diff + refs 绝对路径。审查清单：
   - **契约**：数字 / 错误码 / 状态转移逐条对速查表；GWT 断言覆盖 requirement 对应条款；
   - **宪法 8 条**逐条过（重点：先持久化后外部效果、唯一性在 DB、限流硬闸门在最外层、UTC、strict TS、mock 不弱化）；
   - **工程**：SOLID、注释、无 any/魔数/吞错、错误响应形状、日志英文；
   - **测试真实性（变异抽查）**：审查者本地临时反转 1–2 个关键守卫/条件（例：把 `first_attempt_at IS NULL` 守卫注释掉），对应测试必须变红；不变红 = 假绿 = 直接 reject；抽查完恢复现场；
   - **越界**：diff 触碰 owned 之外文件 = reject。
7. **判定与打回**：审查者返回结构化结论 `{ verdict: "pass"|"reject", issues: [{file, line, severity, reason, expected}] }`。
   - `pass` → 编排者**亲自重跑**验证命令终验（不信任任何转述的输出）→ 任务置 DONE → 勾 VITEST_PLAN / PLAN 对应项。
   - `reject` → 带 issues 打回实现者，从第 4 步重走；**同一任务第 3 次被拒** → 编排者亲自接管实现或把任务再拆分，JOURNAL 记录原因；仍失败 → 置 BLOCKED（§8）。
8. **踩坑义务**：定位到非显而易见根因（并发/时序/契约语义/环境差异）→ 按 `AGENTS.md` §7 格式在**同一 commit** 追加条目；契约语义级的坑同步 `docs/analysis/11-gotchas.md` 前先确认不与原文冲突（analysis 只读原则的例外仅限 11-gotchas 的追加，且在 JOURNAL 说明）。

## 6. Git 与交付纪律

- 小步提交、任务边界即提交边界；历史应能让评审按时间线读懂建造过程（考题 §5 明文「保留 git 历史」）。
- 主干 `main` 单线推进；如泳道并行产生分叉，由编排者在串行汇合点合并（冲突用 `resolving-merge-conflicts` skill）。
- 永不提交：`.env`、密钥、`node_modules`、`media/` 产物、coverage。
- **不 push**（未授权）；远端交付由人类执行。

## 7. 阶段验收与持续运行

- **阶段门**：每阶段（P0–P8）结束执行——全仓 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿 + 该阶段「累计产出」（review 报告 §3.3 表）可演示（例：P3 后 S1–S4 用 mock 开关现场复现）→ JOURNAL 写阶段小结 → 更新 HANDOFF → commit。
- **持续运行**：任务完成不停顿，立即从 DAG 取下一个可执行任务；某泳道 BLOCKED 时切换到其他泳道；全部阻塞时做巡检类工作（全量测试、矩阵覆盖核对、README 草稿）并等待，**绝不空转停机**。
- **裁剪预案**（时间不足时按此固定顺序减配，每次裁剪 JOURNAL + README 完成度表双登记）：C1 媒体 → leave-all 的 5s 核对/终局对账装饰（保留契约最小行为）→ 页面 5 预检弹窗美化（保留 422 的 stepIndex/key 展示）。**永不裁剪**：A5 崩溃恢复路径、P7 崩溃注入测试套件、mock 的任何契约行为、审查环节。
- **负面清单**（全程禁止）：引入 Redis/MQ/BullMQ/ORM；实现 design/13 的任何扩容触发器（分区/缓存/对象存储/多租户）；UI 视觉打磨、i18n、主题、响应式；扩写设计文档（只允许 patch 式修订）；用 npm/yarn。

## 8. 自主边界与升级（何时可以停下来等人）

默认全自主。仅以下四类可在 JOURNAL 记 `BLOCKED`（附建议方案）后**切换其他泳道继续工作**，等人处理：
1. 破坏性/不可逆操作需求（删库、drop schema、删卷、批量删除非本会话产生的文件）；
2. 同一任务 3 次打回 + 编排者接管后仍失败；
3. 环境级故障（docker 不可用、依赖源不可达）且无替代路径；
4. 发现设计文档与 requirement.md 冲突且无法从原文裁决。

**契约空隙不阻塞**：解释声明未覆盖的新空隙 → 选最保守解释继续实现，同时登记 design/README 解释声明（新增条目）+ JOURNAL 记录理由。

永不：修改 requirement.md / analysis（11-gotchas 追加除外）；弱化 mock 契约行为让测试变绿；跳过独立审查；把没跑过的验证说成跑过。

## 9. Definition of Done（终验清单，逐项勾选后才算完成）

**运行与构建**
- [ ] 从干净环境按 README 能完整跑起：`pnpm install` → `docker compose up -d` → `pnpm -F server db:migrate && pnpm -F server db:seed` → `pnpm dev`（四服务并行）；README 的每条命令都实际执行验证过。
- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` 全仓全绿。
- [ ] 根 `AGENTS.md` 的命令/端口/脚本名与实际一致（脚手架落地后逐条验证并同步——AGENTS.md 自身的要求）；四个包各有包内 `AGENTS.md`（只写该包特有内容）。

**契约与验收**
- [ ] `server/VITEST_PLAN.md` 全部勾选：I1–I14、S1–S8、gw-1..28、ag-1..19、崩溃注入 4 点、审查回归（含 R-A/R-B 新增行）——或每项未勾条目在 README 完成度表中有明确裁剪记录。
- [ ] `docs/design/11-verification.md` 矩阵 125/125（C3 完成则 ❌ 转 ✅）。
- [ ] S1–S8 每场景一条命令可复现（`pnpm demo:s1`…`pnpm demo:s8` 或 README 记录的等价脚本），断言用 mock 的 `/_test/counters` 作真值（S4 零试探、S5 恰一条、S8 零落地）。
- [ ] A0：迁移可重复执行 + schema 落后/超前拒绝启动，有测试证明；`/api/health` 返回 `{ok, schemaVersion}`。
- [ ] C3 冒烟（已授权）：登录 → 打开群 → 看到 agent run 步骤，单条 Playwright 测试可重复运行。
- [ ] C2（若时间允许，按裁剪顺序它在 C1 之后）：`AGENT_MODE=anthropic` 实例 + 只改 `AGENT_URL` 切换的演示记录（无 key 时用录屏/文档说明）。

**质量与交付面**
- [ ] git 历史：英文 Conventional Commits、任务/设计章节可追溯、无 `.env`；从首个 commit 起无大块「一次性倾倒」。
- [ ] README（中文为主，命令原样）：快速开始、架构一段图、S1–S8 演示方法、「如何验证重启不变量」一章（一条命令跑崩溃测试套件）、**完成度三栏表（完成/部分/未做）**、契约解释声明链接、C2 切换说明。
- [ ] `AGENTS.md` §7 踩坑记录：开发中所有非显而易见根因均已入册（append-only，格式合规）。
- [ ] 抽查复审：编排者最终随机抽 5 个已 DONE 任务重跑其验证命令 + 重读其代码（可读性/注释/SOLID），任何一项不过 → 该任务重开审查循环。
- [ ] `docs/plan/JOURNAL.md` 完整覆盖全部任务；`HANDOFF.md` 终态 = 「DoD 达成，待人类 push/交付」。

## 10. Skills 使用映射（专业场景用专研 skill；不可用则按内置流程降级并 JOURNAL 记录）

Skill 文档位于 `/Users/alfredchaos/.agents/skills/<name>/SKILL.md`（部分来自插件目录）。**skill 是方法论增强，与本提示词冲突时以本提示词为准。**

| 场景 | 首选 skills |
|---|---|
| 阶段 0 规范/计划/任务票 | `to-spec`、`writing-plans`、`to-tickets`、`plan` |
| 编排与执行 | `executing-plans`、`subagent-driven-development`、`implement`；多泳道看板可选 `kanban-orchestrator` + `kanban-worker` |
| TDD 循环 | `tdd` / `test-driven-development` |
| 调试 | `systematic-debugging`、`diagnosing-bugs`；Node 进程级问题 `node-inspect-debugger` |
| 代码审查 | `requesting-code-review`、`code-review`（§5 第 6 步的清单是底线，skill 只能加严不能放宽） |
| 提交与冲突 | `git-commit`、`resolving-merge-conflicts`；lint 钩子可选 `setup-pre-commit` |
| 前端（web 包） | `frontend-design-workflow` / `frontend-skill`；组件库如需选 `shadcn`；C3 冒烟用 `webapp-testing` |
| auth 模块实现时 | `security-best-practices`（B3 会话安全自查） |
| 中断交接 | `handoff`（更新 HANDOFF.md 的方法论） |

## 11. 质量红线（审查发现即 reject，无警告）

1. `any`、非受控断言、静默吞错、本地时区、无出处魔数；
2. 违反「先持久化后外部效果」（对照 design/10 §1 E1–E14 清单）；
3. 用进程内存变量承担唯一性/互斥正确性（必须落 DB 约束）；
4. 弱化 mock 的契约行为让测试变绿（宪法 §3-8）；
5. 假绿测试：断言不指向行为、变异抽查不变红、跳过或篡改契约数字；
6. 关键函数无注释、或审查者无法从代码+注释理解「为什么这样写」；
7. 越界修改（触碰任务卡 owned 之外的文件）；
8. 修改 `docs/requirement.md` / `docs/analysis/`（11-gotchas 追加除外）/ 已应用的迁移文件。

---

*生成：2026-09-27，基于 docs/review/01-design-review-2026-09-27.md（含 §5 复核记录）。项目所有者修订本文件后即可下发。*
