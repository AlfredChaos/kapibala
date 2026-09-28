# 11 · 需求覆盖验收矩阵

> 逐条对照 [requirement.md](../requirement.md)。覆盖状态：✅ 完整 / ⚠️ 部分 / ❌ 未覆盖。
> 「设计位置」指向本目录文档章节；所有契约数字与错误码以 [analysis/10-quick-reference.md](../analysis/10-quick-reference.md) 为核对基准。

## A. §2.3 端点表（含字段约定）

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| A-01 | `POST /api/auth/login` → `{accessToken}`；预置 admin/viewer；access 15min | [09](09-auth-module.md) §2 | ✅ | 密码 bcrypt；15 分钟硬编码契约值 |
| A-02 | `GET /api/health` → `{ok, schemaVersion}` | [01](01-architecture.md) §6.4 | ✅ | schemaVersion=迁移账本最新版本 |
| A-03 | `GET /api/accounts` → `[{id,status,platformUserId,rateLimitedUntil}]` | [03](03-account-module.md) §6 | ✅ | |
| A-04 | `POST /api/accounts/:id/connect` → 调网关、存 platformUserId、idle/disconnected→online | [03](03-account-module.md) §2 | ✅ | 网关幂等 → 先调外部后落库，崩溃无害 |
| A-05 | `POST /api/accounts/:id/transition` → 400/404/409 ILLEGAL_TRANSITION/409 CAS_CONFLICT；expectedFrom 必填；标 disconnected/idle 调网关 disconnect | [03](03-account-module.md) §3 | ✅ | 三段式判定顺序与契约一致 |
| A-06 | `POST /api/groups` → 202 {jobId}/422 ACCOUNT_NOT_ONLINE/400 VALIDATION_ERROR；全员 online；memberAccountIds ≥1 不含群主；默认 agentEnabled/autoKickEnabled=false | [04](04-group-module.md) §2.1 | ✅ | |
| A-07 | `GET /api/groups(/:id)` → 全字段；status 三态；left 后 members=[]；role 分配；activeAgentRunId/activeSequenceRunId 仅 running 时非空 | [04](04-group-module.md) §5 | ✅ | 部分唯一索引保证 active* 至多一行 |
| A-08 | `PATCH /api/groups/:id` → 200 | [04](04-group-module.md) §5 | ✅ | 关 agentEnabled → run 当前步后 cancelled（[06](06-agent-module.md) §10） |
| A-09 | `POST /api/groups/:id/send` → 202 {clientMsgId}/409 ACCOUNT_NOT_IN_GROUP/409 ACCOUNT_UNAVAILABLE；rate_limited 照常受理保持 queued | [05](05-messaging-module.md) §2.1.1、§6 | ✅ | |
| A-10 | `POST /api/groups/:id/leave-all` → 202 {jobId} | [04](04-group-module.md) §3 | ✅ | |
| A-11 | `GET /api/jobs/:jobId` → {status, errors[{step,code}]}；errors 非空即 failed；step 枚举 | [04](04-group-module.md) §7、[02](02-data-model.md) §6.1 | ✅ | JOB_NOT_FOUND 码为设计值（契约未定义） |
| A-12 | `GET /api/groups/:id/messages` → 字段；sentAt 倒序；own 消息 queued 起在列表、sentAt 先受理后网关、一行；deliveryStatus 枚举；failed/cancelled 时 failCode 必填 | [05](05-messaging-module.md) §4、§5 | ✅ | 一行原则 + 乱序合并路径 §4.3 |
| A-13 | `GET /api/agent-runs/:id` → status/endReason 映射；kind 三值；协议错误步 toolUseId/name/input=null；rawResponse 2KB；isError→errorCode；resultSummary 200 字 | [06](06-agent-module.md) §11、[02](02-data-model.md) §7.2 | ✅ | 截断在写路径保证 |
| A-14 | `GET /api/groups/:id/agent-runs` → 最近运行列表（可不含 steps） | [06](06-agent-module.md) §11 | ✅ | |
| A-15 | `POST /api/sequences` → {id}（B1 格式） | [07](07-sequence-module.md) §1 | ✅ | |
| A-16 | `POST /api/groups/:id/sequence-runs` → 201/409 SEQUENCE_ALREADY_RUNNING/422 UNRESOLVED_PLACEHOLDER{stepIndex,key} | [07](07-sequence-module.md) §2.4、§7 | ✅ | |
| A-17 | `GET /api/sequence-runs/:id` → run/step 状态枚举、每步字段（scheduledAt/sentAt/clientMsgId/resolvedVars/varSources） | [07](07-sequence-module.md) §6 | ✅ | |
| A-18 | `WS /ws`：auth 帧先行、success 回执后才推事件、`{seq,type,payload}`、seq 全局单调、sinceSeq 补发 | [08](08-realtime-module.md) §2.1 | ✅ | |
| A-19 | WS 六类事件 payload | [08](08-realtime-module.md) §2.3 | ✅ | message 事件增补 deliveryStatus（契约允许字段多出） |
| A-20 | 字段约定：ISO 8601 UTC、无值 null、错误体 `{error:{code,message,requestId,…}}`、401=UNAUTHORIZED、403=FORBIDDEN | [01](01-architecture.md) §6.3、各章端点节 | ✅ | |
| A-21 | 环境变量 `PORT / DATABASE_URL / GATEWAY_URL / AGENT_URL` 配置服务 | [01](01-architecture.md) §6.1 | ✅ | 缺失即拒绝启动；AGENT_URL 单点注入支撑 C2 切换（[12](12-agent-service.md) §5–§6） |

