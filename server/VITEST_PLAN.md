# server · Vitest 用例映射计划（G4）

> 依据：[docs/design/10-reliability.md](../docs/design/10-reliability.md) §4–§5（I1–I14 与崩溃注入）、[docs/analysis/09-scenarios.md](../docs/analysis/09-scenarios.md)（S1–S8）、[docs/design/14-gateway-service.md](../docs/design/14-gateway-service.md) §5（网关开关 1–28）、[docs/design/12-agent-service.md](../docs/design/12-agent-service.md) §7（agent 开关 1–19）。
> 用法：**写完一个用例勾一个**（`☐` → `☑`）；用例名直接引用不变量/场景/开关编号（评审 5 分钟能对上号）。测试连真实 PostgreSQL、外部服务用 mock 进程内装配（AGENTS.md §4）。
> 本文是计划文件：文件名是约定，落地时允许微调路径，但**编号引用关系不许丢**。

## 0. 崩溃注入基建（P7 前置）

`tests/helpers/crash.ts`：`withCrashPoint(name, fn)`——在事务提交前后、外部调用前后可注入 `process.exit(9)`；测试以子进程起 server、杀进程、重启后断言 DB 状态与 mock counters。

## 1. 不变量 I1–I14 → 用例

| # | 不变量（简述） | 用例文件 | 状态 |
|---|---|---|---|
| I1 | 网关已发出的每条我方消息 DB 必有记录 | `tests/crash/crash-consistency.test.ts`（崩溃点 ①） | ☐ |
| I2 | 一条出站记录至多一条网关消息（重发 ≤1 且先确认未发出） | `tests/messages/unknown-adjudicator.test.ts`（开关 gw-7/8）+ crash ① | ☐ |
| I3 | 时间线无重复行；(groupId,msgId) 唯一；回流合并一行 | `tests/messages/finalize-sent.test.ts`（含乱序合并稳态断言，D1-3/D3-5） | ☐ |
| I4 | 每群至多一个 running agent run / 序列 run | `tests/agent/trigger.test.ts`、`tests/sequences/start-mutex.test.ts`（S7） | ☐ |
| I5 | 账号只沿转移表变化；终态无出边；CAS 后写不覆盖 | `tests/accounts/state-machine.test.ts`（并发 CAS 注入） | ☐ |
| I6 | 终态副作用原子（全有或全无；含在途转 unknown，D1-2） | `tests/accounts/terminal-side-effects.test.ts`（事务中途回滚注入 + 在途竞态） | ☐ |
| I7 | WS 事件对应已持久化状态（同事务） | `tests/ws/hub.test.ts`（崩溃后重放无「先事件后状态」） | ☐ |
| I8 | 游标只推进连续前缀；停机事件恢复后全部处理 | `tests/events/cursor-prefix.test.ts` + `tests/events/resume.test.ts` | ☐ |
| I9 | unknown 5s 落定；by-client-id 不可用期间保持、恢复后 2s 内定 | `tests/messages/unknown-adjudicator.test.ts`（开关 gw-9） | ☐ |
| I10 | agent run 恢复同 runId；已产生效果的工具不重放不记失败 | `tests/agent/crash-recovery.test.ts`（四个崩溃点 ×2/③） | ☐ |
| I11 | 序列重启只重排最早过期步骤 | `tests/sequences/restart-reschedule.test.ts`（崩溃点 ④） | ☐ |
| I12 | WS seq 单调；sinceSeq 补发不重复；断线 3s 补齐 | `tests/ws/sinceseq.test.ts` | ☐ |
| I13 | refresh 复用整会话作废；logout 后 access 即失效 | `tests/auth/session.test.ts` | ☐ |
| I14 | 契约时序数字不取整 | 常量集中定义 + `tests/constants.test.ts`（对照速查表逐个断言值） | ☐ |

## 2. 场景 S1–S8 → 编排与用例

