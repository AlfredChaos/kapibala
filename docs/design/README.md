# 后端系统架构设计（kapibala · server 包）

> 本目录是 `server` 包的**实现前设计**：在写代码之前，把每个模块的行为、事务边界、状态机与崩溃恢复语义定死。
> 行为基准是契约：[requirement.md](../requirement.md)（最终依据）与 [analysis/10-quick-reference.md](../analysis/10-quick-reference.md)（速查）。设计中的【解读】= 契约未明说、由本设计选定并在文档中声明取舍的决策。

## 阅读顺序

**第一遍（理解骨架，约 15 分钟）：**

1. [01-architecture.md](01-architecture.md) — 进程模型、模块划分、六条设计原则（先持久化后外部效果 / 数据库承载一切唯一性 / 状态机收敛 / 时间预算 / 事件幂等不中断 / DB 驱动调度）
2. [02-data-model.md](02-data-model.md) — 全部表、约束与索引；§9 是「需求 → 数据库机制」对照表
3. [10-reliability.md](10-reliability.md) — 事务边界清单（E1–E14）、outbox 应用点、启动恢复扫描、全局不变量（I1–I14）

**第二遍（按域细读，实现各模块前读对应章）：**

4. [03-account-module.md](03-account-module.md) — 账号状态机 / CAS / 终态原子副作用 / 限流硬闸门
5. [04-group-module.md](04-group-module.md) — 建群 job / leave-all / 成员投影 / 群状态机
6. [05-messaging-module.md](05-messaging-module.md) — 出站管线与 unknown 判定 / 入站投影 / 时间线分页 / C1 媒体
7. [06-agent-module.md](06-agent-module.md) — 触发与单飞行 / turn 循环 / 协议错误分流 / 审计 / 幂等 key / 崩溃恢复（最重一章）
8. [07-sequence-module.md](07-sequence-module.md) — 预检与变量合并（含推演表）/ 链式排期 / 重启重排
9. [08-realtime-module.md](08-realtime-module.md) — SSE 消费（连续前缀游标 / 死信）与 WS 网关（seq / sinceSeq / 3 秒补齐）
10. [09-auth-module.md](09-auth-module.md) — opaque token + 轮换链 + 复用作废 / 权限矩阵
11. [12-agent-service.md](12-agent-service.md) — mock-agent 单包双 provider（scripted 剧本引擎 / anthropic C2）；故障开关 ↔ 契约行为 ↔ 后端防御分支映射表
12. [13-capacity.md](13-capacity.md) — 容量假设（业务推导的七负载轴）、逐轴确认单进程+单 PG 的理由、扩容触发器表（出现信号才动手）
13. [14-gateway-service.md](14-gateway-service.md) — mock-gateway 模拟器：内存状态 + 事件账本 + `/_test` 控制平面；28 项故障开关 ↔ 契约行为 ↔ 后端防御分支映射表（S1–S5 的驱动源）
14. [15-web-console.md](15-web-console.md) — 控制台前端：页面 × 数据流、WS 客户端（seq 去重/补齐）、401 单飞续期、keyset+WS 时间线合并、组件级测试点

**提交前自查：**

15. [11-verification.md](11-verification.md) — 需求覆盖验收矩阵（125 条，逐条标注设计位置与状态）
16. [server/VITEST_PLAN.md](../../server/VITEST_PLAN.md) — I1–I14 × S1–S8 × mock 开关 → Vitest 用例映射（写完一个勾一个）

## 文件索引

