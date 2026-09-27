# JOURNAL · 执行日志（append-only）

> **格式**：每个任务一条记录，按时间顺序追加，**只增不改**（修正以新条目出现，引用旧条目）。
> 每条记录固定五段：
>
> ```
> ## <日期时间> <任务ID 或 事件名>
> - 做了什么：
> - 验证命令与输出摘录：（命令 + 关键输出行；无法验证时如实写缺什么，禁止假绿）
> - 偏差与【解读】：（与任务卡/设计文档的偏离、契约空隙的保守解释及登记位置）
> - 踩坑：（非显而易见根因；契约语义级的同步 docs/analysis/11-gotchas.md 追加说明）
> ```
>
> 阶段边界追加「阶段小结」条目（阶段门四项的执行证据）。
> 本文件由编排者与各任务实现者共同追加；`server/VITEST_PLAN.md` 的实际勾选在阶段门统一执行（SP-6），任务条目里先登记「应勾行」。

---

## 2026-09-27 environment-check（环境自检）
- 做了什么：编排者的 worker 按 DRIVER-PROMPT §3.2 逐项自检 node / pnpm / docker / git。
- 验证命令与输出摘录：**验证待收口**（由 phase0 worker 执行；本条目为占位登记，编排者复核后补输出：`node -v` ≥22、`pnpm -v` ≥9、`docker compose version`、`git --version`）。
- 偏差与【解读】：无（若任何一项缺失，按 §3.2 记 BLOCKED + 替代方案）。
- 踩坑：无。

## 2026-09-27 git-init（git 初始化与首提交）
- 做了什么：编排者的 worker 执行 `git init`、写 `.gitignore`（node_modules/ dist/ coverage/ .env media/ *.tsbuildinfo）、首个 commit 收录全部文档（`docs: initial analysis, design, and review corpus`）。
- 验证命令与输出摘录：**验证待收口**（`git log --oneline` 应显示首提交；`.gitignore` 内容核对）。
- 偏差与【解读】：无。
- 踩坑：无。

## 2026-09-27 R-A…R-G（审查残留修复，P0 前置）
- 做了什么：编排者的文档 worker 按 review §5.2 逐条回写设计文档——R-A（design/04 §4：复活分支先查 `terminal_at`；TOMB 分支 `DO UPDATE SET last_event_id=GREATEST(...)`）、R-B（design/06 §2：END2 第 3 步与 SWEEP 前加守卫 `group.status='active' AND agent_enabled=true`，守卫不过**保留**积压行；语义登记 design/README 解释声明新增条目）、R-C…R-G（编辑性五处：04 §2.2 旧句 / 13 §3 租约措辞 / 15 §2 refresh 措辞 / 14 §2 clientMsgId 有序列表 / 14 §5 gw-5 补投语义区分）；VITEST_PLAN §5 的 D2-1 行补「迟到 joined 不得复活终态账号」场景 + 新增 R-B 回归行；审查报告 §4 追加第 15 行勾选。
- 验证命令与输出摘录：**验证待收口**（复核方法：重读修订段落 + 按 R-A/R-B 场景各做一次时序推演；VITEST_PLAN 两行 diff 核对）。
- 做了什么（补充）：02-TASKS.md 的相关任务（T-P2-09、T-P4-04）已按**修复后的语义**编写，不依赖本次回写的完成时序。
- 偏差与【解读】：无。
- 踩坑：无。

## 2026-09-27 T-P0-01 workspace 脚手架与工程基建
- 做了什么：落地 pnpm workspace 骨架与工程基建（T-P0-01 验收项全量）：根 package.json / tsconfig.base.json / eslint.config.js / pnpm-workspace.yaml（预收录 `packages/*`）、四包骨架（package.json / tsconfig / vitest.config / .env.example / 包内 AGENTS.md 存根）、docker-compose（postgres:16）、根脚本一次性预注册（dev/build/test/lint/typecheck + demo:s1..s8 / e2e / db:migrate / db:seed）、`packages/contract` 占位骨架（F1）。commit `e3d1b5d`（39 files +2791）。
- 验证命令与输出摘录：`pnpm install --frozen-lockfile` → clean；`docker compose up -d` → postgres:16 healthy（pg_isready 通过）；`pnpm lint && pnpm typecheck && pnpm build && pnpm test` → 全绿；`pnpm dev` 冒烟 → vite :5173 回 200、fastify :3000 listening、`/api` 经 vite 代理到 :3000 验证通过。
- 偏差与【解读】：(a) 卡 owned 之外新增 7 个可启动 dev 的占位文件（`server/src/index.ts`、`web/index.html` + `vite.config.ts` + `src/*`、mock 存根）——编排者 brief 明确授权；(b) Docker Hub 不可达 → 经 docker.m.daocloud.io 镜像拉取 postgres:16 后本地 retag，compose 文件未动——全新机器需可访问 Docker Hub；(c) `pnpm-lock.yaml` 一并提交（卡 owned 未列）——随 manifest 所有者提交（既定规则）；(d) 审查 info 级发现两项随本轮收口提交：`@types/node` 钉到 `^22`（对齐 engines floor）、各包 tsconfig `include` 扩宽为 `["src", "tests", "vitest.config.ts"]`（`rootDir` 相应改包根——include 越出 src 后 `tsc` 与 `tsc --noEmit` 均报 TS6059；dist 布局变 `dist/src/**`，dev 走 tsx 不受影响）。
- 踩坑：`docker compose up` 拉镜像超时失败的根因是本机网络到 registry-1.docker.io（Docker Hub）不可达，而非 compose 配置问题——绕法：`docker pull docker.m.daocloud.io/library/postgres:16` 后 `docker tag` 为 `postgres:16`。

