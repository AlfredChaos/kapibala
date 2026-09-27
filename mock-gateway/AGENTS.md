# AGENTS.md — mock-gateway

消息网关模拟包（根 [AGENTS.md](../AGENTS.md) 的就近覆盖，只写本包特有内容）。

- 端口 `:4100`（`PORT`）；单进程、内存状态、事件账本，**无 DB、无外部依赖**（DES/14 §6）。
- `/_test` 控制平面是后端测试 arrange 的唯一入口（scenario/clear/reset/counters/emit）。
- 契约时序数字全部照抄速查表并可固定为确定值；**故障开关是验收资产**（根 §3-8）：禁止为了让测试变绿而弱化契约行为。
- 开关语义归 `src/switches/*.ts`（`basic.ts` = gw-1/2/3）；SSE 投递修饰（gw-3 双推、gw-4 乱序）统一走 `src/sse.ts` 的 `createFrameExpander` seam——每连接一实例、展开点在**水位过滤之后**（展开结果不再过水位，否则同 eventId 的第二份与乱序后的旧帧会被丢掉）。
- 契约权威：`docs/analysis/02-gateway-contract.md` + 速查表；设计：`docs/design/14-gateway-service.md`。
