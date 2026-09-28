# HANDOFF · 交接快照

> 用法：**会话恢复后的第一动作 = 读本文件 + `02-TASKS.md` 状态列 + `JOURNAL.md` 末尾**，不信任会话记忆。
> 在阶段边界与任何可能被中断的时刻更新本文件。状态枚举：TODO / ACTIVE / REVIEW / DONE / BLOCKED。

## 目标（不变）

从「文档完备、零代码」自主迭代到 DRIVER-PROMPT §9 的 Definition of Done：A/B 组行为全对且可演示（S1–S8 一条命令复现）、崩溃一致性证据（P7 套件 + I1–I14 映射）、C1/C2/C3 按余力全收、诚实完成度表；git 历史可读；不 push。

## 已完成

- [x] 设计收口：D1-1/D1-2/D1-3、X-1/X-2、D2-*、D3-*、O1–O4 裁剪已回写设计文档（review §4 清单 1–12）。
- [x] 审查残留 R-A/R-B/R-C…R-G 已由文档 worker 回写（phase0 完成并收口，commit f7a05a8）。
- [x] 环境自检 + git init + 首提交（phase0 完成，见 JOURNAL）。
- [x] 规划三件套：`00-SPEC.md`（规范书 + 验收总表 + 裁剪预案）、`01-PLAN.md`（P0–P8+缓冲）、`02-TASKS.md`（73 个原子任务 DAG）；`JOURNAL.md` / `HANDOFF.md` 骨架就位。
- [x] 计划评审门：2 个独立上下文审查子代理评审 SPEC/PLAN/TASKS → **均 PASS（无 blocker）**；合并修复清单 F1–F11（含 contract 占位骨架实现细节）已全部回写 02-TASKS / 00-SPEC / 01-PLAN / 本文件，卡字段完整性脚本复查通过。计划三件套已 commit（514c287）。
- [x] **T-P0-01 workspace 脚手架与工程基建 DONE**（e3d1b5d，39 files +2791；lint/typecheck/build/test 全绿 + `pnpm dev` 冒烟通过，见 JOURNAL）。reviewer info 级跟进（@types/node 钉 `^22`、各包 tsconfig include 覆盖 tests/）已随收口提交落地。
- [x] **T-P0-02 共享契约类型包 DONE**（bbcb69d；审查 PASS + 变异探针证据；vitest 基建 follow-up `17bfca7`、ws-events 注释补引 design/08 §2.3 随簿记提交落地）。
- [x] **T-P0-03 全量数据库迁移 DONE**（851c11f；001–008 共 20 表；审查 PASS——174 列/21 CHECK/9 唯一/18 FK 穷举保真审计 + 14 行为探针全过）。
- [x] **T-P0-05 契约常量 + I14 DONE**（e1e702f；54 常量 + 56 断言含变异抽查，VITEST_PLAN I14 已勾；REFRESH_TOKEN_TTL/pending-event 保留常量 follow-up 已由 `b204dfd` 收口）。
- [x] **T-P0-04 db 基建 + 迁移 runner + 版本门 + /api/health DONE**（a937f9c，18 files +956/−10；审查 PASS——版本门 live 双向验证 + schema 门变异探针（验证后还原））。
- [x] **T-P0-06 seed DONE**（741d249；审查 PASS；幂等 seed + G-21 预置）。
- [x] **T-P0-07 auth B3 DONE**（04ea50c；审查 PASS + live B3 链验证；I13 / A-01 / A0-3 / B3-1/2/3 登记勾选）。
- [x] **P0 阶段门达成（7/7 全 DONE）**；矩阵外验收编号（A0-1/2/3、A-01/02/20/21、G-21、B3-1/2/3）集中登记于 `server/VITEST_PLAN.md` §6.1。
- [x] **T-P1-01 mock-gateway 骨架 + 账号域 + /_test 控制平面 DONE**（e5099d3 + 审查修复 2fb533e（2 minor 入参守卫）；审查 PASS）。
- [x] **T-P1-02 事件账本与 SSE 推送器 DONE**（6374ed3；审查 PASS；advisory：decorateFrame 缝对乱序/补投过窄 → T-P1-05 扩缝）。
- [x] **T-P1-03 群生命周期端点 DONE**（90d66fa；簿记时点审查进行中——编排者决定先记 DONE，审查拒绝则重开；备注：派发卡曾出现非契约字段/开关名，实现按 REQ §2.1 正确）。
- [x] **UX 审计缺陷修复批次（audit-2026-09-28 复审闭环）实现完毕**：独立 reviewer `review-fixes` 判 **APPROVE**，收口五门全绿（lint / server typecheck / web typecheck / web test 69 · build）；详见「进行中」与 `JOURNAL.md` 同日条目。**代码未提交**（提交权留给用户）。