## 2026-09-27 T-P0-02 follow-up（vitest config + 测试排除 emit）
- 做了什么：按 T-P0-02 审查发现补齐 contract 包测试基建——`package.json` 增 `"test": "vitest run"`（对齐兄弟包脚本形状）；新增 `vitest.config.ts`（include 限定 `src/**/*.test.ts`，仿 mock-agent 样式）；`tsconfig.json` 增 `"exclude": ["src/__tests__"]`，并删除 dist 中已误出的测试副本。
- 验证命令与输出摘录：`pnpm -F @kapibala/contract build` → dist 仅 5 个源码模块（.js/.d.ts），无 `__tests__`；`pnpm -F @kapibala/contract test` → Test Files 1 passed / Tests 6 passed（仅 src 一份，不再执行 dist 副本）；`pnpm typecheck` → 0 错。
- 偏差与【解读】：tsconfig `exclude` 收缩编译输入集——`src/__tests__/shapes.test.ts` 因此不再进 `tsc` 程序，其**编译期**穷尽性断言（`Record<X, true>`）暂不被根 typecheck 执行，**运行时**常量数组断言在 vitest 下仍然生效；单 tsconfig 无法同时「测试参与 typecheck + 不参与 emit」，如需完整编译期断言，后续以测试专用 tsconfig 分离收口（回 T-P0-02 串行变更）。
- 踩坑：tsc 不清理旧产物——排除测试后已存在的 `dist/__tests__/` 仍残留，须手动删除后重建才能验证干净 emit。

## 2026-09-27 T-P0-02 共享契约类型包 packages/contract
- 做了什么：impl-a 填充全部跨包共享类型——`agent-protocol.ts`（agent 错误码 13 码 / 工具定义 / 协议形状）、`gateway-errors.ts`（网关 13 码）、`api-errors.ts`（自有 API 码全表 + 各状态联合类型）、`ws-events.ts`（REQ §2.3 六类 + DES/08 §2.3 扩展 group_updated/job）与 `index.ts` 导出。commit `bbcb69d`。
- 验证命令与输出摘录：审查者 **PASS**，附变异探针证据——改名一个错误码 → `shapes.test.ts` 立即变红，还原后复绿（穷尽性断言真实生效，非恒绿）。
- 偏差与【解读】：审查发现包缺 test 脚本与 vitest 配置（plain `vitest run` 会误执行 dist/ 编译副本）→ follow-up `17bfca7` 落 `vitest.config.ts` + `"test"` + tsconfig `exclude`（详见上一条目）；残留 info 级：`ws-events.ts` 的 group_updated 注释应显式引用 design/08 §2.3——**随本轮簿记提交修复**（一行注释，事件名 + §2.3 事件类型表扩展）。
- 踩坑：见上条目（tsc 不清旧产物；单 tsconfig 下测试「参与 typecheck」与「不参与 emit」不可兼得）。

## 2026-09-27 T-P0-03 全量数据库迁移（20 表 DDL）
- 做了什么：impl-b 按 DES/02 全文一次性落地迁移 001–008：19 张业务表 + `schema_migrations`，全部约束/索引/生成列（含单飞行部分唯一索引、`sort_key` 生成列、`resend_count` CHECK）。commit `851c11f`。
- 验证命令与输出摘录：审查者 **PASS**——保真度**穷举审计**（逐列逐约束对照 DES/02）：174 列 / 21 CHECK / 9 唯一索引 / 18 FK 全数核实；另 14 条行为探针（乱序投影/单飞行冲突/幂等重放等）全部通过。
- 偏差与【解读】：契约空隙的保守解释（如状态列 text + CHECK 而非 enum）已在迁移文件内注释注明出处。
- 踩坑：无。

