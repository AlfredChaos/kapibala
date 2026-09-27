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

---

<!-- 后续任务条目按上述格式在此追加。示例：
## 2026-09-XX T-P0-01 workspace 脚手架
- 做了什么：…
- 验证命令与输出摘录：…
- 偏差与【解读】：…
- 踩坑：…
-->