## B. §2.4 场景 S1–S8

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| S-01 | S1 受理与发出：202→message_sent 之间 accepted，之后 sent | [05](05-messaging-module.md) §1、§2.5 | ✅ | |
| S-02 | S2 事件全推两次：时间线无重复、agent 不重复触发 | [08](08-realtime-module.md) §1.2、[05](05-messaging-module.md) §3、[06](06-agent-module.md) §2 | ✅ | 双层：event_id 去重 + (groupId,msgId) 唯一 + 单飞行索引 |
| S-03 | S3 自己消息回流：isOwn=true、合并一行、不触发 agent | [05](05-messaging-module.md) §4、§3 | ✅ | 含乱序合并路径 §4.3 |
| S-04 | S4 限流：进入 rate_limited、期内零次 send、到期自动恢复 | [03](03-account-module.md) §5 | ✅ | 硬闸门在出站最外层（§5.2） |
| S-05 | S5 同 key 重试：网关恰一条、第二次返回当前状态、不再审计、run 正常结束 | [06](06-agent-module.md) §8.2 | ✅ | 幂等 key 表 + 5s 等待窗口 |
| S-06 | S6 坏响应：坏 JSON→未知工具→正常结束；三种 endReason 之一；不崩；每步有 kind 和 rawResponse | [06](06-agent-module.md) §4 | ✅ | 路径 A/B 分流；TURN_TIMEOUT 时 rawResponse=null（超时无响应体，契约要求有 rawResponse 的场景为有响应体的步） |
| S-07 | S7 并发启动：恰一个 201 一个 409 | [07](07-sequence-module.md) §2.4、§7 | ✅ | 部分唯一索引仲裁 |
| S-08 | S8 预检：422 带 stepIndex/key、零消息、零运行记录、之后可启动 | [07](07-sequence-module.md) §2.4、§7 | ✅ | 预检先于任何 INSERT |

