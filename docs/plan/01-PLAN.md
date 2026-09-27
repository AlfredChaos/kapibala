# 01 · 阶段计划（kapibala）

> 基线 = `/Users/alfredchaos/home/work/kapibala/docs/review/01-design-review-2026-09-27.md` §3.3 作战图（P0–P8 + 缓冲）。
> **阶段依赖与裁剪顺序不可改变**；本计划只在阶段内细化任务组与验收。任务 ID 见 `02-TASKS.md`。
> 设计残留 R-A/R-B 已由编排者的文档 worker 并行回写设计文档（验证待收口，见 JOURNAL 种子条目）——本计划的任务按**修复后的语义**编写：member_joined 复活分支检查 `terminal_at`（R-A）；END2/SWEEP 补建 run 前加 `group.status='active' AND agent_enabled=true` 守卫、守卫不过时**保留**积压行（R-B）。

## 0. 通用阶段门（每个阶段 P0–P8 结束时执行，缺一不可）

1. 全仓 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿；
2. 该阶段「累计产出」（下表）可现场演示；
3. JOURNAL 写阶段小结（含偏差与【解读】）；HANDOFF 更新；`server/VITEST_PLAN.md` 勾选由编排者在此统一执行（SP-6）；
4. 阶段边界 commit（英文 Conventional Commits，引用阶段号）。

> **阶段门屏障的精确语义（F7，与 02-TASKS §0 规则 7 同口径）**：屏障约束的是 **lane-A 主干进入下一阶段**与该阶段的**签收**（累计产出演示 + 四命令绿 + 簿记）；独立泳道（B/C/D）任务的派发只受「depends 全部 DONE + owned 与所有 ACTIVE 零交集 + 本泳道规则」约束——lane-C（mock-agent）可在 lane-A 阻塞时提前拉起（见 §1 泳道视角），lane-B 同理。阶段门不因等待独立泳道收尾而空转。

## 1. 阶段总表（review §3.3 原文基线）

| 阶段 | 内容（基线原文） | 预估 | 累计产出（基线原文） |
|---|---|---|---|
| P0 | 修文档缺陷（§3.1，已由文档 worker 完成）+ 脚手架 + 迁移 + A0 + docker-compose | 4h | 服务可起、health 可查 |
| P1 | mock-gateway 核心（正常路径 + S1/S2 开关） | 6h | 网关可联调 |
| P2 | A2 入站（SSE+前缀游标+死信）+ A1 状态机 + A4 时间线 | 8h | 时间线活起来 |
| P3 | A3 建群 job + A2 出站（含 unknown 判定/单次重发）+ B2 leave-all | 8h | S1–S4 可演示 |
| P4 | mock-agent scripted + A5 全量（含恢复） | 12h | S5/S6 可演示——**全场最重的一段，P0–P3 超支时优先压缩 P3 的对账类 embellishment** |
| P5 | 前端页面 1–3（A6）+ B3 会话 | 8h | 控制台可操作 |
| P6 | B1 序列 + 页面 5 + B4/页面 4 | 8h | S7/S8 可演示 |
| P7 | 崩溃测试套件 + I 映射 | 6h | 差异化证据 |
| P8 | C2 + C1 + C3 + README/录屏/完成度表 | 8h | 加分收尾 |
| 缓冲 | — | 4h | — |

泳道视角：lane-A（server 主干）贯穿 P0→P8；lane-B（mock-gateway）P1 起与 lane-A 并行；lane-C（mock-agent）DAG 上只依赖共享类型任务（T-P0-02），正式排在 P4，lane-A 阻塞时可提前拉起；lane-D（web）在 server REST/WS 接口面冻结（P3 末）后启动（正式排在 P5）；跨泳道集成任务（T-P3-11 / T-P4-15 / T-P6-08 / T-P8-03）是串行汇合点。

---

## 2. 各阶段细化

### P0 · 脚手架 + 契约 + 迁移 + A0 + seed + B3 后端

- **目标**：monorepo 可安装可构建；迁移可重复执行且版本门生效；`/api/health` 可查；常量与 I14 测试就位；seed 幂等；auth 三端点 + viewer 403（B3 后端半边）。
- **任务组**：T-P0-01 脚手架（workspace/四包/tsconfig strict/ESLint/vitest/docker-compose/脚本预注册/根+包内 AGENTS.md）→ T-P0-02 `packages/contract` 共享契约类型 → T-P0-03 全量 DDL 迁移（20 表，串行主干独占 `server/migrations/**`）→ T-P0-04 db 基建 + 迁移 runner + schemaVersion 门 + `/api/health` + 测试库隔离基建 → T-P0-05 `constants.ts` + I14 → T-P0-06 seed → T-P0-07 auth（login/refresh/logout/opaque 轮换链/复用作废/权限矩阵）。
- **阶段门**：`pnpm -F server db:migrate && pnpm -F server db:seed` 幂等重跑成功；`GET /api/health` → `{"ok":true,"schemaVersion":<N>}`；故意落后/超前的 schema 拒绝启动；`tests/constants.test.ts` 全绿（I14）；`tests/auth/session.test.ts` 全绿（I13、B3）。
- **退出条件**：通用阶段门 4 项 + 上述演示；四包 `pnpm build` 通过（web 此时为占位骨架亦可构建）。