| # | 编排（开关组合） | 断言要点 | 用例文件 | 状态 |
|---|---|---|---|---|
| S1 | gw-1 + gw-2（钉值） | accepted→sent 流转、恰好一行 | `tests/scenarios/s1.test.ts` | ☐ |
| S2 | gw-3（双推） | 时间线无重复、agent 不二触发 | `tests/scenarios/s2.test.ts` | ☐ |
| S3 | 默认行为（回流） | isOwn=true 合并一行、不触发 run | `tests/scenarios/s3.test.ts` | ☐ |
| S4 | gw-6 | rateLimitedUntil 正确；**counters.sendCallsByAccount=0**；到期按序发出 | `tests/scenarios/s4.test.ts` | ☐ |
| S5 | gw-7 + agent-8 | 网关消息数=1；第二次调用返 sent；审计恰一次；run finished | `tests/scenarios/s5.test.ts` | ☐ |
| S6 | agent-17（三连剧本） | run 终态合法、steps kind/rawResponse 齐全、进程不崩 | `tests/scenarios/s6.test.ts` | ☐ |
| S7 | 并发两 POST | 恰好 201/409 | `tests/scenarios/s7.test.ts` | ☐ |
| S8 | 构造第 3 步未解析占位符 | 422 字段齐全；counters.landedMessages=0；无运行记录 | `tests/scenarios/s8.test.ts` | ☐ |

## 3. mock 开关 → 代表用例

### 3.1 mock-gateway（[design/14](../docs/design/14-gateway-service.md) §5，#1–28）

| 开关 | 用例文件 | 开关 | 用例文件 |
|---|---|---|---|
| gw-1/2 send 延迟 | `tests/scenarios/s1.test.ts` | gw-15 message_failed | `tests/messages/outbound-dispatcher.test.ts` |
| gw-3 双推 | `tests/scenarios/s2.test.ts` | gw-16 sender_not_in_group | `tests/messages/outbound-dispatcher.test.ts` |
| gw-4 乱序 ≤1s | `tests/messages/finalize-sent.test.ts` | gw-17 account_offline_409 | `tests/messages/outbound-dispatcher.test.ts` |
| gw-5 离线补投 | `tests/messages/timeline-pagination.test.ts` | gw-18 joined_never | `tests/groups/create-group-job.test.ts` |
| gw-6 限流 | `tests/scenarios/s4.test.ts` | gw-19 joined_delay | `tests/groups/member-projection.test.ts` |
| gw-7 504+1.5s 落地 | `tests/scenarios/s5.test.ts` | gw-20 invite_not_ready | `tests/groups/create-group-job.test.ts` |
| gw-8 504 未发出 | `tests/messages/unknown-adjudicator.test.ts` | gw-21 invite_expired | `tests/groups/create-group-job.test.ts` |
| gw-9 by-client-id 503 | `tests/messages/unknown-adjudicator.test.ts` | gw-22 already_member | `tests/groups/create-group-job.test.ts`（D2-2 回归） |
| gw-10 全局 503 | `tests/messages/outbound-dispatcher.test.ts` | gw-23 promote_not_member_yet | `tests/groups/create-group-job.test.ts` |
| gw-11/12/13 终态 | `tests/accounts/terminal-side-effects.test.ts` | gw-24 kick_slow/504 | `tests/agent/tools-kick.test.ts` |
| gw-14 group_write_forbidden | `tests/groups/group-state.test.ts` | gw-25 kick 同名码 | `tests/agent/tools-kick.test.ts`（X-1 回归） |
|  |  | gw-26 leave_500 | `tests/groups/leave-all.test.ts` |
|  |  | gw-27/28 媒体/外部成员 | `tests/messages/media.test.ts` / `tests/groups/member-projection.test.ts` |

### 3.2 mock-agent（[design/12](../docs/design/12-agent-service.md) §7，#1–19）