## C. §2.1 网关契约关键行为

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| G-01 | connect 同 accountId 恒返同 platformUserId | [03](03-account-module.md) §2 | ✅ | 依赖该幂等性安排先调外部 |
| G-02 | disconnect 后五类操作 409 ACCOUNT_OFFLINE：send→该条 failed 同名码；join→job 失败；kick/leave→错误路径 | [05](05-messaging-module.md) §2、[04](04-group-module.md) §2.2 join 其他错误分支、[06](06-agent-module.md) §8.5 | ✅ | |
| G-03 | 离线补投：新 eventId、原 msgId/sentAt、不受 1s 窗口限制 | [08](08-realtime-module.md) §1.2、[05](05-messaging-module.md) §5.2 | ✅ | 去重键 + keyset 排序天然正确 |
| G-04 | account_status 事件（suspended/session_expired）+ 网关自动移群推 member_left | [03](03-account-module.md) §4、[04](04-group-module.md) §4 | ✅ | 两条路径幂等（终态条件更新） |
| G-05 | 建群响应返回即成员、creator 无 member_joined | [04](04-group-module.md) §2.2 | ✅ | creator 建群事务直写成员表 |
| G-06 | invite：readyAfterMs 0/几秒；INVITE_NOT_READY 等待重试；EXPIRED 任意时刻、重申一次 | [04](04-group-module.md) §2.2 | ✅ | |
| G-07 | join：202 仅受理；member_joined 100–1500ms 或永不到；ALREADY_MEMBER 视为成功且不再推事件 | [04](04-group-module.md) §2.2 | ✅ | waiting/joined 状态区分 |
| G-08 | promote：群主校验 NO_PERMISSION；NOT_MEMBER_YET；不推事件；调用总数 ≤ 2 | [04](04-group-module.md) §2.2 | ✅ | 计数持久化，崩溃续传累计 |
| G-09 | kick：1–5s 响应；504 → 成员列表判定（2s 收敛）；OWNER_LEFT/NO_PERMISSION 透传 | [06](06-agent-module.md) §8.5 | ✅ | |
| G-10 | leave：200 后 member_left；也可能 500（没退成） | [04](04-group-module.md) §3.2 | ✅ | 500 → errors[] 记录，账号两端保持成员 |
| G-11 | member_joined/left 含外部用户 | [04](04-group-module.md) §4 | ✅ | 外部成员**不建成员行**（容量决策 [13](13-capacity.md) §3 轴 3）：事件仅入 gateway_event 账本，外部成员以消息行 `senderPlatformUserId` 字符串存在；kick 判定查网关列表（[06](06-agent-module.md) §8.5）不受影响 |
| G-12 | GET members 即时性（入/离群即变，事件其后） | [04](04-group-module.md) §3.3、[06](06-agent-module.md) §8.5 | ✅ | kick/leave 结果判定与对账用它 |
| G-13 | send：202 可能 1–2s；message_sent 50–2000ms；message_failed 两码同同步语义 | [05](05-messaging-module.md) §2、§2.5 | ✅ | send 超时预算 8s（设计值） |
| G-14 | 同步错误七种分流（429/SUSPENDED/EXPIRED/GROUP_WRITE_FORBIDDEN/SENDER_NOT_IN_GROUP/ACCOUNT_OFFLINE/504） | [05](05-messaging-module.md) §2、[03](03-account-module.md) §5.1、[04](04-group-module.md) §1 | ✅ | 与 A2 错误对照表同源 |
| G-15 | 429 计时重置：等待期内任何 send 试探重置计时 | [03](03-account-module.md) §5.2 | ✅ | 硬闸门零试探 + greatest() 公式兜底 |
| G-16 | 网关不按 clientMsgId 去重（唯一性全在我方） | [02](02-data-model.md) §5.1、[05](05-messaging-module.md) §2.3 | ✅ | |
| G-17 | by-client-id：200 返回最早一条 / 404；504 后 2s 内落地推 message_sent；超 2s 仍 404 = 确认未发出 | [05](05-messaging-module.md) §2.4 | ✅ | 「最早一条」语义由我方单条不变量保证 |
| G-18 | 任何端点（含 by-client-id）503 | [05](05-messaging-module.md) §2.4、§7 | ✅ | 503 与 504 分流；恢复后 2s 内定 |
| G-19 | SSE：六类事件；eventId 全局单调；since 独占；全历史保留；at-least-once；乱序 ≤1s；断线带 since 补拉、不带从当前；启动即推与 connect 无关 | [08](08-realtime-module.md) §1 | ✅ | 游标=连续前缀（§1.3）解决乱序跳号 |
| G-20 | message 事件：含自己消息；sentAt 毫秒精度同毫秒多条；mediaUrl 可选 | [05](05-messaging-module.md) §3、[02](02-data-model.md) §5.1 | ✅ | 复合排序键 (sent_at, sort_key) |
| G-21 | 服务账号在 migration/seed 预置；初始 `status=idle`、`platformUserId=null` | [02](02-data-model.md) §10 | ✅ | seed 幂等（ON CONFLICT DO NOTHING） |

