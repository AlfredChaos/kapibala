# scripts/ — 根脚本预注册说明（T-P0-01，SP-5）

根 `package.json` 在 T-P0-01 **一次性预注册**全部脚本入口（指向本目录约定路径），
后续任务只创建脚本文件、不再改根 `package.json`（避免并行任务抢写；SP-5）。

## demo 脚本（S1–S8 场景编排）

| 脚本 | 目标文件 | 落地任务 |
|---|---|---|
| `pnpm demo:s1` … `demo:s4` | `scripts/demo/s1.ts` … `s4.ts` | T-P3-11 |
| `pnpm demo:s5` / `demo:s6` | `scripts/demo/s5.ts` / `s6.ts` | T-P4-15 |
| `pnpm demo:s7` / `demo:s8` | `scripts/demo/s7.ts` / `s8.ts` | T-P6-08 |

**当前状态**：脚本文件尚未创建。现在运行 `pnpm demo:s1` 会得到 tsx 的
`ERR_MODULE_NOT_FOUND`（报错中带完整缺失路径 `scripts/demo/s1.ts`）——
这是有意的诚实行为：占位实现（假 PASS / 假摘要）比清晰的「文件不存在」更有害。

## e2e

`pnpm e2e` → `pnpm -F web exec playwright test`；Playwright 配置与用例归 T-P8-03（C3 已授权的单条冒烟）。
落地前运行会报 `command not found: playwright`。

## db 脚本

`pnpm -F server db:migrate` / `db:seed` 的入口在 `server/package.json`
（目标 `src/db/migrate.ts` / `src/db/seed.ts`），实现分别归 T-P0-04 / T-P0-06。
