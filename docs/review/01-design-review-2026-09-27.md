# 01 · 设计审查报告（可行性 × 需求覆盖 × 120 分路线）

> 审查人视角：项目 Leader。审查对象：[docs/requirement.md](../requirement.md)（契约）· [docs/analysis/](../analysis/README.md)（12 篇拆解）· [docs/design/](../design/README.md)（13 篇设计，约 2700 行）。
> 审查方法：以原文为唯一基准逐条回溯——每个状态机逐边核对、每个契约数字对表、每条「先持久化后外部效果」路径做崩溃点推演、每条【解读】判定是否合理取舍。
> 日期：2026-09-27。状态：**审查完成 → 设计修订已回写（同日，见 §4 回链）→ 修订复核通过（见 §5，含 2 项残留修订 + 5 处编辑性问题）**。

---

## 0. 结论摘要（先行）

| 审查项 | 结论 |
|---|---|
| **1. 架构可行性** | ✅ **可行，可进入实现阶段**——但有前置条件：先修复 §2.3 的 3 个高优缺陷（都在「崩溃一致性」这条项目宪法路径上），并对 2 处契约偏离做出改判或显式声明。技术选型全部是成熟机制，无研究性风险；**最大风险不是技术，是工程量 vs 48h**（估算 70–110 人时，见 §1.4）。 |
| **2. 需求覆盖** | 验收矩阵（125 条，124✅/1❌）**本身诚实且无漏项**；但矩阵验证的是「有没有设计位置」，不验证「设计内部是否自洽」。本次深查发现 **8 个设计缺陷/契约偏离**（3 高 5 中）、**5 个交付级缺口**（mock-gateway 设计、前端设计、交付层规划、测试映射、C3 决策）、**4 处可瘦身的过度设计**。契约数字与错误码经对表**零改写**。 |
| **3. 120 分路线** | 核心判断：这份设计的文档深度已超笔试均值，**拉开差距的不是再写文档，而是把「正确性」变成评审者 5 分钟内可见的证据**——崩溃注入测试、S1–S8 一键演示、C1/C2/C3 全收、诚实的完成度表。详见 §3。 |

---

## 1. 可行性评估

### 1.1 架构选型逐项判定

| 选型 | 判定 | 评语 |
|---|---|---|
| 模块化单体 + 单进程 | ✅ 正确 | 题目无独立扩展诉求；多实例正确性靠 DB 约束而非拆分，立场清晰（design/01 §5） |
| PostgreSQL 承载全部真值与并发控制（无 Redis/MQ） | ✅ 正确 | outbox/死信/事件日志全用 PG 表，崩溃面最小；容量文档（13）逐轴论证了「不引入」，纪律性好 |
| 手写 SQL + pg，不用 ORM | ✅ 正确 | 本项目正确性核心恰是部分唯一索引、条件更新（CAS）、advisory lock——ORM 会藏掉这些语义 |
| Fastify + ws + pino | ✅ 可行 | 成熟、轻、schema 校验对齐 `VALIDATION_ERROR` |
| 自研迁移 runner（~100 行） | ✅ 可行 | 需求只有「可重复执行 + 落后拒启动」两点，自研是最短路径；注意「超前也拒绝」是加严（合理，代码回滚保护） |
| DB 驱动调度（1s 扫描兜底 + 进程内 timer 只做加速器） | ✅ 正确 | 这是「重启不变量」的最稳实现形态；限流到期/unknown 落定/join 超时的秒级精度满足契约（契约对这些点无毫秒级要求） |
| opaque token + 查表（非 JWT） | ✅ 正确 | B3 的 logout 即时失效与复用作废本来就需要服务端状态，JWT 优势不成立 |
| mock-agent 单包双 provider（scripted/anthropic） | ✅ 正确 | scripted 保确定性测试与无 key 演示，anthropic 收 C2 分；19 项故障开关 ↔ 契约行为 ↔ 后端防御分支的映射表是全设计里最好的一张表 |

### 1.2 数据库机制可行性核验（逐机制确认在 PG 16 成立）

| 机制 | 用途 | 核验 |
|---|---|---|
| 部分唯一索引 `(group_id) WHERE status='running'` | 每群单飞行（agent run / 序列），S7 | ✅ PG 原生支持；`INSERT ... ON CONFLICT (group_id) WHERE status='running' DO NOTHING` 索引推断合法 |
| 部分唯一索引 `(group_id, msg_id) WHERE msg_id IS NOT NULL` | 入站去重 | ✅ |
| 生成列 `sort_key = COALESCE(msg_id, client_msg_id)` | keyset 分页第二键 | ✅ COALESCE 为 immutable，可作 STORED 生成列 |
| 条件 UPDATE + rowcount | CAS（A1）、状态机守卫 | ✅ 惯用法 |
| `pg_try_advisory_lock` / `FOR UPDATE SKIP LOCKED` | 执行器互斥、扫描互斥 | ✅；注意 advisory lock 生命周期 = 会话，需专用连接（实现细节，design/10 §6 已登记风险） |
| `BIGSERIAL` 作 WS seq | 全局单调 | ✅ 事务回滚产生空洞不违约（契约只要求单调） |
| LISTEN/NOTIFY | 多实例 WS 投递 | ✅（单实例可先内存通知，见 O4） |

**结论：无任何机制超出现实能力，全部是 PG 惯用法。**

### 1.3 关键正确性机制评审（设计最硬的四块，逐一确认思路成立）