## D. §2.2 Agent 契约关键行为

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| T-01 | turn 请求形状（runId/tools/messages）；runId 我生成=GET id；同 run 同 runId | [06](06-agent-module.md) §6 | ✅ | 恢复续传同 runId（§9） |
| T-02 | tools 恰好 4 个、required 覆盖全部入参（否则 TOOLS_INVALID） | [06](06-agent-module.md) §6 | ✅ | 常量定义，我方永不触发 TOOLS_INVALID |
| T-03 | 合法响应每轮恰一块；stop_reason 区分；is_error 省略为 false | [06](06-agent-module.md) §4、§6 | ✅ | 三段式校验第三层 |
| T-04 | BAD_JSON 三层定义（非 2xx / 非法 JSON 含围栏夹文 / 形状不符） | [06](06-agent-module.md) §4 | ✅ | |
| T-05 | 触发上下文格式；triggerMessages 按 sentAt 升序 | [06](06-agent-module.md) §2、§6 | ✅ | 含 pending 合并的升序要求 |
| T-06 | get_recent_messages：升序、含触发消息与 run 期间新消息、limit 上限 50 超 50 按 50、单条 500 字截断置 truncated | [06](06-agent-module.md) §7.1 | ✅ | limit 超限钳制不报 INVALID_INPUT（契约字面） |
| T-07 | send_message 工具：accepted/sent 后返回、最多等 5 秒、failed 三种错误码、5 秒未确认 SEND_TIMEOUT | [06](06-agent-module.md) §8.2 | ✅ | SEND_TIMEOUT 后消息保持 unknown 由判定器收敛（不误标失败） |
| T-08 | kick_user / finish 工具语义 | [06](06-agent-module.md) §7.3、§7.4 | ✅ | finish 不再调 turn |
| T-09 | 错误 tool_result 码表 13 个全覆盖 | [06](06-agent-module.md) §4、§8 | ✅ | 逐一出现在对应分支 |
| T-10 | Agent 重试用新 tool_use.id；重复 id 先按协议错误 | [06](06-agent-module.md) §4 | ✅ | UNIQUE(run_id, tool_use_id) 检测 |
| T-11 | finish → final+summary；end_turn → summary 不发群 | [06](06-agent-module.md) §3、§7.4 | ✅ | |
| T-12 | 恶劣行为清单（坏 JSON/未知工具/schema 不符/重复 id/同 key 重试/无限工具/limit 100000/慢响应或不返回/audit 全故障形态） | [06](06-agent-module.md) §4、§7.1、§8.1、§8.2 | ✅ | 每条有对应分支；测试 = mock 开关清单（[12](12-agent-service.md) §7 映射表逐条对照） |
| T-13 | audit 契约（200 pass/fail；500/坏 body/慢/不返回 = 无结论） | [06](06-agent-module.md) §8.1 | ✅ | 3 次重试 → blocked；双模式实现见 [12](12-agent-service.md) §3–§4 |