## 进行中

- **唯一在途事项 = 审计修复批次尚未提交**：`GET /api/sequences`（解释声明 #27）+ `useWsEvent` 订阅竞态根修（`useSyncExternalStore` 就绪门控）+ AppShell 导航壳 / `/groups` 列表与建群 job 轮询 / NotFound 页 + AgentRunPage 轮询与返回容错 + GroupDetailPage notFound 态与换 id 复位 + AccountsPage `→suspended` 确认 + SequencesPage 换服务端定义列表。工作区 = 16 改（含本文件与 JOURNAL 簿记）+ 6 个新代码/测试文件 + `docs/review/ux-audit-2026-09-28/` 审计产物目录；**commit/push 由用户执行**——恢复会话的第一动作先 `git status`，别假设干净。
- 除此之外无进行中任务：73/73 卡全部 DONE，P0–P8 阶段门全部达成（见「剩余」与文末终态块）。

## 剩余（按 DAG 顺序，详见 02-TASKS.md）

- P0：**已完成（7/7）**（全仓终验时点）。
- P1（5）：已完成。
- P2（12）：已完成——SSE/死信/账号状态机/入站/成员投影/WS/时间线 + gw-4/5/19/28。
- P3（11）：已完成——出站全链/建群/leave-all + S1–S4 集成。
- P4（15）：已完成——mock-agent + A5 全量 + S5/S6。
- P5（5）：已完成——web 页面 1–3 + 401 单飞。
- P6（8）：已完成——序列 + 页面 4/5 + S7/S8 + B4。
- P7（5）：已完成——崩溃注入套件 + I 映射收口。
- P8（5）：已完成——C1 媒体落盘/清理、C2 anthropic provider、C3 playwright 冒烟、README/完成度表、DoD 终验。

## 风险

| 风险 | 状态 | 缓解 |
|---|---|---|
| 工程量 vs 48h（review R1） | 收口 | 全部阶段裁剪决策已在各 P* 提交落地；无带病项遗留 |
| server 全量测试 flake | 开放·已知 | 资源争用型（各轮挂的文件不同、孤立跑全绿、maxWorkers:4 后三轮终验一轮全绿）；如再发按「孤立重跑判性」流程确认非新红 |
| C2 真实 LLM | 需自配 | 通道/映射实装且绿（mock 单测 + e2e scripted）；ANTHROPIC_API_KEY 需使用者自备，后端只改 `AGENT_URL` |
| C3 e2e 竞态 | 已消解 | state 文件生命周期归 backend 自理（启动删旧 + ready 最后写）；连跑多轮绿 |
| R-A/R-B 回写验证未收口 | 已消解 | T-P7-05 审计收口：VITEST_PLAN D2-1 扩展行与 R-B 回归行已勾选，全量套件绿（commit 22397f6） |
| lane-C（mock-agent）正式排在 P4 但 DAG 只依赖 T-P0-02 | 已利用 | lane-A 阻塞时提前拉起 T-P4-01..03（不违反阶段依赖：它们不消费 server） |
| 共享文件竞态（index.ts/dispatch.ts/registry.ts/routes/index.ts/VITEST_PLAN/根 package.json） | 已消解 | §0 规则 1/2/3/7：依赖边串行化 + 阶段门统一勾选 + 脚本预注册 |
| AGENTS.md 命令漂移 | 已消解 | T-P0-01 初核对、T-P8-04 终同步，域任务只核对不改 |
| Docker Hub 不可达（本机网络） | 已缓解 | postgres:16 经 docker.m.daocloud.io 拉取后本地 retag（compose 未动）；全新机器需可访问 Docker Hub 或预配镜像 |
| 审计修复批次未提交 | 开放 | 工作区 16 改 + 6 新文件 + 审计产物目录（HEAD 仍 `0f542e0`，91 commits）；提交/推送归用户，簿记不代作 commit |
| GroupsPage 新群以列表差集识别 | 已知限制 | job 响应不带 groupId，并发建群会误认（文件内注记已声明）；后端补 jobId→群 关联即消 |