| 文件 | 一句话摘要 |
|---|---|
| [01-architecture.md](01-architecture.md) | 模块化单体 + 数据库驱动：六组件、六原则、多实例边界、横切面（配置/requestId/错误/迁移） |
| [02-data-model.md](02-data-model.md) | 19 张表的字段/索引/约束；(groupId,msgId) 与 client_msg_id 唯一、每群单飞行部分唯一索引、CAS、轮换链、游标、WS 日志 |
| [03-account-module.md](03-account-module.md) | A1 状态机全图；connect/transition 时序；终态六动作单事务；限流硬闸门在出站最外层 |
| [04-group-module.md](04-group-module.md) | 建群 job 全分支（invite 重试/超时/promote≤2）；leave-all 群主最后退；成员表事件投影 |
| [05-messaging-module.md](05-messaging-module.md) | 出站全路径（429 顺延/504→unknown 5s 判定/单次重发）；入站去重与一行合并；keyset 分页；C1 媒体 |
| [06-agent-module.md](06-agent-module.md) | run 状态机与三重预算；turn 时序；协议错误两类分流；审计 3 次门禁；幂等 key 生命周期；崩溃点分析 |
| [07-sequence-module.md](07-sequence-module.md) | 占位符预检与 vars/stepVars 推演表；链式排期（skipped=跳过时刻发出）；并发互斥；重启只重排最早一步 |
| [08-realtime-module.md](08-realtime-module.md) | SSE 游标=连续前缀（抗乱序跳号）+死信不丢；WS 事件先落库后推送、seq 单调、sinceSeq 3 秒补齐 |
| [09-auth-module.md](09-auth-module.md) | opaque token 查表（logout/作废即时生效）；refresh 轮换链与复用检测；viewer 权限矩阵 |
| [10-reliability.md](10-reliability.md) | 每个外部效果前的持久化点（E1–E14）；outbox 应用点；启动恢复六扫描；不变量 I1–I14 |
| [11-verification.md](11-verification.md) | 需求 → 设计位置 → 覆盖状态矩阵（124 ✅ / 1 ❌[C3 前端 E2E 范围外]） |
| [12-agent-service.md](12-agent-service.md) | mock-agent 单包双 provider：scripted（剧本 + 19 项故障开关，映射表）与 anthropic（C2，只改 AGENT_URL 切换）；无状态全量历史规约 |
| [13-capacity.md](13-capacity.md) | 容量从业务推导（七负载轴 + 压力点）；逐轴确认单进程+单 PG / 无 Redis·MQ / SSE 单消费者；扩容触发器表与风暴微批注记 |
| [14-gateway-service.md](14-gateway-service.md) | mock-gateway：内存状态 + append-only 事件账本（eventId 跨 reset 不复用）+ `/_test` 计数器；28 项开关映射表（S1–S5 驱动源） |
| [15-web-console.md](15-web-console.md) | 五页面 × 数据流；WS 客户端（auth/sinceSeq/seq 去重）；401 单飞续期；keyset 分页 × WS 合并；第 1/2 层测试点与人工验收清单 |

## 契约解释声明（【解读】汇总）

契约未明说或存在多种合理读法之处，本目录统一在此声明取舍——评审对分歧点有据可查（源自各章【解读】与设计审查后的增补）：