## E. §3 功能需求 A 组

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| A0-1 | 迁移可重复执行；schema 落后拒绝启动 | [01](01-architecture.md) §6.4、[10](10-reliability.md) §3 | ✅ | 落后与超前均拒绝 |
| A0-2 | 错误响应格式 | [01](01-architecture.md) §6.3 | ✅ | |
| A0-3 | login 返回 access；viewer 写操作 403 | [09](09-auth-module.md) §2、§4 | ✅ | 接口层兜底（前端隐藏仅展示层） |
| A1-1 | 转移表逐格（16 条合法边——2026-09-28 起含 disconnected→online，按 REQ 网格字面回拨）；表外（含同态）ILLEGAL_TRANSITION | [03](03-account-module.md) §1 | ✅ | |
| A1-2 | 终态无出边、重连不可恢复；重复进终态静默忽略 | [03](03-account-module.md) §1 | ✅ | 条件更新实现幂等 |
| A1-3 | rateLimitedUntil 刷新不算转移 | [03](03-account-module.md) §5.1 | ✅ | |
| A1-4 | 并发至多一个成功、409 CAS_CONFLICT、后写不覆盖 | [03](03-account-module.md) §3 | ✅ | 条件 UPDATE rowcount 判定 |
| A1-5 | 终态原子副作用（移出所有群+queued→cancelled(ACCOUNT_TERMINAL)+序列步骤 skipped+account_terminal 事件；来源无关；全有或全无） | [03](03-account-module.md) §4 | ✅ | 单事务六动作 |
| A1-6 | 推给前端的状态事件对应已保存状态 | [03](03-account-module.md) §2、[08](08-realtime-module.md) §2.2 | ✅ | ws_event 同事务 |
| A1-7 | rate_limited 到期自动回 online；到期时已非 rate_limited 则不转移 | [03](03-account-module.md) §5.3 | ✅ | |
| A2-1 | 出站记录与 deliveryStatus 全链；崩溃不出「网关有 DB 无」、不出「一条记录多条网关消息」 | [05](05-messaging-module.md) §2、§2.3、[10](10-reliability.md) §1 E7 | ✅ | first_attempt_at 意图先行 |
| A2-2 | 504→unknown；5 秒内落定；确认未发出才可重发一次（同 clientMsgId）；重发仍未发出→failed(NETWORK_TIMEOUT)；by-client-id 503 期间保持 unknown、恢复后 2s 内定 | [05](05-messaging-module.md) §2.4 | ✅ | 2s 确认线 / 5s 落定线 / resend_count≤1 |
| A2-3 | 入站 (groupId,msgId) 去重、sentAt 排序展示 | [05](05-messaging-module.md) §3 | ✅ | |
| A2-4 | isOwn=true 不触发 agent | [05](05-messaging-module.md) §3、§4.4 | ✅ | |
| A2-5 | 事件处理 DB 写失败：不中断、不丢、推 inconsistency | [08](08-realtime-module.md) §1.2、§1.4 | ✅ | 账本+死信双事务 |
| A2-6 | 停机/断流期间事件恢复后处理到 | [08](08-realtime-module.md) §1.1、§1.3 | ✅ | since 补拉 + 连续前缀游标 |
| A2-7 | 错误对照表：RATE_LIMITED（排队顺延、原顺序、序列顺延不跳过） | [03](03-account-module.md) §5.1、§5.2、[07](07-sequence-module.md) §3.2 | ✅ | |
| A2-8 | 错误对照表：ACCOUNT_SUSPENDED / SESSION_EXPIRED → 终态 | [05](05-messaging-module.md) §2、[03](03-account-module.md) §4 | ✅ | |
| A2-9 | 错误对照表：GROUP_WRITE_FORBIDDEN → 群 unreachable+序列 stopped+agent 当前步后 cancelled+账号不变 | [04](04-group-module.md) §1、[06](06-agent-module.md) §10 | ✅ | |
| A2-10 | 错误对照表：SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE → 该条 failed 同名码、状态不变 | [05](05-messaging-module.md) §2 | ✅ | |
| A2-11 | 错误对照表：NOT_MEMBER_YET → promote ≤2 次；member_joined 10s → JOIN_TIMEOUT | [04](04-group-module.md) §2.2 | ✅ | |
| A2-12 | 错误对照表：OWNER_LEFT/NO_PERMISSION → kick_user 同名错误、状态不变 | [06](06-agent-module.md) §8.5 | ✅ | |
| A3-1 | 建群流程五段；异步；job 可查进度与失败步骤 | [04](04-group-module.md) §2 | ✅ | |
| A3-2 | 成员表写入时机（creator 建群成功；其他收到 member_joined） | [04](04-group-module.md) §2.2、§4 | ✅ | |
| A4-1 | 游标分页；加载更早与新写入并发不重不漏 | [05](05-messaging-module.md) §5 | ✅ | keyset + sentAt 变化分析 §5.2 |
| A4-2 | WS auth 后推送、seq 单调 | [08](08-realtime-module.md) §2 | ✅ | |
| A5-1 | 触发（agentEnabled+非自己）；每群至多一个 running（多实例成立）；待处理消息合并进下一次 triggerMessages（全部） | [06](06-agent-module.md) §2 | ✅ | 部分唯一索引+trigger_queue |
| A5-2 | 循环；一步=一次往返；审计重试不计步；12 步含结束步；60s 含审计、恢复续算停机不计；连续 3 次协议错误、合法响应清零；turn 超时 10–15s 可配、超时记 TURN_TIMEOUT、迟到响应丢弃 | [06](06-agent-module.md) §3、§5 | ✅ | 三重预算表+墙钟公式 |
| A5-3 | 协议错误两类处理（未知工具/schema→assistant 块+is_error tool_result；BAD_JSON/重复 id/超时→user text 块 PROTOCOL_ERROR，计步、kind=protocol_error、rawResponse） | [06](06-agent-module.md) §4 | ✅ | |
| A5-4 | 审计门禁（text 定义、verdict 恰为 pass、fail→AUDIT_REJECTED、无结论 3 次→blocked 不执行、单次失败不返回不计步、耗时计 60s、推事件） | [06](06-agent-module.md) §8.1、§8.3 | ✅ | |
| A5-5 | 执行账号（online 群成员；kick 需 creator/admin；NO_AVAILABLE_ACCOUNT 不算协议错误但计步；中途终态→SEND_FAILED run 继续） | [06](06-agent-module.md) §8.4、§8.2 | ✅ | |
| A5-6 | kick 需 autoKickEnabled=true 否则 POLICY_DENIED | [06](06-agent-module.md) §8.4 | ✅ | 门槛顺序：policy→audit→账号 |
| A5-7 | 幂等（同 key 第二次不再发不再审、返回当前状态；AUDIT_REJECTED/POLICY_DENIED 不消耗 key） | [06](06-agent-module.md) §8.2 | ✅ | 消耗时机=过审创建消息同事务 |
| A5-8 | 恢复（任意时刻重启、同 runId 续传、已产生外部效果的工具不重放不记失败） | [06](06-agent-module.md) §9、[10](10-reliability.md) §1 E5/E13 | ✅ | 崩溃点分析表 |
| A5-9 | tool_result ≤8KB 截断置 truncated；resultSummary ≤200 字 | [06](06-agent-module.md) §7.1、§11 | ✅ | |
| A5-10 | 群 unreachable / agentEnabled 关闭 → 当前步结束后 cancelled | [06](06-agent-module.md) §10 | ✅ | 协作式检查点 |
| A5-11 | 重复 get_recent_messages 处理自定、12 步内合理结束 | [06](06-agent-module.md) §7.1 | ✅ | 取「正常执行+预算兜底」（标注解读） |
| A5-12 | 每步（含协议错误步）可查看 | [06](06-agent-module.md) §11 | ✅ | |
| A6 | 前端页面 1–3 | [09](09-auth-module.md) §4、[03](03-account-module.md) §6、[04](04-group-module.md) §5、[05](05-messaging-module.md) §5、[08](08-realtime-module.md) §3 | ✅ | 后端支撑（端点/事件/权限）完备；页面实现属 `web` 包范畴 |