| 开关 | 用例文件 | 开关 | 用例文件 |
|---|---|---|---|
| ag-1–4 坏 JSON/形状 | `tests/agent/protocol-errors.test.ts` | ag-12/13 慢/挂 turn | `tests/agent/turn-loop.test.ts` |
| ag-5/6 未知工具/入参 | `tests/agent/protocol-errors.test.ts` | ag-14–16 audit 故障 | `tests/agent/tools-send-message.test.ts`（blocked 分支） |
| ag-7 重复 tool_use.id | `tests/agent/protocol-errors.test.ts` | ag-17 S6 三连 | `tests/scenarios/s6.test.ts` |
| ag-8 同 key 重试 | `tests/agent/idempotency.test.ts` | ag-18 同 runId 重发 | `tests/agent/crash-recovery.test.ts` |
| ag-9/10/11 无限工具/重复查询/超大 limit | `tests/agent/budget.test.ts` | ag-19 tools_invalid | `tests/agent/turn-loop.test.ts`（常量反测） |

## 4. 崩溃注入用例（design/10 §5 的四个契约点）

| 崩溃点 | 注入位置 | 用例 | 状态 |
|---|---|---|---|
| ① queued 未发（first_attempt_at 落库前/后） | dispatcher 事务边界 | `tests/crash/crash-consistency.test.ts` | ☐ |
| ② turn 已发未收（turn_dispatched） | turn HTTP 前后 | `tests/agent/crash-recovery.test.ts` | ☐ |
| ③ tool_dispatched（send/kick 效果未知） | 工具执行前后 | `tests/agent/crash-recovery.test.ts` | ☐ |
| ④ 序列排期中（链头已排期/在途） | 排期事务边界 | `tests/sequences/restart-reschedule.test.ts` | ☐ |

## 5. 设计审查修复项的回归用例（review/01 §2）

| 修复项 | 回归断言 | 用例 | 状态 |
|---|---|---|---|
| D1-1 死信三写同事务 | 制造永久性业务写失败（孤儿群 FK）→ 死信事务成功、消费循环推进、账本有行 | `tests/events/dead-letter.test.ts` | ☐ |
| D1-2 终态 × 在途发送 | send 在途时注入终态事件 → 行转 unknown 而非 cancelled；202 回写落 accepted；回流不产生第二行 | `tests/accounts/terminal-side-effects.test.ts` | ☐ |
| D1-3 finalizeSent 合并 | 乱序窗口 message→message_sent / by-client-id 200 补投两路径 → 稳态恰一行、序列步骤联动 | `tests/messages/finalize-sent.test.ts` | ☐ |
| D2-1 成员事件乱序 | left(E2) 先到 joined(E1) 后到 → 终态账号不复活；joined 在途终态 → 墓碑行 | `tests/groups/member-projection.test.ts` | ☐ |
| D2-2 ALREADY_MEMBER | gw-22 → 成员行 UPSERT、promote 后 role=admin、GET members 含该账号 | `tests/groups/create-group-job.test.ts` | ☐ |
| D2-5 限流登记守卫 | 429 与 disconnected 竞态 → rate_limited_until 恒 NULL（非 rate_limited 态） | `tests/accounts/rate-limit.test.ts` | ☐ |
| X-1 kick 码表 | gw-24(504 仍在)/gw-17 → tool_result.code ∈ 13 码表（SEND_FAILED），细节在 message | `tests/agent/tools-kick.test.ts` | ☐ |
| X-2 取消检查点 | send_message 步中关闭 agentEnabled → 当前步含 tool_result 完整落库、run cancelled、无悬挂 tool_use | `tests/agent/turn-loop.test.ts` | ☐ |
| D3-1 孤儿事件 | 未知群 message 事件 → 账本+inconsistency、不进死信 | `tests/events/dead-letter.test.ts` | ☐ |
| D3-4 手动限流入参 | transition to=rate_limited 缺 rateLimitedUntil → 400 | `tests/accounts/transition.test.ts` | ☐ |

## 6. 进度总览

- [ ] I1–I14（14 条）
- [ ] S1–S8（8 条）
- [ ] gw-1–28（28 项开关各有代表用例）
- [ ] ag-1–19（19 项开关各有代表用例）
- [ ] 崩溃注入 4 点
- [ ] 审查回归 10 项
