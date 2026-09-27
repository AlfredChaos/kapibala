# AGENTS.md — web

控制台前端包（根 [AGENTS.md](../AGENTS.md) 的就近覆盖，只写本包特有内容）。

- dev 端口 `:5173`；`/api`、`/ws` 由 vite 代理到 server `:3000`（`vite.config.ts`），前端代码一律同源相对路径。
- 只写单元（纯函数）与组件/集成层测试（根 §4）；Playwright 仅 C3 授权场景（T-P8-03）。
- 页面/路由/数据层设计见 `docs/design/15-web-console.md`；API 形状以 `@kapibala/contract` 与 `docs/analysis/04-api-spec.md` 为准。