### P1 · mock-gateway 核心

- **目标**：§2.1 契约的保真模拟器可联调：账号域、事件账本 + SSE、群生命周期、send/by-client-id、`/_test` 平台与 S1/S2 开关（gw-1/2/3）。
- **任务组**：T-P1-01 骨架+账号域+/_test 平台 → T-P1-02 事件账本+SSE 推送器 → T-P1-03 群生命周期端点 → T-P1-04 send/kick/leave/members/by-client-id+消息事件 → T-P1-05 gw-1/2/3 开关与自身契约测试。
- **阶段门**：mock 自身契约测试全绿（connect 幂等同 platformUserId、since 独占补拉、双推开关生效、counters 准确）；server 可用 `GATEWAY_URL` 指向它做人工冒烟。
- **退出条件**：通用阶段门；`eventId` 跨 `/_test/reset` 不复用有测试证明（design/14 §1）。

### P2 · A2 入站 + A1 状态机 + A4 时间线

- **目标**：SSE 消费进 DB（连续前缀游标 + 死信不丢），账号状态机/终态副作用/限流登记完整，入站投影 + 成员投影 + WS 推送 + 时间线分页可用。
- **任务组（lane-A 串行）**：T-P2-01 gateway client → T-P2-02 调度器/恢复器骨架+启动时序 → T-P2-03 SSE 消费+前缀游标 → T-P2-04 死信三写+孤儿分流 → T-P2-05 账号状态机+connect/transition → T-P2-06 终态原子副作用（D1-2）→ T-P2-07 限流登记/闸门/到期（D2-5）→ T-P2-08 入站 message 投影+触发入口 → T-P2-09 成员投影（D2-1+R-A）→ T-P2-10 WS hub → T-P2-11 时间线分页；lane-B 并行：T-P2-12 乱序/补投/延迟/外部成员开关（gw-4/5/19/28）。
- **阶段门**：用 in-process mock-gateway 推事件 → server 时间线出现消息（`isOwn`/排序/去重正确）；`account_status` 事件驱动终态六动作一次成型（I6）；WS 客户端 auth 后收到单调 `seq` 事件（I12）。
- **退出条件**：通用阶段门；I5/I6/I7/I8（部分）/I12 用例绿；死信用例（D1-1/D3-1）绿。

### P3 · A3 建群 + A2 出站 + B2 leave-all —— S1–S4 可演示

- **目标**：出站全链（受理→dispatcher→同步错误分流→unknown 判定→单次重发→finalizeSent 收口）、建群 job 全分支、leave-all、群查询/级联；mock 开关 gw-6..10/14..23/26/27 落地。
- **任务组**：T-P3-01 send 受理 → T-P3-02 dispatcher+同步错误 → T-P3-03 unknown 判定器 → T-P3-04 finalizeSent（D1-3）+事件确认 → T-P3-05 建群主流程 → T-P3-06 建群异常分支（B2 三行/JOIN_TIMEOUT/promote≤2）→ T-P3-07 leave-all → T-P3-08 群端点+unreachable 级联；lane-B：T-P3-09 出站类开关、T-P3-10 建群类开关；**汇合**：T-P3-11 S1–S4 场景用例+demo 脚本。
- **阶段门**：`pnpm demo:s1`…`pnpm demo:s4` 现场复现，断言走 `GET /_test/counters`（S4 `sendCallsByAccount=0`）；S2 双推时间线无重复且 agent 不二触发（触发入口层面的幂等）。
- **退出条件**：通用阶段门；I2/I3/I9 用例绿；A2-2 全链（5s/2s/重发一次）用例绿。**REST/WS 接口面自此冻结**（lane-D 解锁）。

### P4 · mock-agent scripted + A5 全量 —— S5/S6 可演示