1. **出站 outbox（E7/E13）**：意图先落库（`first_attempt_at`）→ 崩溃后「尝试过 = 结果未知」走判定路径而非盲目重发——这是 A2 两条不变量（网关发了 DB 必有记录 / 一条记录至多一条网关消息）的正确解。✅（但见 D1-2：终态取消与该路径有竞态。）
2. **SSE 游标 = 连续前缀（08 §1.3）**：乱序 ≤1s 下「游标取 max」会永久跳过 gap，前缀语义 + 网关全历史补拉是唯一无损解。思路正确且是多数答卷会漏的点。✅（但死信支路有 D1-1 缺陷。）
3. **agent run 崩溃恢复（06 §9）**：step 断点状态机（pending→turn_dispatched→turn_received→tool_dispatched→done）+ `appended_blocks` 重建会话 + 效果型工具「不重发、反查外部现状」——A5-8 的正确解，崩溃点分析完整。「无状态全量历史」规约把 §2.2 的模糊句（Agent 按 runId 维护会话状态）显式化为对 mock/C2 的实现约束并配了故障开关，处理得诚实。✅
4. **序列链式排期 + 重启只重排最早一步（07 §5）**：与 B1 逐字吻合；「同一时刻至多链头有排期」的推理正确。✅

### 1.4 风险清单（按严重度）

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| R1 | **工程量 vs 48h** | 🔴 高 | 粗估：server 30–45h + mock-gateway 8–12h + mock-agent 8–12h + 前端 10–15h + 测试 10–20h + 交付打磨 3–5h ≈ **70–110 人时**（AI 辅助可压缩，但仍是全场最大风险）。必须执行 §3.3 的分阶段裁剪，且**裁剪决定要现在做，不要做到一半再砍** |
| R2 | 3 个高优设计缺陷（D1-1/2/3） | 🔴 高 | 全部位于「重启不变量」路径，实现后才发现会返工最难测的部分。**先改文档再动代码** |
| R3 | agent executor 复杂度集中 | 🟡 中 | 06 章是全设计状态机最深处（step 五态 × 恢复四分支 × 三重预算 × 审计循环）。建议实现时每个 step 状态转移配一个单测，恢复分支各配一个 kill -9 集成测试 |
| R4 | mock-gateway 无设计（G1） | 🟡 中 | S1–S8 的验收全依赖它的故障开关保真度；「契约即验收基准」的另一半没有落地文档 |
| R5 | 两处契约偏离（D2-3/D2-4） | 🟡 中 | 若评审者按字面验收会扣分；改判成本低，见各条修复建议 |

### 1.5 可行性结论

> **系统设计可用（usable）**：选型成立、机制可落地、四个最硬的正确性设计思路正确、契约数字零改写。**放行条件**：修复 D1-1/D1-2/D1-3，对 D2-3/D2-4 改判或显式声明偏离，并把 R1 的裁剪计划写进作战图。不存在需要推倒重来的架构级问题。

---

## 2. 需求覆盖审查（遗漏 / 画蛇添足 / 与原文相悖）

### 2.0 覆盖矩阵复核

对 requirement 逐节反向扫描（§2.1×21 条、§2.2×13、§2.3×21、§2.4×8、§3×61、§5），[design/11](../design/11-verification.md) 的 125 条矩阵**无漏项、统计准确（21+8+21+13+39+19+3+1=125）、C3 的 ❌ 声明诚实**。analysis 12 篇与原文对表：时序数字、错误码、状态转移表**逐字一致**，【解读】标注纪律执行到位。以下是矩阵覆盖不到、或覆盖了但设计内部有错的条目。

### 2.1 遗漏（交付级缺口，按重要度）

| # | 缺口 | 影响 | 建议 |
|---|---|---|---|
| G1 | **mock-gateway 没有设计文档**。mock-agent 有 design/12（19 项开关映射表），网关侧只有 analysis/02 的契约重述。网关 mock 是更复杂的一半：全历史事件存储与 `since` 回放、≤1s 乱序模拟、离线补投、每事件双推（S2）、429 计时重置、504+1.5s 落地（S5）、kick 1–5s/504 收敛、join 100–1500ms/永不到、invite 就绪/过期、by-client-id、`GET /media/:id`（C1） | S1–S8 验收与后端集成测试全部依赖它；无设计会导致实现时「顺手弱化 mock」（违反宪法 §3-8） | 补 `design/14-gateway-service.md`：照 design/12 的格式写「契约行为 ↔ 故障开关 ↔ 依赖它的后端测试」映射表；明确事件账本存储（内存+可重置 or SQLite）、确定性时序控制接口（`/_test/*`）、测试间状态重置语义 |
| G2 | **前端（web 包）没有任何设计/计划**。矩阵把 A6/B4-2 标为「web 包范畴」，页面 5（序列）连矩阵行都没有。前端有自己的硬需求：WS 客户端（auth 帧、sinceSeq 补齐、seq 去重）、401 单飞续期（B3）、keyset 分页与 WS 增量合并（A4「不重不漏」的前端半边）、deliveryStatus 原地更新、viewer 按钮可见性 × 转移合法性（页面 2）、预检弹窗复用 resolvedVars/varSources（页面 5）、blocked 醒目提示 | 前端占分不小（A6 是 A 组、页面 4/5 挂在 B 组），且 B4「3 秒内出现且不重复」一半靠前端实现 | 补一篇轻量 `design/15-web-console.md`：页面 × 数据流 × 状态管理选型 × WS 重连/去重策略 × 组件级测试点（对齐全局 UI 测试策略第 1/2 层） |
| G3 | **交付层无规划**：README 结构、docker-compose、seed 演示数据、S1–S8 演示脚本、完成度声明（§5 交付物是评分面） | 「做到哪算哪」的评分制下，评审体验=分数 | 见 §3.2 第 3 条 |
| G4 | **不变量 I1–I14 → 测试用例的映射未落地**（design/10 §5 留给「实现仓库的测试计划」） | I 清单是全场最好的验收资产，没有映射就只是声明 | 实现前建 `server/VITEST_PLAN.md`：每条 I × 每个 S × 19 个 mock 开关 → 用例文件名；写完一个勾一个 |
| G5 | **C3 的 ❌ 需要用户决策**。design/11 判 C3「范围外」依据的是 AGENTS.md 的 E2E 红线；但 C3 是**考题原文的选做加分项**——考题本身构成「明确要求」的候选解释。这与全局规则存在张力，按规则应由你裁决 | C3 实际成本 ≈ 1–2h（一条冒烟：登录→群详情→看到 run steps） | **建议做**（见 §3.2 第 4 条）；若你裁决不做，在 README 完成度表里写明理由即可，损失有限 |

