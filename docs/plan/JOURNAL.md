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

<!-- 后续任务条目按上述格式在此追加。示例：
## 2026-09-XX T-P0-01 workspace 脚手架
- 做了什么：…
- 验证命令与输出摘录：…
- 偏差与【解读】：…
- 踩坑：…
-->
