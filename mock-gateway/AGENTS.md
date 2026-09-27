# AGENTS.md — mock-gateway

消息网关模拟包（根 [AGENTS.md](../AGENTS.md) 的就近覆盖，只写本包特有内容）。

- 端口 `:4100`（`PORT`）；单进程、内存状态、事件账本，**无 DB、无外部依赖**（DES/14 §6）。
- `/_test` 控制平面是后端测试 arrange 的唯一入口（scenario/clear/reset/counters/emit）。
- 契约时序数字全部照抄速查表并可固定为确定值；**故障开关是验收资产**（根 §3-8）：禁止为了让测试变绿而弱化契约行为。
- 开关语义归 `src/switches/*.ts`：`basic.ts` = gw-1/2/3（send/message_sent 钉值 + 双推）、`timing.ts` = gw-4/19（相邻乱序 + member_joined 钉值）、`backlog.ts` = gw-5/28（arm 时刻注入离线补投帧 / 外部成员进出群事件）、`outbound.ts` = gw-6..10/14..17（429 计时重置、504 两态、503 不可用窗口、403 三码、强制离线）、`terminal.ts` = gw-11/12/13（终态标志 + `account_status` 并自动移出所有群）；媒体（gw-27：`media_message` / `media_expire_404`）在 `src/media.ts`。
- `/_test/scenario` 的 arm 接线统一走 `test-plane.ts` 的 `armSwitch`（终态 → 出站 → 注入三段）：**arrange 失败一律 400 且开关不登记**（拼错目标/参数当场炸，不静默无效）；`clear` 只撤有状态标志（终态、群禁写位），已推的账本事件与已发生的成员变更不撤回。gw-10 的 503 拦截**豁免 `/_test`**（否则开关关不掉），且发生在业务处理与 counters 之前——503 的调用不算「网关收到的调用」。
- SSE 投递修饰统一走 `src/sse.ts` 的 `createFrameDelivery` seam（`(sink) => FrameDelivery`：每连接一实例，可 0..n 次、可**延后**写 sink）；投递链在 `app.ts` 串联为 **gw-4 定序 → gw-3 复制 → socket**。seam 位于水位过滤**之后**且 sink 不再过滤——否则双推的第二份与乱序后的旧帧都会被 `eventId > lastSentEventId` 丢掉；水位取已写 eventId 的单调最大值。
- 契约权威：`docs/analysis/02-gateway-contract.md` + 速查表；设计：`docs/design/14-gateway-service.md`。
