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

## 2026-09-27 T-P2-12 mock-gateway 乱序/补投/延迟/外部成员开关（gw-4/5/19/28）
- 做了什么：`src/switches/timing.ts` 落地 gw-4 `reorder_1s`（投递层相邻帧交换：扣住一帧，下一帧到达则**先写新帧再写旧帧**；无下一帧则到 `holdMs` 冲刷尾帧——不丢帧；`holdMs` 夹进契约乱序窗口 [0,1s]，钉值也不能突破）与 gw-19 `member_joined_delay`（钉值/区间解析自 `groups.ts` 收拢，契约区间 100–1500ms 常量随迁）；`src/switches/backlog.ts` 落地 gw-5 `offline_backlog`（arm 时刻按离线窗口逐条注入补投帧：**新 eventId + 原值 msgId/sentAt/text/groupId/senderPlatformUserId**，经 `appendLedger` 即「`/_test/emit` 配方」，`landedMessages` 不增）与 gw-28 `external_member_events`（mock 自造 `ext-<seq>` 外部用户进/出群、推 member_joined/member_left、网关成员列表同步变化）；`test-plane.ts` 抽出 `armSwitch`（11/12 置终态标志 + 5/28 注入；失败 → 400 且开关不登记）。**投递 seam 再加宽**：T-P1-05 的 `FrameExpander (frame)=>LedgerFrame[]` → `FrameDelivery{push,close?}` + `FrameSink`（`createFrameDelivery: (sink)=>FrameDelivery`，每连接一实例）——gw-4 的尾帧冲刷是**延后写出**，同步返回数组表达不了；`app.ts` 把投递链串成 **gw-4 定序 → gw-3 复制 → socket**（双推两份始终相邻）。`switches.ts` 增 `readTargetString`，`randomBetween` 收为共享（basic/timing/groups/messaging 单一随机源）。新增 `tests/switches-timing.test.ts`（16 用例）+ `tests/helpers/gateway.ts`（arrange/收帧助手自 switches-basic.test.ts 提取，两文件共用）。
- 验证命令与输出摘录：**先红后绿**——实现前 `pnpm -F mock-gateway test tests/switches-timing.test.ts` → **12 failed | 4 passed**（gw-4 交换/gw-5 补投/gw-28 注入全红；gw-19 两条与「未开开关原序透传」先绿，因 gw-19 行为在 T-P1-03 已存在、本任务只收拢归宿）。实现后：`pnpm -F mock-gateway test` → **83 passed**（6 文件）、`typecheck` → 0 错、`npx eslint mock-gateway/src mock-gateway/tests` → clean；下游 seam 消费者 `pnpm -F server test tests/gateway-client.test.ts` → **15 passed**。**变异抽查**（改后已还原、复跑 83 绿）：① gw-4 改直通 → 交换 / 尾帧冲刷 / message 先于 message_sent 3 条红；② 去掉 `holdMs` 的 1s 夹取 → 钉 5000 的窗口用例红（5s 才到）；③ 去掉尾帧冲刷 → 3 条红（收帧超时）；④ 补投帧 sentAt 改 `new Date()` → gw-5 三条「原值 sentAt」红；⑤ gw-28 不写成员集 → 3 条红。**真实进程冒烟**（`PORT=4179/4180 pnpm exec tsx src/index.ts` + curl）：gw-28 arm → `GET /groups/gw-1/members` = `[puid-3b2f660a, ext-1]`；gw-5 arm → SSE 出现 `id:3 event:message data:{msgId:"m-1",sentAt:"…05.429Z"}`，与 `id:2` 业务字段逐字相同而 eventId 更大，`?since=2` 仍只回 `id:3`（独占语义未动），`landedMessages=1`、`framesEmitted=4`；gw-4 arm → `?since=0` 实收顺序 `[2,1,4,3]`（相邻交换）；arrange 失败面：`offline_backlog` 未知账号 → 400、`external_member_events` 未知群 → 400。
- 偏差与【解读】：① gw-5 的注入触发点定为 **arm 时刻一次性**（DES/14 §5 行 5「开关打开时…按离线窗口逐条 emit」）：`target.accountId` 必填、`target.groupId` 可选、`params.sentAtFromMs/sentAtUntilMs`（含端点）圈窗口；**无命中一律 400**（arrange 写错必须当场炸，静默无效会让 S 用例假绿）；重复 arm = 再注入一次（at-least-once 下合法）。② gw-5 只补投 `message`（不补 `message_sent`）——REQ §2.1 离线补投讲的是「消息通过事件流补投」，时间线/分页消费的是 `message`（VITEST gw-5 → timeline-pagination）。③ gw-4 的乱序幅度 = 扣帧时长，故以「夹取到契约窗口 1s」结构性保证 ≤1s（不逐对比较 emittedAt，无死代码）；`holdMs` 默认 200ms 是 mock 内部传输选择（非契约数字，定位同 `HEARTBEAT_MS`）。④ gw-28：`params.action='joined'|'left'`（默认 joined）、可选 `params.platformUserId`；`left` 缺省取群内第一个外部成员（puid ∉ 服务账号集合），无外部成员/非成员 → 400。⑤ seam 由 `createFrameExpander` **改名加宽**为 `createFrameDelivery`（clean cutover，无兼容别名）；switches-basic.test.ts 里那段「合成 reorder 展开器」自检随之删除，其保证由 gw-4 真实用例接管（该文件 7 用例仍全绿）。**应勾行（VITEST_PLAN，阶段门统一勾选）**：§3.1 gw-4/5/19/28 的落地侧 `mock-gateway/tests/switches-timing.test.ts`（server 侧仍分别归 finalize-sent / timeline-pagination / member-projection）。
- 踩坑：投递层一旦要支持「延后写出」（gw-4 尾帧冲刷），seam 就不能是同步返回 `LedgerFrame[]`——必须把 sink 交给开关层（`(sink)=>FrameDelivery`）并提供 `close()` 清定时器，否则连接关闭后定时器向死 socket 写帧、或尾帧永久滞留（用例表现为收帧超时）。另：Fastify 实例被收帧助手 `close()` 后不能再 `inject`（`Fastify has already been closed`）——同一 app 的 SSE 观测必须排在全部 arrange 之后。