### 2.2 与原文相悖 / 契约偏离（2 处，建议改判）

**X-1（=D2-3）kick_user 失败错误码不在契约码表内。** [design/06 §8.5](../design/06-agent-module.md)：kick 504 且目标仍在 → `is_error NETWORK_TIMEOUT`【解读】；`409 ACCOUNT_OFFLINE 等 → is_error SEND_FAILED / 对应码`。问题：§2.2 的错误 tool_result 码表是**封闭的 13 个**，`NETWORK_TIMEOUT`、`ACCOUNT_OFFLINE` 都不在其中——「Agent 服务根据 code 决定下一步」，表外码属于协议违约，且我方自己的校验器/测试若按码表断言会直接翻车。**修复**：统一取表内的 `SEND_FAILED`（语义=操作未成功），`reason` 字段里带上网关细节；OWNER_LEFT / NO_PERMISSION 保持透传（这两个在表内，A2 明文）。

**X-2（=D2-4）A5-10 取消检查点放在「效果型工具执行前」，与原文「当前这一步结束后终止」相悖，且文本自相矛盾。** [design/06 §10](../design/06-agent-module.md) 检查点有两个：循环顶部 + 效果型工具执行前；同节事务描述却写「当前步照常落库（**含 tool_result**——已完成的不浪费）」——工具没执行哪来 tool_result。后果：agentEnabled 被关闭时，进行中的 send_message 步会被拦腰截断（turn 已返回 tool_use，工具不执行、无 tool_result），而契约字面是**完成当前步（含发送）再终止**；群 unreachable 场景其实已被 §8.2 的 GATE1（工具级群状态检查 → `GROUP_UNREACHABLE` 错误结果）覆盖，不需要第二个检查点。**修复**：删掉「效果型工具执行前」检查点，只留循环顶部检查点；unreachable 走 GATE1 让当前步以合法 tool_result 收尾，再在循环顶部 cancelled——恰好实现 A2 表的「当前步后 cancelled」，且会话历史无悬挂 tool_use。

**合理【解读】清单（判定为可接受的自主取舍，不改）**：connect 前置态从严（idle/disconnected）；群 `unreachable` 不回转；unreachable/left 群拒绝启动序列（409 GROUP_UNREACHABLE，码名自定）；leave 失败码名 `LEAVE_FAILED`、job 404 码名 `JOB_NOT_FOUND`；C1 按群粒度保守保护媒体文件；get_recent_messages 重复调用不设防、靠预算兜底（A5-11 明文允许自定）；audit 单次超时 5s（契约无数字，必须有）；`limit>50` 钳制不报 INVALID_INPUT（契约字面「超过按 50 处理」，正确）；refresh 并发重放视同复用（B3 字面语义）；首次部署不带 `since` 起流。**建议**：把散在各章的【解读】汇总成 README 的「契约解释声明」一节——评审看到分歧点被主动声明，是加分而非扣分。

### 2.3 设计缺陷（内部不自洽 / 崩溃窗口推演不成立，按严重度）

#### 🔴 D1-1 死信事务的外键矛盾——「不中断不丢失」路径自身会中断

- **位置**：[design/08 §1.2](../design/08-realtime-module.md) × [design/02 §1.4](../design/02-data-model.md) × design/01 §4.5。
- **症状**：主事务是「a) INSERT gateway_event + b) 业务分发 + c) 推进游标」单事务；b/c 失败 → **整个事务回滚，账本行也没了**。死信事务只「INSERT pending_event + 推进游标」，而 `pending_event.event_id` 是 `NOT NULL REFERENCES gateway_event(event_id)` → **FK 违例，死信事务也失败** → 走「退避重试整个事务」→ 永久性错误（如 D3-1 的孤儿群 FK 失败）下消费循环在同一事件上无限空转，A2「不能中断」被违反。
- **连带**：design/05 §3 要点「事件先入账本再处理」与 §1.2 的单事务图互相矛盾；§1.4 重试「a 步骤天然冲突跳过」只有在账本行已存在时才成立。
- **修复**（一句话）：死信事务改为 **INSERT gateway_event(E) ON CONFLICT DO NOTHING + INSERT pending_event + 推进游标**，三写同事务。这样：主事务回滚→账本无行→死信事务补上；重试时 a) 冲突跳过、只重放 b)，与 §1.4 的描述闭合。前缀游标把死信事件计为「已入账」（内容已持久化于 pending_event），语义不变。

#### 🔴 D1-2 终态原子副作用 × 在途发送的竞态——破坏 I1/I3