## 2026-09-27 T-P0-05 契约常量集中定义 + I14 对照测试
- 做了什么：impl-a 落地 `server/src/constants.ts`（全仓唯一常量归宿）：54 个常量逐个带出处注释（QR §1 契约数字 + 各设计值），`tests/constants.test.ts` 56 条断言逐个对照。commit `e1e702f`。
- 验证命令与输出摘录：I14 审查含**变异抽查**（篡改常量值 → 测试变红后还原）；`pnpm -F server test tests/constants.test.ts` → 全绿；VITEST_PLAN §1 的 I14 行已勾（☑）。
- 偏差与【解读】：审查指出漏 `REFRESH_TOKEN_TTL_MS` 与 pending-event 保留常量——follow-up 曾挂 impl-a 待收口，**簿记时已落地**：`b204dfd`（refresh TTL + 死信/待定事件保留常量补齐）。
- 踩坑：无。

## 2026-09-27 T-P0-04 db 基建 + 迁移 runner + 版本门 + /api/health
- 做了什么：impl-b 落地 `server/src/db/`（pool / tx / pages / migrate / ensure-schema）与 HTTP 骨架（app、request-id/errors/auth-guard 插件、health 路由）、启动版本门接线。commit `a937f9c`（18 files +956/−10）。
- 验证命令与输出摘录：审查者 **PASS**——版本门 **live 双向验证**（迁移落后与 schema 超前两方向均实测拒启）；schema 门附**变异探针**（故意破坏 → 变红，验证后已还原）；`tests/migration.test.ts` + `tests/health.test.ts` 全绿；VITEST_PLAN §6.1 的 A0-1/A0-2/A-02/A-20/A-21 登记勾选。
- 偏差与【解读】：无。
- 踩坑：无。

## 2026-09-27 T-P0-06 seed：admin/viewer + acc-01..04
- 做了什么：幂等 seed 落地——`server/src/db/seed.ts`（users admin/viewer + accounts acc-01..04）。commit `741d249`（4 files +162）。
- 验证命令与输出摘录：审查者 **PASS**；`tests/seed.test.ts` 覆盖幂等与 G-21 预置（账号 idle、对应字段 NULL）；VITEST_PLAN §6.1 的 G-21 登记勾选。
- 偏差与【解读】：无。
- 踩坑：无。

## 2026-09-27 T-P0-07 认证与会话（B3 后端全量 + viewer 403）
- 做了什么：auth 模块与路由落地——`server/src/modules/auth/`（service / tokens）+ `routes/auth.ts`（login/refresh/logout）+ viewer 角色门。commit `04ea50c`（6 files +557/−2）。
- 验证命令与输出摘录：审查者 **PASS**——含 **live B3 链验证**（login → refresh HttpOnly cookie → 复用作废整会话 → logout 即失效，真实端点链路走通）；`tests/auth/session.test.ts` 全绿；VITEST_PLAN §1 I13 勾选，§6.1 的 A-01/A0-3/B3-1/2/3 登记勾选。**至此 P0 阶段门达成（7/7）**。
- 偏差与【解读】：无。
- 踩坑：无。

## 2026-09-27 T-P1-01 mock-gateway 骨架 + 账号域 + /_test 控制平面
- 做了什么：impl-a 落地 mock-gateway 包骨架（app / index / state）、账号域（`accounts.ts`）与 `/_test` 控制平面（`test-plane.ts`）。commit `e5099d3`（6 files +769/−5）。
- 验证命令与输出摘录：审查者 **PASS**；两条 minor（`/_test` 入参守卫）随修复提交 `2fb533e` 落地；`mock-gateway/tests/accounts.test.ts` 全绿。
- 偏差与【解读】：minor 均为入参守卫收紧，无接口语义变化。
- 踩坑：无。

## 2026-09-27 T-P1-02 事件账本与 SSE 推送器
- 做了什么：`mock-gateway/src/ledger.ts`（事件账本）+ `sse.ts`（SSE 推送器）落地，接线 app/state。commit `6374ed3`（5 files +379）。
- 验证命令与输出摘录：审查者 **PASS**；`mock-gateway/tests/sse.test.ts` 全绿。
- 偏差与【解读】：审查一条 advisory——`decorateFrame` 缝偏窄，容纳不了乱序/补投类开关（gw-4/5）；不单开修复，随 **T-P1-05** 扩缝处理。
- 踩坑：无。

## 2026-09-27 T-P1-03 群生命周期端点（create/invite/join/promote）
- 做了什么：`mock-gateway/src/groups.ts` 群域落地（create/invite/join/promote 端点），接线 app。commit `90d66fa`（4 files +486）。
- 验证命令与输出摘录：`mock-gateway/tests/groups.test.ts` 全绿。簿记时点审查**进行中**——编排者按协议先记 DONE（02-TASKS 已翻），若审查拒绝再重开。
- 偏差与【解读】：派发卡文案曾出现契约中不存在的字段/开关名（编排层漂移）；实现以契约为准，**按 REQ §2.1 正确**，未带入代码。
- 踩坑：无。

