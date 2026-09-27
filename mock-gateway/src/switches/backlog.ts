// 注入类开关（T-P2-12）：arm（打开开关）时刻直接向账本注入契约事件，走正常 SSE 投放。
// - gw-5  `offline_backlog`：账号离线补投——**新 eventId、原值 msgId/sentAt**（REQ §2.1；DES/14 §5 行 5）。
//   R-G 定稿：这与「SSE 断线重连回放」是两件事——回放是 `?since=` 的**默认行为**（原 eventId、账本零新增、
//   不需要任何开关），本开关才产生**新事件**；两者绝不混为一个开关（DES/14 §1/§3、review R-G）。
// - gw-28 `external_member_events`：外部用户（非服务账号）进出群推成员事件（DES/14 §5 行 28）。
// 两者都是 arrange 配方：注入即入账本（appendLedger 是唯一的帧产生入口），因此 framesEmitted 照计、
// eventId 由分配器单调分配（补投帧的 eventId 必然大于此前所有帧）。
import { appendLedger, type GatewayState, type MockGroupState, type MockMessageRecord, type SwitchConfig } from '../state.js';
import { readNumberParam, readStringParam, readTargetString } from '../switches.js';

/**
 * gw-5：把该账号已落地的消息按「离线窗口」逐条补投（DES/14 §5 行 5：注入机制 = `/_test/emit` 配方）。
 * 补投帧 = 原 `message` 事件的业务字段逐字保留（msgId / sentAt / text / groupId / senderPlatformUserId），
 * eventId 新分配（必然更大）；**不产生第二条落地记录**（`landedMessages` 不增、messages 列表不动）——
 * 补投是投递语义（at-least-once），不是新消息。
 * target：`accountId`（必填，补投谁发的消息）、`groupId`（可选，只补投该群）。
 * params：`sentAtFromMs` / `sentAtUntilMs`（含端点，epoch ms）圈定离线窗口；缺省 = 该账号全部落地消息。
 * 返回 null = 成功；返回字符串 = arrange 失败（调用方 400 且开关不登记）。
 */
export function injectOfflineBacklog(state: GatewayState, config: SwitchConfig): string | null {
  const accountId = readTargetString(config, 'accountId');
  if (accountId === undefined) {
    return 'offline_backlog requires target.accountId';
  }
  const account = state.accounts.get(accountId);
  if (account === undefined) {
    return `unknown target account: ${accountId}`;
  }
  const groupId = readTargetString(config, 'groupId');
  if (groupId !== undefined && !state.groups.has(groupId)) {
    return `unknown target group: ${groupId}`;
  }

  const fromMs = readNumberParam(config, 'sentAtFromMs');
  const untilMs = readNumberParam(config, 'sentAtUntilMs');
  const selected: MockMessageRecord[] = [];
  for (const rows of state.messages.values()) {
    for (const row of rows) {
      if (!row.landed || row.senderPuid !== account.platformUserId) {
        continue;
      }
      if (groupId !== undefined && row.groupId !== groupId) {
        continue;
      }
      const sentAtMs = Date.parse(row.sentAt);
      if ((fromMs !== undefined && sentAtMs < fromMs) || (untilMs !== undefined && sentAtMs > untilMs)) {
        continue;
      }
      selected.push(row);
    }
  }
  if (selected.length === 0) {
    // 无命中一律当 arrange 写错（窗口/账号/群拼错）——静默无效会让用例假绿
    return `offline_backlog matched no landed message for account: ${accountId}`;
  }
  for (const row of selected) {
    // 落地序逐条 emit（DES/14 §5 行 5「按离线窗口逐条 emit」）；字段与 landMessage 的 message 帧一致
    appendLedger(state, 'message', {
      groupId: row.groupId,
      msgId: row.msgId,
      senderPlatformUserId: row.senderPuid,
      text: row.text,
      sentAt: row.sentAt,
      // gw-27 的媒体链接同样按原值补投（server 侧 C1 可能仍未下载过它）
      ...(row.mediaUrl === undefined ? {} : { mediaUrl: row.mediaUrl }),
    });
  }
  return null;
}

/**
 * gw-28：外部用户（非服务账号）进出群并推成员事件（DES/14 §5 行 28；REQ §2.1「外部用户进出群也会推这两种事件」）。
 * 外部用户 id 由 mock 自造 `ext-<seq>`（DES/14 §2 末行）；帧形状 = 契约 `{groupId, platformUserId}`。
 * 网关成员列表（`GET /groups/:id/members`）随之变化——外部成员是网关视角的真实成员，
 * server 侧对它**不建成员行**（DES/04 §4），本开关就是那条分流分支的驱动。
 * target：`groupId`（必填）。params：`action` = `joined`（默认）| `left`；`platformUserId`（可选，指定外部用户）。
 */
export function injectExternalMemberEvents(state: GatewayState, config: SwitchConfig): string | null {
  const groupId = readTargetString(config, 'groupId');
  if (groupId === undefined) {
    return 'external_member_events requires target.groupId';
  }
  const group = state.groups.get(groupId);
  if (group === undefined) {
    return `unknown target group: ${groupId}`;
  }
  const action = readStringParam(config, 'action') ?? 'joined';
  if (action !== 'joined' && action !== 'left') {
    return `external_member_events action must be 'joined' or 'left', got: ${JSON.stringify(action)}`;
  }
  const specified = readStringParam(config, 'platformUserId');
  if (action === 'joined') {
    const platformUserId = specified ?? `ext-${++state.extSeq}`;
    group.members.add(platformUserId);
    appendLedger(state, 'member_joined', { groupId, platformUserId });
    return null;
  }
  const platformUserId = specified ?? externalMembersOf(state, group)[0];
  if (platformUserId === undefined) {
    return `no external member in group: ${groupId}`;
  }
  if (!group.members.delete(platformUserId)) {
    return `external member not in group: ${platformUserId}`;
  }
  appendLedger(state, 'member_left', { groupId, platformUserId });
  return null;
}

/** 群内的外部成员（puid 不属于任何已知服务账号），按成员集插入序 */
function externalMembersOf(state: GatewayState, group: MockGroupState): string[] {
  const servicePuids = new Set<string>();
  for (const account of state.accounts.values()) {
    servicePuids.add(account.platformUserId);
  }
  return [...group.members].filter((platformUserId) => !servicePuids.has(platformUserId));
}
