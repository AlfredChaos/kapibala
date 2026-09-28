# kapibala 控制台 UX/E2E 走查报告

- 日期：2026-09-28
- 环境：`pnpm dev` 全量起（server :3000 · web :5173 · mock-gateway :4100 · mock-agent :4200），Postgres 已迁移+seed
- 驱动方式：ego-browser（ego lite），taskSpace `kapibala-audit`（spaceId=4，profile=Default——ego-browser 未提供创建新 profile 的 API，`taskSpace(..., {profileId:'kapibala-audit'})` 报 `Profile not found`，故用专用 task space 代替）
- 测试数据：4 个服务账号（acc-01..04）、1 个 active 群（gw-1，acc-01 creator / acc-02 admin / acc-03 member）、11+ 条消息、5 个 agent run（finished ×4 / blocked ×1 / failed ×1 / running 曾观察到）、多个 sequence 与 sequence run
- 截图：同目录 `01-*.png` … `30-*.png`

## 1. 功能走查表

| # | 步骤 | 结果 | 证据 |
|---|------|------|------|
| 1 | 打开 / → 未登录重定向 /login | ✅ | 01-login.png |
| 2 | 错误密码登录 | ✅ 显示「用户名或密码错误」alert | 02-login-invalid.png |
| 3 | 正确登录 → 落 /accounts | ✅ | 03-accounts.png |
| 4 | 账号表格：4 行状态/puid/限流列 | ✅ 数据正确 | 03/20-accounts*.png |
| 5 | acc-04 置 rate_limited(90s) → 行内倒计时 | ⚠️ 倒计时本身对（"69s 后恢复"逐秒走），但**状态变化不刷新页面**（见缺陷 D1） | 20-accounts-rate-limited.png |
| 6 | REST 转移 acc-03→disconnected，页面开着等 30s+ | ❌ 行仍显示 online；WS 帧确已到达（sessionStorage lastSeq 推进、singleton authed=true）但 UI 不变（D1） | 实测+psql |
| 7 | F5 后再次 REST 转移 acc-02/acc-04/acc-01 | ❌ 同样不更新，×3 复现 | 实测 |
| 8 | 点「重连」acc-01 | ✅ 行变 online；期间按钮 disabled（无 spinner） | 21-accounts-reconnect.png |
| 9 | 「调整状态…」弹窗 | ✅ dialog 正常，列出全部目标态（含 idle 回退） | 04-transition-dialog.png |
| 10 | 群详情页（只能手输 URL 到达） | ✅ 状态/成员/时间线/run 列表齐全 | 05-group-detail.png |
| 11 | UI 发送消息 | ✅ 「已受理：cm-…」反馈 + queued→sent 徽标演进 | 06/23-send-accepted.png |
| 12 | 断线账号发送 | ✅ 409 → 「ACCOUNT_UNAVAILABLE：account acc-03 is disconnected」行内 alert | 22-send-409-error.png |
| 13 | WS 实时性：emit 外部消息 | ✅ 时间线无刷新出现新行 + agent 回复行 | 07-group-ws-live.png |
| 14 | 超长无空格文本 | ✅ 正常换行不横向溢出 | 05-group-detail.png |
| 15 | blocked run → 群页横幅 | ✅ 「⚠ 1 个 agent run 被审计拦截」+ run 行标红 | 09-group-with-blocked-banner.png |
| 16 | agent run 详情（finished/failed/blocked/running） | ✅ steps、rawResponse `<details>` 可展开、errorCode/audit verdict 齐全；blocked/failed 有红色警示条 | 08/10/11/25/26/27-*.png |
| 17 | 序列：定义（含占位符） | ✅ 201，列表登记 | 13-seq-defined.png |
| 18 | 422 预检（缺 vars） | ✅ 出错步骤行红框 + banner「步骤 1 的占位符 {name} 未解析」+ alert | 14-seq-422-precheck.png |
| 19 | 预检通过 → PreflightModal | ✅ 每步 resolvedVars/来源表格 + 运行视图出现 | 15-seq-preflight-modal.png |
| 20 | run 视图 WS 推进 | ❌ run 早已 finished（REST 证实），UI 卡 `running`/`pending` 30s+，×2 复现（D2） | 18-seq-run-loaded.png、实测 |
| 21 | F5 /sequences | ❌ 已定义序列全部消失（本会话内存列表，后端无 GET /api/sequences）（D3） | 17-seq-after-reload.png |
| 22 | F5 /accounts 后会话保持 | ✅ refresh 静默续期，仍登录 | 实测 |
| 23 | 不存在群 URL | ⚠️ 显示 GROUP_NOT_FOUND alert，但下方永远转「加载中…」（D7） | 24-group-not-found.png |
| 24 | 404 路由 /nonexistent | ⚠️ 静默重定向 /accounts，无 404 提示（D8） | 19-404-redirect.png |
| 25 | viewer 角色登录 | ✅ 操作列/写按钮不渲染、群页无发送表单、开关 disabled | 28/29-viewer-*.png |
| 26 | 建群 / 踢人 / leave-all / 登出 | ❌ UI 无入口（REST 有对应端点）（D4/D5） | 全页 snapshot |
| 27 | 「返回群列表」链接（/sequences 页） | ❌ 路由表无 /groups → 跳回 /accounts，死链接（D6） | router.tsx + 实测 |
| 28 | autoKickEnabled 开关点击 | ⚠️ 点击后 UI 与服务端均未变化，无任何反馈，疑似静默失败（未复测确认） | 实测 |

