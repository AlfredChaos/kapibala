# 02 · 原子任务 DAG（kapibala）

> 状态标记：`[status: TODO|ACTIVE|REVIEW|DONE|BLOCKED|REJECTED-n]`，初始全部 TODO。
> 任务卡五字段（goal/refs/owned/depends+lane/size）+ 验收五项（a 命令 / b GWT / c 测试先行 / d 负面检查 / e 文档联动）缺一即评审不通过（DRIVER-PROMPT §4）。
> 引用缩写：`QR` = `/Users/alfredchaos/home/work/kapibala/docs/analysis/10-quick-reference.md`；`DES` = `/Users/alfredchaos/home/work/kapibala/docs/design`；`REQ` = `/Users/alfredchaos/home/work/kapibala/docs/requirement.md`；`VITEST_PLAN` = `/Users/alfredchaos/home/work/kapibala/server/VITEST_PLAN.md`。契约数字在 b) 中逐字引用 QR，不得转述。

## 0. DAG 硬规则（调度器与审查者共同遵守）

1. **单写者**：任意时刻两个 ACTIVE 任务 owned 不相交。跨泳道任务按包目录天然隔离；触碰全局串行资源（`server/migrations/**`、`packages/contract/**`、`docs/plan/**`、根 `package.json`、根 `AGENTS.md`、`server/VITEST_PLAN.md`）的任务全局串行。**簿记豁免（F2）**：`server/VITEST_PLAN.md` 的勾选与 `docs/plan/JOURNAL.md` 的追加属**编排者序列化簿记**——在任务 REVIEW→DONE 转换与阶段门处由编排者统一执行（SP-6），不占用任何任务卡的 owned，也不受规则 6 的 owned 交集检查约束（T-P7-05 对 VITEST_PLAN 的显式 ownership 是收口例外，仍与编排者簿记串行进行）。
2. **迁移串行**：`server/migrations/**` 仅 T-P0-03 一个任务创建（全量 DDL，SP-2 裁决）；此后只增不改，无并行分支预占版本号。
3. **共享契约类型先行**：`packages/contract` 仅 T-P0-02 创建，下游（server/web/mock-gateway/mock-agent）只读引用（`@kapibala/contract`，workspace 依赖）；变更回 T-P0-02 串行处理。
4. **泳道**：lane-A = server 主干（严格串行链）；lane-B = mock-gateway；lane-C = mock-agent；lane-D = web（P3 接口面冻结后启动）；lane = integration 的任务（T-P3-11、T-P4-15、T-P6-08、T-P8-03..05）是串行汇合点，由编排者单独调度。
5. **测试资源隔离**：连 PG 的 Vitest 文件各自独立 database（模板库 + 随机后缀，基建在 T-P0-04）；mock 以进程内装配（`createGatewayApp()` / `createAgentApp()`）或子进程随机端口启动，用例间 `/_test/reset`，eventId 计数器不回退（DES/14 §1）。
6. **调度不变量**：只调度「depends 全 DONE 且 owned 与所有 ACTIVE 零交集」的任务；上下文压缩后第一动作 = 读 HANDOFF + 本文件状态 + JOURNAL 末尾。
7. **lane-A 共享文件与串行策略**：lane-A（server 主干）按任务编号全序**串行派发——任意时刻 lane-A 至多一个 ACTIVE 任务**（与 driver prompt「lane-A 严格按域依赖串行」一致）。以下被多个 lane-A 任务渐进编辑的共享文件因此安全（编辑者两两之间存在直接依赖边或编号顺序串行关系，且规则 6 的 owned-零交集检查是兜底闸门）——`server/src/index.ts`（T-P0-04 创建→T-P2-02 编排）、`server/src/http/routes/index.ts`（T-P0-04 创建→T-P0-07→T-P2-05→T-P2-11→T-P3-01→T-P3-05→T-P3-07→T-P3-08→T-P4-13→T-P6-01→T-P6-02→T-P6-05 各加注册行）、`server/src/events/dispatch.ts`（T-P2-03 创建→T-P2-06→T-P2-08→T-P2-09→T-P3-04 接线）、`server/src/scheduler/registry.ts`（T-P2-02 创建→各 `-scan.ts` 所属任务）、`server/src/recovery/scans.ts`（T-P2-02→T-P4-11→T-P6-04）、`server/tests/agent/crash-recovery.test.ts`（T-P4-11→T-P7-03）、`server/tests/sequences/restart-reschedule.test.ts`（T-P6-04→T-P7-04）。跨泳道任务**不得**触碰上述文件。另：**阶段门屏障的精确语义（F7）**——它约束 lane-A 主干进入下一阶段与该阶段的签收（累计产出演示 + 四命令绿 + 簿记）；独立泳道（B/C/D）任务的派发只受「depends 全部 DONE + owned 与所有 ACTIVE 零交集 + 本泳道规则」约束，允许 lane-C 在 lane-A 阻塞时提前拉起（与 01-PLAN §1 泳道视角一致）。
8. **验收可机检**：每卡 a) 给出命令与预期输出；审查者变异抽查（反转 1–2 个守卫，测试必须变红）不过 = reject。

---

# P0 · 脚手架 + 契约 + 迁移 + A0 + seed + B3 后端（7 任务）