- **位置**：[design/03 §4 T3](../design/03-account-module.md) × design/05 §2.5 更新守卫。
- **推演**：dispatcher 落 `first_attempt_at` 后正在调网关 send（该行仍 `queued`）；同一瞬间 `account_status: suspended` 事件到达 → 终态事务把**所有 queued 行**（含这条在途的）置 `cancelled(ACCOUNT_TERMINAL)`。随后网关返回 202 / 推来 `message_sent`：更新守卫 `WHERE delivery_status IN ('queued','accepted','unknown')` 不含 cancelled → rowcount=0 → 被 §2.5 误判为「非我方 clientMsgId，忽略」。结果：**网关实际发出了消息，我方记录停在 cancelled**；更糟的是回流 `message` 事件按 `(group_id, msg_id)` 查无此行 → **插入第二行**——同一逻辑消息两行（违反「一条消息只有一行」与 I3），且时间线永远缺一条 sent 记录（违反 I1 的精神）。
- **修复**：终态事务 T3 的范围收窄为 `delivery_status='queued' AND first_attempt_at IS NULL`（真正未发出的才取消）；`first_attempt_at` 非空的行**转入 unknown 判定路径**（`unknown_since=now(), deadline=now+5s`），由判定器按网关真相落定（sent/failed）。配套两点：① dispatcher 的 202 写回归卫放宽为 `IN ('queued','unknown')`（恢复扫描/终态转换可能在 send 在途时把行改为 unknown）；② 契约措辞「排队中的发送变为 cancelled」按此解释声明——已交给网关的发送不再受我方控制，判定落定比强行 cancelled 更符合 I1。序列步骤联动同范围收窄（未尝试→skipped；尝试过→随判定结果 sent/failed）。

#### 🔴 D1-3 §4.3 乱序合并路径按图施工必然撞唯一约束；且两条兄弟路径缺同样处理

- **位置**：[design/05 §4.3](../design/05-messaging-module.md) × §2.4（by-client-id 200 分支）× §2.5。
- **推演**（照时序图逐步执行）：出站行 X 已 accepted（msg_id=NULL）；乱序窗口内 `message` 事件先到 → 按 §3 插入行 M（msg_id=M, client_msg_id=NULL, sent）。随后 `message_sent{X,M}` 到达：图中声称「UPDATE WHERE client_msg_id=X → rowcount=0」——**错**，出站行 X 存在且状态 accepted，UPDATE 会命中并试图置 msg_id=M → 撞 `uq_message_group_msg`（M 行已持有该键）→ **事务报唯一违例，不是 rowcount=0**。接着的「回退路径」先给 M 行 SET client_msg_id=X 再 DELETE 占位行——顺序反了：X 还挂在占位行上，SET 时撞 `uq_message_client_msg`。
- **连带缺口**：① §2.4 判定器 by-client-id 返回 200{msgId,sentAt} 的「回填」分支，在补投场景（M 行早已存在、占位行 unknown）会撞同样的冲突，文中未提合并；② 合并路径成功后**没有联动**序列步骤置 sent / 下一步排期（§2.5 有、§4.3 没有），agent send_message 的 5s 等待同样要能看到合并后的行。
- **修复**：抽一个共享的 `finalizeSent(clientMsgId, msgId, sentAt, tx)`：同事务内先查 `(group_id, msg_id)` 是否已有行——无则常规回填占位行；有则 **先 DELETE 占位行（client_msg_id=X, msg_id IS NULL）再 UPDATE M 行 SET client_msg_id=X, delivery_status='sent', sent_at=网关值**，随后统一执行序列联动 + ws_event。`message_sent` 事件、by-client-id 200、（未来任何确认途径）全部走这一个函数；唯一违例作为「需要合并」的信号捕获亦可，但显式预检更可读。

#### 🟡 D2-1 成员事件乱序（member_left 先到）会把已离群账号投影成活跃成员

- **位置**：[design/04 §4](../design/04-group-module.md) 成员投影流程图。
- **推演**：契约允许相邻事件乱序 ≤1s。账号入群后 1s 内被踢/进终态：`member_left`(E2) 先于 `member_joined`(E1) 到达。现行处理：left→「无活跃行→幂等跳过」；joined→「无行→INSERT 活跃行」或「有行且 left_at 非空→**复活**」。终局：终态/被踢账号在成员表里是**活跃**行——违反「进入终态时从所有群成员表移除」，成员列表与网关不一致，还可能被选为 agent 执行账号（发出后被网关 SENDER_NOT_IN_GROUP 打回，系统能自愈但状态已错）。
- **修复**：`group_member` 加 `last_event_id bigint`；成员事件仅在 `event_id > last_event_id` 时改变活跃性（小 id 的迟到 joined 只补 joined_at、不复活）；`member_left` 无行时**插入墓碑行**（left_at=now, last_event_id=E）而非跳过；`member_joined` 命中服务账号时先查账号终态（`terminal_at` 非空 → 插入即带 left_at）。外部成员维持「不建行」（乱序只影响有行的服务账号）。

#### 🟡 D2-2 ALREADY_MEMBER 路径下成员行永远缺失，promote 落空

- **位置**：design/04 §2.2（WJM 分支）× §4（PRM 处理）。
- **推演**：契约明文 ALREADY_MEMBER 时**网关不再推 member_joined**；而设计的成员行「唯一写入源」是事件路径（job 执行器不写非 creator 成员）。于是该账号无成员行 → promote 后 `UPDATE role='admin'` 命中 0 行（静默）→ `GET /api/groups/:id` 的 members 缺人、role 丢失——违反「建群完成时 memberAccountIds[0] 已是管理员」的可见结果。§2.2 的 ALLIN「context 与成员表核对」也会因缺行卡住。B2 明文要求处理该分支，mock 大概率内置此开关来考。
- **修复**：ALREADY_MEMBER 分支由 job 事务 **UPSERT 成员行**（role=member；此为「事件写入源」的第三个明示例外，与 creator/promote 并列）；promote 成功后的 role 更新同样改 UPSERT 兜底。

#### 🟡 D2-5 限流登记 SQL 破坏 `rate_limited_until` 的表级不变量