## F. §3 功能需求 B 组

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| B1-1 | 序列 JSON 格式与校验 | [07](07-sequence-module.md) §1 | ✅ | |
| B1-2 | accountRole=admin（creator/admin 且 online，优先 admin）；member（字典序第一） | [07](07-sequence-module.md) §3.3 | ✅ | |
| B1-3 | 无匹配账号 skipped；rate_limited 不算没有（顺延不跳过） | [07](07-sequence-module.md) §3.2、§3.3 | ✅ | 候选集含 rate_limited |
| B1-4 | vars/stepVars 取值规则（持续生效、stepVars ""=不改、vars ""=未提供） | [07](07-sequence-module.md) §2.2、§2.3 | ✅ | 推演表为测试基准 |
| B1-5 | 预检：全部步骤、任何 {key} 解析不到→422（stepIndex/key）、零消息、零记录、之后可启动 | [07](07-sequence-module.md) §2.4、§7 | ✅ | |
| B1-6 | resolvedVars=最终取值；varSources=default / step:<index>（最初给出者） | [07](07-sequence-module.md) §2.2、§2.3 | ✅ | 启动时快照 |
| B1-7 | 每群至多一个 running；并发恰好一个 201 一个 409 | [07](07-sequence-module.md) §2.4 | ✅ | |
| B1-8 | 排期：「发出」=message_sent 时刻；第 n 步锚前一步；skipped 视为跳过时刻发出 | [07](07-sequence-module.md) §3.1、§3.2 | ✅ | |
| B1-9 | skipped 有时间戳、进度照常推进 | [07](07-sequence-module.md) §3.2、[02](02-data-model.md) §8.3 | ✅ | |
| B1-10 | 重启：只重排最早过期步骤（重启时刻+delaySeconds）、后续仍链式、不一次性全发 | [07](07-sequence-module.md) §5、[10](10-reliability.md) §3 | ✅ | |
| B2-1 | 建群错误三行（NOT_READY 等待重试 / EXPIRED 重申一次 / ALREADY_MEMBER 视为成功直接 promote） | [04](04-group-module.md) §2.2 | ✅ | |
| B2-2 | leave-all：群主最后退；非群主失败→errors[]、其余继续、群主不退、job failed、失败账号两端仍成员 | [04](04-group-module.md) §3 | ✅ | |
| B2-3 | 完成后成员表与网关成员列表一致 | [04](04-group-module.md) §3.3 | ✅ | 事件确认+对账；对账范围为**服务账号**（leave-all 操作的即我方账号，外部成员本就不在成员表语义内——【解读】见 [04](04-group-module.md) §3.3，容量决策 [13](13-capacity.md) §3 轴 3） |
| B3-1 | refresh 只走 HttpOnly cookie；refresh 端点轮换+新 Set-Cookie | [09](09-auth-module.md) §2、§3.2 | ✅ | Path 限定 /api/auth |
| B3-2 | 旧 refresh 复用→401+整会话作废（新 refresh+新 access 全失效） | [09](09-auth-module.md) §3.1、§3.2 | ✅ | 复用检测事务 |
| B3-3 | logout 后同一 access 立即失效 | [09](09-auth-module.md) §3.3 | ✅ | 服务端 token 状态 |
| B3-4 | 前端自动续期、并发 401 单飞一次 refresh | [09](09-auth-module.md) §3.4 | ✅ | 后端语义配合（401+轮换幂等） |
| B4-1 | 断线期间事件重连 3 秒内出现、不重复 | [08](08-realtime-module.md) §2.2、§3 | ✅ | sinceSeq 表回放+seq 去重 |
| B4-2 | 页面 4（agent 步骤详情） | [06](06-agent-module.md) §11 | ✅ | 后端 API 完备（steps 全字段）；页面属 web 包 |