## 2026-09-27 T-P3-09 mock-gateway 出站类开关（gw-6..10/14..17/27）
- 做了什么：`src/switches/outbound.ts` 落地出站判定（开关名逐字取自 DES/14 §5 表）——gw-6 `rate_limit`（429 `{retryAfterSeconds}` + **计时重置**由网关侧实现；窗口内复用首次值以兑现「再次得到**同样**的错误」）、gw-7/8 的 504 三态判定（`land_after_1500` / `not_sent`，1.5s 常量随迁）、gw-9 `by_client_id_503` 与 gw-10 `gateway_503_all` 的不可用窗口（`durationMs` 在 arm 时归一为绝对 `untilMs`，未给 = 直到 clear；503 体 `{code:'UNAVAILABLE'}` 取 contract 传输层码）、gw-14 群禁写（判定 + DES/14 §2 的 `writeForbidden` 状态位 arm/clear 同步）、gw-15 `message_failed_event`（两码闭集 + **arrange 校验**：缺 code / 非闭集 → 400，收口 T-P1-04 审查 advisory）、gw-16 强制「不在群」、gw-17 `account_offline_409`（接入 accounts.ts 的五操作共享闸门，connect 不受影响）。`src/switches/terminal.ts` 收拢 gw-11/12 的终态标志（自 test-plane.ts 迁出）并落地 gw-13 `account_status_event`：置终态 + 推 `account_status` + **自动移出所有群并逐群推 `member_left`**（REQ §2.1 逐字）。`src/media.ts` 由恒 404 存根充实为真实媒体面（gw-27）：确定性 SVG 字节、`GET /media/:id` 带 content-type 回字节、`media_expire_404`（arm 即过期 / `afterMs` 到期过期 / `target.mediaId` 收窄）→ 404；`message` 事件的 `mediaUrl` 是**绝对 URL**（消费方契约：server `downloadMedia(mediaUrl)` 直接 fetch 不拼 base）。`app.ts` 注册 gw-10 的 onRequest 拦截（路由之前、`/_test` 豁免）；`state.ts` 增 `media` 存储 + `rateLimitRetryAfterSeconds` + 消息行 `mediaUrl`（gw-5 补投按原值带上）；`test-plane.ts` 的 arm/clear 改为 `applyTerminalSwitch → applyOutboundSwitch → 注入` 三段 dispatch。新增 `tests/switches-outbound.test.ts`（19 用例）；`tests/helpers/gateway.ts` 补 `byClientId` / `withListening` / `frameAt` / `lastFrame` / `singleFrame`（switches-timing.test.ts 的本地副本随之收拢）。
- 验证命令与输出摘录：**先红后绿**——`git stash` 掉 `mock-gateway/src` 的实现后跑 `pnpm -F mock-gateway test tests/switches-outbound.test.ts` → **15 failed | 4 passed**（gw-9/10/13/17/27 与 gw-6「同样错误+复用值」/gw-15 校验全红；先绿的 4 条是 T-P1-04 已实现的 gw-6 首探/gw-7/gw-8/gw-15 行为）。实现后：`pnpm -F mock-gateway test` → **102 passed**（7 文件）、`pnpm -F mock-gateway typecheck` → 0 错、`npx eslint mock-gateway/src mock-gateway/tests` → clean。**变异抽查**（逐个改后还原、复跑 102 绿）：① 去掉 429 计时重置 → gw-6 两条红；② gw-13 不移出群 → 两条红；③ gw-15 校验改恒 null → arrange 用例红；④ gw-17 恒 false → 五操作 409 用例红；⑤ 不可用窗口恒 false → gw-9 两条 + gw-10 两条 + counters 用例红；⑥ 媒体恒不过期 → gw-27 三条红；⑦ 去掉 `/_test` 豁免 → gw-10 两条红（开关关不掉）。**真实进程冒烟**（`PORT=4181 pnpm exec tsx src/index.ts` + curl）：gw-6 两次试探均 `429 {retryAfterSeconds:2}` 且 `sendCallsByAccount.acc-02=2`、`landedMessages=0`；gw-15 缺 code / `code:"BOGUS"` → 400（带精确文案）；gw-9 → by-client-id `503 {code:UNAVAILABLE}` 而同期 send 仍 202、300ms 后自动恢复 200；gw-27 → SSE 帧里 `mediaUrl=http://127.0.0.1:4181/media/m-3`（绝对、带真实端口），下载 `200 image/svg+xml` 且字节含 `data-media-id="m-3"`，arm `media_expire_404` → 404；gw-13 → `members` 只剩群主、acc-02 connect `403 ACCOUNT_SUSPENDED`、账本各 1 条 `account_status`/`member_left`；gw-10 → send/members/events 全 503 而 `/_test/counters` 200，clear 后 send 202，且 503 那次的 `c-z` **未进 counters**（`c-z2` 进了）。
- 偏差与【解读】：① gw-6 的「计时重置」在**网关侧**实现（每次试探把窗口推满 `retryAfterSeconds`），server 侧的零试探是另一半（S4）；窗口内 `retryAfterSeconds` 复用首次值（新增 `rateLimitRetryAfterSeconds` 状态），否则 clear 后再探会漂到默认 30s，把「到期自动恢复」的用例悄悄拖长。② gw-6 的 429 判定保留「开关已 clear 但窗口未过 → 仍 429」——契约不依赖开关存活（`rateLimitedUntil` 是网关状态）。③ gw-10 的 503 拦在路由之前：**不计入 counters**（网关整体不可用 = 调用未被受理），`/_test` 控制平面豁免（否则开关关不掉）；`/events` 也在 503 范围内（REQ「任何端点」）。④ gw-13 同时置终态标志：只推事件而账号仍能 send 会与「之后该账号的所有请求都返回同样错误」矛盾；`params.status` 必填且 ∈ {suspended, session_expired}（缺失/非法 → 400），clear 只撤标志，已推事件与移出群不撤回（append-only + 既成事实）。⑤ gw-15 的 code 校验按 T-P1-04 审查 advisory 落在 arm 时刻（静默忽略会让「推 message_failed」的用例退化成正常落地 = 假绿）。⑥ gw-27 的过期只由开关驱动（不在媒体对象上存 `expiresAt`）：clear 即撤销过期安排，与 gw-11/12 的标志同构；`mediaId` 与 `msgId` 同名（server 侧 C1 存 `media/<msgId>`，可追溯）。⑦ gw-9/10 的恢复时刻支持 `durationMs`（相对，arm 时归一）与 `untilMs`（绝对）两种配方，对应 DES/14 §5「可配时长 / 可配恢复时刻」。⑧ 既有覆盖不重复：gw-11/12 的终态码与 gw-14/15/16 的基本路径在 accounts/messaging.test.ts（T-P1-01/04）已有用例，本文件只补新增语义（状态位、按群收窄、arrange 校验、counters 归口）——重构后两文件仍全绿。**应勾行（VITEST_PLAN，阶段门统一勾选）**：§3.1 gw-6/7/8/9/10/11/12/13/14/15/16/17/27 的**落地侧** `mock-gateway/tests/switches-outbound.test.ts`（server 侧代表用例仍分别归 s4 / s5 / unknown-adjudicator / outbound-dispatcher / terminal-side-effects / group-state / tools-kick / media 等）。
- 踩坑：`mediaUrl` 必须是绝对 URL——server 的 `downloadMedia(mediaUrl)` 直接 `fetch(mediaUrl)`（T-P2-01 已提交的消费方契约），而落地发生在 202 之后的定时器里，那时已无请求上下文：origin 必须在 send 路由入口就固定下来（真实 HTTP 下 Host 头带端口；`app.inject` 的 Host 无端口，故媒体下载断言只能走 `withListening` + 裸 fetch）。另：`media_expire_404` 若既在创建时写 `expiresAt`、又在 GET 时查开关，两条规则会互相打架（arm 带 `afterMs` 时「未到期」也立刻 404）——收敛成单一规则「开关命中 + 距 createdAt 超过 afterMs」。

---

## 2026-09-27 T-P2-10 WS hub + ws_event（I7/I12）
- 做了什么：`server/src/ws/` 落地——`hub.ts`（`/ws` 升级只认同端口路径、auth 帧验证 accessToken 查表、`{type:'auth',success}` 回执门控、每连接 lastSentSeq 水位 + sinceSeq 独占补发升序、进程内 `notifyWsEventCommitted` 直推 + `WS_EVENT_POLL_MS=250` 兜底轮询、30s 心跳终止僵死连接、`WS_SEND_QUEUE_LIMIT` 背压断开）、`retention.ts`（30min 窗口条件 DELETE 扫描，boot 注册进调度器）、`notify.ts`（业务事务 COMMIT 后唤醒投递的缝）。`index.ts` 接线：注册表 + attachWsHub(app.server) + stop/监听失败路径 close。
- 验证命令与输出摘录：**先红后绿**——两个测试文件先行，`npx vitest run tests/ws/` 首跑 **4 failed**（全部指向真缺陷而非用例笔误）：① sinceSeq>maxSeq → 水位自陷永久不投递；② sinceSeq=0 误报 ws_backlog_expired；③ 过期用例 sinceSeq 越界为 ≤0 被 parser 丢弃（用例修正为「水位指向被清行」）；④ 交叠用例漏算 auth 前已提交行。修复后 **72 passed**（hub+sinceseq+constants）；全量 `npx vitest run` → **162 passed / 14 文件**、`npx tsc --noEmit` 0 错、eslint clean。**真实 boot() 冒烟**（tsx 脚本跑 index.ts 编排）：连接 `/ws` 未认证跨 ≥1 轮询节拍零帧；auth+sinceSeq=0 收到 success+全量回放；事务提交后实时帧到达；`handle.stop()` 干净退出（WS 连接不挂 fastify close）。
- 偏差与【解读】：① 解读 #20 的 sinceSeq 语义取字面「表里已无该行」——`sinceSeq ≥ min(seq)` 不告警；`sinceSeq=0` 是 BIGSERIAL 前的哨兵（全量回放）而非过期，豁免告警。② 水位钳制 `min(sinceSeq,maxSeq)`：超前水位不是过期场景、回放集为空，若采信则永不可达——钳制后最坏多收 ≤ 窗口行（客户端 seq 去重吸收，B4）。③ min/max 用单条聚合同一快照取，避免两次查询之间行被清/被插撕裂判定。④ hub.close() 必须在 app.close() 之前：WS 升级连接不属于 fastify 生命周期，不先断开会挂住 server.close()。
- 踩坑：sinceSeq 水位自陷 + 0 哨兵误报（详见 AGENTS.md §7 同日条目）。
- VITEST 登记：§5.2 的 I7（hub.test.ts）、I12（sinceseq.test.ts）、A-18/19、A4-2、B4-1（服务端半边）应勾——按 SP-6 规则登记于此，勾选在阶段门统一执行。

---

