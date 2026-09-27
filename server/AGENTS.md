# AGENTS.md — server

后端包（根 [AGENTS.md](../AGENTS.md) 的就近覆盖，只写本包特有内容）。

- 测试连**真实 PostgreSQL**（`docker compose up -d` 后再跑）：`pnpm -F server test`；测试库隔离基建见 `tests/helpers/db.ts`（T-P0-04 落地，模板库 + 随机后缀）。
- 迁移 `server/migrations/*.sql` **只增不改**（T-P0-03 封闭目录）；排查用 `pnpm -F server db:migrate`（dev 启动时自动执行）。
- `pnpm -F server db:seed`：幂等预置 admin/viewer + acc-01..04（T-P0-06 落地）。
- 配置变量与默认值以 `docs/design/01-architecture.md` §6.1 为准（`.env.example` 同源）；缺失必填项拒绝启动。
- 端口 `:3000`（`PORT`）。