- **目标**：agent 编排全量：触发/单飞行/END2+SWEEP（R-B 守卫）、turn 循环与三重预算、协议错误分流、审计门禁、四工具、幂等 key、崩溃恢复、cancelled 检查点、查询端点；mock-agent scripted + 19 开关。
- **任务组**：lane-C：T-P4-01 mock-agent 骨架+默认剧本 → T-P4-02 协议类开关（ag-1..7,17,19）→ T-P4-03 行为类开关（ag-8..16,18）；lane-A：T-P4-04 触发/单飞行/END2+SWEEP → T-P4-05 executor+turn 循环+预算 → T-P4-06 三段式校验+协议错误 → T-P4-07 审计门禁+blocked → T-P4-08 get_recent_messages+finish → T-P4-09 send_message+幂等 → T-P4-10 kick_user（X-1）→ T-P4-11 崩溃恢复四分支 → T-P4-12 cancelled+孤儿租约（X-2）→ T-P4-13 查询端点；lane-B：T-P4-14 kick 开关（gw-24/25）；**汇合**：T-P4-15 S5/S6。
- **阶段门**：`pnpm demo:s5`（网关消息恰 1、第二次调用返 sent、审计恰一次、run finished）与 `pnpm demo:s6`（三连剧本，run 终态合法、每步 kind/rawResponse、进程不崩）。
- **退出条件**：通用阶段门；I4/I10（单测级）用例绿；ag-1..19 与 gw-24/25 代表用例绿。**全场最重阶段：超支时压缩 P3 的对账类装饰，不动此处**（基线原文）。

### P5 · 前端页面 1–3 + B3 前端

- **目标**：web 包可用：登录（401 单飞续期）、WS 客户端（seq 去重/退避/sinceSeq）、账号列表（转移合法目标面板/viewer 隐藏）、群详情（成员/开关/发送/时间线合并/加载更早/blocked 横幅）。
- **任务组（lane-D）**：T-P5-01 web 骨架+登录+单飞续期 → T-P5-02 WS 客户端 → T-P5-03 账号列表页 → T-P5-04 群详情骨架 → T-P5-05 时间线合并与加载更早。
- **阶段门**：浏览器操作员流程人工过一遍（design/15 §7 清单项：登录→账号→建群后的群详情→发消息→徽标流转→viewer 只读）；web 第 1/2 层测试绿。
- **退出条件**：通用阶段门（web 纳入 lint/typecheck/build/test）。

### P6 · B1 序列 + 页面 5 + B4/页面 4 —— S7/S8 可演示

- **目标**：序列定义/预检/启动互斥/链式排期/重启恢复/查询端点；页面 4（run 步骤详情）与页面 5（预检弹窗+422 展示）；B4 断线 3s 补齐验收。
- **任务组**：lane-A：T-P6-01 定义+预检（推演表）→ T-P6-02 启动互斥+快照 → T-P6-03 链式排期 → T-P6-04 重启恢复 → T-P6-05 查询端点；lane-D：T-P6-06 页面 4 → T-P6-07 页面 5；**汇合**：T-P6-08 S7/S8+B4 补齐验收。
- **阶段门**：`pnpm demo:s7`（恰一个 201 一个 409）、`pnpm demo:s8`（422 字段齐全、`landedMessages=0`、无运行记录、之后可启动）；断线重连 3 秒内补齐且不重复（I12 前端半边）。
- **退出条件**：通用阶段门；I11（单测级）/I4（序列半边）用例绿。

### P7 · 崩溃测试套件 + I 映射

- **目标**：`withCrashPoint` 基建 + 四个契约崩溃点的 kill -9 集成测试 + I1–I14 映射核对补漏——差异化证据。
- **任务组**：T-P7-01 crash 基建（子进程 server + 每用例独立库）→ T-P7-02 崩溃点①（I1/I2）→ T-P7-03 崩溃点②③（I10）→ T-P7-04 崩溃点④（I11）→ T-P7-05 I 映射核对与 VITEST_PLAN 收口。
- **阶段门**：一条命令跑崩溃套件全绿（README 章节的脚本入口已预注册）；`server/VITEST_PLAN.md` 全部条目要么勾选、要么在完成度表有裁剪记录。
- **退出条件**：通用阶段门。**本阶段与 A5 恢复路径永不裁剪**（基线原文）。

### P8 · C2 + C1 + C3 + 交付面

- **目标**：加分项全收 + 诚实交付面。
- **任务组**：T-P8-01 C1 媒体（下载/清理/保护）→ T-P8-02 C2 anthropic provider（只改 `AGENT_URL` 切换演示）→ T-P8-03 C3 Playwright 冒烟（登录→群→run 步骤）→ T-P8-04 README+完成度三栏表+demo 终验+AGENTS.md 终同步 → T-P8-05 DoD 终验清单执行。
- **阶段门**：DoD（DRIVER-PROMPT §9）逐项勾选；抽查复审 5 个已 DONE 任务重跑验证命令。
- **退出条件**：HANDOFF 终态 = 「DoD 达成，待人类 push/交付」。

### 缓冲（4h）

- 用途优先级：修复阶段门破绿 → 抽查复审打回项 → 录屏/asciinema 演示素材 → README 打磨。禁止用缓冲启动新功能面。

---

## 3. 阶段依赖图（不可改变）

```
P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → 缓冲
        （P1 lane-B 与 P0 末/P2 lane-A 并行；P5 lane-D 依赖 P3 接口面冻结 + P4 端点）
```

裁剪顺序与永不砍清单见 `00-SPEC.md` §6（照抄 review §3.3 / DRIVER-PROMPT §7）。
