// 群成员列表（T-P5-04；DES/15 §2 页面 3、DES/04 §5 成员形状）。
// 形状逐字：members = [{accountId, platformUserId, role(creator|admin|member)}]，
// 服务端已按 creator → admin → member 排序输出（§5），前端不再重排。
import { Crown, Shield, User } from 'lucide-react';
import type { GroupMemberView } from '../lib/api-types.js';
import { EmptyState, Tag } from '../ui/primitives.js';

const ROLE_ICON = {
  creator: <Crown size={12} className="text-warn" aria-hidden />,
  admin: <Shield size={12} className="text-info" aria-hidden />,
  member: <User size={12} className="text-ink-tertiary" aria-hidden />,
} as const;

export function GroupMembers(props: { members: GroupMemberView[] }): JSX.Element {
  if (props.members.length === 0) {
    return <EmptyState data-testid="members-empty">无成员</EmptyState>;
  }
  return (
    <ul data-testid="member-list" className="divide-y divide-hairline/60">
      {props.members.map((m) => (
        <li key={m.accountId} className="flex items-center gap-2 py-2">
          <strong className="font-mono text-xs text-ink">{m.platformUserId}</strong>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-tertiary">
            {m.accountId}
          </span>
          <Tag data-testid={`member-role-${m.accountId}`}>
            <span className="mr-1 inline-flex items-center">{ROLE_ICON[m.role]}</span>
            {m.role}
          </Tag>
        </li>
      ))}
    </ul>
  );
}
