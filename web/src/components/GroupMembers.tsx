// 群成员列表（T-P5-04；DES/15 §2 页面 3、DES/04 §5 成员形状）。
// 形状逐字：members = [{accountId, platformUserId, role(creator|admin|member)}]，
// 服务端已按 creator → admin → member 排序输出（§5），前端不再重排。
import type { GroupMemberView } from '../lib/api-types.js';

export function GroupMembers(props: { members: GroupMemberView[] }): JSX.Element {
  if (props.members.length === 0) {
    return <p data-testid="members-empty">无成员</p>;
  }
  return (
    <ul data-testid="member-list" style={{ listStyle: 'none', padding: 0 }}>
      {props.members.map((m) => (
        <li key={m.accountId} style={{ padding: '0.25rem 0', borderBottom: '1px solid #eee' }}>
          <strong>{m.platformUserId}</strong>
          <span style={{ marginLeft: '0.5rem', color: '#555' }}>{m.accountId}</span>
          <span
            data-testid={`member-role-${m.accountId}`}
            style={{ marginLeft: '0.5rem' }}
          >
            {m.role}
          </span>
        </li>
      ))}
    </ul>
  );
}