- **位置**：[design/03 §5.1](../design/03-account-module.md) × design/02 §3.1（「非 rate_limited 态恒为 NULL」）。
- **推演**：429 与操作员标记 disconnected 竞态时，`CASE WHEN status='online'` 保持状态为 disconnected，但 `rate_limited_until` 仍被写成非 NULL——不变量破坏；该账号重连回 online 后带着陈旧的 until 值（硬闸门只看 status='rate_limited' 所以不会误挡，但数据已脏，`GET /api/accounts` 的 rateLimitedUntil 输出错误）。
- **修复**：UPDATE 加状态守卫 `WHERE id=$id AND status IN ('online','rate_limited')`（online→置 rate_limited+until；rate_limited→仅顺延 until）；其他状态收到 429 记警告日志、不写字段。理论上 429 只发生在网关侧在线的账号，守卫不影响正常路径。

（D2-3 / D2-4 已并入 §2.2 的 X-1 / X-2。）

#### 🟢 D3（低——文档补写即可，不阻塞开工）

| # | 条目 | 建议 |
|---|---|---|
| D3-1 | **未知群/账号事件无处理规则**：孤儿网关群（E1 崩溃窗口产物）的 `message` 事件 → group_id 无法解析 → FK 失败 → 按 D1-1 修复后进死信 → 重试永不成功 → 20 次后 `dead_letter_stuck`。能自愈但浪费且吵 | 在 08 §1.2 加规则：gateway_group_id 无法映射且**不在任何 running job 的 context 里** → 仅入账本 + 推一次 inconsistency（kind='unknown_group_event'），不进死信；在 creating 窗口内的 → 死信短重试（映射很快会出现） |
| D3-2 | 启动顺序「先恢复后开流量」若被实现成**同步等待** SSE 追平 / run 恢复完成，长时间停机后 HTTP 会迟迟不监听 | 在 01 §7 明确：恢复=登记+异步交接（executor/dispatcher/判定器接管），SSE 消费异步启动，`/api/health` 随监听立即可用；「先恢复」指恢复扫描**登记**完成，不是追平完成 |
| D3-3 | WS `message` 事件在 queued 阶段 `msgId=null`（契约 payload 写了 msgId），且前端需要 clientMsgId 才能原地更新 | 在 08 §2.3 文档化：payload = `{groupId, msgId(可null), isOwn, clientMsgId?, deliveryStatus?}`——契约「多出的字段不影响」，null 判断写明 |
| D3-4 | 手动 `transition {to:'rate_limited'}` 在转移表上合法（online→rate_limited），但 API 没有 retryAfterSeconds，until 写什么未定义 | 契约空隙。建议设计定死：手动转 rate_limited 必须带可选参数 `rateLimitedUntil`，缺省 → 400 VALIDATION_ERROR；或干脆拒绝该目标（声明偏离）。二选一写进 03 §3 |
| D3-5 | 乱序窗口（≤1s）内时间线短暂两行（占位行 + M 行）是 D1-3 方案的固有瞬态 | 在 05 §4.3 声明为已知瞬态（契约的「一行」按稳态解释），并加一个「稳态一行」的集成测试 |
| D3-6 | `POST /api/groups/:id/send` 对空 text / 超长 text 无校验定义 | 补 VALIDATION_ERROR 规则（非空；上限自定并声明） |

### 2.4 过度设计审查（画蛇添足判定）

**判定原则**：48h 笔试里，每多一个机制 = 实现时间 + 测试面 + 出 bug 面。以下按「砍/降级/保留」给出裁决：

| # | 机制 | 裁决 | 理由 |
|---|---|---|---|
| O1 | **租约 + 孤儿接管 + `pg_terminate_backend` 强杀**（06 §2.1/§9.4） | 🔻 **降级** | 这是「进程活着但 executor 挂死」的第三道防线，但所有外呼已带超时（挂死的主要来源被堵住），事件循环整体卡死时 health check 也会暴露。强杀持锁会话是全场最 exotic 的操作，误杀窗口的辩护逻辑（两个租期+条件更新兜底）本身就说明复杂度超标。**保留** `lease_until` 字段与「租约过期 → 记 error 日志 + inconsistency」的观测（近乎零成本），**砍掉** terminate+接管编排；真发生挂死，重启进程即触发既有恢复扫描 |
| O2 | `AGENT_MAX_CONCURRENT_RUNS` 全局并发闸（06 §2.1） | 🔻 简化 | 考试规模并发 run ≤ 10。保留 env 配置项，但实现为**进程内计数信号量**即可，不必做「拾取事务 + 每秒重试拾取」的编排；13 章「系统真实并发容量=该值」的叙事保留为文档观点 |
| O3 | `account.version` 乐观锁列 | ✂️ 砍 | 状态 CAS 全走条件更新（设计自己说 version 只是「兜底」），`platform_user_id` 写入无并发对手（connect 幂等）。留一列没人用的版本号是给读者埋疑问 |
| O4 | WS 多实例 LISTEN/NOTIFY + 2s 兜底轮询（08 §2.2） | ⏸ 延后 | 单实例演示为默认（01 §5 自己说的）；先内存通知，NOTIFY 留接口不实现。多实例正确性已由 DB 约束满足（这是契约唯一要求的多实例性质） |
| O5 | 13-capacity 的业务推导（群控+AI 销售、千级账号池） | ✅ 保留 | 自设业务上下文有风险（题目没给），但全文的结论都是「**不引入**」+ 触发器表，恰好展示判断力而非堆料。注意实现时不要被它反向驱动（比如真去做账号缓存） |

**反过度设计的正面清单（这些都不要砍）**：连续前缀游标、gateway_event 账本、死信、ws_event 表（sinceSeq 的真值）、部分唯一索引、执行器 advisory lock、opaque token、双 provider mock、微批「标记为选项不实现」、外部成员不建模、job.context 用 jsonb。——它们要么是契约直接要求，要么是正确性的最简形态。

**总体判定**：设计整体是「克制的深」而非「堆砌的深」，六原则与容量文档的纪律性明显；O1–O4 裁剪后可回收约 8–15 实现小时，且砍掉的恰是最难测的部分。