## 2026-09-28 T-P2-07 限流登记 / 硬闸门 / 到期恢复（D2-5）
- 做了什么：`server/src/modules/accounts/rate-limit.ts` 落地三段契约——`registerRateLimit`（单事务：SELECT FOR UPDATE 锁行取转移前值 → 状态守卫 UPDATE `WHERE status IN ('online','rate_limited')` + `until=greatest(now(),rate_limited_until)+retryAfterSeconds`；online→rate_limited 才补 ws_event，rate_limited 再 429 只顺延不转移）、`checkRateLimit`（每次 send 前逐条 SELECT 的硬闸门，不缓存——S4 零试探根基；到期未转移行放行，未知账号 ACCOUNT_NOT_FOUND）、`createRateLimitExpiryScan`（条件 UPDATE 收拢到期行 + 同事务 ws_event + 事务外 wakeDispatcher 缝）。`server/src/scheduler/ratelimit-scan.ts` 注册行（`rate-limit-expiry`），index.ts boot 接线。
- 验证命令与输出摘录：**先红后绿**——测试文件先行报「module not found」，实现后 `npx vitest run tests/accounts/rate-limit.test.ts` → **7 passed**；全量 `npx vitest run` → 169 passed / 15 文件（另有 1 文件 = 兄弟任务 T-P2-06 的 terminal-side-effects.test.ts 半成品红，非本卡范围）；`npx tsc --noEmit` 对本卡文件 0 错（TS2307 报的全是兄弟未落地 import）；eslint clean。覆盖断言：until 顺延从旧 until 末尾起算（±3s 容差）；竞态下 until 恒 NULL + warn×3；闸门对 已到期未转移 / online / disconnected / unknown 四分支分明；到期扫描唤醒缝收到正确 accountId 且二轮幂等归零。
- 偏差与【解读】：① 竞态分支用「SELECT FOR UPDATE + 条件 UPDATE」两步实现 §5.1 的 rowcount=0 语义——行锁保证守卫与转移前值判定同一快照，比裸 UPDATE RETURNING 更贴「只允许两态写限流字段」的逐字语义。② 到期扫描与 T-P2-05 的 boot 恢复扫描（runAccountsRecoveryScan §a）共用同一条条件 UPDATE 语义：boot 段收「进程停了错过到期」的补转，本扫描是常驻节拍的常态路径；不重提 transitions.ts 以免撞兄弟正在编辑的终端副作用六动作。③ wakeDispatcher 为可选缝：T-P3-02 dispatcher 未落地，恢复转移本身照常发生，queued 消息由 dispatcher 轮询拾取（DB 为真值）。
- 踩坑：无新坑（竞态守卫沿用 enterTerminal 的 SELECT FOR UPDATE 先例）。
- VITEST 登记：D2-5、A1-3/7、G-15 应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P2-08 入站 message 投影 + isOwn 合并 + agent 触发入口
- 做了什么：`server/src/modules/messages/inbound.ts`（§3 管线：网关 groupId → group.gateway_group_id 映射 → own 检测 account.platform_user_id EXISTS → 外部 INSERT is_own=false/delivery_status=NULL 或回流占位 is_own=true/delivery_status='sent'/client_msg_id=NULL，全走 ON CONFLICT (group_id,msg_id) 部分唯一索引吸收，RETURNING 区分插入/冲突；新插发 ws_event(message)）+ `modules/agent/trigger-entry.ts`（§4.4 判定收口：守卫 active+agent_enabled → INSERT agent_run ON CONFLICT 单飞行索引 DO NOTHING + ws_event(agent_run) → 冲突则 agent_trigger_queue ON CONFLICT；trigger_context 按 REQ §2.2 形状含 ownPlatformUserIds/policy/triggerMessages）+ `events/handlers/message.ts`（payload 契约外形收窄 → projectInboundMessage；畸形 warn+skip 不进死信）+ index.ts 注册。dispatch.ts 骨架注释的属卡勘误（message→T-P2-08、member_*→T-P2-09、sent/failed→T-P3-04）。
- 验证命令与输出摘录：**先红后绿**——测试先行（缺模块全红），实现后 `npx vitest run tests/messages/inbound.test.ts` → **7 passed**；连带 `tests/events/ + rate-limit + boot-order` 共 **40 passed**；eslint clean；tsc 对本卡文件 0 错（兄弟 T-P2-06/09 半成品文件的 TS2307 与已注释字段无关）。断言点：外部落行字段全形（is_own/delivery_status/client_msg_id/account_id/media_url）、ws_event 仅 own 携带 clientMsgId/deliveryStatus、trigger_context 逐字段含 ownPlatformUserIds、重推三场景零重复（行/事件/run/队列）、回流两种命中形态、守卫不过零 run 零积压、映射缺失零副作用。
- 偏差与【解读】：① 外部消息 ON CONFLICT 判定用 RETURNING rowcount 而非预检——冲突吸收与触发在同一个原子写里，S2 的「不重复触发」没有竞态窗口。② own 检测按 §3 原文读 `account.platform_user_id`（服务账号集合真值，不缓存）；回流占位行的 account_id 就地写入（finalizeSent 合并时会迁移审计字段，不占位也能对应）。③ 畸形 payload → warn+skip：契约外形之外的数据是上游 bug，账本行照留、不进死信（与 account-status.ts 同收口）。④ ws_event(message) 的 own 帧带 deliveryStatus='sent'（§2.3 own 才携带），回流跳过零事件——不推「不变的更新」。
- 踩坑：无。
- VITEST 登记：A2-3/4、S-02/03（入站半边）、G-20 应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P2-11 时间线游标分页（A4）
- 做了什么：`server/src/modules/messages/timeline.ts`（encode/decodeCursor base64(sent_at_epoch_ms + '.' + sort_key)、sort_key 含 '.' 按首个分隔切；listTimeline：群存在先行 404、keyset `(sent_at,sort_key)<cursor` 复合比较、DESC 双键排序、limit+1 探测 nextCursor、字段 null 语义逐字 §5.3）+ `http/routes/messages.ts`（auth:'required'，querystring→模块装配）+ routes/index.ts 注册行。
- 验证命令与输出摘录：**先红后绿**——测试先行（缺模块全红），实现后 `npx vitest run tests/messages/timeline-pagination.test.ts` → **7 passed**；全量 `npx vitest run` → **200 passed / 19 文件**（唯一红 = 兄弟 T-P3-05 半成品 create-group-job.test.ts ×6）；`npx tsc --noEmit` → 0 错；eslint clean。断言点：默认恰 50、同毫秒行按 sort_key DESC 定序（非到达序）、null 语义全字段、翻页间并发写入零重复零遗漏（fresh 行不越界进后页、3ms 补投行按序落在 page2）、own 消息 sentAt 上移后不在后页复现（§5.2a）、游标往返与脏输入 400、viewer 可读/未认证 401/未知群 404。
- 偏差与【解读】：① limit 上限取 50（TIMELINE_PAGE_SIZE）——契约「limit=50」与 QR §1 视为默认即上限，超界按 400（agent get_recent_messages 同规则同上限）。② 非 uuid 形状的 :id 提前 404——避免 PG 22P02 掉成 500（控制台 API 的 groupId 是内部 uuid）。③ nextCursor 用 limit+1 探测：恰好满页时给末行游标（空页次轮返回），不足时 null——§5.1「不足 limit → null」的保守实现，nextCursor 存在则必有下一页的语义不倒置。
- 踩坑：无。
- VITEST 登记：A-12、A4-1、G-03（排序半边）应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P3-01 操作员 send 受理端点（§2.1.1 校验 + 先持久化后 202）
- 做了什么：`server/src/modules/messages/accept.ts`（acceptOperatorMessage：text trim+≤TEXT_MAX_LENGTH → 群存在+非 left → 账号存在 → group_member 活跃行 → 状态守卫（仅 online/rate_limited 受理；rate_limited 照常受理 queued 到期放行）→ 单事务 INSERT queued + ws_event(message) → COMMIT 后 notifyWsEventCommitted + onAccepted 缝）+ `http/routes/groups-send.ts`（auth:'write'，body 装配，显式 reply.status(202)）+ routes/index.ts 注册行。
- 验证命令与输出摘录：**先红后绿**——测试先行 6 红，实现后 `npx vitest run tests/messages/accept.test.ts` → **6 passed**；全量 `npx vitest run` → 208 passed / 18 文件（红的全部是兄弟 T-P3-05 WIP：migration.test.ts ×2 因其 009 迁移未落、create-group-job.test.ts ×1）；`npx tsc --noEmit` → 0 错；eslint clean。断言点：202 响应体 clientMsgId 服务端生成、响应落地后查库必有行（sent_at=受理时刻窗口内、source=operator、is_own、first_attempt_at NULL）、ws_event 同事务含 {groupId,msgId:null,isOwn,clientMsgId,deliveryStatus:'queued'}、text 空/空白/2001 字 400 且零行、边界 2000 字 202、群缺失 404 / left 409 / 非成员与 left 成员 409 / idle·disconnected·suspended·session_expired 全 409、rate_limited 与 unreachable 群均 202、viewer 403 / 匿名 401。
- 偏差与【解读】：① left 群按 ACCOUNT_NOT_IN_GROUP 返回——REQ §2.3 send 行错误列只有 ACCOUNT_NOT_IN_GROUP/ACCOUNT_UNAVAILABLE 两个 409，GROUP_NOT_FOUND 语义是「群不存在」；left 后成员行终结，成员维度收口比群维度更贴近契约列。② 受理的事务内同时写 ws_event：DES/08 §2.3 的 message 帧来源含「出站受理」；queued 态 msgId 必 null（D3-3）、own 携带 clientMsgId/deliveryStatus。③ clientMsgId = `cm-<uuid4>` 服务端生成（卡片 d）；`notifyWsEventCommitted`（T-P2-10 缝）+ `onAccepted`（T-P3-02 dispatcher 缝）均为 COMMIT 后调用——提前调用会让 hub/dispatcher 读不到未提交行。④ 路径 :id 非 uuid 由 PG 22P02 兜底映射 GROUP_NOT_FOUND（与 timeline.ts 同策略）。
- 踩坑：无。
- VITEST 登记：A-09、G-16（受理半边）应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P3-02 出站 dispatcher + 同步错误八向分流
- 做了什么：`modules/messages/dispatcher.ts`（startOutboundDispatcher：每账号 pump + `pg_try_advisory_lock(hashtext('outbound-dispatcher'), hashtext(accountId))` 会话锁；wake 驱动 + needsRerun 补跑；硬闸门 checkRateLimit 最外层；claimAttempt 落 first_attempt_at 先于 send（E7/I1）；503/裸网络异常泵内指数退避环——常量 SEND_RETRY_BACKOFF_*；八向分流逐字 §2.3）；`scheduler/dispatch-wakeup.ts`（每秒扫 queued&NULL-attempt 账号 → wake，漏唤醒兜底）；index.ts 三处接线（dispatcher 先于 buildApp、onMessageAccepted 入路由、rate-limit 到期 wakeDispatcher + dispatch-wakeup 注册行、stop 顺序）；RouteDeps/app.ts/groups-send.ts 的 onAccepted 透传。
- 验证命令与输出摘录：**先红后绿**——测试先行红（模块不存在），实现后 `npx vitest run tests/messages/outbound-dispatcher.test.ts` → **9/9**；scoped `vitest run tests/messages/ tests/boot-order.test.ts tests/constants.test.ts tests/events/` → 116 passed / 9 文件；tsc/eslint 我触面 clean（leave-all.ts 两处报错 = 兄弟 T-P3-08 WIP）。断言点：429 期内 `sendCallsByAccount===1`（S4 零试探）+ 到期顺延不跳过、503 重试 clientMsgId 不变 resend_count=0 first_attempt_at 不重置、enterTerminal 副作用帧（account_terminal/account_status_changed/cancelled message 帧）、GWF 级联单事务（group unreachable + running sequence_run→stopped + sequence_run 帧）、504→unknown(deadline=since+5000)。
- 偏差与【解读】：① **429/裸异常复位 first_attempt_at=NULL**——E7「落库=结果未知」不适用「确认未发出」的 429；复位让行保持可拾取且崩溃扫描不误转 unknown（A2）。② 503 重试在泵内进行（锁保持）：spec 无数字给节奏，沿用 SSE 退避档 500ms→5s；不重入 DB 行（resend_count/first_attempt_at 语义逐字 #17）。③ 群无 gateway_group_id（creating）时复位 first_attempt_at 并停泵——不把「建群未完成」当成网关失败。④ 未分类错误码（INVALID_RESPONSE/INTERNAL/NOT_FOUND/其余业务码）兜底走 unknown 而非 failed——宁保守不盲发。⑤ gw-16 sender_not_in_group 按 (group,account,clientMsgId) 定向只拦 m1，m2 照常（队列不阻断断言由此而来）。⑥ mock `counters` 在路由内增计——503 前置拦截不计数，重试断言只能用我方包装层 sendCalls。
- 踩坑：① **兄弟提交扫带未跟踪文件**：impl-a3 的 T-P3-06 commit (1778b09) 把我在 worktree 中未暂存的 index.ts dispatcher 接线一并提交，HEAD 树曾短暂悬空引用（commit 内 import → 未入库文件）；本次提交落库后恢复自洽。教训：并发 lane-A 下共享文件 index.ts 需 staged-only 习惯。② hashline 工具在密集同形段落（多个 `rows[0]`/`return`)易误锚——用「范围精确覆盖 + 不重述下界」规避。
- VITEST 登记：A2-1/7/8/10、G-13/14、gw-15/16/17/10（测试侧）应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P3-03 unknown 判定器（5s 落定 / 2s 确认线 / 单次重发）
- 做了什么：`modules/messages/adjudicator.ts`（createUnknownAdjudicator.sweep：扫 `delivery_status='unknown' AND unknown_deadline_at<=now()` → 逐行 pg_try_advisory_lock(clientMsgId) → by-client-id 判定表逐字分流：200→finalizeSent / 404 未过 2s 线→deadline+500ms 顺延再探 / 404 过线→resend_count=0 时 UPDATE 回 queued+resend_count=1+wakeDispatcher（重走 §2.1 全流程）/ resend_count=1 → failed(NETWORK_TIMEOUT) / 503·探测异常→保持 unknown 顺延 500ms）+ `modules/messages/finalize-sent.ts`（§4.3 唯一收口先行落库：预检→常规回填/乱序合并（先删占位再 UPDATE M 行+审计字段迁移）→序列步联动→ws_event；T-P3-04 的事件入口复用它）+ `scheduler/unknown-scan.ts`（注册行：1s tick 调 sweep）+ recovery/scans.ts 扫描1 落地（queued NULL→wakeDispatcher；queued 已尝试→转 unknown=5s deadline）+ index.ts 接线（wakeDispatcher 入 RecoveryDeps + unknown-settle 注册行）。
- 验证命令与输出摘录：**先红后绿**——测试先行红（模块不存在），实现后 `npx vitest run tests/messages/unknown-adjudicator.test.ts` → **4/4**；scoped sweep（messages+constants+boot-order）→ 109 passed / 8 文件；全量 `vitest run` → 264/265（唯一红 = 兄弟 create-group-job.test.ts 偶发 fail：两次单独重跑均 6/6 绿——其 join 阶段对「202 延迟 + member_joined 时钟」有竞态假设，非我域）。断言点：gw-7 落地 → by-client-id 200 → finalizeSent sent+msgId 回填；gw-8 恒 404：未过 2s 线 sendCalls=0（A2「确认前不得重发」逐字）→ 过线后 resend_count=1+queued 交接 → 再 504 → unknown（deadline 重算）→ 再确认 → failed(NETWORK_TIMEOUT)；gw-9 503 期间行保持 unknown（since=2500 也绝不判未发出）→ 恢复后下一轮探测即定 sent；幂等 sweep 对已 sent 行吸收。
- 偏差与【解读】：① finalizeSent 我先行落库（卡片归 T-P3-04，判定器 200 分支必需）；§4.3 全文实现并签名对齐 `finalizeSent(clientMsgId,msgId,sentAt,tx)`——兄弟 T-P3-04 已在其 commit（4e965c3）中连带入库本文件并对其 confirm.ts 建 handler，复用零摩擦。② resend 的 first_attempt_at 复位 NULL（而非 §2.4 图内联的"=now()"）——dispatcher 选择器认 NULL，发前由 claimAttempt 落新戳；E7 崩溃语义不变（已尝试且在途 → 恢复扫描转 unknown）。③ unknown_deadline_at 兼作探测调度字段（404/503 均顺延 500ms = PROBE_BACKOFF_MS 即探测节拍）——调度器 1s tick 是兜底不是节奏上限；判定逻辑读字段驱动。④ sweep LIMIT 100 批：积压超限时下 tick 续扫（真值在 DB）。⑤ by-client-id 探测异常（网络/TIMEOUT/INVALID_RESPONSE）同 503 对待——不推进判定，宁保守不误判。
- 踩坑：① **兄弟二次扫带**：T-P3-04 commit (4e965c3) 把我 worktree 中未暂存的 finalize-sent.ts + index.ts 接线一并入库；HEAD 曾引用未跟踪的 unknown-scan.ts/adjudicator.ts，本次提交后自洽——并发 lane-A 的 index.ts/scans.ts 已两次被扫，commit 窗口需更紧或先 stash-push。② 测试回拨 unknown_since 时忘记同步 deadline（首轮 sweep 已顺延）→ 二轮 sweep 扫不到——修即绿；教训：回拨时间戳断言必须同时满足扫描谓词。
- VITEST 登记：I2、I9、A2-2、G-17/18、gw-7/8/9（测试侧）应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P3-11 S1–S4 场景用例 + demo 脚本（串行汇合点）
- 做了什么：`tests/helpers/env.ts`（startScenarioEnv：真 PG 测试库（模板克隆）→ seed → in-process mock-gateway + mock-agent listen → boot() 全管线 → admin token；+ REST/开关/counters/emit/时间线/建群封装，测试与 demo 共用）+ `tests/scenarios/{s1,s2,s3,s4}.test.ts` + `scripts/demo/{s1,s2,s3,s4}.ts`（与用例同编排，逐条 ✓ 断言 + `PASS sN — checks=N, counters={快照}` 摘要）。server devDeps +mock-agent（env.ts 裸导需要）。
- 验证命令与输出摘录：先红——env 未落时四文件全红（登录 401，boot 不含 seed——CLI 职责）；实现后 `npx vitest run tests/scenarios/` → **4/4**（~11s）；`pnpm demo:s1`→PASS checks=10、`s2`→PASS checks=6、`s3`→PASS checks=7、`s4`→PASS checks=28（18 个窗口内探测点 sendCalls 恒=1）。全量 `vitest run` → 296–298/299 绿，残余红全是兄弟域既有 flake：`create-group-job` 主链（HEAD 即偶发 fail，~66% 率，与「member_joined 时钟+202 延迟」竞态强相关）与一次 `ws/hub` backpressure（孤立重跑 2/2 绿）。
- 偏差与【解读】：① `GET /api/accounts` 只有列表端点——getAccount 走列表 find；`GET /api/groups/:id/messages` limit 上限 50（TIMELINE_PAGE_SIZE）→ 封装钉 50。② **S4 rate_limit 开关需先 clear 再看窗口**：武装态命中规则即永拒（「期内再 send 复 429」对开关命中而言）；窗口存续靠 mock 侧已记 rateLimitedUntil——正是「窗口独立于开关存在」的契约语义，用例先注册 429 → clear → 观察冻结窗口。③ S4 硬门断言基线=1：mock 在路由入口即计 sendCalls（429 那下也算），零试探=计数冻结而非恒 0。④ 时间线 ORDER BY sent_at DESC——「按原顺序」断言为索引 i2<i1。⑤ demo 复用测试库基建（kapibala_test_<rand>，结束 DROP）而非 dev 库——可重复、零环境污染。
- 踩坑：① boot() **不做** seed——seed 是独立 CLI 职责；env 缺 seed → 401（先红来源）。② content-type=json + 空 body 被 Fastify 400——connect POST 必须带 `{}`。③ job 响应契约只有 {status,errors}，group_id 需库读。④ mock rate_limit 开关武装=永拒（窗口仅在 clear 后由 rateLimitedUntil 承继）——编排顺序必须是 注册→clear→观察。⑤ hashline 工具在本卡密集同形段（多 `.filter(`/`await timeline`）多次误锚；编辑顺序断言时曾吞掉 m2 send 行——每次边界警告都必须回读验证。
- VITEST 登记：S1、S2、S3、S4、gw-1/2/3/6（场景侧）应勾——按 SP-6 规则登记于此。阶段门 P3：demo:s1–s4 现场 PASS（checks=10/6/7/28）。