| # | 分歧点 / 契约空隙 | 本设计的选择 | 出处 |
|---|---|---|---|
| 1 | connect 前置状态未穷举 | 从严：仅 `idle/disconnected`（`rate_limited` 到期自动回 online，不提供重连） | [03](03-account-module.md) §2 |
| 2 | 群 `unreachable` 能否回转 | 不可回转（视为终态）；mock 支持恢复场景时再补边 | [04](04-group-module.md) §1 |
| 3 | `unreachable`/`left` 群启动序列 | 拒绝：`409 GROUP_UNREACHABLE`（码名自定，契约未定义） | [07](07-sequence-module.md) §2.4 |
| 4 | leave 失败的 job 错误码名 | `LEAVE_FAILED`（契约未给码名） | [04](04-group-module.md) §3.2 |
| 5 | job 查询 404 错误码名 | `JOB_NOT_FOUND`（契约未定义） | [04](04-group-module.md) §7 |
| 6 | C1 媒体保护粒度 | 按群保守：该群有 running run 即跳过该群全部待删文件 | [05](05-messaging-module.md) §7 |
| 7 | `get_recent_messages` 重复调用 | 不设防，靠 12 步/60s 预算兜底（A5-11 允许自定） | [06](06-agent-module.md) §7.1 |
| 8 | audit 单次超时 | 5s（契约无数字，必须有界） | [01](01-architecture.md) §4.4 |
| 9 | `limit>50` | 钳制为 50，不报 `INVALID_INPUT`（契约字面「超过按 50 处理」） | [06](06-agent-module.md) §4 |
| 10 | refresh 并发重放 | 视同复用：作废整会话（B3 字面语义） | [09](09-auth-module.md) |
| 11 | 首次部署 SSE 起流 | 不带 `since` 从当前时刻开始（部署前历史与我方无关） | [08](08-realtime-module.md) §1.1 |
| 12 | 「排队中的发送变为 cancelled」（终态联动） | 仅指**从未交给网关**（`first_attempt_at IS NULL`）的排队发送；在途行转 unknown 由判定器按网关真相落定（D1-2） | [03](03-account-module.md) §4 |
| 13 | kick 的 504 收敛失败 / 网关侧同步码 | tool_result 取表内 `SEND_FAILED`，网关细节进 `message`（13 码表封闭；`OWNER_LEFT`/`NO_PERMISSION` 在表内保持透传，X-1） | [06](06-agent-module.md) §8.5 |
| 14 | 手动 transition 到 `rate_limited` 的期限来源 | 必须携带 `rateLimitedUntil`（未来时刻），否则 `400`（D3-4） | [03](03-account-module.md) §3 |
| 15 | 消息 text 长度上限 | `TEXT_MAX_LENGTH = 2000` 字符（设计值，操作员/序列/agent 共用；D3-6） | [05](05-messaging-module.md) §2.1.1 |
| 16 | 群 `unreachable` 时操作员 send 受理 | 照常受理，由网关回 `GROUP_WRITE_FORBIDDEN` 落定（网关为准） | [05](05-messaging-module.md) §2.1.1 |
| 17 | 503 与 504 的区分 | 503=未达业务层，退避重试同一意图（不计重发）；504=结果未知走判定 | [05](05-messaging-module.md) §8 |
| 18 | 幂等 key 对 `GROUP_UNREACHABLE` 的消耗 | 不消耗（环境错误未受理发送，与审计拒绝同批） | [06](06-agent-module.md) §8.2 |
| 19 | 序列选账号「优先 admin」 | 同优先级内字典序；限流账号不跳过（顺延），同级有 online 则取 online | [07](07-sequence-module.md) §3.3 |
| 20 | WS 保留窗口外的 `sinceSeq` | 从现存最小 seq 回放并推 `ws_backlog_expired`，前端整页刷新 | [08](08-realtime-module.md) §2.2 |
| 21 | WS 连接期 token 过期 | 不断开（建立时验一次；实时性优先） | [08](08-realtime-module.md) §2.4 |
| 22 | agent-runs 列表长度 | 最近 20 条（分页可选） | [06](06-agent-module.md) §11 |
| 23 | token 有效期 | access 15min（契约）；refresh 7d（设计值，题目未规定） | [02](02-data-model.md) §2.3 |
| 24 | 乱序窗口内时间线短暂两行 | 已知瞬态，契约「一行」按稳态解释（D3-5） | [05](05-messaging-module.md) §4.3 |
| 25 | 不匹配字符集的花括号（序列模板） | 按字面量文本处理 | [07](07-sequence-module.md) §2.1 |
| 26 | run 结束/兜底补建 run 时群已 unreachable 或 agentEnabled 关闭 | 不补建 run；积压的 trigger_queue 行保留，agentEnabled 重新打开后由 SWEEP 补建（实现『重新启用后补处理』） | [06](06-agent-module.md) §2 |

## 设计约定（全目录通用）

- 图表：状态机 `stateDiagram-v2`、时序 `sequenceDiagram`、流程 `flowchart`、数据模型 `erDiagram`（GitHub 可渲染）。
- 所有契约数字（5s / 2s / 10s / 12 步 / 60s / 10–15s / 3 次 / 15min / ≤2 次 / 50 / 500 / 8KB / 200 / 2KB…）**逐字取自契约**，出处见 [analysis/10-quick-reference.md](../analysis/10-quick-reference.md)；代码中以命名常量集中定义。
- 时间：内部 epoch 毫秒 / `timestamptz`；对外 ISO 8601 UTC 字符串，无值 `null`。
- 每个模块文档末节固定为「设计取舍与风险」：声明放弃了什么、什么场景会痛、哪三点需要人工评审。

## 与其他目录的关系

- [docs/requirement.md](../requirement.md)：只读，最终依据；本设计与它冲突时以它为准并回改设计。
- [docs/analysis/](../analysis/README.md)：无损拆解，行为基准；本设计大量链接其条目作依据。
- `server/`（未来实现）：实现不得偏离本设计；偏离必须先改文档（先设计后代码），并把契约级结论回 [analysis/11-gotchas.md](../analysis/11-gotchas.md) 与原文核对。测试映射计划见 [server/VITEST_PLAN.md](../../server/VITEST_PLAN.md)。