## G. §3 C 组（选做）

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| C1 | 媒体下载到 media/、localFilePath、N 天（默认 30 可配）清理、无悬挂记录、运行中 run 引用保护 | [05](05-messaging-module.md) §7、[02](02-data-model.md) §5.1 | ✅ | 按群粒度保守保护（标注解读） |
| C2 | 真实 LLM 独立服务、接口与 §2.2 完全相同、后端只改 AGENT_URL 切换 | [12](12-agent-service.md) §2、§4、§5；[01](01-architecture.md) §6.5、§8 | ✅ | mock-agent 单包双 provider：`AGENT_MODE=anthropic` 起独立实例即「独立服务」；后端侧边界 AGENT_URL 单点注入 + 契约形状校验集中在 agentclient |
| C3 | Playwright E2E（登录→群→run 步骤） | — | ❌ | 前端 E2E，不在后端架构设计范围；项目测试策略（AGENTS.md §4）规定 E2E 仅明确要求时编写 |

## H. §3 总则

| # | 需求摘要 | 设计位置 | 状态 | 备注 |
|---|---|---|---|---|
| H-1 | 每条行为在服务任意时刻重启前后成立 | [10](10-reliability.md) 全文 | ✅ | 事务边界清单 E1–E14、恢复扫描、不变量 I1–I14 |

## 统计

| 状态 | 条数 | 明细 |
|---|---|---|
| ✅ 完整 | 124 | A 节 21 · B 节 8 · C 节 21 · D 节 13 · E 节 39 · F 节 19 · G 节 2 · H 节 1 |
| ⚠️ 部分 | 0 | — |
| ❌ 未覆盖 | 1 | C3（前端 E2E，范围外） |
| 合计 | 125 | |

> C3 是唯一未覆盖项：它对应的行为（Playwright 用例）不涉及后端任何设计决策；后端为该流程暴露的全部能力（login、群详情、agent-runs/:id steps）已由 A-01/A-07/A-13 覆盖。若后续明确要求实现 C3，按 [analysis/07-requirements-C.md](../analysis/07-requirements-C.md) 单独出测试计划，不影响本设计。