---

## 2026-09-28 T-P8-01 C1：媒体文件落盘与清理
- 做了什么：`modules/messages/media.ts`（`createMediaDownloadScan`：扫 `media_url NOT NULL AND local_file_path IS NULL AND 未盖过期戳` 行 → `gateway.downloadMedia` → `media/<msgId>` 写盘 → tx 条件 UPDATE 回填；404→`inconsistency{kind:'media_expired'}` 经 `INSERT…WHERE NOT EXISTS` 单次盖戳且该行退出谓词；网络/5xx→指数退避 500ms×2 封顶 30s（内存 Map 只约束节奏）+ `createMediaCleanupScan`：`created_at < now()-retention` 且群无 running run → **先 tx 置空指针 COMMIT 后 unlink**（不留指向已删文件的记录；ENOENT 幂等）；内部 24h 节流对契约「每日」粒度）+ `scheduler/media-scan.ts`（两注册行：`media-download` 随 tick、`media-cleanup` 内部节流）+ index.ts 接线（retentionDays ← `config.mediaRetentionDays`，默认 30）。**跨文件修正**：`inbound.ts` own-merge 分支补 `media_url` 条件回填（出站行 INSERT 时本无 mediaUrl，回流是唯一载体；不补则 own 媒体消息永不可下载——C1 必需，幂等 `WHERE media_url IS NULL`）。
- 验证命令与输出摘录：**先红后绿**——模块不存在时 4 个直调例红（addGroup 缺 account FK → insert 前先落 acc-01 行）；实现后 `npx vitest run tests/messages/media.test.ts` → **6/6**（E2E×2 走真管线 1s-tick 自下载/盖戳 + 直调×4 钉退避/幂等/清理/隔离）。断言点：字节内容含 `data-media-id="<msgId>"`（mock 确定性 SVG）；404 用例跨 ≥2 tick 后 inconsistency 仍恰 1 条；退避例 calls=1→1→2 锁死节奏；清理例返回 removed=1（B 群 running run 保护 + C 未到期不动，第二轮 0）。全量 340/341 绿——唯一红仍是已知 create-group-job flake。
- 偏差与【解读】：① 清理顺序定为「置空先、删文件后」——同事务语义的防崩溃正确序：DB 先一致、文件后删；倒序会在崩溃窗留悬空指针（C1 逐字「不留指向已删文件的记录」以此为兑现方式），代价最坏是孤儿文件（无害、不可见）。② 过期盖戳真值放 ws_event 行（NOT EXISTS 双保险），非内存——重启后也不重推。③ `local_file_path` 存绝对路径（`path.resolve(mediaDir, safeMsgId)`）——清理零依赖目录约定。④ msgId→文件名做路径穿越消毒（`[\\/]`→`_`）——契约形状 m-N 不受影响。⑤ mediaDir 默认 `path.resolve('media')`（包根 cwd）；`.gitignore` 的 `media/` 已覆盖（验证：E2E 写盘后 `git status` 干净）。
- 踩坑：① **`media/` 会真实落 server 包目录**（cwd=server）——E2E 后需清或靠 .gitignore；mock 的 `attachMedia` 只在落地时刻判定，arm `media_message` 必须在 send 之前。② own-回流 merge 分支会吞 media_url（T-P2-08 遗留缺口）——C1 对此类消息曾经完全不可达；同一 bug 也在外部消息 dup/补投路径下没事（INSERT 本就带 media_url）。③ 直插 `message` 行的测试要先插 account（FK `group.creator_account_id`）。
- VITEST 登记：C1、gw-27（测试侧）应勾——按 SP-6 规则登记于此。