---

## 3. 120 分路线（满分 100 的加分策略）

前提认知：这是「做到哪算哪」的完成度评分考试。**100 分 = A/B 组行为全对且可演示；120 分 = 在此基础上，让评审者以最低成本确认「这个人做过真正的分布式系统」**。以下按投入产出比排序：

### 3.1 先修缺陷，再开工（0.5 天，保住基本盘）

D1-1/D1-2/D1-3 都在「任意时刻重启」这条总则路径上——笔试的题眼。带着缺陷开工，最难的测试会先红，返工成本 ×3。X-1/X-2 改判各只需改一段文档。**本报告 §2.3/§2.2 的修复建议可直接落回对应设计文档**（按 README 约定：先改文档后改代码）。

### 3.2 五个评审可见的加分动作（按性价比排序）

1. **把「崩溃一致性」做成可见证据**（差异化最强，别人基本不会有）：
   - `withCrashPoint(name, fn)` 测试脚手架 + 在四个契约点各杀一次进程的集成测试（queued 未发 / turn 已发未收 / tool_dispatched / 序列排期中）——design/10 §5 已设计，落实现；
   - I1–I14 每条至少一个具名测试（G4 的映射文件），测试名直接引用不变量编号；
   - README 一章「如何验证重启不变量」：一条命令跑崩溃测试套件。
2. **S1–S8 一键演示**：每个场景一条命令（`pnpm demo:s5` = 起 mock 开关 + 触发 + 断言输出），README 附每场景的「预期看到什么」两行说明；再录 2–3 分钟 asciinema/GIF（评审者没义务跑起来才给分）。**mock 的 19+ 故障开关面板本身就是展品**——它证明你把契约读到了字面以下。
3. **C 组全收**：C1 已设计完（成本低）；C2 有双 provider 设计 + 真实 LLM 录屏（评审无 key，录屏是唯一展示方式）；C3 一条 Playwright 冒烟（登录→群→看到 run steps，1–2h；考题明文列出，构成对全局 E2E 红线的「明确要求」候选——按 §2.1 G5 请你拍板，建议做）。
4. **诚实完成度表 + 契约解释声明**：README 三栏（完成/部分/未做）+ 全部【解读】项汇总（§2.2 清单）。「做到哪算哪」的评分制下，**主动声明边界比假装完整可信得多**；解释声明同时 preempt 了评审对 X-1/X-2 类分歧点的质疑。
5. **git 历史即交付物**（§5 明文「保留 git 历史」）：小步提交、conventional、message 引用设计文档章节（如 `feat(agent): turn loop per design/06 §3`）。评审翻历史时看到的是一部有序的建造过程——这是 48h 内伪造不出来的信号，从现在 scaffolding 起就严格执行。

### 3.3 分阶段裁剪作战图（对 R1 的正面回答）

原则：**每个阶段结束时仓库处于可演示、可提交状态**；时间不够时，后面的阶段整体不做（而不是每个阶段做一半）。

| 阶段 | 内容 | 预估 | 累计产出 |
|---|---|---|---|
| P0 | 修文档缺陷（§3.1）+ 脚手架 + 迁移 + A0 + docker-compose | 4h | 服务可起、health 可查 |
| P1 | mock-gateway 核心（正常路径 + S1/S2 开关）→ 补设计文档 G1 先行 | 6h | 网关可联调 |
| P2 | A2 入站（SSE+前缀游标+死信）+ A1 状态机 + A4 时间线 | 8h | 时间线活起来 |
| P3 | A3 建群 job + A2 出站（含 unknown 判定/单次重发）+ B2 leave-all | 8h | S1–S4 可演示 |
| P4 | mock-agent scripted + A5 全量（含恢复）| 12h | S5/S6 可演示——**全场最重的一段，P0–P3 超支时优先压缩 P3 的对账类 embellishment** |
| P5 | 前端页面 1–3（A6）+ B3 会话 | 8h | 控制台可操作 |
| P6 | B1 序列 + 页面 5 + B4/页面 4 | 8h | S7/S8 可演示 |
| P7 | 崩溃测试套件 + I 映射（§3.2-1）| 6h | 差异化证据 |
| P8 | C2 + C1 + C3 + README/录屏/完成度表 | 8h | 加分收尾 |
| 缓冲 | — | 4h | — |

合计 ≈ 72h——**仍超 48h**，所以裁剪预案现在就定：超时先砍顺序 = O1–O4（已建议）→ C1 → leave-all 的 5s 核对/终局对账（保留契约最小行为）→ 页面 5 的预检弹窗美化（保留 422 展示）。**A5 恢复路径与 P7 崩溃测试永不砍**——它们是这道题的身份标识。

### 3.4 负面清单（120 分的路上不要做的事）

- 不要再扩写设计文档（4400 行已是上限；review/ 本报告是最后一篇，后续修订以 patch 形式回写原文档）；
- 不要实现 13 章的任何扩容触发器（分区/缓存/对象存储）；
- 不要为 UI 视觉加分投入（题目明说「不需要 i18n、主题、响应式」，全局策略也只要求状态正确性）；
- 不要引入 Redis/MQ/BullMQ「以防万一」；
- 不要弱化 mock 的故障行为来让测试变绿（宪法 §3-8）。

---

## 4. 实现前行动清单（可直接执行）

> 2026-09-27 修订回写完成：1–12 已落地，13 待用户裁决，14 未开始。