## 2. 视角一：运营人员（核心交互逻辑）

运营的核心动作与结论：

- **看账号健康**：能看到状态/限流倒计时，✅；但页面常驻时**状态变化靠不住**（D1）——运维盯着页面会错过账号掉线/被限流，这是监控台最不能犯的错。
- **看群里正在发生什么**：✅ 时间线 WS 实时更新验证通过（外部消息+agent 回复无刷新出现），own 消息 queued→accepted→sent 徽标演进清晰。
- **发消息**：✅ 受理回执、409/422 错误码透出、字数计数、前端校验都在。但「已受理：cm-xxx」里的 UUID 对运营无意义，且受理提示不自动消失会堆积语义噪音。
- **查 agent run**：✅ 详情页质量最高——逐步骤、rawResponse、audit verdict、错误码都在。⚠️ 但 running 中的 run 中途不增量刷新（代码注释写明只终态重拉），运营要等终态才能看到步进展；`isError SEND_TIMEOUT` + `audit:pass` + run finished 的组合语义令人困惑（实际回复已送达，看起来像失败）。
- **跑序列**：⚠️ 422 预检高亮做得好，但两个硬伤：F5 后定义丢失（D3）+ run 视图不推进（D2），运营会认为「跑挂了」。
- **建群/退群**：❌ 控制台里**完全没有入口**，必须 curl REST。对笔试演示来说这是「演示不了建群」级别的问题（D4）。
- **登出**：❌ 无入口（D5）。
- **导航**：❌ 无全局导航栏，群详情只能手输 URL（D6）。

## 3. 视角二：产品经理（信息架构）

- **导航缺失是结构性问题**：路由表只有 `/accounts`、`/groups/:id`、`/agent-runs/:id`、`/sequences`，彼此间只有「← 返回」单行链接，且 `/groups` 列表页不存在——`/sequences` 的「返回群列表」指到一个没有页面的路由。信息架构上「群」是核心实体却没有入口列表页。
- **状态语义可辨但靠文本**：`finished/failed/blocked/running`、`audit_blocked/protocol_errors` 等英文契约词直接铺在 UI，专业用户可读；blocked 有横幅+红行，failed 只有详情页红条、列表页不标红——**同级严重度待遇不一致**。
- **account 状态行有歧义**：`rate_limited` 有倒计时是好设计；但「释放账号」（→suspended 终态）无确认弹窗、不可逆操作一键完成。
- **序列域数据模型与 UI 错位**：后端无 GET /api/sequences，前端用内存列表伪装「已定义序列」——PM 视角这是**契约缺口被 UI 掩盖**，刷新即穿帮。
- **死端**：run 详情拉取失败时「← 返回群详情」指向 `/groups/`（空 id）；`loadRun` 失败被 `catch{}` 静默吞掉，输错 runId 无反馈。

## 4. 视角三：UI/UX（视觉与规范）

- **整体**：纯内联样式 + 浏览器默认控件（system-ui/sans-serif、原生 `<dialog>`/`<details>`/表格）。符合「笔试答卷最小化」基调，但不是「现代控制台」：无导航壳、无卡片化层级、无 hover/disabled 视觉态（仅原生 disabled 灰）。
- **颜色系统**：语义色只有 `#c00/#b00/crimson/#070` 四档硬编码。blocked 横幅是大面积纯红底白字（对比度约 4.0:1，大文本勉强过 AA），视觉上很「报警」但没有分级（warn/error 同红色）。
- **排版**：登录页 label/input 同行挤排，输入框无宽度约束（02-login-invalid.png 可见密码框换行错位感）；标题用裸 `<h1>/<h3>`，间距靠 margin 默认值。
- **截断/溢出**：长消息换行正常 ✅；UUID 全长铺出（run 列表、群标题）占行宽、无 copy 按钮。
- **时间戳**：裸 ISO 8601 UTC 字符串（`2026-09-28T02:47:57.231Z`），占空间且不友好——至少应裁掉毫秒+T。
- **反馈覆盖**：有 role=alert 错误文案、按钮 busy disabled、「加载中…」，但**无 toast 体系**——`inconsistency`/`ws_backlog_expired` 这类全局告警在 UI 层没有消费者（死代码，`onBacklogExpired` 无人订阅），WS 断线状态完全不可见。
- **组件状态**：checkbox 点击无反馈迹象（autoKick 点击疑似无响应）；「释放账号」无二次确认；序列保存成功后表单不回显已保存内容。