## 2026-09-27 T-P1-05 S1/S2 驱动开关（gw-1/2/3）与 counters 断言
- 做了什么：`mock-gateway/src/switches/basic.ts` 落地三开关语义（开关名逐字取自 DES/14 §5 表）：gw-1 `send_accept_slow` / gw-2 `message_sent_delay` 的钉值解析 + 契约区间常量（1–2s / 50–2000ms）自 `messaging.ts` 收拢为单一归宿；gw-3 `dup_push_all` 的投帧展开器（每帧投递两次，同 eventId）。**扩缝**（T-P1-02 审查 advisory 的收口）：`src/sse.ts` 的 `decorateFrame(frame)=>LedgerFrame`（1→1，表达不了双推/乱序）改为 `createFrameExpander: () => (frame)=>LedgerFrame[]`——每连接一实例（可自带缓冲），展开点位于**水位过滤之后**，水位改为「已写 eventId 的单调最大值」，故延迟/乱序产出的较小 eventId 不再被 `eventId > lastSentEventId` 丢弃；`?since=` 独占回放语义未动。`src/app.ts` 接线、`src/state.ts` 补 `framesEmitted` 语义注释（计账本产出、不计投递次数）。新增 `mock-gateway/tests/switches-basic.test.ts`（8 用例）。
- 验证命令与输出摘录：**先红后绿**——前任 worker 留下的 6 用例全红（双推未实现 → 收帧超时 5s；`(await app.inject(...).json())` 优先级笔误 → TypeError），修正笔误并实现后 `pnpm -F mock-gateway test` → **68 passed**（原 60 + 新 8）、`pnpm -F mock-gateway typecheck` → 0 错、`npx eslint mock-gateway/src mock-gateway/tests` → clean。**变异抽查**（改后已还原、复跑全绿）：① 双推改单推 → 3 条双推用例红；② 水位过滤挪到展开之后 → seam 乱序自检用例红（eventId 1 被丢）+ 双推红；③ 钉值解析改恒随机 → gw-1/gw-2/覆盖参数/counters 4 条红。**真实进程冒烟**（`PORT=4178 pnpm exec tsx src/index.ts` + curl）：gw-1 钉 1500ms → 202 的 `time_total` = **1.502s**；gw-2 钉 400ms → SSE 依次收 `message_sent`(id 1) 与回流 `message`(id 2)；`GET /_test/counters` = `{sendCallsByAccount:{acc-01:1},sendCallsByClientMsgId:{c-smoke:1},landedMessages:1,kickCalls:0,framesEmitted:2}`；:4177 的 gw-3 冒烟 = 同一帧（id/data 逐字节相同）投递两次而 `framesEmitted=1`、账本一行。
- 偏差与【解读】：① gw-1/gw-2 的钉值读取在 T-P1-04 已内联于 `messaging.ts`，本任务按卡面 owned 收拢进 `switches/basic.ts`（行为逐位不变）；② counters 用例把「同 clientMsgId 两次 send（不同账号）」与「群不存在 → 404 的 send」一并纳入断言，证明计数计的是**调用尝试**而非成功（S4「限流期内 sendCallsByAccount=0」的语义基础），故 `framesEmitted=7`——前任 worker 草稿写 4 与其自身注释（列了 5 项）不符，按实测真值改正；③ 钉值断言的上界一律取**契约区间之外**（gw-1 改钉 300ms < 下沿 1000ms、覆盖用例钉 0ms < message_sent 下沿 50ms），钉值被忽略时随机延迟必落区间内 → 用例变红（假绿防线）。**应勾行（VITEST_PLAN，阶段门统一勾选）**：§3.1 gw-1/2 与 gw-3 行的落地侧 `mock-gateway/tests/switches-basic.test.ts`；§2 S1/S2 行的开关驱动侧已就绪（场景用例本体归 T-P3-11/T-P4-15）。gw-4 `reorder_1s` 在 T-P2-12 直接接入同一 seam（本任务已用「相邻交换」最小实现自检该接入点）。
- 踩坑：SSE 投递修饰插在 1→1 的 `decorateFrame` 里既表达不出双推、也表达不出乱序；而把展开结果**再过一次水位**会同时丢掉「同 eventId 的第二份」与「乱序后的旧帧」——seam 必须位于水位过滤之后且水位单调不回退（`src/sse.ts` 注释 + `tests/switches-basic.test.ts` 的 seam 自检用例守住）。

---

<!-- 后续任务条目按上述格式在此追加。示例：
## 2026-09-XX T-P0-01 workspace 脚手架
- 做了什么：…
- 验证命令与输出摘录：…
- 偏差与【解读】：…
- 踩坑：…
-->