1. ☑ 按 §2.3 D1-1 修订死信事务三写同事务 → [design/08](../design/08-realtime-module.md) §1.2、[design/01](../design/01-architecture.md) §4.5、[design/02](../design/02-data-model.md) §1.4、[design/05](../design/05-messaging-module.md) §3；
2. ☑ 按 D1-2 修订终态取消范围 + unknown 转换 + 202 回卫 → [design/03](../design/03-account-module.md) §4（T3 与细节 1）、[design/05](../design/05-messaging-module.md) §1/§2.1、[design/02](../design/02-data-model.md) §9；
3. ☑ 按 D1-3 修订共享 `finalizeSent` 合并函数 + 序列联动 → [design/05](../design/05-messaging-module.md) §4.3（唯一收口）/§2.4/§2.5；
4. ☑ 按 X-1 修订 kick 错误码收敛进 13 码表 → [design/06](../design/06-agent-module.md) §8.5（+错误码封闭性说明）；
5. ☑ 按 X-2 删「效果型工具执行前」检查点 → [design/06](../design/06-agent-module.md) §10（GATE1 通用化：§8.2/§8.4）；
6. ☑ 按 D2-1 修订 `last_event_id` + 墓碑行 + 终态检查 → [design/04](../design/04-group-module.md) §4、[design/02](../design/02-data-model.md) §4.2；
7. ☑ 按 D2-2 修订 ALREADY_MEMBER UPSERT 成员行 → [design/04](../design/04-group-module.md) §2.2（WJM/W_ADMIN/要点）；
8. ☑ 按 D2-5 修订限流登记状态守卫 → [design/03](../design/03-account-module.md) §5.1；
9. ☑ D3-1…D3-6 文档补写 → D3-1 [08](../design/08-realtime-module.md) §1.2；D3-2 [01](../design/01-architecture.md) §7；D3-3 [08](../design/08-realtime-module.md) §2.3；D3-4 [03](../design/03-account-module.md) §3；D3-5 [05](../design/05-messaging-module.md) §4.3；D3-6 [05](../design/05-messaging-module.md) §2.1.1（+ [07](../design/07-sequence-module.md) §1）；
10. ☑ O1–O4 裁剪回写 → O1 [06](../design/06-agent-module.md) §2.1/§9.4；O2 [01](../design/01-architecture.md) §6.1 + [06](../design/06-agent-module.md) §2.1；O3 [02](../design/02-data-model.md) §3.1；O4 [08](../design/08-realtime-module.md) §2.2 + [01](../design/01-architecture.md) §4.7（残留句同步：[10](../design/10-reliability.md) §3/§6、[13](../design/13-capacity.md) §6）；
11. ☑ 新增 [design/14-gateway-service.md](../design/14-gateway-service.md)（G1，28 项开关映射表 + `/_test` 控制平面 + eventId 跨 reset 不复用）与 [design/15-web-console.md](../design/15-web-console.md)（G2，五页面 × 数据流 + WS 客户端 + 测试点）；
12. ☑ 建 [server/VITEST_PLAN.md](../../server/VITEST_PLAN.md)（G4：I×S×gw-28×ag-19 → 用例映射 + 崩溃注入 4 点 + 审查修复项回归 10 条）；
13. ☐ **用户裁决 C3（G5）**——建议做（≈1–2h 一条冒烟）；若不做，README 完成度表写明理由；
14. ☐ 按 §3.3 作战图开工 P0（脚手架 + 迁移 + A0 + docker-compose）。

附（本轮修订新增）：【解读】清单已汇总为 [design/README.md](../design/README.md)「契约解释声明」25 条；本报告 §2.3 各项的回归用例已列入 VITEST_PLAN §5。

> 修订完成后，本报告 §2.3 各条应回链到设计文档的对应修订段落；踩坑记录（AGENTS.md §7）从第一条真实开发坑开始记，本报告发现的 D1 系列若在实现期再次以其他形态出现，按规则升级为宪法条目。

---

## 5. 修订复核记录（check round，2026-09-27 晚）

> 复核方法：不读修订说明、直接重读修订后的文档全文，对 §4 清单 1–12 逐项做「按图施工」推演（重跑一遍崩溃窗口与乱序时序），并对三篇新文档做首轮审查。

### 5.1 逐项核验结论：12/12 落地，质量合格

| 项 | 核验结论 |
|---|---|
| D1-1 死信三写同事务 | ✅ 08 §1.2 / 01 §4.5 / 02 §1.4 / 05 §3 四处一致；「重试时 a) 冲突跳过」与账本补写的闭合关系已写明 |
| D1-2 终态取消收窄 | ✅ 03 §4 T3（`first_attempt_at IS NULL` 才 cancel；在途转 unknown）+ T4 步骤联动同范围收窄；05 §1 状态机、§2.1 SA 守卫放宽 `IN ('queued','unknown')`、02 §9 I6 行、README 解释声明 #12 全链一致。推演过 202/message_sent/再 504 三条竞态路径，均收敛 |
| D1-3 finalizeSent | ✅ 05 §4.3 预检→先删占位行→再更新 M 行（审计字段随行迁移是超出建议的加分项，保住 I2 证据链）；§2.4 by-client-id 200 与 §2.5 事件路径统一收口；序列联动、agent 5s 等待透明性、重复调用幂等均覆盖；D3-5 瞬态已声明（README #24） |
| X-1 kick 错误码 | ✅ 06 §8.5 收敛为表内 `SEND_FAILED`+message 细节，错误码封闭性成段声明；README #13 |
| X-2 取消检查点 | ✅ 06 §10 只剩循环顶部检查点；GATE1 通用化到 kick（§8.4 门槛 3）；「不存在半个步」的语义已写死 |
| D2-1 成员乱序 | ✅（主体）`last_event_id` 单调 + 墓碑行 + INSERT 分支终态检查已落 02 §4.2 / 04 §4；**残留一处，见 5.2 R-A** |
| D2-2 ALREADY_MEMBER | ✅ WJM/W_ADMIN 双 UPSERT + §4 例外 3；**同文档一处旧句未同步，见 5.2 R-C** |
| D2-5 限流守卫 | ✅ 03 §5.1 `WHERE status IN ('online','rate_limited')` + rowcount=0 记 warn |
| D3-1…D3-6 | ✅ 孤儿事件分流（08 §1.2）/ 恢复=登记+异步交接（01 §7）/ WS payload（08 §2.3）/ 手动 rate_limited 必带 `rateLimitedUntil`（03 §3+§6，README #14）/ 瞬态声明 / `TEXT_MAX_LENGTH=2000`（05 §2.1.1 + 07 §1，README #15） |
| O1–O4 裁剪 | ✅ 租约降级观测（06 §2.1/§9.4，10 §3/§6、13 §6 同步）；并发闸=进程内信号量（01 §6.1）；`account.version` 已删（02 §3.1）；NOTIFY 预留不实现（08 §2.2 + 01 §4.7）；**13 §3 轴 6 一处旧词，见 5.2 R-D** |
| design/14（G1） | ✅ 28 项开关映射表与 analysis/02 契约行为逐条对得上；`/_test` 控制平面 + counters 作为验收真值来源；**「eventId 跨 reset 不复用」是修订者自行发现的关键坑，超出审查建议，加分**；两处编辑性问题见 5.2 R-F/R-G |
| design/15（G2）+ VITEST_PLAN（G4） | ✅ 15 覆盖 WS 客户端/单飞续期/时间线合并/transition 合法目标面板/预检弹窗/第 1、2 层测试点；VITEST_PLAN 四类映射（I×S×gw28×ag19）+ 崩溃 4 点 + 审查回归 10 条齐备。15 一处措辞见 5.2 R-E |
| README 契约解释声明 | ✅ 25 条汇总落地（§2.2 建议项），新增解读均编号入册 |