## 5. 缺陷清单

| 级别 | 位置 | 症状 | 期望 | 证据 |
|---|---|---|---|---|
| blocker | 全局 | 无导航栏；群列表页不存在；建群/退群/登出 UI 入口缺失 | 控制台起码能「找到群、建群、登出」 | 各页 snapshot、router.tsx |
| major | /accounts | 页面常驻时 `account_status_changed` 帧到达（lastSeq 推进、socket authed）但行不更新，×3 复现；疑似 `useWsEvent` 在 `initWsClient` 之前订阅的挂载序竞态（页面 effect 早于 AuthProvider effect 执行，singleton=null → subscribe 空转） | 行随 WS 原地更新 | 实测 + sessionStorage lastSeq + getWsClient() 注入验证 |
| major | /sequences 运行视图 | run 已 finished，UI 停 `running`/`pending` 30s+，×2 复现（同 D2 订阅死区嫌疑） | sequence_run 帧推进 status/currentStepIndex | 18-seq-run-loaded.png + REST 对照 |
| major | /sequences | 已定义序列 F5 后全丢（本地内存态，后端无列表接口） | 序列列表持久化可查 | 17-seq-after-reload.png |
| major | 全局 | `inconsistency`/`ws_backlog_expired` 无任何 UI 订阅者——WS 断线/积压过期时用户无感知 | 全局 toast + 兜底 refetch | WsClient.ts:156 死代码 |
| minor | /groups/:id 不存在 | GROUP_NOT_FOUND alert 下仍显示「加载中…」 | 明确「群不存在」态 | 24-group-not-found.png |
| minor | /agent-runs/:id | 详情加载失败时返回链接指向空 groupId；running 中不增量刷新 steps | 返回链接容错 + 步级实时 | AgentRunPage.tsx:36-54 |
| minor | /sequences | `loadRun` catch{} 静默——输错 runId 无任何反馈 | 错误提示 | SequencesPage.tsx:59 |
| minor | /accounts | 「释放账号」(suspended 终态) 无确认 | confirm dialog | 03-accounts.png |
| minor | 群详情 autoKick 开关 | 点击疑似无响应（UI+服务端均未变，无反馈） | 切换生效或报错 | 实测一次 |
| nit | 全局 | 404 静默跳 /accounts；时间戳裸 ISO；UUID 全长铺出；成员加入事件不进时间线 | 404 页/友好时间/截断+复制 | 19-404-redirect.png |
| nit | 视觉 | 纯内联样式、原生控件、登录表单挤行 | 最小一致性打磨 | 01/02-login*.png |

## 6. 结论

**Ship 判定（对笔试评审者）：部分可演示，不建议原样交付。**

功能纵深（agent run 步级取证、422 预检定位、乐观时间线、viewer 只读门、refresh 续期）做得扎实，是这个仓库的亮点；但**控制台作为「运营操作台」的基本盘有两个洞**：找不到群（无列表/无导航/无建群入口）和看不见状态变化（账号页 WS 更新失灵、序列视图不推进）。评审者 F5 一次 /sequences 就会撞上「序列全没了」，点一次 /accounts 等不到状态翻转——这些恰好是会被试出来的路径。

**Top-3 最高价值修复**：

1. **补全局导航 + 群列表页**（含建群入口、登出）：一行 nav + `/groups` 路由即可，收益是「控制台可用」与「演示死路消失」。
2. **修 WS 订阅挂载序竞态**：`useWsEvent` 应等待/重试 singleton（或在 `initWsClient` 完成后统一补订），否则首屏页面 WS 更新整体失灵——这同时修掉账号行不更新和序列视图卡 running 两个 major。
3. **序列列表持久化**：加 `GET /api/sequences` 并把「已定义序列」改为服务端数据源——否则 F5 丢定义的穿帮点必然被踩中。