## 验证状态快照（最近一次）

- 全仓 lint / typecheck / build / test：**四命令全绿**（T-P8-05 终验逐条实跑；server 测试 typecheck 面经 `tsconfig.test.json` 修复后纳入检查）。
- **最近一次实跑（审计修复批次收口门，逐条 exit 0）**：`pnpm lint` 0 错 · `pnpm -F server typecheck` Done · `pnpm -F web typecheck` Done · `pnpm -F web test` 9 files / 69 tests 全绿 · `pnpm build` 5 包 Done（web bundle 279.86 kB │ gzip 88.85 kB）。`pnpm -F server test` 未随簿记重跑（DB-bound ≈80s）；后端面改动落地时已实跑 58 files / 438 tests 全绿。
- 簿记同属未提交：`JOURNAL.md` 新增「2026-09-28 UX 审计缺陷修复（audit-2026-09-28 复审闭环）」条目 + 本文件五处（已完成 / 进行中 / 风险 / 验证状态快照 / 待人工验收）同步更新——`git status` 里两项 `M docs/plan/*` 即它们，与代码改动一起等用户提交。
- 阶段门：**P0–P8 全部达成（73/73 卡 DONE）**。
- VITEST_PLAN：**125 行矩阵勾选完毕**（T-P7-05 `22397f6` 收口）。
- 计划评审门：已通过（两审查 PASS + F1–F11 修复落地 + 脚本复查）。

## 待人工验收（UX 审计修复批次）

- [ ] 建群表单联调：选 online 账号建群 → 202 受理 → `GET /api/jobs/:jobId` 轮询 → 新行出现；换离线账号撞 `ACCOUNT_NOT_ONLINE`（422）时提示文案与落点是否可接受。
- [ ] 登出：AppShell 右上「登出」→ 会话清空 + 跳 `/login`，后续请求不再带旧 token。
- [ ] `/groups` 行点击：列表行 → `/groups/:id`；A→B 来回切不串页（不复用上页的「群不存在」/旧详情）。
- [ ] notFound 页：已登录手输未知路径 → 404 页且导航壳仍在；未登录撞未知路径先去 `/login`。
- [ ] blocked 横幅观感：agent run 落 `blocked` 时红色 alert + endReason 徽标在真实信息密度下是否醒目而不扰。
- [ ] 序列页服务端列表空态：清空 `sequence` 表后刷新 → 「（暂无定义）」；定义后刷新列表仍在（F5 丢定义已闭）。

> **终态（2026-09-28）：DoD 达成，已交付 https://github.com/AlfredChaos/kapibala（public，main=90 commits）。**
>
> - 四门终验：`pnpm lint` 0 错 · `pnpm typecheck` 5/5 包 Done · `pnpm build` 全 Done（web 271.52 kB）· `pnpm test` 全绿（contract 6 + mock-agent 57 + mock-gateway 120 + web 52 + server 434 = **669 tests**）。
> - 任务：**73/73 卡全 DONE**（T-P8-05 统一勾选：逐卡比对 `git log` 提交主题——51 张历史遗留未翻状态的卡全部有对应提交，无一悬空；四命令全绿为行为证据）。
> - 矩阵：VITEST_PLAN 125 行勾选完毕（T-P7-05 收口 22397f6）。
> - 抽查复审：**5/5 PASS**（review-final 独立会话：T-P4-15/T-P6-06/T-P7-03/T-P8-01/T-P2-12 重跑验证+代码重读；4 条非阻塞观察见 JOURNAL）。
> - git：84 提交、Conventional Commits、一提交一逻辑变更、工作区干净（仅 flake 修复/类型面提交均为单点变更）。
> - 交付后更新：上行「工作区干净」为 T-P8-05 时点事实；其后的 UX 审计修复批次已改动工作区且**未提交**（HEAD 仍 `0f542e0`），commit/push 由用户决定。