### T-P0-01 workspace 脚手架与工程基建            [status: DONE]
- goal: 建立 pnpm workspace monorepo：根配置、四包骨架（package.json/tsconfig/vitest 配置/.env.example/包内 AGENTS.md 存根）、ESLint、docker-compose（postgres:16）、根脚本一次性预注册（含 demo:s1..s8 / e2e / db:migrate / db:seed，SP-5）；并为共享契约包建立**占位骨架**——`pnpm-workspace.yaml` 预收录 `packages/*`、四包 package.json 预声明 `"@kapibala/contract": "workspace:*"`、`packages/contract` 落最小占位文件（F1：否则前向声明的 workspace 依赖会使 `pnpm install` 在 T-P0-02 之前失败）。
- refs: /Users/alfredchaos/home/work/kapibala/AGENTS.md §1–§2；DES/01-architecture.md §6.1、§6.4；DES/12-agent-service.md §6；DES/14-gateway-service.md §6
- owned: /pnpm-workspace.yaml（预收录 packages/*）、/package.json、/tsconfig.base.json、/eslint.config.js、/docker-compose.yml、/.dockerignore、/scripts/README.md（仅占位说明；demo 脚本文件归 T-P3-11/T-P4-15/T-P6-08）、/AGENTS.md（根，命令同步）、packages/contract/package.json、packages/contract/tsconfig.json、packages/contract/src/index.ts（占位骨架：空导出 + 注释「类型由 T-P0-02 填充」）、server/package.json、server/tsconfig.json、server/vitest.config.ts、server/.env.example、server/AGENTS.md、web/package.json、web/tsconfig.json、web/vitest.config.ts、web/.env.example、web/AGENTS.md、mock-gateway/package.json、mock-gateway/tsconfig.json、mock-gateway/vitest.config.ts、mock-gateway/.env.example、mock-gateway/AGENTS.md、mock-agent/package.json、mock-agent/tsconfig.json、mock-agent/vitest.config.ts、mock-agent/.env.example、mock-agent/AGENTS.md
- depends: 无；lane: A
- size: M
- acceptance:
  a) `pnpm install` → 0 错误；`docker compose up -d` → postgres:16 就绪（`pg_isready`）；`pnpm lint && pnpm typecheck && pnpm build` → 全绿（四包空骨架可构建）
  b) Given 全新 clone，When `pnpm install && docker compose up -d`，Then 四包可构建且根脚本 `dev/build/test/lint/typecheck` 与预注册的 `demo:s1..s8`/`e2e`/`-F server db:migrate`/`-F server db:seed` 均可在 package.json 中找到（AGENTS.md §1 命令逐条一致）；`pnpm-workspace.yaml` 含 `packages/*` 且四包 package.json 均预声明 `@kapibala/contract: workspace:*`，占位骨架存在使该依赖在 T-P0-02 之前 `pnpm install` 即成功、`pnpm -F @kapibala/contract build` 对空导出占位可构建；tsconfig 全部 `strict: true`（宪法 §3-7）
  c) 新增测试：无（纯脚手架）；JOURNAL 记录每条命令实际输出
  d) 不引入 Redis/MQ/ORM；不用 npm/yarn 生成 lockfile；`.gitignore` 覆盖 `.env`/`node_modules`/`dist`/`coverage`/`media/`/`*.tsbuildinfo`；root package.json 此后仅 T-P8-04 可改
  e) 根 AGENTS.md §1 命令表与本任务落地逐条核对同步；JOURNAL 登记端口表（:3000/:5173/:4100/:4200/:4300/:5432）

### T-P0-02 共享契约类型包 packages/contract            [status: TODO]
- goal: 在 T-P0-01 建立的占位骨架（package.json/tsconfig/index.ts 空导出）之上填充全部跨包共享类型（SP-1 裁决：独立小包）：§2.2 Agent 协议形状、网关错误码、自有 API 错误码、WS 事件 payload。下游只读；包配置文件不动（F1 分工）。
- refs: REQ §2.2、§2.3；DES/12-agent-service.md §2；DES/06-agent-module.md §12 风险 1；DES/08-realtime-module.md §2.3；QR §3/§4
- owned: packages/contract/src/agent-protocol.ts、packages/contract/src/gateway-errors.ts、packages/contract/src/api-errors.ts、packages/contract/src/ws-events.ts（新增类型文件）、packages/contract/src/index.ts（导出改写的最小范围）、packages/contract/src/__tests__/shapes.test.ts——**不动** package.json/tsconfig（T-P0-01 占位所有）
- depends: T-P0-01；lane: A
- size: S
- acceptance:
  a) `pnpm -F @kapibala/contract build && pnpm typecheck` → 0 错误；四包已声明 workspace 依赖（T-P0-01 前向声明 + 占位骨架），本任务填充类型后 `import ... from '@kapibala/contract'` 在四包立即可用
  b) Given agent 错误码联合类型，Then 恰为 QR §3 的 13 个：`UNKNOWN_TOOL / INVALID_INPUT / DUPLICATE_TOOL_USE_ID / BAD_JSON / TURN_TIMEOUT / AUDIT_REJECTED / POLICY_DENIED / SEND_TIMEOUT / SEND_FAILED / NO_AVAILABLE_ACCOUNT / GROUP_UNREACHABLE / OWNER_LEFT / NO_PERMISSION`（REQ §2.2 逐字）；Given API 错误码类型，Then 覆盖 QR §4 全表（`UNAUTHORIZED/FORBIDDEN/VALIDATION_ERROR/ACCOUNT_NOT_FOUND/ILLEGAL_TRANSITION/CAS_CONFLICT/ACCOUNT_NOT_IN_GROUP/ACCOUNT_UNAVAILABLE/SEQUENCE_ALREADY_RUNNING/UNRESOLVED_PLACEHOLDER/ACCOUNT_NOT_ONLINE/JOIN_TIMEOUT/TOOLS_INVALID` + 设计值 `JOB_NOT_FOUND/LEAVE_FAILED/GROUP_NOT_FOUND/GROUP_UNREACHABLE/INTERNAL`）；WS payload 覆盖 REQ §2.3 六类 + DES/08 §2.3 扩展（`group_updated`/`job`）
  c) 新增 `packages/contract/src/__tests__/shapes.test.ts`（类型存在性/穷尽性编译断言）；先红（包不存在）后绿记录进 JOURNAL
  d) 包内**零契约数字**（数字只在 server constants，SP 见 00-SPEC §4.5）；无 any；无运行时依赖
  e) 无 VITEST 行；如后续需扩类型，回本任务串行变更并通知消费者

### T-P0-03 全量数据库迁移（20 表 DDL）            [status: TODO]
- goal: 按 DES/02 全文一次性落地全部表、约束、索引、生成列（19 张业务表 + `schema_migrations`，SP-2），迁移文件按域分 001–008、版本连续；此后迁移目录封闭。
- refs: /Users/alfredchaos/home/work/kapibala/docs/design/02-data-model.md 全文（§5.1 约束三索引、§7.1 单飞行索引、§8.3 步骤索引、§9 对照表）
- owned: server/migrations/**（001-infra.sql … 008-sequence.sql 及后续本任务内文件）
- depends: T-P0-01；lane: A
- size: M
- acceptance:
  a) `docker compose exec postgres psql -c '\dt'`（经 T-P0-04 runner 应用后）→ 20 张表齐全；重复执行 migrate → 幂等无变化
  b) Given 迁移已应用，Then 以下约束存在且语义正确（\d+ 验证）：`uq_message_group_msg ON message(group_id, msg_id) WHERE msg_id IS NOT NULL`；`uq_message_client_msg ON message(client_msg_id) WHERE client_msg_id IS NOT NULL`；`uq_agent_run_single_flight ON agent_run(group_id) WHERE status='running'`；`uq_sequence_run_single_flight ON sequence_run(group_id) WHERE status='running'`；`sort_key` 为 `COALESCE(msg_id, client_msg_id)` STORED 生成列；`agent_run_step` 的 `UNIQUE(run_id, tool_use_id) WHERE tool_use_id IS NOT NULL`；`resend_count CHECK (resend_count IN (0,1))`（DES/02 §5.1/§7.1/§7.2/§8.2）
  c) 新增 server/tests/migration-schema.test.ts（对已应用 schema 断言上述约束/索引/列，pg_catalog 查询）；先红后绿进 JOURNAL（测试先于 runner 存在时以显式 psql 断言替代，runner 任务落地后转正式用例）
  d) 只创建不修改；版本号 1..N 连续无空洞；不使用 enum 类型（状态列 text + CHECK，DES/02 约定）
  e) 无 VITEST 行（A0-1 的行为测试归 T-P0-04）

### T-P0-04 db 基建 + 迁移 runner + 版本门 + /api/health            [status: TODO]
- goal: pg Pool 与事务助手、自研迁移 runner（事务内「执行+记版本」）、启动版本门（落后/超前均拒绝）、Fastify 骨架（requestId/统一错误映射/auth guard 挂点）、`GET /api/health`、测试库隔离基建（模板库+随机后缀）。
- refs: DES/01-architecture.md §6.2–§6.4、§7；DES/02-data-model.md §1.1/§10；REQ §2.3（health 行）；AGENTS.md §3-1/§3-7
- owned: server/src/db/**（pool.ts、tx.ts、migrate.ts、pages.ts）、server/src/config/**、server/src/http/**（app.ts、plugins/request-id.ts、plugins/errors.ts、plugins/auth-guard.ts、routes/index.ts）、server/src/index.ts、server/tests/helpers/db.ts、server/tests/migration.test.ts、server/tests/health.test.ts
- depends: T-P0-01、T-P0-03；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/migration.test.ts tests/health.test.ts` → 全绿；`pnpm -F server db:migrate` 连跑两次 → 第二次 no-op；`pnpm typecheck` → 0 错
  b) Given DB 版本落后于代码注册版本，When 启动，Then 进程退出且 error 日志列缺失版本（A0：schema 落后拒绝启动）；Given DB 超前（代码回滚），Then 同样拒绝（DES/01 §6.4）；`GET /api/health` → `200 {"ok":true,"schemaVersion":<int>}`（= schema_migrations 最新版本）；Given 未知异常抛出，When 任一路由，Then `500 {"error":{"code":"INTERNAL","message":…,"requestId":…}}` 且日志含 err stack（DES/01 §6.3）
  c) 新增 tests/migration.test.ts（可重复执行/落后/超前三用例）、tests/health.test.ts；先红后绿记录
  d) runner 约 100 行内；无 any；错误不吞；helpers/db.ts 保证每个测试文件独立 database（随机后缀），worker 间不争用
  e) VITEST 行 A0-1/A0-2/A-02/A-20/A-21 登记应勾；根 AGENTS.md §1 的 db:migrate 命令**只读核对**（root AGENTS.md 归 T-P0-01/T-P8-04 所有：发现偏差登记进 JOURNAL 由 T-P8-04 统一改，本任务不改）

### T-P0-05 契约常量集中定义 + I14 对照测试            [status: TODO]
- goal: `server/src/constants.ts` 是**全仓唯一常量归宿**（预收集全部任务卡引用的常量）：除 QR §1 契约数字外，一并定义各设计文档的设计值常量（超时/重试/扫描/租约/保留窗口等，逐个带出处注释），`tests/constants.test.ts` 逐个断言（I14）。
- refs: QR §1 全表；DES/01-architecture.md §4.4；AGENTS.md §3-2
- owned: server/src/constants.ts、server/tests/constants.test.ts
- depends: T-P0-01；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test tests/constants.test.ts` → 全绿；`pnpm typecheck` → 0 错
  b) QR §1 契约数字逐字断言：`EVENT_REORDER_WINDOW_MS=1000`（≤1s）、`MEMBER_JOINED_DELAY_MS_MIN/MAX=100/1500`、`JOIN_TIMEOUT_MS=10000`、`PROMOTE_MAX_CALLS=2`（≤2 次）、`KICK_LATENCY_MIN/MAX_MS=1000/5000`（1–5s）、`KICK_CONVERGE_MS=2000`、`SEND_ACCEPT_MIN/MAX_MS=1000/2000`（1–2s）、`MESSAGE_SENT_MIN/MAX_MS=50/2000`、`SEND504_LAND_MS=2000`、`UNKNOWN_SETTLE_MS=5000`（5s）、`SEND_MESSAGE_WAIT_MS=5000`、`ACCESS_TOKEN_TTL_MS=900000`（15min）、`AGENT_MAX_STEPS=12`、`AGENT_WALL_CLOCK_MS=60000`、`AGENT_TURN_TIMEOUT_DEFAULT_MS=12000`（10–15s 可配）、`PROTOCOL_ERROR_STREAK_LIMIT=3`（3 次）、`AUDIT_MAX_ATTEMPTS=3`、`GET_RECENT_LIMIT_MAX=50`、`TEXT_TRUNCATE_CHARS=500`（500 字）、`TOOL_RESULT_MAX_BYTES=8192`（8KB）、`RESULT_SUMMARY_CHARS=200`（200 字）、`RAW_RESPONSE_MAX_BYTES=2048`（2KB）、`WS_BACKFILL_MS=3000`（3s）、`TIMELINE_PAGE_SIZE=50`、`MEDIA_RETENTION_DAYS_DEFAULT=30`（30 天）——以上均标「QR §1」。设计值常量逐个断言（各标出处）：`GATEWAY_TIMEOUT_DEFAULT_MS=10000`/`KICK_TIMEOUT_MS=6000`/`SEND_TIMEOUT_BUDGET_MS=8000`/`BY_CLIENT_ID_TIMEOUT_MS=5000`（DES/01 §4.4）；`AUDIT_SINGLE_TIMEOUT_MS=5000`（README 解释声明 #8）；`DEADLETTER_SCAN_INTERVAL_MS=5000`、`DEADLETTER_BACKOFF_MAX_MS=300000`（5min）、`DEADLETTER_STUCK_THRESHOLD=20`（DES/08 §1.4）；`UNKNOWN_PROBE_BACKOFF_MS=500`（DES/05 §2.4）；`INVITE_NOT_READY_RETRY_UNLIMITED=true`（等待时长=网关响应 readyAfterMs，非本地常量；重试不设上限，DES/04 §2.2）；`PROMOTE_RETRY_WAIT_MS=1000`（DES/04 §2.2 等 1s 重试）；`WS_HEARTBEAT_MS=30000`（DES/08 §2.4）；`WS_EVENT_RETENTION_MINUTES=30`（DES/02 §1.5）、`WS_SEND_QUEUE_LIMIT=1000`（DES/08 §2.4 超限断开）；`LEAVE_ALL_CONFIRM_TIMEOUT_MS=5000`（DES/04 §3.2 5s 核对）；`AGENT_MAX_CONCURRENT_RUNS=50`（DES/01 §6.1）；`AGENT_LEASE_RENEW_MS=2000`、`AGENT_LEASE_TTL_MS=10000`（DES/06 §2.1）；`SCHEDULER_TICK_MS=1000`（DES/01 §3）；`SSE_RECONNECT_BACKOFF_START_MS=500`、`SSE_RECONNECT_BACKOFF_MAX_MS=5000`（DES/08 §1.1）；`TOKEN_CLEANUP_RETENTION_DAYS=1`（DES/09 §5 过期行清理窗口 1d）；`TEXT_MAX_LENGTH=2000`（DES/05 §2.1.1，D3-6/解读 #15）；`AGENT_RUN_LIST_LIMIT=20`（解读 #22）；`TRIGGER_SWEEP_INTERVAL_MS=5000`（DES/06 §2 SWEEP 周期）
  c) 新增 tests/constants.test.ts；先红（常量缺失/默认值不符）后绿记录
  d) 禁止取整（如 5s→6000）；每常量带出处注释；此后任何任务不得新增无出处魔数（各卡 d 项统一引用本条）
  e) VITEST 行 I14 登记应勾

### T-P0-06 seed：admin/viewer + acc-01..04            [status: TODO]
- goal: 幂等 seed（ON CONFLICT DO NOTHING）：`app_user` 两用户（admin/admin、viewer/viewer，bcrypt cost 10）+ `account` 四账号（acc-01..acc-04，`status='idle'`、`platform_user_id=NULL`）。
- refs: DES/02-data-model.md §10、§2.1/§3.1；REQ §2.1（预置账号行）；DES/09-auth-module.md §5
- owned: server/src/db/seed.ts、server/tests/seed.test.ts
- depends: T-P0-04；lane: A
- size: S
- acceptance:
  a) `pnpm -F server db:seed` 连跑两次 → 第二次 no-op；`pnpm -F server test tests/seed.test.ts` → 绿
  b) Given seed 后，Then `app_user` 恰含 admin/viewer（role 对应）且 `account` 恰含 acc-01..acc-04 且 `status='idle'`、`platform_user_id IS NULL`（REQ §2.1「初始 status = idle、platformUserId = null」）；密码为 bcrypt 哈希非明文
  c) 新增 tests/seed.test.ts；先红后绿记录
  d) 幂等不靠先查后插（用 ON CONFLICT）；不打印明文密码
  e) VITEST 行 G-21 登记应勾；根 AGENTS.md db:seed 命令**只读核对**（同 T-P0-04 e 项限定：偏差登记、不直接改）

### T-P0-07 认证与会话（B3 后端全量 + viewer 403）            [status: TODO]
- goal: opaque token（256bit、SHA-256 落库）+ login/refresh/logout 三端点 + refresh 轮换链 + 复用检测作废整会话 + logout 即时失效 + auth guard 权限矩阵。
- refs: DES/09-auth-module.md 全文；REQ §2.3 auth 行、§3 B3、A0；QR §4
- owned: server/src/modules/auth/**、server/src/http/routes/auth.ts（+routes/index.ts 注册行）、server/tests/auth/session.test.ts
- depends: T-P0-04、T-P0-05、T-P0-06；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/auth/session.test.ts` → 全绿；`pnpm typecheck` → 0 错
  b) GWT（逐字数字）：Given admin/admin，When `POST /api/auth/login`，Then `200 {accessToken}` + `Set-Cookie: rt=<httpOnly>`（HttpOnly; Path=/api/auth; SameSite=Lax），access 有效期 **15 分钟**（QR §1）；Given 已轮换的旧 refresh 再次出现，When refresh，Then `401 UNAUTHORIZED` 且同会话全部 token（新 refresh + 新 access）立即失效（B3/I13）；Given logout 后，When 同一 access 调任意端点，Then 立即 `401`（B3）；Given viewer，When 任一写操作（connect/transition/groups/PATCH/send/leave-all/sequences/sequence-runs），Then `403 FORBIDDEN`（A0，判定顺序 401 先于 403）；Given 密码错误，Then `401 UNAUTHORIZED`（不区分用户存在性）
  c) 新增 tests/auth/session.test.ts（覆盖 I13 三断言 + 并发 refresh 恰一成功）；先红后绿记录
  d) token 原文不落库不进日志；并发轮换用条件更新 `WHERE status='active'`（DES/09 §3.2）；无 any
  e) VITEST 行 I13 登记应勾；矩阵 A-01/A0-3/B3-1..3 登记应勾

---

# P1 · mock-gateway 核心（5 任务，lane-B）

### T-P1-01 mock-gateway 骨架 + 账号域 + /_test 控制平面            [status: TODO]
- goal: mock-gateway 包可起：Fastify 应用 + 内存状态模型 + 账号域端点（connect/disconnect 幂等、offline/终态错误）+ `/_test` 控制平面骨架（scenario/clear/reset/counters/emit）。
- refs: DES/14-gateway-service.md §1–§2、§4、§6；REQ §2.1 账号节；QR §2
- owned: mock-gateway/src/app.ts、mock-gateway/src/state.ts、mock-gateway/src/accounts.ts、mock-gateway/src/test-plane.ts、mock-gateway/src/index.ts、mock-gateway/tests/accounts.test.ts
- depends: T-P0-01、T-P0-02；lane: B
- size: M
- acceptance:
  a) `pnpm -F mock-gateway test` → 全绿；`pnpm -F mock-gateway dev`（随机端口测试内）→ 可请求
  b) Given 同一 accountId 两次 connect，Then 返回**同一个** platformUserId（确定性派生，REQ §2.1）；Given disconnect 后，When send/join/promote/kick/leave，Then `409 ACCOUNT_OFFLINE`（REQ §2.1 五操作）；Given 账号被置 suspended/session_expired，When 其后**任何**请求（含 connect），Then 恒 `403 ACCOUNT_SUSPENDED` / `401 SESSION_EXPIRED`；Given `POST /_test/reset`，Then 业务状态与账本清空但 eventId 计数器**不回退**（DES/14 §1 关键坑）
  c) 新增 mock-gateway/tests/accounts.test.ts；先红后绿记录
  d) 开关/端点命名与 DES/14 §4 逐字一致，不自创契约；`GATEWAY_SEED_ACCOUNTS` 默认 `acc-01,acc-02,acc-03,acc-04`；无 any
  e) mock-gateway 包内 AGENTS.md 命令**只读核对**（不改根 AGENTS.md；包内文件如需修改，登记偏差由 T-P8-04 统一改，或回本泳道 owning 任务 T-P1-01 串行处理——其余 lane-B 任务不直接改它）；无 VITEST 行（开关用例随阶段汇入）

### T-P1-02 事件账本与 SSE 推送器            [status: TODO]
- goal: append-only 事件账本（eventId 单调分配）+ `GET /events?since=`（独占语义、全历史回放、不带 since 从当前时刻开始）+ SSE 帧格式 `id/event/data`（data 内带 eventId 与 type）。
- refs: DES/14-gateway-service.md §1、§3；REQ §2.1 事件流节；QR §1（乱序窗口行）
- owned: mock-gateway/src/ledger.ts、mock-gateway/src/sse.ts、mock-gateway/tests/sse.test.ts
- depends: T-P1-01；lane: B
- size: M
- acceptance:
  a) `pnpm -F mock-gateway test tests/sse.test.ts` → 全绿
  b) Given 账本有 eventId 1..10，When `GET /events?since=3`，Then 收到且仅收到 eventId>3 的事件（since 独占，REQ §2.1）；When 不带 since 新连接，Then 从连接时刻开始（不回放历史）；Given 服务重启进程内重建（mock 无持久化，用例内模拟），Then 帧顺序与账本一致且 `id:` 行 = data.eventId；六类事件 `message / message_sent / message_failed / member_joined / member_left / account_status` 均可投递
  c) 新增 tests/sse.test.ts（用 EventSource/fetch stream 消费）；先红后绿记录
  d) 每条推送先入账本再投帧；无静默丢帧；无 any
  e) 无 VITEST 行（server 侧消费在 T-P2-03 联测）

### T-P1-03 群生命周期端点（create/invite/join/promote）            [status: TODO]
- goal: `POST /groups`（创建者即成员、不推 member_joined）、`POST /groups/:id/invite`（readyAfterMs 0 或数秒、链接可过期）、`POST /groups/:id/join`（202 受理 + member_joined 100–1500ms 或永不到）、`POST /groups/:id/promote`（群主校验/NOT_MEMBER_YET/不推事件）。
- refs: DES/14-gateway-service.md §2–§3；REQ §2.1 群与成员节；QR §1（100–1500ms 行）
- owned: mock-gateway/src/groups.ts、mock-gateway/tests/groups.test.ts
- depends: T-P1-02；lane: B
- size: M
- acceptance:
  a) `pnpm -F mock-gateway test tests/groups.test.ts` → 全绿
  b) Given `POST /groups {creatorAccountId}`，Then 响应即含该成员（GET members 立即可见）且**不推** member_joined（REQ §2.1）；Given invite 返回 `readyAfterMs`，When 就绪前 join，Then `409 INVITE_NOT_READY`；链接过期后 join → `410 INVITE_EXPIRED`；Given join 202，Then `member_joined` 通常 **100–1500ms** 后到达（可钉值为确定值）且也可能永不到（开关 gw-18 在 T-P3-10 落地，本任务暴露参数）；已在群账号 join → `409 ALREADY_MEMBER` 且不再推事件；promote 非群主 → `403 NO_PERMISSION`；对方 member_joined 之前 → `409 NOT_MEMBER_YET`；promote 成功不推事件
  c) 新增 tests/groups.test.ts；先红后绿记录
  d) 时序默认区间随机、`/_test/scenario` 可钉死（DES/14 §3）；无 any
  e) 无 VITEST 行（server 侧联测归 P3）

### T-P1-04 send / kick / leave / members / by-client-id 端点            [status: TODO]
- goal: `POST /groups/:id/send`（202 可能 1–2s + message_sent 50–2000ms / message_failed 两码）、kick（1–5s、200 前移除成员、随后 member_left、504 收敛）、leave（200 + member_left / 500）、`GET /members` 即时性、`GET /messages/by-client-id/:clientMsgId`（200 最早一条/404）、`GET /media/:id` 存根（404 直至 gw-27）、message 事件全量回流（S3 默认行为）。
- refs: DES/14-gateway-service.md §2–§3、§5 注（S3 非开关）；REQ §2.1 发消息节；QR §1
- owned: mock-gateway/src/messaging.ts、mock-gateway/src/media.ts、mock-gateway/tests/messaging.test.ts
- depends: T-P1-03；lane: B
- size: M
- acceptance:
  a) `pnpm -F mock-gateway test tests/messaging.test.ts` → 全绿
  b) Given send 202（本身可能 **1–2s**），Then `message_sent {clientMsgId,msgId,sentAt}` 通常 **50–2000ms** 后到达，且 `message` 事件同样推送（含服务账号自己的消息——网关不区分来源，S3）；Given 同一 clientMsgId 发两次，Then 网关落地**两条**（不去重），by-client-id 返回**最早一条**（REQ §2.1）；Given kick 200（响应可能 **1–5s**），Then 目标在 200 返回前已从成员列表移除、member_left 随后推出；Given leave，Then 200 后推 member_left，也可能 `500`（没退成）；Given by-client-id 查询不存在的 clientMsgId，Then `404`
  c) 新增 tests/messaging.test.ts；先红后绿记录
  d) message 状态模型按 clientMsgId → **有序列表**（R-F 定稿语义）；sentAt 毫秒精度；无 any
  e) 无 VITEST 行

### T-P1-05 S1/S2 驱动开关（gw-1/2/3）与 counters 断言            [status: TODO]
- goal: 落地 gw-1 `send_accept_slow`、gw-2 `message_sent_delay`（钉值）、gw-3 `dup_push_all`（每事件推两次）+ counters（sendCallsByAccount/sendCallsByClientMsgId/landedMessages/kickCalls/framesEmitted）完备性测试。
- refs: DES/14-gateway-service.md §4–§5（#1/2/3 行）；VITEST_PLAN §2 S1/S2 行
- owned: mock-gateway/src/switches/basic.ts、mock-gateway/tests/switches-basic.test.ts
- depends: T-P1-04；lane: B
- size: S
- acceptance:
  a) `pnpm -F mock-gateway test tests/switches-basic.test.ts` → 全绿
  b) Given gw-3 开启，Then 每个事件帧投递两次（eventId 相同）；Given gw-1 钉值 1500ms，Then send 202 恰 1500ms 后返回；Given gw-2 钉值，Then message_sent 恰钉值后到达；Given `GET /_test/counters`，Then 各计数与实际调用一一对应（S1/S2 编排的断言真值）
  c) 新增 tests/switches-basic.test.ts；先红后绿记录
  d) 双推是**投递两次**（同 eventId），不是造两条事件；开关重复调用=覆盖参数；不弱化契约行为
  e) VITEST 行 gw-1/2/3（落地侧）登记应勾

---

# P2 · A2 入站 + A1 状态机 + A4 时间线（12 任务）

### T-P2-01 server 网关 client（gateway/）            [status: TODO]
- goal: server 侧唯一网关出口：全部端点封装、显式超时（普通 10s / kick 6s / send 8s / by-client-id 5s）、HTTP 错误 → 类型化 `{status, code, body}` 异常、响应浅校验、SSE 流消费接口、media 下载接口。
- refs: DES/01-architecture.md §4.4、§6.5、§8；REQ §2.1；DES/14-gateway-service.md §7
- owned: server/src/gateway/**、server/tests/gateway-client.test.ts
- depends: T-P0-02、T-P0-04、T-P0-05；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/gateway-client.test.ts` → 全绿（对进程内 mock-gateway）
  b) Given 网关返回 `429 {retryAfterSeconds}`，Then client 抛 `GatewayError{status:429, code:'RATE_LIMITED', body:{retryAfterSeconds}}` 且 retryAfterSeconds 数值保留不取整；Given `504`，Then code=`NETWORK_TIMEOUT`；Given `503`，Then 抛可重试类异常（与 504 分流，DES/05 §8）；Given 超时，Then AbortController 取消且异常带端点名
  c) 新增 tests/gateway-client.test.ts；先红后绿记录
  d) client 不做业务决策；全部超时值来自 constants.ts（标注 DES/01 §4.4 出处）；无 any
  e) 无 VITEST 行（被各域用例间接覆盖）

### T-P2-02 调度器/恢复器骨架与启动时序            [status: TODO]
- goal: `scheduler/`（1s 周期扫描注册表 registry.ts）+ `recovery/`（六扫描骨架，按 DES/10 §3 顺序）+ 启动时序（迁移检查→恢复登记→SSE 异步→调度器→HTTP 监听最后，恢复=登记+异步交接 D3-2）。
- refs: DES/01-architecture.md §3、§4.6、§7；DES/10-reliability.md §2–§3
- owned: server/src/scheduler/**（index.ts、registry.ts）、server/src/recovery/**（index.ts、scans.ts）、server/src/index.ts（启动编排，共享串行文件）、server/tests/boot-order.test.ts
- depends: T-P0-04；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/boot-order.test.ts` → 全绿；`pnpm typecheck` → 0 错
  b) Given 启动，Then 顺序为：连接+版本门 → 恢复扫描登记 → SSE 消费异步启动 → 调度器启动 → HTTP 监听（`/api/health` 随监听即可用，不等 SSE 追平，D3-2）；Given 注册的扫描函数抛错，Then 记 error 日志且调度器不退出
  c) 新增 tests/boot-order.test.ts；先红后绿记录
  d) 调度动作全部条件更新可重复触发（幂等吸收）；无进程内正确性判定（宪法 §3-5）
  e) 无 VITEST 行

### T-P2-03 SSE 消费循环 + 连续前缀游标            [status: TODO]
- goal: 消费循环（全局单飞 advisory lock `events:consumer`）、`event_cursor` 连续前缀推进、断线退避重连（500ms 起上限 5s、since 恒读库）、首部署不带 since、事件分发骨架 dispatch.ts。
- refs: DES/08-realtime-module.md §1.1、§1.3；DES/02-data-model.md §1.2；REQ §2.1 事件流；QR §1（≤1s 乱序窗口）
- owned: server/src/events/consumer.ts、server/src/events/cursor.ts、server/src/events/dispatch.ts、server/tests/events/cursor-prefix.test.ts、server/tests/events/resume.test.ts
- depends: T-P2-01、T-P2-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/events/cursor-prefix.test.ts tests/events/resume.test.ts` → 全绿
  b) Given 事件 5 先到、4 未到（乱序窗口 **≤1s**），When 4 到达，Then 游标才推进到 5（连续前缀，不是 max，DES/08 §1.3 / I8）；Given 停机期间网关产生事件，When 重启，Then `since=<持久化游标>` 补拉全部处理到（A2「停机或断开期间的事件恢复后都要处理到」）；Given 首次运行（游标=0），Then 不带 since 从当前开始（DES/08 §1.1 解读 #11）；Given 重复推送同 eventId，Then `gateway_event` PK `ON CONFLICT DO NOTHING` 吸收且游标照常推进
  c) 新增两测试文件；先红后绿记录
  d) 游标只在事务内推进；重连 since 从不用内存值；无 any
  e) VITEST 行 I8、A2-6、G-19 登记应勾

### T-P2-04 死信三写事务 + 孤儿事件分流 + 重试            [status: TODO]
- goal: 主事务失败 → 死信事务（三写同事务：补账本 + INSERT pending_event + 推进游标，D1-1）→ inconsistency 事件 → 消费不中断；调度器 5s 重试（指数退避上限 5min、20 次 → dead_letter_stuck）；孤儿群/孤儿账号事件分流（D3-1）。
- refs: DES/08-realtime-module.md §1.2、§1.4；DES/10-reliability.md E14 相关；VITEST_PLAN §5 D1-1/D3-1 行
- owned: server/src/events/deadletter.ts、server/src/events/orphan.ts、server/src/scheduler/deadletter-scan.ts（注册行）、server/tests/events/dead-letter.test.ts
- depends: T-P2-03；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/events/dead-letter.test.ts` → 全绿
  b) Given 制造永久性业务写失败（孤儿群 FK），When 事件到达，Then 死信事务成功（账本有行 + 死信行 + 游标推进）、消费循环推进、推 `inconsistency {kind:'db_write_failed'}`（VITEST D1-1 行）；Given 未知群 message 事件且不在任何 running 建群 job 的 context，Then 仅入账本 + `inconsistency {kind:'unknown_group_event'}`、**不进死信**（D3-1）；Given 处于建群窗口，Then 死信短重试；Given 重试成功，Then status='done' 并补推 WS 事件
  c) 新增 tests/events/dead-letter.test.ts（事务中途回滚注入）；先红后绿记录
  d) 死信事务必须三写同事务（只写死信会 FK 违例，DES/08 §1.2）；永不丢事件；无 any
  e) VITEST 行 D1-1/D3-1/A2-5 登记应勾

### T-P2-05 账号状态机 + connect / transition 端点            [status: TODO]
- goal: `transitions.ts` 15 条合法边集中定义；`enterTerminal` 幂等入口；connect（前置 {idle,disconnected}，先调网关后落库）；transition 三段式判定（400→404→ILLEGAL_TRANSITION→CAS_CONFLICT）+ disconnect 补调；`GET /api/accounts`。
- refs: DES/03-account-module.md §1–§3、§6；REQ §2.3 账号行、A1；QR §4、§6
- owned: server/src/modules/accounts/**（transitions.ts、connect.ts、transition.ts、list.ts）、server/src/http/routes/accounts.ts（+index 注册行）、server/tests/accounts/state-machine.test.ts、server/tests/accounts/transition.test.ts
- depends: T-P0-07、T-P2-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/accounts/state-machine.test.ts tests/accounts/transition.test.ts` → 全绿
  b) GWT：Given 转移不在 A1 表上（含同态→同态，如 online→online），Then `409 ILLEGAL_TRANSITION`；15 条合法边逐条可走通（A1 转移表逐格）；Given `expectedFrom` ≠ 当前状态，Then `409 CAS_CONFLICT` 且后写不覆盖先写（并发注入两请求恰一成功，I5）；Given 不存在账号，Then `404 ACCOUNT_NOT_FOUND`；Given `to='rate_limited'` 缺 `rateLimitedUntil`（或非未来时刻），Then `400 VALIDATION_ERROR`（D3-4）；Given connect 时账号为 rate_limited，Then `409 ILLEGAL_TRANSITION`（前置从严解读 #1）；connect 成功 → `200 {status:'online', platformUserId}`；标 disconnected/idle 落库后调网关 disconnect（崩溃由恢复器补调，E10）
  c) 新增两测试文件（含并发 CAS 注入）；先红后绿记录
  d) 判定顺序与 §2.3 错误码语义一致（静态 ILLEGAL 先于 CAS）；CAS 全部条件 UPDATE rowcount 判定；无 any
  e) VITEST 行 I5、D3-4、A-03/04/05、A1-1/2/4 登记应勾

### T-P2-06 终态原子副作用 enterTerminal（D1-2 收窄）            [status: TODO]
- goal: 三来源（同步错误 / account_status 事件 / 操作员）汇聚单一 `enterTerminal`：单事务六动作；取消范围收窄为 `queued AND first_attempt_at IS NULL`；在途行转 unknown 判定；SSE account_status 事件接线（挂入 T-P2-03 建立的 dispatch 骨架）。
- refs: DES/03-account-module.md §4（含细节 1/2）；DES/02-data-model.md §9；VITEST_PLAN §5 D1-2 行；REQ A1「进入终态时…」
- owned: server/src/modules/accounts/terminal.ts、server/src/events/handlers/account-status.ts（+dispatch 注册行）、server/tests/accounts/terminal-side-effects.test.ts
- depends: T-P2-05、T-P2-03；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/accounts/terminal-side-effects.test.ts` → 全绿
  b) Given 首次进入终态，Then 同一事务内：状态+terminal_at、全部活跃成员行置 left_at、`queued 且 first_attempt_at IS NULL` 的消息 → `cancelled(failCode=ACCOUNT_TERMINAL)`、关联序列步骤 → `skipped` + 下一步 `scheduled_at=now()+delay`、`ws_event(account_terminal + account_status_changed + 每条 cancelled 的 message)`（I6 全有或全无，事务中途回滚注入验证）；Given send 在途（first_attempt_at 非空）时终态到达，Then 该行转 `unknown(unknown_since=now(), unknown_deadline_at=now()+5s)` 而**非** cancelled（D1-2）；Given 重复进入同一终态，Then 静默忽略不重放副作用（A1）；Given 另一终态，Then 记日志不中断事件路径
  c) 新增 tests/accounts/terminal-side-effects.test.ts；先红后绿记录
  d) 副作用六动作不得拆事务（跨模块经 TxContext 回调，DES/03 §7）；无 any
  e) VITEST 行 I6、D1-2、A1-5、G-04 登记应勾

### T-P2-07 限流登记 / 硬闸门 / 到期恢复（D2-5）            [status: TODO]
- goal: 429 登记单事务（状态守卫 `WHERE status IN ('online','rate_limited')` + `greatest(now(), rate_limited_until) + retryAfterSeconds`）、闸门判定函数（挡在出站最外层）、到期扫描自动回 online（条件更新）。
- refs: DES/03-account-module.md §5；VITEST_PLAN §5 D2-5 行；REQ A1/A2 RATE_LIMITED 行；QR §2
- owned: server/src/modules/accounts/rate-limit.ts、server/src/scheduler/ratelimit-scan.ts（注册行）、server/tests/accounts/rate-limit.test.ts
- depends: T-P2-05；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/accounts/rate-limit.test.ts` → 全绿
  b) Given 429 `{retryAfterSeconds: N}`，When 账号 online，Then → `rate_limited` 且 until = greatest(now(), 旧 until)+N（期内再试探重置计时的兜底公式）；Given 429 与 disconnected 竞态，Then `rate_limited_until` 保持 NULL（非 rate_limited 态恒 NULL，D2-5）且 rowcount=0 记 warn；Given 到期，When 仍 rate_limited，Then 条件更新回 online + until=NULL + ws_event + 唤醒 dispatcher；When 已非 rate_limited，Then 不转移（A1 明文）；`rateLimitedUntil` 刷新不算状态转移（A1-3）
  c) 新增 tests/accounts/rate-limit.test.ts；先红后绿记录
  d) 闸门逐条查询不缓存（S4 的零试探根基）；disconnect/leave 不走闸门（A2）；无 any
  e) VITEST 行 D2-5、A1-3/7、G-15 登记应勾

### T-P2-08 入站 message 投影 + isOwn 合并 + agent 触发入口            [status: TODO]
- goal: SSE `message` 事件处理：去重插入、own 检测（ownPlatformUserIds 集合）、回流合并（message_sent 先到则幂等跳过）、agent 触发判定（active+agentEnabled → INSERT run ON CONFLICT DO NOTHING → 否则 trigger_queue）。
- refs: DES/05-messaging-module.md §3、§4.1–§4.2、§4.4；DES/02-data-model.md §5.1；REQ A2、S2/S3
- owned: server/src/modules/messages/inbound.ts、server/src/modules/agent/trigger-entry.ts（触发判定的最小存根，T-P4-04 接管扩展）、server/src/events/handlers/message.ts（+dispatch 注册行）、server/tests/messages/inbound.test.ts
- depends: T-P2-06、T-P2-03；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/messages/inbound.test.ts` → 全绿
  b) Given 外部消息，Then INSERT `is_own=false, delivery_status=NULL` 且 `ON CONFLICT (group_id,msg_id) DO NOTHING`（重复推送不触发 agent，S2）；Given 自己回流，When 已有回填行，Then 幂等跳过；When 无行，Then INSERT `is_own=true, delivery_status='sent', client_msg_id=NULL`（S3，不触发 agent）；Given agentEnabled=true 的 active 群新外部消息，Then `INSERT agent_run ... ON CONFLICT (group_id) WHERE status='running' DO NOTHING`，冲突 → `agent_trigger_queue ON CONFLICT DO NOTHING`（A5-1）；triggerMessages 按 sentAt 升序（§2.2）
  c) 新增 tests/messages/inbound.test.ts；先红后绿记录
  d) 去重键与排序键以 DB 为真值（宪法 §3-3）；无 any
  e) VITEST 行 A2-3/4、S-02/03（入站半边）、G-20 登记应勾

### T-P2-09 成员投影（D2-1 + R-A 定稿语义）            [status: TODO]
- goal: member_joined/member_left 事件投影：`last_event_id` 单调、墓碑行、复活分支先查 `terminal_at`（R-A）、TOMB 分支 `DO UPDATE SET last_event_id=GREATEST(...)`、外部成员不建行。
- refs: DES/04-group-module.md §4（含 D2-1）；DES/02-data-model.md §4.2；VITEST_PLAN §5 D2-1 行（含 R-A 补充场景）
- owned: server/src/modules/groups/members.ts、server/src/events/handlers/member.ts（+dispatch 注册行）、server/tests/groups/member-projection.test.ts
- depends: T-P2-06、T-P2-03；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/groups/member-projection.test.ts` → 全绿
  b) Given `member_left`(E2) 先到、`member_joined`(E1) 后到（乱序 ≤1s），Then E1 只补 joined_at、**不复活**（终态账号不复活——R-A：复活前查 terminal_at，非空按 STALE 处理；一般账号 E1<E2 同样不复活，D2-1）；Given join 在途账号已终态，Then INSERT 即带 left_at（墓碑）；Given member_left 无行，Then 插墓碑行且 `ON CONFLICT DO UPDATE SET last_event_id=GREATEST(last_event_id, EXCLUDED.last_event_id)`（双 leave 循环防线）；Given 外部成员（puid ∉ 服务账号集合），Then 不建行仅入账本（G-11/gw-28）；Given 重复 member_joined（S2），Then 幂等跳过
  c) 新增 tests/groups/member-projection.test.ts（含 R-A「迟到 joined 不得复活终态账号」回归场景）；先红后绿记录
  d) 活跃性变更只在 `event_id > last_event_id` 时发生；无 any
  e) VITEST 行 D2-1（含 R-A 场景）、G-04/11 登记应勾

### T-P2-10 WS hub + ws_event 表（I7/I12）            [status: TODO]
- goal: `/ws` 端点：auth 帧验证（access token 查表）、`{type:'auth',success:true}` 回执后才推事件、`{seq,type,payload}` 帧、sinceSeq 补发（seq > sinceSeq 升序）、每连接 lastSentSeq 水位、心跳 30s、保留窗口清理、积压过期 `ws_backlog_expired`。
- refs: DES/08-realtime-module.md §2 全文；DES/02-data-model.md §1.5；REQ §2.3 WS 行、A4/B4；QR §1（3s 行）
- owned: server/src/ws/**、server/tests/ws/hub.test.ts、server/tests/ws/sinceseq.test.ts
- depends: T-P0-07、T-P2-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/ws/hub.test.ts tests/ws/sinceseq.test.ts` → 全绿
  b) Given 未 auth，Then 不推任何事件；Given 无效 token，Then `{type:'auth',success:false}` 并关闭；Given sinceSeq=S，Then 按 seq 升序补发 seq>S 且与实时帧交叠不重复（客户端按 seq 去重，B4「断线 ≤3s 补齐」服务端半边，保留窗口 30min ≫ 3s）；Given 业务事务提交，Then hub 只投已提交行（先持久化后推送，I7；崩溃重放无「先事件后状态」窗口）；Given 超保留窗口的 sinceSeq，Then 从现存最小 seq 回放并先推 `inconsistency {kind:'ws_backlog_expired'}`（解读 #20）；六类事件 payload 形状与 DES/08 §2.3 一致（message 帧 `msgId` 可 null、own 带可选 clientMsgId/deliveryStatus，D3-3）
  c) 新增两测试文件；先红后绿记录
  d) seq 由 BIGSERIAL 分配，不用内存计数；连接期 token 过期不断开（解读 #21）；无 any
  e) VITEST 行 I7、I12、A-18/19、A4-2、B4-1（服务端半边）登记应勾

### T-P2-11 时间线游标分页（A4）            [status: TODO]
- goal: `GET /api/groups/:id/messages?before=&limit=50`：keyset 复合游标（base64(sent_at_epoch_ms + '.' + sort_key)）、`ORDER BY sent_at DESC, sort_key DESC`、nextCursor 语义、响应字段与 null 语义。
- refs: DES/05-messaging-module.md §5 全文；REQ §2.3 messages 行；QR §1（50 行）
- owned: server/src/modules/messages/timeline.ts、server/src/http/routes/messages.ts（+index 注册行）、server/tests/messages/timeline-pagination.test.ts
- depends: T-P2-08；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/messages/timeline-pagination.test.ts` → 全绿
  b) Given 默认 limit，Then 恰 **50**（QR §1）；Given「加载更早」期间新消息写入（含补投旧行 sentAt 任意早），When 翻页，Then 不重复不遗漏（keyset 以 cursor 为唯一边界，A4）；Given own 消息 sentAt 由受理时刻改为网关时刻（上移），Then 不在后页重复出现（§5.2(a)）；响应 items 字段 `{msgId, clientMsgId, senderPlatformUserId, isOwn, text, sentAt, deliveryStatus, failCode}` 无值 null；群不存在 → `404 GROUP_NOT_FOUND`
  c) 新增 tests/messages/timeline-pagination.test.ts（配合 gw-5 补投场景，开关在 T-P2-12 落地后补集成断言）；先红后绿记录
  d) 排序不用到达顺序；时间比较不用字符串；无 any
  e) VITEST 行 A-12、A4-1、G-03（排序半边）登记应勾

### T-P2-12 mock-gateway 乱序/补投/延迟/外部成员开关（gw-4/5/19/28）            [status: TODO]
- goal: 落地 gw-4 `reorder_1s`（相邻帧交换，含 message 先于 message_sent）、gw-5 `offline_backlog`（R-G 定稿：账号离线补投——新 eventId、原 msgId/sentAt，经 `/_test/emit` 配方生成）、gw-19 `member_joined_delay`（钉值）、gw-28 `external_member_events`。
- refs: DES/14-gateway-service.md §5（#4/5/19/28 行）、§1（R-G 语义）；VITEST_PLAN §3.1 对应行
- owned: mock-gateway/src/switches/timing.ts、mock-gateway/src/switches/backlog.ts、mock-gateway/tests/switches-timing.test.ts
- depends: T-P1-05；lane: B
- size: M
- acceptance:
  a) `pnpm -F mock-gateway test tests/switches-timing.test.ts` → 全绿
  b) Given gw-4 开启，Then 相邻两帧投递顺序交换（模拟乱序 **≤1s** 窗口）；Given gw-5 注入补投，Then 帧携带**新的更大的 eventId** 与**原值 msgId/sentAt**（sentAt 可比已收消息早任意时长，不受 1s 窗口限制，REQ §2.1）；Given gw-19 钉值，Then member_joined 恰钉值后到达；Given gw-28 开启，Then 外部用户 member_joined/left 正常推送
  c) 新增 tests/switches-timing.test.ts；先红后绿记录
  d) gw-5 不得把「SSE 断线回放」（默认行为）与「离线补投」混为一个开关（R-G）；无 any
  e) VITEST 行 gw-4/5/19/28（落地侧）登记应勾

---

# P3 · A3 建群 + A2 出站 + B2 leave-all —— S1–S4（11 任务）

### T-P3-01 操作员 send 端点与受理校验            [status: TODO]
- goal: `POST /api/groups/:id/send`：text 非空且 ≤ `TEXT_MAX_LENGTH`(2000)、群非 left、账号为活跃成员（否则 `409 ACCOUNT_NOT_IN_GROUP`）、账号非 {idle,disconnected,终态}（否则 `409 ACCOUNT_UNAVAILABLE`）、rate_limited 照常受理、INSERT queued + ws_event、返回 `202 {clientMsgId}`。
- refs: DES/05-messaging-module.md §2.1.1、§6；DES/02-data-model.md §5.1；REQ §2.3 send 行；解读 #15/16
- owned: server/src/modules/messages/accept.ts、server/src/http/routes/groups-send.ts（+index 注册行）、server/tests/messages/accept.test.ts
- depends: T-P2-11；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test tests/messages/accept.test.ts` → 全绿
  b) Given 空文本或 >2000 字，Then `400 VALIDATION_ERROR`；Given 非成员账号，Then `409 ACCOUNT_NOT_IN_GROUP`；Given idle/disconnected/终态账号，Then `409 ACCOUNT_UNAVAILABLE`；Given rate_limited 账号，Then `202` 受理且消息保持 `queued` 到期按序发（REQ §2.3）；Given unreachable 群，Then 照常受理（网关为准，解读 #16）；受理即 INSERT（先持久化后 202）
  c) 新增 tests/messages/accept.test.ts；先红后绿记录
  d) client_msg_id 服务端生成；无 any
  e) VITEST 行 A-09、G-16（受理半边）登记应勾

### T-P3-02 出站 dispatcher 与同步错误分流            [status: TODO]
- goal: dispatcher 常驻循环：每账号 advisory lock 串行、取最早 `queued AND first_attempt_at IS NULL`（id 升序）、硬闸门、落 first_attempt_at 后调 send、八类响应分流（202/429/终态/GWF/SENDER/OFFLINE/504/503）。
- refs: DES/05-messaging-module.md §2.1–§2.3；DES/03-account-module.md §5.2；DES/10-reliability.md E7；REQ A2 错误对照表；QR §2
- owned: server/src/modules/messages/dispatcher.ts、server/src/scheduler/dispatch-wakeup.ts（注册行）、server/tests/messages/outbound-dispatcher.test.ts
- depends: T-P3-01、T-P2-07；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/messages/outbound-dispatcher.test.ts` → 全绿
  b) GWT（逐字）：Given 网关 202，Then `accepted`（守卫 `IN ('queued','unknown')`，D1-2 配套）；Given `429 RATE_LIMITED`，Then 账号→rate_limited、消息保持 queued、期内网关 **0 次** 该账号 send（counters 断言）、序列顺延不跳过（A2/S4）；Given `403 ACCOUNT_SUSPENDED`/`401 SESSION_EXPIRED`，Then enterTerminal + 该条 failed 同名码；Given `403 GROUP_WRITE_FORBIDDEN`，Then 群 unreachable 级联 + 该条 failed；Given `403 SENDER_NOT_IN_GROUP`/`409 ACCOUNT_OFFLINE`，Then 该条 failed 同名 failCode、账号群状态不变；Given `504 NETWORK_TIMEOUT`，Then → `unknown(unknown_since=now(), deadline=now()+5s)`；Given `503`，Then 指数退避重试同一意图（resend_count 不变，解读 #17）；崩溃推演：网关已发 DB 必有记录（first_attempt_at 先于调用，E7/I1）
  c) 新增 tests/messages/outbound-dispatcher.test.ts（gw-15/16/17/10 代表断言，开关由 T-P3-09 提供、此前用 mock 直注响应）；先红后绿记录
  d) 闸门挡在最外层（宪法 §3-4）；同账号至多一条在途（§2.2）；无 any
  e) VITEST 行 A2-1/7/8/10、G-13/14、gw-15/16/17/10（测试侧）登记应勾

### T-P3-03 unknown 判定器（5s 落定 / 2s 确认线 / 单次重发）            [status: TODO]
- goal: 判定器：路径 A 等 message_sent、路径 B 自 unknown_since+2s 起每 500ms 探测 by-client-id；404 超 2s = 确认未发出；`resend_count=0` 才可重发（同 clientMsgId）；重发仍未发出 → `failed(NETWORK_TIMEOUT)`；503 期间保持 unknown。
- refs: DES/05-messaging-module.md §2.4；REQ A2 第 2 条、§2.1 by-client-id；QR §1（5s/2s 行）
- owned: server/src/modules/messages/adjudicator.ts、server/src/scheduler/unknown-scan.ts（注册行）、server/tests/messages/unknown-adjudicator.test.ts
- depends: T-P3-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/messages/unknown-adjudicator.test.ts` → 全绿
  b) Given 504 后 1.5s 落地（gw-7），Then `message_sent` 到达 → sent（5s 内落定）；Given by-client-id 恒 404（gw-8）且超 **2s**，Then 确认未发出 → 重发一次（同 clientMsgId，`resend_count=1`）→ 仍未发出 → `failed(failCode=NETWORK_TIMEOUT)`（A2 逐字）；Given by-client-id 503（gw-9），Then 保持 unknown，恢复后 **2s 内**确定（I9）；Given 确认前，Then **不得**重发（A2「在确认消息没有发出之前不能重发」）；Given 2s 内 404，Then 不算数（消息可能正要落地）
  c) 新增 tests/messages/unknown-adjudicator.test.ts；先红后绿记录
  d) 探测节奏由调度器扫描 unknown_deadline_at 驱动（漏拍兜底）；resend_count CHECK (0,1) 是最后防线；无 any
  e) VITEST 行 I2、I9、A2-2、G-17/18、gw-7/8/9（测试侧）登记应勾

### T-P3-04 finalizeSent 唯一收口（D1-3）+ message_sent/failed 事件            [status: TODO]
- goal: 共享 `finalizeSent(clientMsgId, msgId, sentAt, tx)`：预检 → 常规回填 / 乱序合并（先删占位行再更新 M 行 + 审计字段迁移）→ 序列联动 → ws_event；message_sent/message_failed 事件处理接入。
- refs: DES/05-messaging-module.md §2.5、§4.3 全文；DES/02-data-model.md §9；VITEST_PLAN §5 D1-3 行、I3 行
- owned: server/src/modules/messages/finalize-sent.ts、server/src/events/handlers/confirm.ts（+dispatch 注册行）、server/tests/messages/finalize-sent.test.ts
- depends: T-P3-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/messages/finalize-sent.test.ts` → 全绿
  b) Given 常规路径，Then 占位行 `queued/accepted/unknown → sent` 回填 msg_id/sent_at=网关值；Given 乱序窗口（≤1s）message 先到（M 行已存在），When message_sent 到达，Then **先 DELETE 占位行（client_msg_id=X, msg_id IS NULL）再 UPDATE M 行 SET client_msg_id=X**（审计字段随行迁移），稳态恰一行含双侧身份（D1-3；D3-5 瞬态声明）；Given by-client-id 200 补投场景（M 行早已存在），Then 走同一合并分支；Given 重复 message_sent（S2），Then 幂等；序列联动：`UPDATE sequence_run_step SET status='sent', sent_at=$sentAt WHERE client_msg_id=X AND status IN ('pending','accepted')` 并触发下一步排期（2a/2b 统一执行）；message_failed 按码分流（GWF → 群级联 + failed；ACCOUNT_SUSPENDED → enterTerminal + failed）
  c) 新增 tests/messages/finalize-sent.test.ts（含稳态一行断言）；先红后绿记录
  d) 所有确认途径（事件/by-client-id/未来）只走此函数（唯一收口）；agent 5s 等待按 client_msg_id 对合并透明；无 any
  e) VITEST 行 I3、D1-3、D3-5、S-01/03（确认半边）登记应勾

### T-P3-05 建群 job 主流程 + GET /api/jobs            [status: TODO]
- goal: `POST /api/groups` 受理（400/422/202 {jobId}）+ job 执行器主链（create→invite→join 并行→waiting_joins→promote→finished/group active）+ `GET /api/jobs/:jobId`（JOB_NOT_FOUND 404）。每步意图先落 phase/context 再外呼（E1–E4）。
- refs: DES/04-group-module.md §2.1–§2.3、§7；DES/02-data-model.md §6.1；REQ §2.3、A3；QR §4
- owned: server/src/modules/groups/create-job.ts、server/src/http/routes/groups.ts（+index 注册行）、server/src/http/routes/jobs.ts（+index 注册行）、server/tests/groups/create-group-job.test.ts
- depends: T-P2-09、T-P2-03；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/groups/create-group-job.test.ts` → 全绿（正常路径用例）
  b) Given 参数不合法（memberAccountIds 空或含群主或重复），Then `400 VALIDATION_ERROR`；任一账号非 online，Then `422 ACCOUNT_NOT_ONLINE`；受理 → `202 {jobId}` 且群 `creating`（对外不暴露）；Given 正常链，Then creator 建群成功事务内写 `role=creator`（无 member_joined，G-05）、join 并行 202、`member_joined` 事件写成员行（A3-2）、到齐后 promote、`memberAccountIds[0]` → `role=admin`（UPSERT 兜底）、job finished + group active + ws_event；`GET /api/jobs/:jobId` → `{status, errors:[{step,code}]}`
  c) 新增 tests/groups/create-group-job.test.ts；先红后绿记录
  d) join 不重发原则在恢复分支（本任务实现 phase 断点续传骨架）；advisory lock `job:<jobId>`；无 any
  e) VITEST 行 A-06/11、A3-1/2、G-05/07（主路径）登记应勾

### T-P3-06 建群异常分支（B2 三行 / JOIN_TIMEOUT / promote≤2 / 崩溃续传）            [status: TODO]
- goal: INVITE_NOT_READY 等 readyAfterMs 重试（不设限、检查 running）、INVITE_EXPIRED 重申一次、ALREADY_MEMBER 视为成功 + UPSERT 成员行（D2-2）、member_joined 10s 未到 → JOIN_TIMEOUT、NOT_MEMBER_YET 重试总调用 ≤2、phase/context 崩溃续传。
- refs: DES/04-group-module.md §2.2 要点、§2.4；REQ B2 第 1 条、A2 表 NOT_MEMBER_YET 行；QR §1（10s、≤2 次行）、§4（JOIN_TIMEOUT）
- owned: server/src/modules/groups/create-job-branches.ts、server/src/scheduler/join-timeout-scan.ts（注册行）、server/tests/groups/create-group-job-branches.test.ts
- depends: T-P3-05；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/groups/create-group-job-branches.test.ts` → 全绿
  b) Given `409 INVITE_NOT_READY`，Then 等 `readyAfterMs` 后重试；Given `410 INVITE_EXPIRED`，Then 重新申请链接后重试**一次**、群与账号状态不变（B2 逐字）；再失败 → job failed（step=invite 或 join:<id> INVITE_EXPIRED）；Given `409 ALREADY_MEMBER`，Then 视为成功直接 promote，成员行由 job 事务 **UPSERT(role=member)**——网关不推 member_joined（D2-2 回归：promote 后 role=admin、GET members 含该账号）；Given member_joined **10s** 未到，Then job failed 且 `errors[].code=JOIN_TIMEOUT`、`step=join:<accountId>` 精确到超时成员（A2）；Given promote `409 NOT_MEMBER_YET`，Then 重试（等 1s）且调用总数 **≤2**（context.promoteCalls 持久化、崩溃续传累计），超限 → failed(step=promote)；Given 崩溃于 joining，When 恢复，Then waiting 成员**不重发 join**、未发出成员照常发（§2.4）
  c) 新增 tests/groups/create-group-job-branches.test.ts；先红后绿记录
  d) promote 计数持久化不靠内存；join_deadline_at 恢复取 max(原值, now) 不重置窗口；无 any
  e) VITEST 行 B2-1、A2-11、G-06/07/08、gw-18/20/21/22/23（测试侧）、D2-2 登记应勾

### T-P3-07 leave-all job（B2）            [status: TODO]
- goal: `POST /api/groups/:id/leave-all` → `202 {jobId}`；非群主串行先退、群主最后；失败记 errors[] 其余继续、群主不退、job failed；member_left 确认或 5s 后查成员列表核对；终局对账（服务账号集合 vs 网关列表）+ inconsistency；完成 → group left、members=[]。
- refs: DES/04-group-module.md §3 全文；REQ §2.3 leave-all 行、B2 第 2/3 条；解读 #4/#5
- owned: server/src/modules/groups/leave-all.ts、server/src/http/routes/groups-leave-all.ts（+index 注册行）、server/tests/groups/leave-all.test.ts
- depends: T-P3-05；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/groups/leave-all.test.ts` → 全绿
  b) Given 全部成功，Then 退出顺序=非群主（按 accountId 序）→ 群主最后，完成 → `status='left'`、`members=[]`（REQ §2.3）；Given 某非群主 leave 返回 `500`（gw-26），Then `errors += {step:'leave:<id>', code:'LEAVE_FAILED'}`、其余非群主继续退、**群主不退**、job failed、失败账号在 DB 与网关都仍是成员（B2 逐字）；Given leave 200 但 member_left 5s 未到，Then `GET /members` 核对判定（解读：5s 核对为设计值，属可裁剪装饰——裁剪时保留「事件确认」最小行为）；Given 终局对账不一致，Then `inconsistency {kind:'member_mismatch'}`；崩溃于 leave 在途 → 查成员列表定结果不重发（E6）
  c) 新增 tests/groups/leave-all.test.ts；先红后绿记录
  d) 崩溃恢复不重发 leave（契约未定义重复 leave 行为）；无 any
  e) VITEST 行 A-10、B2-2/3、G-10/12、gw-26（测试侧）登记应勾

### T-P3-08 群查询端点 + PATCH + GROUP_WRITE_FORBIDDEN 级联            [status: TODO]
- goal: `GET /api/groups(/:id)` 全字段组装（activeAgentRunId/activeSequenceRunId、creating 隐藏、left 后 members=[]）、`PATCH`（开关 + 关 agentEnabled 写取消请求标志）、`markGroupUnreachable` 单事务级联（群条件更新 + 序列 stopped + agent 取消请求 + 账号不动）。
- refs: DES/04-group-module.md §1、§5；REQ §2.3 群行；A2 表 GWF 行；DES/02-data-model.md §7.1/§8.2
- owned: server/src/modules/groups/query.ts、server/src/modules/groups/state.ts、server/src/http/routes/groups-patch.ts（+index 注册行）、server/tests/groups/group-state.test.ts
- depends: T-P3-05、T-P2-09；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/groups/group-state.test.ts` → 全绿
  b) Given 响应组装，Then 字段 `{id, gatewayGroupId, status, creatorAccountId, agentEnabled, autoKickEnabled, members:[{accountId,platformUserId,role}], activeSequenceRunId, activeAgentRunId}`，role=creator/admin/member 分配正确，active* 仅 running 时非空（部分唯一索引保证）；`status='left'` → `members=[]`；creating 群不出现；Given GWF（gw-14），Then 单事务：group `active→unreachable`（幂等）、running 序列 → `stopped` + ws_event、running agent run 写取消请求（当前步后 cancelled 的标志，不在此事务打断）、**账号状态不变**（A2 逐字）；Given unreachable 群，Then 不回转（解读 #2）；PATCH 关 agentEnabled 同法写取消请求（A5-10）
  c) 新增 tests/groups/group-state.test.ts；先红后绿记录
  d) 取消不改 run 状态（尊重「当前这一步结束后」，X-2 语义前置）；无 any
  e) VITEST 行 A-07/08、A2-9、gw-14（测试侧）登记应勾

### T-P3-09 mock-gateway 出站类开关（gw-6..10/14..17/27）            [status: TODO]
- goal: 落地 gw-6 `rate_limit`（429 + 期内任何 send 再 429 且计时重置）、gw-7 `send_504_land_1500`、gw-8 `send_504_not_sent`、gw-9 `by_client_id_503`、gw-10 `gateway_503_all`、gw-11/12/13 终态码与 account_status 事件、gw-14 `group_write_forbidden`、gw-15 `message_failed_event`、gw-16 `sender_not_in_group`、gw-17 `account_offline_409`、gw-27 `media_message`/`media_expire_404`。
- refs: DES/14-gateway-service.md §5（#6–17、27 行）、§3；VITEST_PLAN §3.1
- owned: mock-gateway/src/switches/outbound.ts、mock-gateway/src/switches/terminal.ts、mock-gateway/src/media.ts（充实）、mock-gateway/tests/switches-outbound.test.ts
- depends: T-P2-12；lane: B
- size: M
- acceptance:
  a) `pnpm -F mock-gateway test tests/switches-outbound.test.ts` → 全绿
  b) Given gw-6 开启首次 send，Then `429 {retryAfterSeconds:N}` 且等待期内任何 send 再 429 并**重置计时**（REQ §2.1）；Given gw-7，Then 第一次 send → 504、**1.5s 后落地**并推 message_sent（S5 编排）；Given gw-8，Then 504 且 by-client-id 恒 404；Given gw-9/10，Then 对应端点 503（可配恢复时刻/时长）；Given gw-13，Then 推 `account_status` + 自动移出所有群并逐群推 `member_left`（REQ §2.1）；Given gw-15，Then 推 `message_failed`（code 可配 GROUP_WRITE_FORBIDDEN|ACCOUNT_SUSPENDED）；Given gw-27，Then message 带 `mediaUrl`、`GET /media/:id` 过期后 `404`
  c) 新增 tests/switches-outbound.test.ts；先红后绿记录
  d) 429 的计时重置由网关侧实现（server 侧零试探是另一半）；不弱化任何契约行为；无 any
  e) VITEST 行 gw-6..17/27（落地侧）登记应勾

### T-P3-10 mock-gateway 建群类开关（gw-18/20/21/22/23/26）            [status: TODO]
- goal: 落地 gw-18 `member_joined_never`、gw-20 `invite_not_ready`、gw-21 `invite_expired`、gw-22 `already_member`（409 且不推事件）、gw-23 `promote_not_member_yet`（可配出现次数）、gw-26 `leave_500`。
- refs: DES/14-gateway-service.md §5（#18/20–23/26 行）；VITEST_PLAN §3.1
- owned: mock-gateway/src/switches/group-lifecycle.ts、mock-gateway/tests/switches-group.test.ts
- depends: T-P3-09；lane: B
- size: S
- acceptance:
  a) `pnpm -F mock-gateway test tests/switches-group.test.ts` → 全绿
  b) Given gw-18，Then join 202 但 member_joined 永不到；Given gw-20，Then invite `readyAfterMs>0` 且就绪前 join `409 INVITE_NOT_READY`；Given gw-21，Then join → `410 INVITE_EXPIRED`（任意时刻过期）；Given gw-22，Then 已在群账号 join → `409 ALREADY_MEMBER` 且**不推事件**；Given gw-23 配 1 次，Then 首次 promote `409 NOT_MEMBER_YET`、第二次 200；Given gw-26，Then leave → `500`（没退成，账号保持成员）
  c) 新增 tests/switches-group.test.ts；先红后绿记录
  d) gw-22 不推事件是契约明文（server 侧 D2-2 依赖此行为）；无 any
  e) VITEST 行 gw-18/20/21/22/23/26（落地侧）登记应勾

### T-P3-11 集成：S1–S4 场景用例 + demo 脚本（串行汇合点）            [status: TODO]
- goal: `tests/scenarios/s1..s4.test.ts`（真 PG + in-process 双 mock + server 子进程或进程内装配）+ `scripts/demo/s1..s4.ts`（一条命令编排：起环境→装开关→触发→断言 counters→输出摘要）。
- refs: REQ §2.4 S1–S4 行；DES/14-gateway-service.md §8；VITEST_PLAN §2；analysis/09-scenarios.md
- owned: server/tests/scenarios/s1.test.ts、s2.test.ts、s3.test.ts、s4.test.ts、server/tests/helpers/env.ts、scripts/demo/s1.ts、s2.ts、s3.ts、s4.ts
- depends: T-P3-03、T-P3-04、T-P3-06、T-P3-07、T-P3-08、T-P3-09、T-P3-10；lane: integration
- size: M
- acceptance:
  a) `pnpm -F server test tests/scenarios/` → 全绿；`pnpm demo:s1` … `pnpm demo:s4` → 各自输出 PASS 摘要（含 counters 快照）
  b) S1：`message_sent` 之前 `deliveryStatus='accepted'`、之后 `sent`、恰一行（REQ §2.4 逐字）；S2：每事件双推 → 时间线无重复行、agent 不被重复触发；S3：回流 `isOwn=true`、不产生新 run；S4：429 → 账号 rate_limited、`counters.sendCallsByAccount=0`（期内零试探）、到期自动恢复按序发出（断言走 `GET /_test/counters`，DRIVER-PROMPT §9）
  c) 新增四场景用例 + demo 脚本；先红后绿记录（红 = server 行为缺失时）
  d) 断言以 mock counters 为真值，不以日志为准；demo 脚本可重复运行（结束清理）
  e) VITEST 行 S1–S4、gw-1/2/3/6（场景侧）登记应勾；阶段门 P3 演示记录进 JOURNAL

---

# P4 · mock-agent scripted + A5 全量 —— S5/S6（15 任务）

### T-P4-01 mock-agent 骨架 + scripted 默认剧本 + TOOLS_INVALID            [status: TODO]
- goal: mock-agent 包可起：HTTP 契约层（tools 校验：恰好 4 个 + required 全覆盖 → 否则 `400 TOOLS_INVALID`）、`AGENT_MODE` 选择 provider、scripted 默认剧本（`get_recent_messages → send_message → finish`）、`/_test/scenario` 装剧本、`/agent/audit` 确定性 pass。
- refs: DES/12-agent-service.md §2–§3、§6；REQ §2.2；DES/06-agent-module.md §6
- owned: mock-agent/src/app.ts、mock-agent/src/providers/scripted.ts、mock-agent/src/scenario.ts、mock-agent/src/index.ts、mock-agent/tests/scripted.test.ts
- depends: T-P0-01、T-P0-02；lane: C
- size: M
- acceptance:
  a) `pnpm -F mock-agent test` → 全绿
  b) Given tools 数量 ≠4 或 required 未覆盖全部入参，Then `400 TOOLS_INVALID`（REQ §2.2）；Given 合法 turn 请求，Then `200` 响应**每轮恰好一个块**且 stop_reason 与块类型一致（REQ §2.2「合法响应每轮恰好一个块」）；Given 剧本播完，Then 回落默认剧本；audit → `200 {verdict:'pass', reason:…}`；响应只由请求 messages 决定（无状态全量历史规约，DES/12 §2.1）
  c) 新增 tests/scripted.test.ts；先红后绿记录
  d) 不做任何业务决策；`Map<runId,游标>` 重启清零可接受（mock 定位）；无 any
  e) mock-agent 包内 AGENTS.md **只读核对**（偏差登记由 T-P8-04 统一改，或回 T-P4-01 串行处理；本任务不改）；无 VITEST 行（ag-19 在 T-P4-02）

### T-P4-02 mock-agent 协议类开关（ag-1..7/17/19）            [status: TODO]
- goal: 落地 ag-1 `bad_json_raw`、ag-2 `bad_json_fenced`、ag-3 `bad_json_wrapped`、ag-4 `shape_invalid`、ag-5 `unknown_tool`、ag-6 `invalid_input`、ag-7 `duplicate_tool_use_id`、ag-17 `s6_sequence`、ag-19 `tools_invalid_probe`。
- refs: DES/12-agent-service.md §7（#1–7、17、19 行）；REQ §2.2「可能出现的行为」；VITEST_PLAN §3.2
- owned: mock-agent/src/switches/protocol.ts、mock-agent/tests/switches-protocol.test.ts
- depends: T-P4-01；lane: C
- size: M
- acceptance:
  a) `pnpm -F mock-agent test tests/switches-protocol.test.ts` → 全绿
  b) Given ag-1/2/3，Then 响应体分别为：非法 JSON / 合法 JSON 外套 markdown 围栏 / JSON 前后夹文字（三者均属 BAD_JSON 定义，REQ §2.2）；Given ag-4，Then JSON 合法但缺 stop_reason 或块数 ≠1 或 stop_reason 与块类型不一致；Given ag-5/6，Then 调用不在 tools 里的工具 / 入参不合 input_schema；Given ag-7，Then 同一 tool_use.id 用两次；Given ag-17，Then 三连剧本：坏 JSON → 未知工具 → 正常结束（S6）；Given ag-19 探针（构造不合规 tools），Then `400 TOOLS_INVALID`（反测后端常量）
  c) 新增 tests/switches-protocol.test.ts；先红后绿记录
  d) 坏响应形态逐字对齐 REQ §2.2 定义，不弱化；无 any
  e) VITEST 行 ag-1..7/17/19（落地侧）登记应勾

### T-P4-03 mock-agent 行为类开关（ag-8..16/18）            [status: TODO]
- goal: 落地 ag-8 `send_timeout_key_retry`、ag-9 `endless_tools`、ag-10 `repeat_get_recent`、ag-11 `huge_limit`、ag-12 `slow_turn`（~8s 可配）、ag-13 `hang_turn`、ag-14 `audit_500`、ag-15 `audit_bad_body`、ag-16 `audit_slow`/`audit_hang`、ag-18 `same_runid_redispatch`。
- refs: DES/12-agent-service.md §7（#8–16、18 行）；REQ §2.2 行为清单；QR §1（~8s 行）
- owned: mock-agent/src/switches/behavior.ts、mock-agent/tests/switches-behavior.test.ts
- depends: T-P4-02；lane: C
- size: M
- acceptance:
  a) `pnpm -F mock-agent test tests/switches-behavior.test.ts` → 全绿
  b) Given ag-8，Then 拿到 send_message 结果后用**同一个 idempotency_key** 再调一次；Given ag-9/10/11，Then 一直调工具 / 连续同样入调研 get_recent_messages / `limit:100000`；Given ag-12，Then 响应约 **8s**（可配）——慢于普通但仍可能落在后端 10–15s 超时内（QR §1「~8s 或更久」）；Given ag-13，Then 永不返回；Given ag-14/15/16，Then audit 分别 500 / 200 但 body 非 JSON 或缺 verdict 或 verdict 为别的值 / 慢或挂（确定性时长如 6s）；Given ag-18，Then 同 runId 相同 messages 重复请求 → 返回**新响应**（恢复重发规约）
  c) 新增 tests/switches-behavior.test.ts；先红后绿记录
  d) audit 慢/挂为确定性时长；无 any
  e) VITEST 行 ag-8..16/18（落地侧）登记应勾

### T-P4-04 agentclient + 触发/单飞行/END2/SWEEP（R-B 守卫）            [status: TODO]
- goal: `agentclient/`（turn/audit 封装 + 三段式校验接口）；触发完整链：入站触发（已有入口）、run 结束事务 END2 四步（含 R-B 守卫）、调度器 SWEEP 兜底（同守卫 + 积压保留）。
- refs: DES/06-agent-module.md §2 全文（含 R-B 修订语义）、§12；DES/05-messaging-module.md §4.4；REQ A5-1；review §5.2 R-B
- owned: server/src/agentclient/**、server/src/modules/agent/trigger.ts、server/src/modules/agent/trigger-entry.ts（接管 T-P2-08 存根并扩展，串行依赖已建）、server/src/modules/agent/end-run.ts、server/src/scheduler/trigger-sweep.ts（注册行）、server/tests/agent/trigger.test.ts、server/tests/agent/trigger-queue-guard.test.ts（VITEST_PLAN §5 R-B 行的名义用例文件）
- depends: T-P2-08、T-P3-08；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/trigger.test.ts` → 全绿
  b) Given agentEnabled 群新消息且无 running run，Then INSERT run 成功并启动 executor（占位）；Given 已有 running，Then 进 trigger_queue；Given run 结束且积压非空**且** `group.status='active' AND agent_enabled=true`，Then 同一事务：旧 run 终态 + 删积压 + 新 run（triggerMessages=全部积压、按 sentAt 升序）+ ws_event×2（A5-1「立即创建下一次 run…全部放进」）；Given 守卫不过（unreachable 或开关关），Then **保留积压行不删**（R-B 定稿：重新启用后由 SWEEP 补处理）且不补建 run；Given SWEEP 发现有积压但无 running run 的群（守卫过），Then 补建 run（防结束事务外崩溃遗漏）；并发触发 → 恰一个 run（I4，部分唯一索引）
  c) 新增 tests/agent/trigger.test.ts；先红后绿记录
  d) 守卫在 END2 第 3 步与 SWEEP 两处都必须存在（缺一即违约）；无 any
  e) VITEST 行 I4、A5-1、T-05、R-B 新增回归行登记应勾；`tests/agent/trigger-queue-guard.test.ts` 即 R-B 回归的落点（END2/SWEEP 守卫 + 守卫不过时积压保留、重新启用后 SWEEP 补处理）

### T-P4-05 run executor 骨架 + turn 循环 + 三重预算            [status: TODO]
- goal: executor（拾取/租约/并发信号量）+ turn 循环（step 状态机 pending→turn_dispatched→turn_received→tool_dispatched→done，意图先行快照）+ 三重预算（12 步含结束步 / 60s 墙钟含审计停机不计 / 连续 3 次协议错误合法响应清零）+ tools 常量（恰 4 个 required 全覆盖）。
- refs: DES/06-agent-module.md §2.1、§3、§5、§6；DES/01-architecture.md §6.5；REQ A5-2；QR §1
- owned: server/src/modules/agent/executor.ts、server/src/modules/agent/budget.ts、server/src/modules/agent/tools-def.ts、server/tests/agent/turn-loop.test.ts、server/tests/agent/budget.test.ts
- depends: T-P4-04；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/turn-loop.test.ts tests/agent/budget.test.ts` → 全绿
  b) Given 步数到 **12**（含结束步），Then run `failed/budget_exhausted`（第 12 步恰 finish → `final`）；Given 墙钟 **60s**（含审计等待），Then `failed/wall_clock`；恢复后 `wall_deadline_at = now() + (60000 - wall_consumed_ms)`（停机不计，A5-2 逐字）；Given turn 超时（`AGENT_TURN_TIMEOUT_MS` 默认 12000，区间 **10–15s** 可配），Then AbortController 取消、超时后才到的响应丢弃（rowcount=0）；Given tools 常量，Then 恰 4 个工具且 required 覆盖全部入参（ag-19 反测：对 mock-agent 发探针永不触发 TOOLS_INVALID）；每步事务结构：step 先 `turn_dispatched`（带 dispatch_payload）→ 才发 HTTP（E11）；executor 拾取经 `pg_try_advisory_lock('agent-run:'+runId)` + 进程内信号量（O2）
  c) 新增两测试文件；先红后绿记录
  d) 会话历史完全由 DB 重建（appended_blocks 拼接，无内存依赖）；无 any
  e) VITEST 行 A5-2、T-01/02、ag-12/13/19（测试侧）登记应勾

### T-P4-06 三段式校验 + 协议错误两类分流            [status: TODO]
- goal: 响应校验三层（HTTP 状态 → JSON 解析含围栏/夹文 → 形状：stop_reason/块数/类型一致）+ 路径 A（UNKNOWN_TOOL/INVALID_INPUT：追加 assistant 块 + is_error tool_result，清零 streak）+ 路径 B（BAD_JSON/DUPLICATE_TOOL_USE_ID/TURN_TIMEOUT：不追加 assistant 块，追加 user text `PROTOCOL_ERROR <code>: <一句话>`，计步计 streak）。
- refs: DES/06-agent-module.md §4 全文；REQ A5-3、§2.2；VITEST_PLAN §3.2 ag-1..7
- owned: server/src/modules/agent/validation.ts、server/src/modules/agent/protocol-errors.ts、server/tests/agent/protocol-errors.test.ts
- depends: T-P4-05；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/protocol-errors.test.ts` → 全绿
  b) Given ag-1/2/3/4 任一形态，Then 路径 B：step `kind='protocol_error'`、`toolUseId/name/input=null`、rawResponse=原始体（≤**2KB**）或超时为 null、streak+1；Given 未知工具（ag-5），Then 路径 A：assistant tool_use 块照常追加 + `is_error:true` tool_result code=`UNKNOWN_TOOL`、streak 清零（合法响应）；Given 入参不合 schema（ag-6），Then `INVALID_INPUT` 同路径 A；Given 重复 tool_use.id（ag-7），Then 路径 B `DUPLICATE_TOOL_USE_ID`（UNIQUE(run_id,tool_use_id) 检测）；Given 连续 **3 次** 协议错误，Then run `failed/protocol_errors`；任何一次合法响应清零（A5-2 逐字）；两类都计步
  c) 新增 tests/agent/protocol-errors.test.ts；先红后绿记录
  d) 协议错误步的 appended_blocks 只含 user text 块（无悬挂 tool_use）；无 any
  e) VITEST 行 A5-3、T-03/04/09/10、ag-1..7（测试侧）登记应勾

### T-P4-07 审计门禁与 blocked            [status: TODO]
- goal: send_message/kick_user 执行前 `/agent/audit`（text 定义：send=待发文本；kick=`JSON.stringify({action:'kick',platform_user_id,reason})`）；verdict 恰为 `pass` 才执行；`fail` → AUDIT_REJECTED；无结论重试至多 **3 次**（单次失败不返回不计步、耗时计 60s）；3 次无结论 → run `blocked/audit_blocked` + ws_event。
- refs: DES/06-agent-module.md §8.1、§8.3、§5（墙钟交互）；REQ A5-4；解读 #8（audit 单次超时 5s）
- owned: server/src/modules/agent/audit.ts、server/tests/agent/audit.test.ts（重试/blocked 机制用例；VITEST ag-14..16 行的 blocked 分支断言位于 tools-send-message.test.ts，归 T-P4-09——文件名微调依据 VITEST_PLAN 头注，编号引用不变）
- depends: T-P4-06；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/audit.test.ts` → 全绿
  b) Given ag-14/15/16（500/坏 body/慢或挂），Then 同一次工具调用重试至多 **3 次**，单次失败不返回给 agent、不计步、不计协议错误；3 次都无结论 → run `blocked`、`endReason='audit_blocked'`、工具不执行、推事件（A5-4 逐字）；Given verdict='fail'，Then `AUDIT_REJECTED`（is_error tool_result、run 继续、key 不消耗）；Given 审计重试中途墙钟到期，Then `wall_clock` 而非 `audit_blocked`（两种交错都测，DES/06 §12 风险 2）；Given verdict 为其他值，Then 视为无结论
  c) 新增 tests/agent/audit.test.ts；先红后绿记录
  d) verdict 判定「合法 JSON 且字段精确匹配 'pass'」；单次 audit 超时 5s（constants 标注解读 #8）；无 any
  e) VITEST 行 A5-4、T-13、ag-14..16（测试侧）登记应勾

### T-P4-08 工具：get_recent_messages + finish            [status: TODO]
- goal: get_recent_messages（limit=min(limit,50) 钳制不报错、升序含触发消息与 run 期间新消息、单条 text 超 **500 字**截断置 truncated、整体 ≤**8KB** 截断）、finish（不调 turn、`finished/final`、summary=input.summary）。
- refs: DES/06-agent-module.md §7.1、§7.4；REQ §2.2 工具表、A5-9；QR §1（50/500 字/8KB/200 字行）
- owned: server/src/modules/agent/tools/query.ts、server/src/modules/agent/tools/finish.ts、server/tests/agent/tools-query.test.ts
- depends: T-P4-06；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/tools-query.test.ts` → 全绿
  b) Given `limit:100000`（ag-11），Then 按 **50** 处理不报 INVALID_INPUT（契约字面「超过按 50 处」）；Given 单条 text >**500 字**，Then 截断并置 `truncated:true`；Given content >**8KB**，Then 截断并置 `truncated:true`（A5-9）；返回 `{messages:[{msgId,senderPlatformUserId,isOwn,text,sentAt}],truncated}` 按 sentAt 升序、包含触发消息本身与 run 期间新到的消息（REQ §2.2 逐字）；`resultSummary` ≤**200 字**；Given finish，Then step `kind='final'`、run `finished/final`、summary 存储、不再调 turn；重复同样入调研用（ag-10）正常返回靠预算兜底（A5-11 解读 #7）
  c) 新增 tests/agent/tools-query.test.ts；先红后绿记录
  d) 截断在写路径保证；非正数 limit → INVALID_INPUT（schema 校验）；无 any
  e) VITEST 行 T-06/08/11、A5-9/11、ag-9/10/11（测试侧）登记应勾。偏差注记：ag-9/10/11 的断言落在本任务的 `tools-query.test.ts`（VITEST_PLAN 名义文件为 `budget.test.ts`；按 VITEST_PLAN 头部「文件名允许微调、编号引用不丢」口径执行，登记行不变）

### T-P4-09 工具：send_message + 幂等 key（A5-7/S5 核心）            [status: TODO]
- goal: send_message 全流程（幂等命中 → 不发不再审返当前状态；未消耗 → 审计 → GATE1 群状态 → 选账号（online 群成员字典序第一，无 → NO_AVAILABLE_ACCOUNT）→ T13 事务（step tool_dispatched + 幂等 key 行 + message(queued)）→ 等 accepted/sent 至多 **5s** → 各失败码）；SEND_TIMEOUT 后消息保持 unknown 由判定器收敛。
- refs: DES/06-agent-module.md §8.2 全文、§8.4；DES/10-reliability.md E13；REQ A5-5/7、§2.2 send_message 行；解读 #18
- owned: server/src/modules/agent/tools/send-message.ts、server/src/modules/agent/idempotency.ts、server/tests/agent/idempotency.test.ts、server/tests/agent/tools-send-message.test.ts
- depends: T-P4-07、T-P3-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/idempotency.test.ts tests/agent/tools-send-message.test.ts` → 全绿
  b) Given 同 run 同 idempotency_key 第二次调用（ag-8/S5），Then 查表命中：不发送、**不再审计**、返回该消息当前状态（可能已 sent）；Given AUDIT_REJECTED/POLICY_DENIED，Then key 不消耗（不落表，A5-7 逐字）；Given GROUP_UNREACHABLE（GATE1 不过），Then key 不消耗（解读 #18）；key 消耗时机 = 审计 pass 且创建出站消息**同一事务**（E13）；Given 无 online 群成员，Then `NO_AVAILABLE_ACCOUNT`（不算协议错误、计入步数，A5-5）；Given 5s 仍 unknown，Then `SEND_TIMEOUT` 且**不取消不标记失败**（判定器继续收敛）；Given 等待中账号变终态，Then 该步 `SEND_FAILED`、run 继续；failed(GROUP_UNREACHABLE) → 同名码
  c) 新增两测试文件；先红后绿记录
  d) 二次创建被 `(run_id,key)` PK 阻止；崩溃恢复按 message 现状生成 tool_result 绝不二次创建；无 any
  e) VITEST 行 A5-5/7、T-07、S-05（工具半边）、ag-8（测试侧）登记应勾

### T-P4-10 工具：kick_user（X-1 码表封闭）            [status: TODO]
- goal: kick_user 门槛顺序（autoKickEnabled → 审计 → GATE1 → 选账号 role∈{creator,admin}）+ 执行（200 / OWNER_LEFT / NO_PERMISSION 透传 / 504 → 等 2s 查成员列表 / 其他网关错 → SEND_FAILED 细节进 message）。
- refs: DES/06-agent-module.md §8.4、§8.5（X-1 封闭性）；REQ A5-6、A2 OWNER_LEFT 行；QR §3
- owned: server/src/modules/agent/tools/kick.ts、server/tests/agent/tools-kick.test.ts
- depends: T-P4-07、T-P3-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/tools-kick.test.ts` → 全绿
  b) Given autoKickEnabled=false，Then `POLICY_DENIED`（门槛 1，不执行不进协议错误，A5-6）；Given 群主已退群后 kick，Then `OWNER_LEFT` 透传；非群主且未 promote，Then `NO_PERMISSION` 透传（A2 逐字，两码均在 13 码表内）；Given kick 504（gw-24）且 2s 后目标已不在成员列表，Then `{kicked:true}`；仍在 → `SEND_FAILED` + message 带 'kick unresolved after gateway 504: target still member'（X-1：表外码一律收敛 SEND_FAILED）；Given 409 ACCOUNT_OFFLINE 等（gw-17），Then `SEND_FAILED` + message 带网关原始码（X-1）；member_left 事件随后更新成员表；kick 是效果型工具：崩溃恢复查成员列表判定不重发（E5）
  c) 新增 tests/agent/tools-kick.test.ts；先红后绿记录
  d) tool_result 的 code 只能取 13 码表（校验器断言封闭性）；无 any
  e) VITEST 行 A5-6、A2-12、G-09、X-1、gw-24/25（测试侧）登记应勾

### T-P4-11 agent run 崩溃恢复（四分支）            [status: TODO]
- goal: 恢复扫描 `agent_run WHERE status='running'`：按最后 step.status 分支（done→预算判定续轮 / turn_dispatched→快照重发同轮 / turn_received→续推进 / tool_dispatched→反查外部现状不重发）；同 runId 续传；墙钟按剩余预算重算。
- refs: DES/06-agent-module.md §9 全文、§12 规约；DES/10-reliability.md 扫描 2；REQ A5-8
- owned: server/src/modules/agent/recovery.ts、server/src/recovery/scans.ts（agent 段充实，共享串行文件）、server/tests/agent/crash-recovery.test.ts
- depends: T-P4-09、T-P4-10、T-P2-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/crash-recovery.test.ts` → 全绿（step 状态注入级；kill -9 级在 T-P7-03 扩展）
  b) Given 崩溃于 turn_dispatched，When 恢复，Then 用 dispatch_payload 快照重发同轮（同 runId）且响应按正常校验处理（ag-18 场景）；Given 崩溃于 tool_dispatched(send)，Then 查 message 现状生成 tool_result（queued→等待；sent→成功；unknown→随判定器）**绝不二次创建消息**；Given tool_dispatched(kick)，Then 查成员列表：不在 → {kicked:true}；在 → 失败 tool_result——不重放不记失败（A5-8 逐字）；Given 恢复时剩余预算 ≤0，Then 第一轮预检即 wall_clock 终结；advisory lock 抢不到 → 跳过
  c) 新增 tests/agent/crash-recovery.test.ts；先红后绿记录
  d) 会话历史由 appended_blocks 重建与崩溃前请求一致；无 any
  e) VITEST 行 I10（单测级）、A5-8、ag-18（测试侧）登记应勾

### T-P4-12 cancelled 检查点 + 孤儿租约观测（X-2/O1）            [status: TODO]
- goal: 取消检查点**只在每步循环开始前**（查 group.status/agent_enabled → cancelled）；unreachable 场景经 GATE1 以 GROUP_UNREACHABLE 错误 tool_result 收尾当前步；调度器每秒观测 `lease_until` 过期的 running run（error 日志 + inconsistency，不接管）。
- refs: DES/06-agent-module.md §10（X-2 修订）、§9.4（O1 裁剪后）、§2.1；REQ A5-10
- owned: server/src/modules/agent/cancel.ts、server/src/scheduler/orphan-run-scan.ts（注册行）、server/tests/agent/cancel.test.ts（X-2 回归用例落此文件——VITEST X-2 行原指向 turn-loop.test.ts，按 VITEST_PLAN 头注允许的路径微调，编号引用不变）
- depends: T-P4-11；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test tests/agent/cancel.test.ts` → 全绿
  b) Given send_message 步进行中关闭 agentEnabled（X-2 回归），Then 当前步含 tool_result 完整落库、run `cancelled`、会话历史无悬挂 tool_use（VITEST X-2 行）；Given 群变 unreachable，Then 当前步以 `GROUP_UNREACHABLE` 错误结果收尾、随后循环顶部 cancelled（A5-10「当前这一步结束后终止」）；Given lease 过期 running run，Then error 日志 + `inconsistency {kind:'orphan_run'}`（同一 run 只推一次），不做 terminate/接管（O1）；处置 = 重启进程触发恢复
  c) 新增 tests/agent/cancel.test.ts；先红后绿记录
  d) 不存在第二个取消检查点（效果型工具执行前的检查点已删，X-2）；无 any
  e) VITEST 行 X-2、A5-10 登记应勾

### T-P4-13 agent-runs 查询端点            [status: TODO]
- goal: `GET /api/agent-runs/:id`（run 字段 + steps[] 逐字段映射）与 `GET /api/groups/:id/agent-runs`（最近 20 条、不含 steps）。
- refs: DES/06-agent-module.md §11；REQ §2.3 两行；解读 #22
- owned: server/src/modules/agent/query.ts、server/src/http/routes/agent-runs.ts（+index 注册行）、server/tests/agent/run-query.test.ts
- depends: T-P4-05；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test tests/agent/run-query.test.ts` → 全绿
  b) Given 含协议错误步的 run，Then steps[].`kind ∈ {tool_use,final,protocol_error}`、协议错误步 `toolUseId/name/input=null`、`rawResponse` ≤**2KB**（截断在写路径保证）、`isError=true` 时 `errorCode` 必填、`resultSummary` ≤**200 字**；`endReason` 仅 `status ≠ running` 时非 null，映射 `final→finished`、`budget_exhausted|wall_clock|protocol_errors→failed`、`audit_blocked→blocked`、`cancelled→cancelled`（REQ §2.3 逐字）；列表 `ORDER BY created_at DESC LIMIT 20`
  c) 新增 tests/agent/run-query.test.ts；先红后绿记录
  d) 时间字段 ISO 8601 UTC、无值 null；无 any
  e) VITEST 行 A-13/14、A5-12 登记应勾

### T-P4-14 mock-gateway kick 开关（gw-24/25）            [status: TODO]
- goal: 落地 gw-24 `kick_slow`/`kick_504`（响应 1–5s 可钉值 / 504；504 后成员列表 **2s 内收敛**、「实际是否踢出」独立可配）、gw-25 `owner_left_on_kick`/`kick_no_permission`。
- refs: DES/14-gateway-service.md §5（#24/25 行）、§3（kick 行）；REQ §2.1 kick 行；QR §1（1–5s、2s 行）
- owned: mock-gateway/src/switches/kick.ts、mock-gateway/tests/switches-kick.test.ts
- depends: T-P3-10；lane: B
- size: S
- acceptance:
  a) `pnpm -F mock-gateway test tests/switches-kick.test.ts` → 全绿
  b) Given gw-24 钉值 3000ms，Then kick 响应恰 3000ms 后返回（区间 **1–5s**）；Given kick 504，Then 无论响应如何 **2s 后**成员列表反映可配真值（收敛独立于响应）；Given gw-25，Then kick → `409 OWNER_LEFT` / `403 NO_PERMISSION`
  c) 新增 tests/switches-kick.test.ts；先红后绿记录
  d) 「是否真踢出」与「响应」解耦可配（后端判定路径的测试根基）；无 any
  e) VITEST 行 gw-24/25（落地侧）登记应勾

### T-P4-15 集成：S5/S6 场景用例 + demo 脚本（串行汇合点）            [status: TODO]
- goal: `tests/scenarios/s5.test.ts`（gw-7 + ag-8）、`tests/scenarios/s6.test.ts`（ag-17 三连）+ 对应 demo 脚本。
- refs: REQ §2.4 S5/S6 行；DES/12-agent-service.md §7 #8/#17；VITEST_PLAN §2
- owned: server/tests/scenarios/s5.test.ts、s6.test.ts、scripts/demo/s5.ts、s6.ts
- depends: T-P4-09、T-P4-10、T-P4-11、T-P4-12、T-P4-13、T-P4-03、T-P4-14；lane: integration
- size: M
- acceptance:
  a) `pnpm -F server test tests/scenarios/s5.test.ts tests/scenarios/s6.test.ts` → 全绿；`pnpm demo:s5` / `pnpm demo:s6` → PASS 摘要
  b) S5（REQ §2.4 逐字）：网关对第一次 send 回 504、**1.5 秒后**消息落地；Agent 拿到结果后用同一 idempotency_key 再调 → **网关里恰好一条消息**（counters.sendCallsByClientMsgId=1）、第二次调用返回该消息当前状态（`sent`）、**不再调审计**（counters 断言恰一次）、run 正常结束；S6：坏 JSON → 未知工具 → 正常结束 → run 以 `final`/`budget_exhausted`/`protocol_errors` 之一结束、服务不崩、每一步都有 `kind` 和 `rawResponse`
  c) 新增两场景用例 + 脚本；先红后绿记录
  d) 断言用 mock counters 与 run steps 真值；无 any
  e) VITEST 行 S-05/06、ag-17（场景侧）登记应勾；阶段门 P4 演示记录进 JOURNAL

---

# P5 · 前端页面 1–3 + B3 前端（5 任务，lane-D）

### T-P5-01 web 骨架 + 登录页 + 401 单飞续期            [status: TODO]
- goal: Vite + React 18 + TS strict 骨架、fetch 封装（拦截 401 → 全局单飞 refresh → 重放；refresh 401 → 跳登录）、auth Context（存 access；refresh 由 HttpOnly cookie 承载，R-E 定稿）、登录页（页面 1）、路由守卫。
- refs: DES/15-web-console.md §1、§2 页面 1、§4；DES/09-auth-module.md §3.4；REQ §4 页面 1、B3 前端行
- owned: web/src/**（骨架、api/client.ts、api/auth.ts、auth/、pages/LoginPage.tsx、router.tsx）、web/tests/auth-refresh.test.tsx
- depends: T-P0-07、T-P3-08；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test` → 全绿；`pnpm -F web build` → 成功；`pnpm dev` 后浏览器可登录
  b) Given viewer 登录，Then 看不到写操作按钮（页面 1，REQ §4）；Given 登录错误，Then 按 `error.code` 显示；Given 并发两请求同时 401（第 2 层测试：刷新端点 mock），Then refresh **恰好调用一次**、两请求均重放成功（B3 前端行逐字）；Given refresh 也 401，Then 清空会话跳 `/login`；refresh 请求带 `credentials:'include'`
  c) 新增 web/tests/auth-refresh.test.tsx；先红后绿记录
  d) 不存 refresh 到 JS 可读存储（R-E）；不引 axios/Redux；无 any
  e) 无 VITEST 行；矩阵 A6/B3-4（前端半边）登记应勾

### T-P5-02 WS 客户端（seq 去重 / 退避 / sinceSeq）            [status: TODO]
- goal: `WsClient` 单例（auth 帧 → success 回执后实时模式、frame.seq ≤ lastSeq 丢弃、close 指数退避 500ms×2 封顶 5s、lastSeq 持久化 sessionStorage）+ `useWsEvent(type, handler)` + inconsistency 全局 toast 与 `ws_backlog_expired` 全量 refetch。
- refs: DES/15-web-console.md §3；DES/08-realtime-module.md §2；REQ B4
- owned: web/src/ws/WsClient.ts、web/src/ws/useWsEvent.ts、web/tests/ws-client.test.ts
- depends: T-P5-01、T-P2-10；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test tests/ws-client.test.ts` → 全绿（第 1 层：applyFrame/nextBackoff 纯函数）
  b) Given 旧帧（seq ≤ lastSeq），Then 丢弃；lastSeq 单调推进（第 1 层断言）；Given 重连，Then 退避序列 500/1000/2000/… 封顶 **5s**；Given auth 失败（token 过期），Then 走 §4 刷新后重连；补发与实时交叠不重复（seq 去重，B4「不重复」）
  c) 新增 web/tests/ws-client.test.ts；先红后绿记录
  d) 不丢 lastSeq；无 any
  e) 矩阵 B4-1（前端半边）登记应勾

### T-P5-03 账号列表页（页面 2）            [status: TODO]
- goal: 状态徽标、platformUserId、rateLimitedUntil 倒计时、connect 按钮（仅 idle/disconnected 可见）、transition 面板（expectedFrom=当前状态、to 只列合法目标、to='rate_limited' 必填 rateLimitedUntil）、viewer 隐藏写按钮。
- refs: DES/15-web-console.md §2 页面 2；DES/03-account-module.md §1/§3；REQ §4 页面 2
- owned: web/src/pages/AccountsPage.tsx、web/src/components/TransitionPanel.tsx、web/tests/accounts-page.test.tsx
- depends: T-P5-02、T-P2-05；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test tests/accounts-page.test.tsx` → 全绿（第 2 层）
  b) Given 当前状态 online，Then 面板合法目标 = idle/rate_limited(带期限)/disconnected/suspended/session_expired（与 A1 转移表同源）；非法目标不出现在 UI（ILLEGAL_TRANSITION 留给并发）；Given `to='rate_limited'` 缺 rateLimitedUntil，Then 提交禁用（D3-4）；Given viewer，Then 「标记离线」「重连」「释放账号」按钮不渲染，直接调接口也得到 `403`（页面 2 逐字）；WS `account_status_changed` 原地更新徽标
  c) 新增 web/tests/accounts-page.test.tsx；先红后绿记录
  d) 静态转移表与 server transitions.ts 语义一致（对照测试）；无 any
  e) 矩阵 A6（页面 2）登记应勾

### T-P5-04 群详情页骨架（页面 3）            [status: TODO]
- goal: 成员列表（含 role）、agentEnabled/autoKickEnabled 开关（viewer 只读）、发送表单（选账号 + text 前端校验）、agent run 区块（最近列表 + blocked 醒目横幅）、页面 3 整体数据流。
- refs: DES/15-web-console.md §2 页面 3；DES/04-group-module.md §5；REQ §4 页面 3
- owned: web/src/pages/GroupDetailPage.tsx、web/src/components/GroupMembers.tsx、web/src/components/SendForm.tsx、web/src/components/AgentRunList.tsx、web/tests/group-page.test.tsx
- depends: T-P5-03、T-P4-13；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test tests/group-page.test.tsx` → 全绿；浏览器人工清单过一遍
  b) Given blocked 的 run，Then 顶部横幅 + 区块标红（「blocked 的 run 醒目提示」，页面 3 逐字）；Given 发送表单空文本或超 2000 字，Then 前端先拦（与 `TEXT_MAX_LENGTH` 同源常量）；WS `agent_run`/`group_updated` 驱动刷新；viewer 开关只读
  c) 新增 web/tests/group-page.test.tsx；先红后绿记录
  d) 不做视觉打磨（负面清单）；无 any
  e) 矩阵 A6（页面 3）登记应勾

### T-P5-05 时间线合并与「加载更早」            [status: TODO]
- goal: 时间线组件：`items: Map<msgId ?? clientMsgId, Row>`、WS message 事件原地 patch（deliveryStatus 只前进、msgId 回填沿用同一行键）、before 游标栈、sentAt 上移不重排。
- refs: DES/15-web-console.md §5；DES/05-messaging-module.md §5.2；REQ A4、§4 页面 3
- owned: web/src/components/Timeline.tsx、web/src/timeline/merge.ts、web/tests/timeline-merge.test.ts
- depends: T-P5-04；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test tests/timeline-merge.test.ts` → 全绿（第 1 层 mergeTimelineItem）
  b) Given queued 行收到 msgId 回填，Then 沿用同一行键原地更新不插新行（后端一行原则的前端配合）；Given deliveryStatus 流转，Then 只前进不倒退（queued→accepted→sent / failed / cancelled）；Given 加载更早期间新消息到达，Then 不重复不遗漏（游标边界 + WS 正交）；自己的消息显示 `deliveryStatus` 徽标（含 failed 的 failCode）
  c) 新增 web/tests/timeline-merge.test.ts；先红后绿记录
  d) 排序以服务端查询为准，避免前端重排抖动；无 any
  e) 矩阵 A4-1（前端半边）登记应勾；阶段门 P5 人工清单记录进 JOURNAL

---

# P6 · B1 序列 + 页面 5 + B4/页面 4 —— S7/S8（8 任务）

### T-P6-01 序列定义 + 占位符解析与预检            [status: TODO]
- goal: `POST /api/sequences` 校验（name 非空、steps 非空、index 正整数唯一可不连续、accountRole ∈ {admin,member}、text 非空 ≤2000、delaySeconds ≥0）；占位符扫描 `/\{([A-Za-z0-9_]+)\}/g`（不匹配字符集按字面量，解读 #25）；vars/stepVars 合并推演（""双语义）。
- refs: DES/07-sequence-module.md §1–§2.3（推演表为测试基准）；REQ §3 B1；解读 #15/#25
- owned: server/src/modules/sequences/define.ts、server/src/modules/sequences/resolve.ts、server/src/http/routes/sequences.ts（+index 注册行）、server/tests/sequences/precheck.test.ts
- depends: T-P3-04；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/sequences/precheck.test.ts` → 全绿
  b) Given DES/07 §2.3 推演表输入（vars `{event:发布会, location:"", time:""}`、stepVars `{"2":{location:"共享盘/Q2"},"3":{location:"",event:""}}`），Then 逐步 resolved_vars/var_sources 与表逐行一致（varSources 标最初给出者：step2 后 `{event:"default", location:"step:2"}`，step3/4 沿用）；步骤 4 引用 `{time}` → 预检失败 `422`、`stepIndex=4`、`key='time'`；`vars` 的 `""` = 未提供、`stepVars` 的 `""` = 不改（B1 双语义）；不匹配字符集（`{-}`）按字面量
  c) 新增 tests/sequences/precheck.test.ts（推演表 4 步全分支）；先红后绿记录
  d) 预检是纯计算无写；定义阶段不做占位符校验；无 any
  e) VITEST 行 A-15、B1-1/4 登记应勾

### T-P6-02 启动互斥 + run/step 快照（S7/S8 事务语义）            [status: TODO]
- goal: `POST /api/groups/:id/sequence-runs`：预检 → INSERT run + 全部 step（resolved_vars/var_sources 快照）+ 第 1 步 scheduled_at=now()+delay + ws_event → `201 {runId}`；唯一索引冲突 → `409 SEQUENCE_ALREADY_RUNNING`；预检失败零 INSERT；unreachable/left 群 → `409 GROUP_UNREACHABLE`（解读 #3）。
- refs: DES/07-sequence-module.md §2.4、§7；DES/02-data-model.md §8.2；REQ §2.3、B1、S7/S8
- owned: server/src/modules/sequences/start.ts、server/src/http/routes/sequence-runs.ts（+index 注册行）、server/tests/sequences/start-mutex.test.ts
- depends: T-P6-01；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/sequences/start-mutex.test.ts` → 全绿
  b) Given 并发两次启动（S7），Then **恰好一个 201、一个 409 SEQUENCE_ALREADY_RUNNING**（部分唯一索引仲裁，多实例成立，B1 逐字）；Given 预检失败（S8），Then `422 {error:{code:'UNRESOLVED_PLACEHOLDER', message, requestId, stepIndex, key}}`、网关零消息（counters.landedMessages=0）、**零运行记录**（无 run/step 行）、之后可正常启动；Given 第 3 步首个失败，Then `stepIndex=3`、key=该占位符名（S8 逐字）；unreachable 群启动 → 409 GROUP_UNREACHABLE
  c) 新增 tests/sequences/start-mutex.test.ts（并发注入）；先红后绿记录
  d) 预检在任何 INSERT 之前；无 any
  e) VITEST 行 I4（序列半边）、A-16、B1-5/6/7 登记应勾

### T-P6-03 链式排期与步骤推进            [status: TODO]
- goal: 调度器扫描到期链头 → 选账号（admin 优先 creator/admin 且 online、member 字典序第一；候选含 rate_limited）→ 创建 message(queued, source='sequence') 或顺延或 skipped；message_sent → step sent + 下一步排期；run 终结判定。
- refs: DES/07-sequence-module.md §3 全文、§4、§6；REQ B1 排期/选账号行；解读 #19
- owned: server/src/modules/sequences/scheduler.ts、server/src/scheduler/sequence-scan.ts（注册行）、server/tests/sequences/scheduling.test.ts
- depends: T-P6-02、T-P3-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/sequences/scheduling.test.ts` → 全绿
  b) Given 第 n-1 步 `message_sent` 时刻 t，Then 第 n 步 `scheduled_at = t + delaySeconds[n]`（「发出」=收到 message_sent 的时刻，B1 逐字）；Given skipped 步，Then `sent_at = skipped_at`（跳过时刻视为发出）、下一步照样锚定、进度照常推进、有时间戳；Given 候选含 rate_limited 账号，Then 顺延（scheduled_at=max(now,rate_limited_until)）**不 skipped**；Given 无任何匹配账号，Then skipped；选账号：admin 步骤优先 role=admin 字典序第一、无 admin 取 creator；member 步骤字典序第一（同级有 online 取 online，解读 #19）；Given 任一步 failed，Then run failed、失败即停（解读）；最后一步终态无 failed → finished
  c) 新增 tests/sequences/scheduling.test.ts；先红后绿记录
  d) 同一时刻至多链头有排期（后续 scheduled_at=NULL）；step 无独立 cancelled 态（终态取消映射 skipped）；无 any
  e) VITEST 行 B1-2/3/8/9、A-17（行为）登记应勾

### T-P6-04 序列重启恢复（只重排最早过期步骤）            [status: TODO]
- goal: 恢复扫描 running 序列 run：链头判定四分支（在途消息等落定 / 未排期等前驱 / 已过期未创建 → 只重排链头 now+delay 且其后全部 scheduled_at=NULL / 未到期保持）。
- refs: DES/07-sequence-module.md §5；DES/10-reliability.md 扫描 3；REQ B1 重启行
- owned: server/src/modules/sequences/recovery.ts、server/src/recovery/scans.ts（序列段充实）、server/tests/sequences/restart-reschedule.test.ts
- depends: T-P6-03、T-P2-02；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/sequences/restart-reschedule.test.ts` → 全绿（状态注入级；kill -9 级在 T-P7-04）
  b) Given 排期中途重启且链头已过期未创建消息，Then **只重排最早一个**：链头 `scheduled_at = now() + 链头.delaySeconds`、其后所有未终态步骤 `scheduled_at = NULL`（B1「不能一次性全部发出」逐字，I11）；Given 链头消息在途，Then 不重排等落定（sent→推进 / failed→步骤 failed / cancelled→skipped）；Given 未到期，Then 保持原排期
  c) 新增 tests/sequences/restart-reschedule.test.ts；先红后绿记录
  d) now()+delay 语义 = 把过期当「重启时刻才到期」重新排队（防重启风暴）；无 any
  e) VITEST 行 I11（单测级）、B1-10 登记应勾

### T-P6-05 sequence-runs 查询端点            [status: TODO]
- goal: `GET /api/sequence-runs/:id` → `{status, currentStepIndex, steps:[{index,status,scheduledAt,sentAt,clientMsgId,resolvedVars,varSources}]}`。
- refs: DES/07-sequence-module.md §6；REQ §2.3 对应行
- owned: server/src/modules/sequences/query.ts、server/src/http/routes/sequence-run-query.ts（+index 注册行）、server/tests/sequences/run-query.test.ts
- depends: T-P6-02；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test tests/sequences/run-query.test.ts` → 全绿
  b) Given 未排期步骤，Then `scheduledAt=null`；未发出 `sentAt=null`；run `status ∈ running|finished|failed|stopped`、step `status ∈ pending|accepted|sent|skipped|failed`（REQ §2.3 枚举逐字）；`resolvedVars`=最终取值、`varSources` ∈ default|step:<index>（B1-6）
  c) 新增 tests/sequences/run-query.test.ts；先红后绿记录
  d) 时间 ISO 8601 UTC、无值 null；无 any
  e) VITEST 行 A-17 登记应勾

### T-P6-06 页面 4：Agent run 详情            [status: TODO]
- goal: `/agent-runs/:id` 页面：steps 时间线（kind/工具名/input/resultSummary/isError+errorCode/auditVerdict/rawResponse 折叠）、协议错误步 errorCode 展示、endReason 徽标、blocked/failed 醒目。
- refs: DES/15-web-console.md §2 页面 4；REQ §4 页面 4、B4-2
- owned: web/src/pages/AgentRunPage.tsx、web/src/components/StepList.tsx、web/tests/agent-run-page.test.tsx
- depends: T-P5-04、T-P4-13；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test tests/agent-run-page.test.tsx` → 全绿（第 2 层）
  b) Given 含协议错误步的 run，Then 该步显示 `errorCode`（toolUseId/name/input 为 null 的呈现）且**可查看原始响应体**（rawResponse 折叠，页面 4 逐字）；Given run 终态（WS agent_run），Then 重拉详情拿全量 steps；endReason 徽标
  c) 新增 web/tests/agent-run-page.test.tsx；先红后绿记录
  d) 2KB 截断由后端保证，前端直接渲染；无 any
  e) 矩阵 B4-2 登记应勾

### T-P6-07 页面 5：序列（定义/启动/预检弹窗/运行视图）            [status: TODO]
- goal: `/sequences` 页：定义表单（steps 编辑 + 校验同 DES/07 §1）、启动表单（选群 + vars/stepVars JSON）、预检失败 422 展示（stepIndex/key 高亮）、预检成功弹窗（复用 resolvedVars/varSources 逐步展示）、运行视图（status/scheduledAt/sentAt/currentStepIndex 跟随 WS）。
- refs: DES/15-web-console.md §2 页面 5；DES/07-sequence-module.md §1/§2/§6；REQ §4 页面 5
- owned: web/src/pages/SequencesPage.tsx、web/src/components/SequenceForm.tsx、web/src/components/PreflightModal.tsx、web/tests/sequences-page.test.tsx
- depends: T-P6-05、T-P5-04；lane: D
- size: M
- acceptance:
  a) `pnpm -F web test tests/sequences-page.test.tsx` → 全绿（第 2 层）
  b) Given 预检 422，Then `stepIndex`/`key` 定位并高亮出错的步骤行（页面 5 逐字）；Given 预检成功，Then 弹窗逐步渲染每 key 的最终取值与来源（default/step:<i>）；Given 运行中，Then 每步 status/scheduledAt/sentAt 展示、currentStepIndex 跟随 WS 推进；定义校验与后端一致（index/accountRole/text/delaySeconds）
  c) 新增 web/tests/sequences-page.test.tsx；先红后绿记录
  d) 弹窗美化属可裁剪装饰（保留 422 的 stepIndex/key 展示，裁剪预案）；无 any
  e) 矩阵 B1（页面半边）登记应勾

### T-P6-08 集成：S7/S8 场景 + B4 断线补齐验收（串行汇合点）            [status: TODO]
- goal: `tests/scenarios/s7.test.ts`（并发启动）、`tests/scenarios/s8.test.ts`（预检）+ demo 脚本 + B4 断线 3s 补齐端到端验收用例。
- refs: REQ §2.4 S7/S8、§3 B4；DES/07 §7；VITEST_PLAN §2
- owned: server/tests/scenarios/s7.test.ts、s8.test.ts、server/tests/ws/backfill-e2e.test.ts、scripts/demo/s7.ts、s8.ts
- depends: T-P6-04、T-P6-05、T-P6-06、T-P6-07、T-P5-02；lane: integration
- size: M
- acceptance:
  a) `pnpm -F server test tests/scenarios/s7.test.ts tests/scenarios/s8.test.ts tests/ws/backfill-e2e.test.ts` → 全绿；`pnpm demo:s7` / `pnpm demo:s8` → PASS 摘要
  b) S7：并发两次启动恰好一个 `201`、一个 `409`（REQ §2.4 逐字）；S8：第 3 步未解析占位符 → `422`、`error.code='UNRESOLVED_PLACEHOLDER'`、`error.stepIndex=3`、`error.key`=该占位符名、`counters.landedMessages=0`、无运行记录、之后可启动；B4：断线期间产生事件 → 重连后 **3 秒内**出现在页面（用例以 WS 客户端 + sinceSeq 断言）且不重复（QR §1「3s」行）
  c) 新增三用例 + 两脚本；先红后绿记录
  d) S8 断言以 counters 与 DB 行数双重真值；无 any
  e) VITEST 行 S-07/08、B4-1（端到端）登记应勾；阶段门 P6 演示记录进 JOURNAL

---

# P7 · 崩溃测试套件 + I 映射（5 任务）

### T-P7-01 崩溃注入基建 withCrashPoint            [status: TODO]
- goal: `tests/helpers/crash.ts`（`withCrashPoint(name, fn)`——事务提交前后/外部调用前后可注入 `process.exit(9)`）+ 子进程 server 装配（随机端口 + 独立测试库 + in-process mock 双服务）+ 崩溃后重启断言 DB/mock counters 的通用断言器。
- refs: DES/10-reliability.md §5；DES/14-gateway-service.md §7；VITEST_PLAN §0
- owned: server/tests/helpers/crash.ts、server/tests/helpers/server-process.ts、server/tests/crash/_setup.test.ts
- depends: T-P4-15；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/crash/` → 基建自检绿；子进程可起可杀可重启（端口/库互不串扰）
  b) Given 注入点触发，Then 子进程 exit code 9 且重启后 `/api/health` 恢复；每用例独立 database（模板+随机后缀）与独立 mock 实例
  c) 新增基建自检用例；先红后绿记录
  d) 崩溃点用环境变量/控制端点触发，不污染生产代码路径（生产代码只保留极薄的 hook）；无 any
  e) VITEST_PLAN §0 登记应勾

### T-P7-02 崩溃点 ①：出站一致性（I1/I2）            [status: TODO]
- goal: `tests/crash/crash-consistency.test.ts`：queued 未发（first_attempt_at 落库前/后）两窗口 kill -9 → 重启 → 对比网关消息与 DB。
- refs: DES/10-reliability.md E7、I1/I2 行；DES/05-messaging-module.md §2.3；VITEST_PLAN §4 ①
- owned: server/tests/crash/crash-consistency.test.ts
- depends: T-P7-01；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/crash/crash-consistency.test.ts` → 全绿
  b) Given 崩溃于 first_attempt_at 落库后、网关 send 前后任意点，When 重启，Then 不出现「网关发出了、DB 无记录」（I1）且同 client_msg_id 在网关至多一条消息（I2，counters 对比）；恢复路径：first_attempt_at 非空 → 转 unknown 判定 → 落定
  c) 新增用例；先红后绿记录（红 = 判定路径缺失时）
  d) 变异抽查：注释掉 first_attempt_at 守卫 → 测试必须变红；无 any
  e) VITEST 行 I1、I2（crash 半边）、崩溃① 登记应勾

### T-P7-03 崩溃点 ②③：agent run 恢复（I10）            [status: TODO]
- goal: 扩展 `tests/agent/crash-recovery.test.ts` 为 kill -9 级：turn_dispatched（HTTP 前后）、tool_dispatched（send/kick 效果未知）四窗口。
- refs: DES/06-agent-module.md §9；DES/10-reliability.md I10；VITEST_PLAN §4 ②③
- owned: server/tests/agent/crash-recovery.test.ts（扩展，共享串行文件）
- depends: T-P7-01、T-P4-11；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/agent/crash-recovery.test.ts` → 全绿
  b) Given 崩溃于 turn 已发未收，When 重启，Then 同 runId 快照重发、run 继续并正常结束（ag-18 编排）；Given 崩溃于 tool_dispatched(send)，Then 已产生效果的工具不重放、不记失败（A5-8 逐字）——网关 counters 中该 clientMsgId 恰 1 条；Given tool_dispatched(kick)，Then 查成员列表定结果；run 恢复用同一 runId（I10）
  c) 扩展用例；先红后绿记录
  d) 变异抽查：去掉「不重发」守卫 → 必须变红；无 any
  e) VITEST 行 I10（crash 半边）、崩溃②③ 登记应勾

### T-P7-04 崩溃点 ④：序列排期中（I11）            [status: TODO]
- goal: 扩展 `tests/sequences/restart-reschedule.test.ts` 为 kill -9 级：链头已排期/在途窗口崩溃 → 重启只重排最早过期步骤。
- refs: DES/07-sequence-module.md §5；DES/10-reliability.md I11；VITEST_PLAN §4 ④
- owned: server/tests/sequences/restart-reschedule.test.ts（扩展，共享串行文件）
- depends: T-P7-01、T-P6-04；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test tests/sequences/restart-reschedule.test.ts` → 全绿
  b) Given 多步序列链头排期中崩溃，When 重启，Then 只重排最早过期步骤（now+delay）、后续步骤 scheduled_at=NULL、不一次性全发（B1/I11 逐字，counters 断言重启后仅链头发出）
  c) 扩展用例；先红后绿记录
  d) 变异抽查：去掉「其后置 NULL」→ 必须变红；无 any
  e) VITEST 行 I11（crash 半边）、崩溃④ 登记应勾

### T-P7-05 I1–I14 映射核对与 VITEST_PLAN 收口            [status: TODO]
- goal: 逐条核对 I1–I14 均有具名测试且测试名引用不变量编号；VITEST_PLAN 全条目（I/S/gw/ag/崩溃/回归含 R-B 行）勾选或完成度表裁剪记录；补漏（缺哪条补哪条的归属任务或直接补测试）。
- refs: VITEST_PLAN 全文；DES/10-reliability.md §4；DES/11-verification.md 统计行
- owned: server/VITEST_PLAN.md（勾选）、docs/plan/JOURNAL.md（核对记录）、（如需补漏）server/tests/** 新增文件
- depends: T-P7-02、T-P7-03、T-P7-04；lane: A
- size: S
- acceptance:
  a) `pnpm -F server test` → 全绿；`grep -r "I[0-9]" server/tests --include='*.test.ts' -l` → I1–I14 各至少一个文件命中
  b) Given VITEST_PLAN，Then 每行要么 ☑ 要么在 README 完成度表有裁剪记录（DoD 条款）；125 条矩阵行 ↔ 任务映射抽查无漏（对照 00-SPEC §5）
  c) 补漏测试同样先红后绿；核对过程与结论进 JOURNAL
  d) 不为凑数写空洞断言（假绿红线）；无 any
  e) 本任务就是文档联动本体；阶段门 P7 记录进 JOURNAL

---

# P8 · C2 + C1 + C3 + 交付面（5 任务）

### T-P8-01 C1：媒体文件落盘与清理            [status: TODO]
- goal: 调度器扫描 `media_url IS NOT NULL AND local_file_path IS NULL` → GET mediaUrl → 写 `media/<msgId>` → 事务回填 localFilePath（404 → inconsistency media_expired）；每日清理超 `MEDIA_RETENTION_DAYS`（默认 **30 天**）且不被 running run 引用（按群保守粒度）的文件，删文件与置空同事务。联调依赖 T-P3-09 已落地的 gw-27 `media_message`/`media_expire_404` 开关。
- refs: DES/05-messaging-module.md §7；DES/02-data-model.md §5.1；REQ C1；解读 #6；QR §1（30 天行）
- owned: server/src/modules/messages/media.ts、server/src/scheduler/media-scan.ts（注册行）、server/tests/messages/media.test.ts
- depends: T-P3-09、T-P2-08；lane: A
- size: M
- acceptance:
  a) `pnpm -F server test tests/messages/media.test.ts` → 全绿
  b) Given message 带 mediaUrl（gw-27），Then 文件下载到 `media/`、路径记 localFilePath；Given `GET /media/:id` 过期 404，Then localFilePath 保持 NULL + `inconsistency {kind:'media_expired'}`；Given 文件超 **30 天**（默认可配）且该群无 running run，Then 删除且**不留下指向已删文件的记录**（同事务置空，C1 逐字）；Given 该群有 running run，Then 跳过该群全部待删文件（解读 #6）；下载失败指数退避不阻塞消费
  c) 新增 tests/messages/media.test.ts；先红后绿记录
  d) `media/` 不进 git（.gitignore 已含）；无 any
  e) VITEST 行 C1、gw-27（测试侧）登记应勾

### T-P8-02 C2：anthropic provider            [status: TODO]
- goal: `providers/anthropic.ts`：@anthropic-ai/sdk 透传 + 进出形状映射（多块取首个有效块强制恰一块、stop_reason 映射、其余映射 end_turn+text 兜底）；audit judge prompt（只输出 `{verdict,reason}` JSON，解析失败 → 500）；`.env.example` 与双实例部署说明。
- refs: DES/12-agent-service.md §4–§6；REQ C2；DES/01-architecture.md §6.5
- owned: mock-agent/src/providers/anthropic.ts、mock-agent/.env.example（更新）、mock-agent/tests/anthropic-shape.test.ts（无 key 时形状映射纯函数测试）
- depends: T-P4-03；lane: C
- size: M
- acceptance:
  a) `pnpm -F mock-agent test tests/anthropic-shape.test.ts` → 全绿；`AGENT_MODE=anthropic ANTHROPIC_API_KEY=… pnpm -F mock-agent dev` 可起（:4300）
  b) Given SDK 返回多 content 块，Then 取首个 tool_use/text、其余丢弃、响应恰一块且 stop_reason 一致（§2.2 形状）；Given audit 输出非法 JSON 或非约定值，Then `500`（落入「无结论」契约形态，后端 blocked 路径可被真实测到）；Given 后端只改 `AGENT_URL=http://localhost:4300` 重启，Then 切换生效、后端代码零改动（C2 逐字；无 key 时以形状映射测试 + 文档/录屏说明演示）
  c) 新增 tests/anthropic-shape.test.ts；先红后绿记录
  d) key 只进本地 `.env` 绝不提交；无 any
  e) 矩阵 C2、A-21（AGENT_URL 切换）登记应勾；C2 切换说明进 README（T-P8-04）

### T-P8-03 C3：Playwright 冒烟（单条，已授权）            [status: TODO]
- goal: 一条 Playwright 测试：登录 → 打开群 → 看到 agent run 的步骤；可重复运行。
- refs: REQ C3；DRIVER-PROMPT 授权声明 2；DES/15-web-console.md §6（「不写 Playwright（除非 C3 获准）」的获准例外）；DES/12 §9
- owned: web/playwright.config.ts、web/tests/e2e/smoke.spec.ts
- depends: T-P5-05、T-P4-15；lane: integration
- size: M
- acceptance:
  a) `pnpm e2e` → 1 passed（重复运行仍绿）
  b) Given 全栈环境（server+web+双 mock+PG），When 测试执行，Then 完成登录 → 进入群详情 → agent run 区块显示 steps（kind/工具名可见）（C3 逐字：登录 → 打开群 → 看到 agent run 的步骤）
  c) 新增 smoke.spec.ts；先红（无环境时失败原因正确）后绿记录
  d) 仅此一条 E2E，不扩面（全局 UI 测试策略）；无 any
  e) 矩阵 C3（❌→✅）登记应勾；DES/11 统计更新说明进 JOURNAL（矩阵本身不改，README 完成度表呈现）

### T-P8-04 README + 完成度表 + 演示终验 + AGENTS.md 终同步            [status: TODO]
- goal: README（中文为主、命令原样）：快速开始、架构一段图、S1–S8 演示方法与预期、「如何验证重启不变量」章（一条命令跑崩溃套件）、完成度三栏表（完成/部分/未做）、契约解释声明链接、C2 切换说明；根/包内 AGENTS.md 与实际命令逐条终同步；`pnpm demo:s1..s8` 全部实跑终验。
- refs: DRIVER-PROMPT §9 交付面；DES/14 §8；REQ §5；AGENTS.md §1 自要求
- owned: /README.md、/AGENTS.md（根，终同步）、server/AGENTS.md、web/AGENTS.md、mock-gateway/AGENTS.md、mock-agent/AGENTS.md、/package.json（如需脚本微调，串行所有权）
- depends: T-P8-01、T-P8-02、T-P8-03、T-P6-08、T-P7-05；lane: integration
- size: M
- acceptance:
  a) 干净环境按 README 逐条执行：`pnpm install` → `docker compose up -d` → `pnpm -F server db:migrate && pnpm -F server db:seed` → `pnpm dev` 四服务并行 → `pnpm demo:s1`…`s8` 全 PASS；每条命令实际执行并记录输出
  b) Given README 的每条命令，Then 均实际执行验证过（DoD 第一条）；完成度表覆盖全部裁剪/未做项（含 C3 状态与理由）；AGENTS.md 命令/端口/脚本名与实际一致
  c) 无新测试（文档+脚本任务）；终验输出进 JOURNAL
  d) 不虚报完成度（诚实三栏表是评分面）；不提交 media 产物/密钥
  e) 本任务是文档联动本体；VITEST 未勾项在完成度表有裁剪记录

### T-P8-05 DoD 终验清单执行            [status: TODO]
- goal: 按 DRIVER-PROMPT §9 逐项勾选终验：全仓四命令绿、抽查复审 5 个已 DONE 任务重跑验证命令 + 重读代码、git 历史检查、HANDOFF 终态。
- refs: DRIVER-PROMPT §9 全文
- owned: docs/plan/HANDOFF.md（终态）、docs/plan/JOURNAL.md（终验记录）
- depends: T-P8-04；lane: integration
- size: S
- acceptance:
  a) `pnpm lint && pnpm typecheck && pnpm build && pnpm test` → 全绿；抽 5 任务重跑各自 a) 命令 → 全绿
  b) Given 抽查任务代码重读（可读性/注释/SOLID），Then 无红线项；否则重开审查循环；HANDOFF 终态 = 「DoD 达成，待人类 push/交付」
  c) 无新测试；抽查名单与结果进 JOURNAL
  d) 任何一项不过 → 该任务重开，不得带病收尾
  e) 全部 VITEST/矩阵勾选状态终核

---

## 附：任务统计与覆盖核对

- 任务总数 **73**：P0=7 · P1=5 · P2=12 · P3=11 · P4=15 · P5=5 · P6=8 · P7=5 · P8=5。
- 泳道：lane-A=47（server 主干，严格串行链）· lane-B=9（mock-gateway：T-P1-01..05、T-P2-12、T-P3-09、T-P3-10、T-P4-14）· lane-C=4（mock-agent：T-P4-01..03、T-P8-02）· lane-D=7（web：T-P5-01..05、T-P6-06、T-P6-07）· integration=6（T-P3-11、T-P4-15、T-P6-08、T-P8-03、T-P8-04、T-P8-05）。
- 覆盖核对：design/11 矩阵 125 条与 VITEST_PLAN 全条目（I1–I14 / S1–S8 / gw-1..28 / ag-1..19 / 崩溃 4 点 / 回归 10+R-B）→ 任务映射见 `00-SPEC.md` §5（每行有归属任务）。
- 并行不相交不变量：跨泳道 owned 天然按包隔离；全局串行资源（migrations/packages/contract/根 package.json/根 AGENTS.md/VITEST_PLAN/共享串行文件）只被依赖链上的任务触碰（§0 规则 1/2/3/7）。
