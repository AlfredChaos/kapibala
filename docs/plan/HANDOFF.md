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

## 进行中

- T-P0-04 db 基建 + 迁移 runner + 版本门 + /api/health — impl-b 执行中。
- T-P1-01 mock-gateway 骨架 + 账号域 + /_test 控制平面 — impl-a 执行中（含 T-P0-05 常量 follow-up 已并入 b204dfd）。

## 剩余（按 DAG 顺序，详见 02-TASKS.md）

- P0 余下：T-P0-04（进行中）→ T-P0-06 seed → T-P0-07 auth(B3)；随后 P1–P8 按 DAG 顺序执行。
- P1（5，T-P1-01 进行中）：mock-gateway 核心 + gw-1/2/3。
- P2（12）：SSE/死信/账号状态机/入站/成员投影/WS/时间线 + gw-4/5/19/28。
- P3（11）：出站全链/建群/leave-all + S1–S4 集成（接口面冻结点）。
- P4（15）：mock-agent + A5 全量 + S5/S6。
- P5（5）：web 页面 1–3 + 401 单飞。
- P6（8）：序列 + 页面 4/5 + S7/S8 + B4。
- P7（5）：崩溃注入套件 + I 映射收口。
- P8（5）：C1/C2/C3 + README/完成度表 + DoD 终验。

## 风险

| 风险 | 状态 | 缓解 |
|---|---|---|
| 工程量 vs 48h（review R1） | 开放 | 严格按 §3.3 裁剪顺序；阶段门即提交点；P4 最重不动、P3 对账装饰可让 |
| R-A/R-B 回写验证未收口 | 开放 | 进入 T-P2-09 / T-P4-04 前先复核设计文档定稿语义（任务卡已按定稿语义写） |
| lane-C（mock-agent）正式排在 P4 但 DAG 只依赖 T-P0-02 | 已利用 | lane-A 阻塞时提前拉起 T-P4-01..03（不违反阶段依赖：它们不消费 server） |
| 共享文件竞态（index.ts/dispatch.ts/registry.ts/routes/index.ts/VITEST_PLAN/根 package.json） | 已消解 | §0 规则 1/2/3/7：依赖边串行化 + 阶段门统一勾选 + 脚本预注册 |
| AGENTS.md 命令漂移 | 已消解 | T-P0-01 初核对、T-P8-04 终同步，域任务只核对不改 |
| Docker Hub 不可达（本机网络） | 已缓解 | postgres:16 经 docker.m.daocloud.io 拉取后本地 retag（compose 未动）；全新机器需可访问 Docker Hub 或预配镜像 |

## 验证状态快照（最近一次）

- 全仓 lint / typecheck / test / build：**绿**（T-P0-01 `e3d1b5d` 时点全绿；收口提交复验 `pnpm typecheck` 0 错、`pnpm build` 全 Done）。
- 阶段门：P0–P8 全部未达。
- VITEST_PLAN 勾选：0/全量（预期；勾选发生在各阶段门）。
- 计划评审门：**已通过**（两审查 PASS + F1–F11 修复落地 + 脚本复查）。

> 终态目标行（达成后填写）：「DoD 达成，待人类 push/交付」。