### 5.2 残留问题（本轮新发现，含一处审查首轮漏检）

**R-A（🟡 中，设计需一行修订）：`member_joined` 复活分支缺终态检查。** [design/04 §4](../design/04-group-module.md) U1「有且 left_at 非空 → 复活」只校验 `E > last_event_id`，未校验账号 `terminal_at`。场景：leave(E2)→rejoin(E3) 的 joined 事件迟到至终态处理（account_status E5 / 同步错误）之后到达，且 E3 > 行上 last_event_id → 终态账号被复活为活跃成员，违反「终态时从所有群成员表移除」。INSERT 分支（I1）已有终态检查，复活分支应对称补上：**复活前先查 `terminal_at`，非空 → 按 STALE 处理（只补 joined_at）**。VITEST_PLAN §5 的 D2-1 回归行需补该场景（现有描述只覆盖 E1<E2 的先后到）。另（更边缘）：TOMB 分支 `ON CONFLICT DO NOTHING` 不推进 `last_event_id`，双 leave 循环下迟到 joined 可越过第二道防线——同事务里 `DO UPDATE SET last_event_id=GREATEST(...)` 即可，随 R-A 一并处理。

**R-B（🟡 低中，设计需补一句守卫；审查首轮漏检，本轮推演 END2 时发现）：run 结束事务与兜底扫描补建 run 前未复查群状态。** [design/06 §2](../design/06-agent-module.md) END2 第 3 步与 SWEEP 只判「积压非空/无 running run」，不判 `group.status='active' AND agent_enabled=true`（入站触发路径 05 §4.4 有判）。后果：run 因 unreachable/关开关被 cancelled 后，若 trigger_queue 有积压，会立刻补建一个「出生即取消」的 run——run 行与 WS 事件churn，且按 A2「agent 不再触发」的字面读法属违约。**修复**：END2 与 SWEEP 补同一守卫；守卫不过时积压行的去留需定（建议：保留行不删——agentEnabled 重新打开时由 SWEEP 用积压补建，恰好实现「重新启用后补处理」，并把该语义写进 README 解释声明）。

**编辑性问题（不阻塞，随下次触碰对应文档时顺手改）：**

| # | 位置 | 问题 |
|---|---|---|
| R-C | 04 §2.2 要点核对末条 | 「job 执行器**不直接写**非 creator 成员」与同文档新增的 WJM/W_ADMIN UPSERT（§4 例外 3）矛盾；改为「除 §4 三个例外，job 执行器不直接写非 creator 成员」 |
| R-D | 13 §3 轴 6 | 「租约**回收**……保证并发不泄漏」是 O1 裁剪前旧词；改「租约观测」 |
| R-E | 15 §2 页面 1 | 「存 access/**refresh**」违反 B3 语感——refresh 只在 HttpOnly cookie，前端不可读不可存；改为「存 access（refresh 由 HttpOnly cookie 承载）」 |
| R-F | 14 §2 | message 状态模型 `clientMsgId → {…}` 是单对象，与「同 id 两条是两条落地记录（by-client-id 返回最早一条）」矛盾；应为 `clientMsgId → […有序列表]` |
| R-G | 14 §5 gw-5 | `offline_backlog` 把两件事混在一起：SSE 断线重连回放（`since` 默认行为，无需开关）与**账号离线补投**（新 eventId、原 msgId/sentAt，需显式注入语义）。VITEST 的 gw-5→timeline-pagination 用例需要的是后者；开关 spec 应写明补投帧的生成方式（专用开关行为或 `/_test/emit` 配方） |

### 5.3 复核结论

> **修订质量合格，放行 P0 开工**——前置条件仅剩两条设计小修（R-A、R-B，合计约 10 分钟文档改动 + VITEST_PLAN 两行更新），编辑性问题 R-C…R-G 随下次触碰顺手改。契约数字在本轮修订中经抽查零改写（5s/2s/10s/12 步/60s/3 次/≤2 次/15min 原样）；11-verification 矩阵无需变更（修订均在原引用章节内）；解释声明制度已建立并收录本轮新增 4 条。