---

## 2026-09-28 T-P8-02 C2：anthropic provider
- 做了什么：`mock-agent/src/providers/anthropic.ts`（@anthropic-ai/sdk 透传 + 进出形状映射：`AnthropicLike` 鸭子类型注入式 client → 测试零网络；请求方向 tools/messages 近同构透传；`mapTurnResponse` 多块取首个 tool_use/text + 恰一块 + stop_reason 由块类型裁定；SDK 未知 stop_reason/无效块 → end_turn+text 兜底；audit 走 judge prompt——只收 {verdict:pass|fail,reason} JSON（容忍 ```json fence），解析失败/非约定值/SDK 抛错 → raw 500「无结论」契约形态；`createAnthropicProviderFromEnv` 静态装配真 SDK，`LLM_MODEL` 可配默认 claude-sonnet-4-5）+ `app.ts` resolveProvider 接线（anthropic+key → 真 provider；无 key 仍拒起）+ `.env.example` 双实例部署说明（A=scripted:4200 / B=anthropic:4300，AGENT_URL 单变量切换）。
- 验证命令与输出摘录：**先红后绿**——模块不存在时测试全红；实现后 `npx vitest run tests/anthropic-shape.test.ts` → **11/11**（请求形状/model 透传、多块取首、stop_reason 一致性四个方向、兜底块、audit 六种输出形态、SDK 抛错 → 500、无 key 拒起、有 key 装配）；mock-agent 全量 57/57；真冒烟 `AGENT_MODE=anthropic ANTHROPIC_API_KEY=sk-ant-dummy PORT=4300 tsx src/index.ts` → **监听 :4300 成功**（SDK 构造不验 key，运行时失败走 500 契约路径）。
- 偏差与【解读】：① `stop_reason 一致` 的解读：块类型与 stop_reason 互相印证而非照搬——SDK 报 end_turn 但首块是 tool_use → tool_use（信块）；SDK 未知值 → end_turn+text 兜底（§4「其余映射为 end_turn + text 兜底块」逐字）。② judge 输出容忍 markdown fence 包装（真实 LLM 高频形态）——剥壳后严格 JSON.parse；verdict 非法值（'maybe'）/缺 reason/非对象 → 500，绝不放行「半对」形状。③ 无 key 时真实 LLM 链路以纯函数形状测试 + 装配冒烟演示——卡片 e 明示的路径；503/超时等运行形态由 server 侧既有契约测试覆盖（agentclient 层已有 fake client）。④ turn 失败也返回 500 而非抛出——HTTP 层对「无结论」故障形态的统一表达。
- 踩坑：① 兄弟遗留测试断言「有 key 也拒起」（T-P4-02 埋的 TODO 语义）——provider 落地后契约语义翻转，用例同步更新而非删除。② `pnpm add @anthropic-ai/sdk` 后需 `--no-frozen-lockfile` 的坑在 pnpm-lock 已含 workspace:* 变更时成立——本卡直接成功（deps 变更是本次工作的合法部分）。③ hashline 工具两次把 edit 锚到错误函数区（`addGroup` 重复定义 / import 块错位）——密集同形段下必须逐次回读，不能连发。
- VITEST 登记：C2、A-21（AGENT_URL 切换）应勾——按 SP-6 规则登记于此。


## 2026-09-28 T-P5-01 B3-4 前端半边：web 骨架 + 登录页 + 401 单飞续期
- 做了什么：`web/src/api/client.ts`（createApiClient：401 → 全局单飞 refresh（并发请求共享同一 promise）→ 成功后用新 accessToken 重放；refresh 401 → onSessionExpired 单点收口；`/api/auth/**` 豁免单飞通道——login 的 401 是业务结果 UNAUTHORIZED 不是会话过期，且 refresh 自身 401 即终局；全部请求 credentials:'include'，Bearer 仅 access token）+ `api/auth.ts`（login/logout 封装 + sessionStorage 会话持久化 restore/persist/clear——access token + user 的 JS 可读副本是 R-E 允许的「客户端 XSS 缓解」范围，refresh 永远只在 HttpOnly cookie）+ `auth/AuthProvider.tsx`（context { session, client, login, logout, expireSession }；client 为 useMemo 稳定单例——重建会丢进行中的单飞 promise；getAccessToken 经 ref 桥接读最新 session；canWrite 是 viewer 只读门的唯一判定收口）+ `pages/LoginPage.tsx`（页面 1：提交 → login → /accounts；失败按 error.code 显示，UNAUTHORIZED → 「用户名或密码错误」，其余 → HTTP_code；role=alert）+ `router.tsx`（RequireAuth 守卫：无会话 → <Navigate to="/login" replace/>；已登录访问 /login → /accounts；/accounts 占位页归 T-P5-02）+ `App.tsx` 接线 + `react-router-dom`、`happy-dom` 依赖 + `tests/auth-refresh.test.tsx`。
- 验证命令与输出摘录：层 2 逐字——`cd web && npx vitest run` → **7/7**（并发两 401 → refresh 恰好一次 + 两请求均以新 Bearer 重放成功；refresh 请求带 credentials:'include'；refresh 也 401 → 单点 onSessionExpired → session=null → 守卫把 /accounts 弹回登录页；非 401(403) 不触发 refresh 不重放；viewer 登录 → role=viewer + canWrite=false；登录 401 → role="alert" 显示「用户名或密码错误」）；`npx tsc --noEmit`（include 已加 tests）+ `npx eslint` → 0；`npx vite build` → ✓ 238 kB。
- 偏差与【解读】：① B3 前端半边的「清空会话跳 /login」按完整链断言：expireSession 清 session → RequireAuth 重渲染 → <Navigate>——层 2 无真实浏览器，用 createMemoryRouter + RequireAuth 直挂重放整个跳转路径。② 「viewer 看不到写操作按钮」钉在 canWrite 判定收口 + viewer 会话两侧——骨架期页面尚无写按钮，门机制本身是被测对象。
- 踩坑：① 登录失败的 401 必须先单飞通道豁免（`/api/auth/` 前缀短路）——否则 login 的 UNAUTHORIZED 会被 refresh 流程吞掉、页面看到 HTTP_404 而非密码错误；这是「401→refresh」拦截器的第一条业务语义边界。② hashline edit 工具多次锚错位（AuthProvider/LoginPage/client.ts 各一次）——小文件直接 rewrite 更稳。
- VITEST 登记：B3-4（web 层 2）、A6 页面 1 部分应勾——00-SPEC.md 行已登记（勾选状态阶段门维护）。


## 2026-09-28 T-P5-02 B4-1 前端半边：WS 客户端（seq 去重 / 退避 / sinceSeq）
- 做了什么：`web/src/ws/WsClient.ts`（createWsClient 单例工厂：open 即发 {type:'auth', accessToken, sinceSeq:lastSeq}（DES/15 §3 伪码逐字——恒带 sinceSeq，旧 seq 补发换不漏，重复靠 seq 去重）；auth:true → authed + 退避清零；auth:false → §4 client.refreshToken() 单飞 → 成功后立即重连（不叠加退避通道，authRetrying 闸）→ 刷新也 401 由 client 层 onSessionExpired 收口不再重连；close → nextBackoff(attempt)=500×2^attempt 封顶 5s 重连；applyFrame(lastSeq, frame) 纯函数：seq<=lastSeq 丢弃否则推进；先 persistSeq(sessionStorage) 后 dispatch——刷新最坏重放不丢；stale-socket 残余帧 socket!==ws 守卫不消费；handler 抛错 warn 后继续——帧是服务端已提交真值不杀死连接；subscribe(type) 收窄只发生在订阅边界（Map 键保证），onBacklogExpired 独立收口 ws_backlog_expired；wsFactory/url/storage/退避参数/token 源全注入）+ `useWsEvent.ts`（initWsClient 幂等装配 + getWsClient + useWsEvent hook：ref 转发 handler 换引用不重订、unmount 退订、未装配空转防御）+ `api/client.ts` ApiClient.refreshToken() 公开（与 401 拦截共享同一单飞 promise）+ `AuthProvider` 装配：hasSession 布尔 dep（token 轮换不重建连接——§2.4 连接期不续验）、session null → disconnect。
- 验证命令与输出摘录：先红后绿——文件不存在时 import 全红；实现后 `cd web && npx vitest run tests/ws-client.test.ts` → **10/10**：L1 applyFrame（9<=10 丢、10<=10 丢、11/99 推进跳号也单调）+ L1 nextBackoff（[500,1000,2000,4000,5000,5000,5000] 逐字序列）+ L2 open 发 auth 帧（type:'auth', accessToken, sinceSeq:0）→ authed + close→2ms 退避重连 auth 帧带 sinceSeq=5 + auth:false→refresh 恰好一次→重连带轮换 token t-2 + 交叠帧 [1,2,2,1,3]→seen [1,2,3] 不重复 + lastSeq 持久化（新实例 sinceSeq=7）+ disconnect 后不重连不收帧 + ws_backlog_expired→onBacklogExpired 恰好一次 + useWsEvent 挂载收帧/卸载停收/重渲染不重订；全量 17/17；tsc（含 tests）+eslint+vite build 全绿。
- 偏差与【解读】：① 「auth 失败→走 §4 刷新后重连」中「重连」解读为刷新成功立即重连零退避（不滥用退避序列——attempt 保留不清零，刷新本身可能连失败）；② useWsEvent 通过模块单例 initWsClient 装配而非 props——DES/15 §3 明示「WsClient 单例，模块级」；③ singleton 未装配时 useWsEvent 空转（守卫已挡页面，hook 不炸防御性兜底）；④ subscribe 存储层抹掉收窄、边界处一次性断言——避免判别联合 handler 逆变的双重断言噪音，唯一不安全点在 Map 键保证处。
- 踩坑：① hashline edit 连续锚错位（onmessage 块内 else 分支被截断拼接）——闭合括号密集段必须逐次回读；② disconnect 后 stale socket 的 onmessage 仍会触发（fake 是直推）——socket!==ws 守卫补上真实 socket「close 后不再投」语义；③ ESLint no-non-null-assertion 在测试文件同样生效——socketAt(i) 抛错助手替代 !。
- VITEST 登记：B4-1（web 层 1+2）应勾——00-SPEC.md 矩阵行已登记（勾选状态阶段门维护）。


## 2026-09-28 T-P5-03 A6 页面 2：账号列表页 + 转移面板
- 做了什么：`web/src/lib/account-transitions.ts`（LEGAL_TRANSITIONS_WEB 纯数据镜像——15 条 A1 合法边，与 server transitions.ts 同构；CONNECT_FROM_WEB={idle,disconnected}；legalTargets/canConnect 纯函数）+ `components/TransitionPanel.tsx`（expectedFrom=打开面板时当前状态；to 只列 legalTargets——非法目标不出现在 UI，ILLEGAL_TRANSITION 留给并发；to='rate_limited' 必填 rateLimitedUntil（未来 ISO，datetime-local→toISOString()）否则提交禁用（D3-4 前端半边）；isValidFutureInstant 导出纯函数）+ `pages/AccountsPage.tsx`（行：状态徽标+platformUserId+rateLimitedUntil 倒计时（rateLimitCountdownText：「Ns 后恢复」/「已到期」，有 rate_limited 行才挂秒表）；REQ §4 三按钮——重连=connect 仅 CONNECT_FROM 可见、标记离线→disconnected、释放账号→suspended，各自由合法边控可见性；「调整状态…」开面板；expectedFrom=行当前态 CAS；成功重拉、失败（CAS_CONFLICT/ILLEGAL_TRANSITION）面板内 role=alert；WS account_status_changed/account_terminal→setAccounts 原地 patch 行徽标；viewer→写列整列不渲染）+ `router.tsx` /accounts 挂真页 + `useWsEvent.ts` +resetWsClient()（测试隔离缝）+ `WsClient.connect()` 修 bug：`stopped` 早退致 disconnect 后永远无法重连（login→logout→login 链断 WS）——connected 幂等闸、stopped 在 connect 内复位。
- 验证命令与输出摘录：先红后绿——面板测试首次红（submitBtn.disabled 应 true 得 false：datetime-local 受控值要原生 setter+input 事件而非 .value+change）；修复后 `cd web && npx vitest run tests/accounts-page.test.tsx` → **8/8**：转移表同源（web 镜像===server LEGAL_TRANSITIONS 直接 import 对照 + CONNECT_FROM 一致）；online 目标集 ={idle,rate_limited,disconnected,suspended,session_expired}（无 online/自身；disconnected 目标无 online——connect 专属边不进面板）；rate_limited 缺时间→禁用、填 2099→解禁；行渲染（徽标/pu-1/30s 后恢复；重连仅 idle 行有、online/rl 行无）；viewer 无写列+无三按钮+直接 client.request transition→ApiError{403,FORBIDDEN}；WS seq=1 status_changed→徽标 online→disconnected、seq=2 terminal→suspended、重放 seq=1 不回退。全量 25/25；tsc/eslint/vite build 全绿。
- 偏差与【解读】：① 「释放账号」映射 suspended 终态（REQ §4 三按钮与转移表对照——idle/suspended 之外无「释放」语义边，suspended 是所有非终态的合法终态目标）；② 「重连」按钮=connect 端点（非 transition——disconnected→online 是 connect 专属边不进表）；③ parity 对照用直接 import server 模块而非文本解析——transitions.ts 的运行时依赖（tx/pg）类型全 type-only，esbuild 剥离后纯数据，跨包 import 安全且最强保证；④ AccountsPage 的 viewer 403 断言走页面同一 ApiClient（双关：透传 ApiError 形状 + 服务端权威语义）。
- 踩坑：① happy-dom + React 18 受控组件：select 用原生 value setter+change、input 用原生 setter+input——React 18 内部 tracker 不认直接 .value 赋值；② StrictMode 双挂载会创建两个 FakeSocket（cleanup 断第一个）——断言用 lastSocket()；③ hashline edit 又一次锚错位（viewer 测试开头被覆盖）——长多行 PUT 必须逐次回读。
- VITEST 登记：A6（页面 2）应勾——00-SPEC.md 矩阵行已登记（勾选状态阶段门维护）。


## 2026-09-28 T-P5-04 A6 页面 3：群详情页骨架
- 做了什么：`web/src/lib/api-types.ts`（GroupView/GroupMemberView/AgentRunView DTO 镜像——与 server modules/groups|agent/query.ts 输出逐字同名）+ `lib/text-limits.ts`（TEXT_MAX_LENGTH=2000 镜像 + validateSendText 纯函数——同源校验直接 import server constants）+ `components/GroupMembers.tsx`（accountId/platformUserId/role 三列，服务端 §5 排序不重排）+ `components/SendForm.tsx`（选成员账号 + text；非空/超 2000 前端先拦——提交禁用+role=alert 校验文案双通道；合法 → POST /api/groups/:id/send → clientMsgId 回执；members 空/提交中禁用）+ `components/AgentRunList.tsx`（run 列表；blocked 行 data-blocked+红底红边——页面 3 逐字「醒目提示」的行级半边）+ `pages/GroupDetailPage.tsx`（/groups/:id：GET 群详情+GET agent-runs 首屏；blocked run>0 → 顶部横幅 role=alert；agentEnabled/autoKickEnabled checkbox PATCH——admin 可写、viewer disabled 只读；WS group_updated→就地 setGroup patch（§2.3 事件携带新值，DES/15 注释逐字）、agent_run→已知行就地 patch/未知 runId 重拉）+ router.tsx 挂 /groups/:id。
- 验证命令与输出摘录：先红后绿——WS 测试首跑红（agent-runs fetch 4 次 vs 预期 3 次：StrictMode 双调 setState updater，updater 里的 reloadRuns 副作用跑两遍）；副作用移出 updater 后 `cd web && npx vitest run tests/group-page.test.tsx` → **6/6**：成员 role 三行；开关 admin 可写值正确 + blocked 横幅存在 + data-blocked 仅 run-1；发送表单空→禁用、2001 字→校验文案「2001/2000」+禁用、合法→POST body{accountId:'a-1',text} + clientMsgId 回执；WS group_updated→开关就地翻转、agent_run 已知行 patch（横幅消失）+未知 run→重拉一次；viewer 开关 disabled+无表单+PATCH→403。全量 31/31；tsc/eslint/build 全绿。
- 偏差与【解读】：① 「开关 viewer 只读」按 checkbox disabled 实现（可见不可动）——REQ §4「看不到写操作按钮」语义上开关是状态展示+控制复合体，只读=disabled 比不渲染更贴合「显示状态」；写权限服务端仍 403 权威；② agent_run 已知行就地 patch、未知 runId 才重拉（避免 WS 增量退化成整页轮询——页面 3「WS 原地更新」精神）；③ 时间线区刻意不做——T-P5-05 卡片专属，本页只留骨架区块位。
- 踩坑：① React 18 setState updater 在 StrictMode 下被双调——updater 内放副作用（重拉）会双倍执行；副作用必须在 updater 外（ref 转发的 useWsEvent handler 每次渲染读最新 state，无闭包旧值问题）；② hashline edit 再次在嵌套回调块中间切错锚点（useWsEvent 被缝进 toggle 的 try 块）——连续三次长 PUT 错位后改用 python 整段替换；③ React 受控 textarea 需原生 value setter + input 事件（与 select 的 change 不同）。
- VITEST 登记：A6（页面 3）应勾——00-SPEC.md 矩阵行已登记（勾选状态阶段门维护）。


## 2026-09-28 T-P5-05 A4-1 前端半边：时间线合并 + 加载更早
- 做了什么：`web/src/timeline/merge.ts`（L1 纯函数层——`mergeTimelineItem(map, ev)`：msgId??clientMsgId 双键定位 + 行键迁移（cm→msgId 保序同位替换，「沿用同一行」）+ deliveryStatus 只前进不倒退（秩表 queued<accepted<unknown<sent<failed/cancelled；unknown→sent 允许是 §6 表逐字行）+ 未命中 → unknownKey（载荷无全行字段不能凭空建行）；`mergeTimelinePage(map, page, 'top'|'bottom')`：已存在键 patch、新键按服务端序前置/后置、跨页重复行去重）+ `components/Timeline.tsx`（items Map 状态；首屏 GET messages?limit=50；before 游标栈——单个 nextCursor 只向前翻页；WS message→mergeTimelineItem 原地 patch / 未知键→重拉首屏窗口；own 徽标 deliveryStatus（failed/cancelled 含 failCode）；optimistic prop→queued 占位行进顶部）+ `GroupDetailPage` 接线（Timeline 挂页面；SendForm onSent 扩成 {clientMsgId,accountId,text}→optimistic 占位行，senderPlatformUserId 由成员表反查）+ `accounts-page.test.tsx` parity 改文本抽取（不再 import server 模块图）。
- 验证命令与输出摘录：先红后绿——三处首跑红（双键定位：键迁到 msgId 后按 clientMsgId 的事件丢失→补 clientMsgId 值域回扫；桩 client 'messages' 子串吞掉 'before=cursor' 翻页请求→排序匹配前缀；无 AuthProvider 时 WS 单例没人 connect→显式 connect()）。修复后 `npx vitest run tests/timeline-merge.test.ts` → **11/11**：L1 键迁移同位不插行、倒退拒绝/unknown→sent/终态不倒退、unknownKey、双键命中；mergePage 双向+跨页去重+快照竞态不倒退；L2 首屏徽标+翻页追加不重排不重复、WS 原地 patch（行序不变）、未知键→重拉一次、failed(failCode) 徽标、optimistic 占位→WS 回填同行。全量 42/42；tsc/eslint/build 全绿。
- 偏差与【解读】：① 「查无此行且为首屏上方新消息 → 插入顶部」实现为重拉首屏窗口 mergeTimelinePage('top')——事件载荷无 text/sentAt 等全行字段，凭空建行会撒谎，重拉是拿完整行的唯一正确通道；落在更早区间的补投行按 §5.2(b) 等翻页自然出现；② 行键迁移用 Map 保序重建（同位替换），不 delete+set（那会移到尾部）；③ 「before 游标栈」落地为单 nextCursor（只向前翻页=栈只需栈顶）；④ unknown→sent 的秩位（unknown>accepted<sent）取「存疑被消解为定论是前进」的解读——§6 表只给单侧例子，反向（sent→unknown）按「只前进」拒绝。
- 踩坑：① **跨包 import server 源做 parity 有运行时陷阱**：transitions.ts → db/tx.js → crash.js（兄弟 WIP）会把整条服务端模块图拉进 web typecheck/运行——改为文本抽取源文件字面边表（范围收窄到 LEGAL_TRANSITIONS 块内，CONNECT_FROM 单列数组不被误吃；抽取集非空兜底断言防空表误绿）；② React 18 StrictMode 双调不只 updater——纯 mount effect 也双跑，桩 client 的 includes 匹配顺序（'before=' 必须先于 'messages'）要按特异度排序；③ tests 无 AuthProvider 时 WS 单例不会自己 connect——测试里显式 connect。
- VITEST 登记：A4-1（web 前端半边）应勾——00-SPEC.md 矩阵行已登记（勾选状态阶段门维护）。


## 2026-09-28 T-P6-06 页面 4：Agent run 详情
- 做了什么：`web/src/components/StepList.tsx`（steps 时间线：seq/kind/name/input(JSON 文本，null→「—」)/resultSummary/isError+errorCode/auditVerdict/rawResponse `<details>` 折叠——后端已 ≤2KB 截断直接渲染；protocol_error 或 errorCode 非空 → 红左边条+红底行）+ `pages/AgentRunPage.tsx`（GET /api/agent-runs/:id；WS agent_run 且 runId 匹配：终态（finished/failed/blocked/cancelled）→ 重拉详情拿全量 steps、非终态（running）→ 只更新头部 status 不重拉；blocked/failed → role=alert 顶部醒目 banner 含 endReason；endReason 徽标）+ `router.tsx`（/agent-runs/:id 挂进 AuthProvider 包裹受保护路由）+ `AgentRunList` 行 id 包 `<Link>`（页面 3 最近 run 列表入口逐字）+ `api-types.ts`（AgentRunStepView/AgentRunDetailView）。
- 验证命令与输出摘录：`npx vitest run tests/agent-run-page.test.tsx` → **5/5**：全字段渲染（kind/name/input/resultSummary/auditVerdict/rawResponse details）；协议错误步 errorCode=BAD_JSON+`toolUseId=null`/`input=—` null 字面量呈现+rawResponse 内容可读；blocked→alert banner+endReason 徽标；WS 终态重拉（finished 后 step-4 出现、其他 runId 帧不重拉、running 帧不重拉）；AgentRunList 行链接 `/agent-runs/run-1`。全量 47/47；tsc/eslint/build 全绿。
- 偏差与【解读】：① 「toolUseId/name/input 为 null 的呈现」落地为 `toolUseId=null`/`input=—` 字面量（比空列更可断言）；② input 对象一律 JSON.stringify 单行展示（不递归美化）；③ running 帧只更新 status——卡片 b 只要求「终态重拉」；④ AgentRunList 链用 `<Link>`（MemoryRouter 测试环境下断言 href）。
- 踩坑：**StrictMode 双 effect 让「按调用序号切假响应」的 fetch 桩失效**（首次 mount 会连拉两次详情，第二条响应被提前消费）→ 响应体改由可变变量控制，调用计数只用于「是否重拉」断言（baseCalls 差值）；WS 终态/他 run 帧断言都用差值不变性。
- VITEST 登记：B4-2 应勾（00-SPEC.md 已登记）。


## 2026-09-28 T-P6-07 页面 5：序列（定义/启动/预检弹窗/运行视图）
- 做了什么：`components/SequenceForm.tsx`（steps 编辑行 index/accountRole/text/delaySeconds + 增删行；`validateSequenceDraft` 与 server define.ts 同构——index 正整数唯一、accountRole∈{admin,member}、text 1..TEXT_MAX_LENGTH、delaySeconds 非负整数，先于 POST 拦截）+ `components/PreflightModal.tsx`（run steps 的 resolvedVars/varSources 逐步表格：key/值/来源 default|step:<i>）+ `pages/SequencesPage.tsx`（三块：定义表单 + 本地序列列表——后端无 GET /api/sequences（QR §1 逐字）本地登记；启动表单选群/选序列/vars+stepVars JSON；422 UNRESOLVED_PLACEHOLDER → stepIndex/key 展示 + 启动表单选中序列的对应步骤行红框高亮 + 行内 ⚠{key} 标记；201 → GET run → 预检弹窗 + 运行视图；运行视图 status/currentStepIndex + 每步 status/scheduledAt/sentAt，WS sequence_run 帧 → 头部推进+重拉详情拿步级 sentAt）+ `api-types.ts`（SequenceStepDef/SequenceStepView/SequenceRunView）+ `api/client.ts`（ApiError.extra 透出——envelope 把 AppError.extra 并入 error，422 的 stepIndex/key 经此到达前端）+ router /sequences。
- 验证命令与输出摘录：`npx vitest run tests/sequences-page.test.tsx` → **5/5**：本地校验拦空 text（0 POST）；合法定义 POST+本地登记；422→`步骤 2 的占位符 {code} 未解析` banner+`launch-step-2` 行内 ⚠{code} 标记（step-1 行不高亮）；201→弹窗逐步渲染 nick=Alice@default、code=42@step:2+关闭；运行视图静态字段+WS sequence_run→currentStepIndex 1→2 + 重拉拿到 step-2 sentAt。全量 52/52；tsc/eslint/build 全绿。
- 偏差与【解读】：① 「预检成功弹窗供确认后提交」无对应后端预检端点（start 的预检与 INSERT 同事务不可分；QR §1 无 precheck 路由）→ 落地为 201 后立即 GET run 展示快照弹窗（数据正是「复用该 run steps 的 resolvedVars/varSources 逐步展示」逐字），422 路径照旧；② 「定义列表」无 GET /api/sequences → 本会话本地登记（session 范围）；③ 422 高亮落在**启动表单选中序列的步骤行**（定义编辑器提交后已重置单步，高亮打空）+ 编辑器行也保留高亮接线（编辑中 422 仍打行）；④ WS 帧 payload 无步级字段 → 头部就地更新+重拉详情（同 agent_run 模式）。
- 踩坑：① happy-dom/React 受控元素：直接 el.value=+change 无效——必须 native prototype setter + input 事件（textarea/input）/change（select）；② ApiError 原先丢 extra（envelope 合并业务字段但 client 只取 code/message）→ 透出 `extra`；③ happy-dom 不行内解析 `border` shorthand 到 borderColor/cssText——行内高亮断言改用语义标记（launch-hit-<i> 在行内）而非 style 文本；④ StrictMode 双 effect 多拉详情→重拉断言用差值；⑤ 测试禁 non-null `!`——`must()`/`el()` helper + querySelector 泛型写在内侧。
- VITEST 登记：B1（页面半边）应勾（00-SPEC.md 已登记）。


## 2026-09-28 T-P6-08 S7/S8 场景 + B4 断线补齐端到端（P6 汇合点）
- 做了什么：`tests/scenarios/s7.test.ts`（同群并发两次 POST sequence-runs → 恰一 201 一 409 SEQUENCE_ALREADY_RUNNING；sequence_run running 恰一行——DB 部分唯一索引仲裁真值）+ `tests/scenarios/s8.test.ts`（step-3 {latecode} 未解析 → 422 error.code/stepIndex=3/key=latecode；counters.landedMessages=0 + sequence_run/step 行数 0 双真值；补齐 stepVars → 201 可启动）+ `tests/ws/backfill-e2e.test.ts`（真 WS socket：auth→实时收 msg(seq=N)→断线→注入两条 message（SSE→消费→ws_event 落库确认）→重连 auth sinceSeq=N→≤3s 两帧补齐 seq>N 独占、零重复+700ms 宽限无迟来重复）+ `scripts/demo/s7.ts`（5 checks PASS）+ `scripts/demo/s8.ts`（10 checks PASS）。
- 验证命令与输出摘录：`npx vitest run tests/scenarios/s7.test.ts tests/scenarios/s8.test.ts tests/ws/backfill-e2e.test.ts` → 3/3 绿（4.56s）；`pnpm demo:s7` → `PASS s7 — 5 checks`（status=[201,409]）；`pnpm demo:s8` → `PASS s8 — 10 checks`。先红后绿说明：三用例均一次过绿——S7/S8/B4 的实现面（部分唯一索引仲裁、预检先于 INSERT、sinceSeq 补发+水位去重）已在前序卡落地，本卡是验收用例的覆盖登记（同 S1-S6 汇合测试的收敛性质），非红→绿开发。
- 偏差与【解读】：① B4「3 秒内」计时从发出重连 auth 起算到收齐补发帧（QR §1 逐字「断线后 3 秒内」——可控段是重连→补齐，断线时长本身人为）；② B4 双重复断言两段式（立即查 + 700ms 宽限再查）覆盖「水位兜底兜住实时/补发交叠」；③ S7 用 fetch Promise.all 双发（同实例并发也由 DB 唯一索引仲裁——卡片逐字「恰好一个 201 一个 409」与部署形态无关）；④ step delay=3600 保 run 常驻 running 不占调度器发送路径。
- 踩坑：① **it 默认 testTimeout=5s vs 场景环境启动 ~5s+**——三用例均报「Test timed out in 5000ms」挂在 startScenarioEnv（此前一次跑过纯属余量够），按 s6 逐字惯例补 `}, 60000)`；② 并行/重负载下 waitFor 放宽只对「等事件落库/实时帧」这类外部时延，≤3s 补发计时断言不放宽（契约本身）；③ **兄弟 T-P7-02 把 `first_attempt_at IS NULL` 守卫误加到 markUnknown/429 复位**（claimAttempt 先落 first_attempt_at，post-claim 永不命中 → 全错误路径楔住）→ 已改 `IS NOT NULL`（行被本尝试 claim 且仍 queued 才可写回），outbound-dispatcher/unknown-adjudicator/s4 恢复绿且 crash 测试不受影响（已与本主确认）。
- VITEST 登记：S-07/S-08/B4-1（端到端）应勾；P6 阶段门演示记录 = 本条 + demo PASS 输出。


## 2026-09-28 T-P8-03 C3：Playwright 冒烟（单条，已授权）
- 做了什么：`web/playwright.config.ts`（webServer 数组拉起全栈：① `server/tests/e2e/backend.ts`（tsx 直跑：真 PG 模板库+mock-gateway+mock-agent+boot() 固定 :3000——vite.config.ts 代理逐字目标；EADDRINUSE 重试 12 次吸收 teardown 滞后；数据装配：setupGroup active + agentEnabled + playbook 剧本（send_message→finish）+ emit 触发 + 等首行 step 落库 → 写 .e2e-state.json stage=ready）；② vite dev :5173 --host 127.0.0.1）+ `tests/e2e/global-setup.ts`（删上轮 state）+ `tests/e2e/smoke.spec.ts`（唯一用例：登录 → goto /groups/:id → 点 run 链接 → /agent-runs/:id 页面 step-list 含 send_message/final）。
- 验证命令与输出摘录：`pnpm e2e` → `1 passed (5.7s)`；连跑 4 次全绿（5.1s/4.7s/7.5s/7.2s），零孤儿进程残留；tsc/eslint 全绿。
- 先红后绿：首跑红因 env 装配竞态（health 就绪早于数据装配完 → 旧 state 文件 groupId 指向已删库 → GROUP_NOT_FOUND）；修复为「装配完成写 stage=ready + 测试端循环等文件」形态。随后两轮连挂的根因排查见踩坑。
- 偏差与【解读】：① 「打开群」落地为 goto /groups/:id（无 /groups 列表路由——既有路由表逐字）+ 点击 run 链接进详情页；② 等首行 step 而非 run 终态（页面只验证「steps 可见」——并行负载下终态可能拖到分钟级，首行在首轮响应写回即存在）；③ 后台进程走「tsx 直调 + vite bin」——pnpm exec 的孙进程会成孤儿；④ C3 场景前后端授权声明 exempt DES/15 §6 禁令，仅此一条 E2E 不扩面。
- 踩坑（两连挂真凶）：**playwright.config.ts 顶层代码在每个 worker 进程里会再求值一次**——把「删上轮 state 文件」放顶层，worker 启动时（晚于 backend ready 写盘）把本轮 state 删掉 → 测试侧 readState 等不到文件、耗尽 240s。修：删文件挪 globalSetup（主进程一次、恰在 webServer 拉起后）。次级坑：① pnpm exec webServer command 的孙进程（tsx）teardown 杀不到 → :3000 残留端口冲突 → 改直调 node_modules/.bin；② vite dev 默认绑 localhost（可能解析 ::1）而 Playwright 探 127.0.0.1 → --host 127.0.0.1 钉死；③ 全栈装配上 90s testTimeout 在兄弟并行测试负载下不够 → 240s（契约只要求可重复，不计时）。
- VITEST 登记：C3 ❌→✅ 应勾（00-SPEC.md 矩阵行已登记 C3=T-P8-03）；DES/11 统计：E2E 层从 0 → 1 条（Playwright smoke）。

<!-- 后续任务条目按上述格式在此追加。示例：
## 2026-09-XX T-P0-01 workspace 脚手架
- 做了什么：…
- 验证命令与输出摘录：…
- 偏差与【解读】：…
- 踩坑：…
-->
