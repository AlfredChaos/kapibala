// 全局工作台壳（侧边栏形态；DES/15 §1 路由表 + §2 页面骨架、REQ §4 页面框架）。
// 挂载点：router.tsx 的 RequireAuth——守卫通过后所有 authed 页面共享侧栏。
// 布局：左侧固定 240px 侧栏（品牌 + 工作台/账号/群/序列导航 + 底部用户卡）；
// 右侧内容列顶部保留 RealtimeBanner：WS inconsistency 帧（DES/08 §2.2/§2.3）收口——
//   kind='ws_backlog_expired' → 常驻红条「连接积压已过期，数据可能不完整」+「重新加载」
//   （lastSeq 水位失效：补发窗口过期，页面数据可能不完整，用户动作兜底 = 整页重载）——
//   走 DES/15 §3 末条设计收口 useWsBacklogExpired（WsClient.onBacklogExpired 的 React 侧
//   接线），inconsistency 订阅里同 kind 帧跳过避免双条；
//   其余 kind → 可关闭琥珀条（原文 kind/message 透出——对账告警逐字展示）。
import {
  LayoutDashboard,
  LogOut,
  MessageSquare,
  ListOrdered,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { cx } from '../ui/cx.js';
import { useWsBacklogExpired, useWsEvent } from '../ws/useWsEvent.js';

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/dashboard', label: '工作台', icon: LayoutDashboard },
  { to: '/accounts', label: '账号', icon: Users },
  { to: '/groups', label: '群', icon: MessageSquare },
  { to: '/sequences', label: '序列', icon: ListOrdered },
];

/** 实时告警横幅：inconsistency 帧按 kind 分流（DES/08 §2.2 ws_backlog_expired 为页面级兜底） */
function RealtimeBanner(): JSX.Element | null {
  const [alert, setAlert] = useState<{ kind: string; message: string } | null>(null);
  const [backlogExpired, setBacklogExpired] = useState(false);

  useWsEvent('inconsistency', (f) => {
    if (f.payload.kind === 'ws_backlog_expired') return; // 该 kind 走下方专用收口——不重复出条
    setAlert({ kind: f.payload.kind, message: f.payload.message });
  });
  // 积压过期 = 补发窗口失效：专用收口置常驻红条（唯一收敛动作 = 用户触发整页重载）
  useWsBacklogExpired(() => setBacklogExpired(true));
  return (
    <>
      {backlogExpired && (
        <div
          role="alert"
          data-testid="ws-backlog-expired-banner"
          className="flex items-center justify-center gap-3 border-b border-danger/50 bg-danger/15 px-4 py-2 text-sm text-danger"
        >
          <TriangleAlert size={14} aria-hidden />
          连接积压已过期，数据可能不完整
          <button
            type="button"
            className="cursor-pointer rounded-sm border border-danger/50 px-2 py-0.5 text-xs transition-colors duration-150 hover:bg-danger/20"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      )}
      {alert !== null && (
        <div
          role="alert"
          data-testid="ws-inconsistency-banner"
          className="flex items-center justify-center gap-3 border-b border-warn/40 bg-warn/10 px-4 py-2 text-sm text-warn"
        >
          <TriangleAlert size={14} aria-hidden />
          <span className="min-w-0 flex-1 text-center">
            {alert.kind}：{alert.message}
          </span>
          <button
            type="button"
            aria-label="关闭"
            className="cursor-pointer rounded-sm p-0.5 transition-colors duration-150 hover:bg-warn/20"
            onClick={() => setAlert(null)}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}

export function AppShell(props: { children: ReactNode }): JSX.Element {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

  // 登出后守卫也会因 session=null 导回 /login；显式 navigate 保证路由立即落地（replace 防历史栈污染）
  async function onLogout(): Promise<void> {
    try {
      await logout();
    } catch {
      // logout 内部已吞 401；其余失败照样清掉了本地会话（finally）——导航不阻断
    }
    navigate('/login', { replace: true });
  }

  const initials = (session?.user.username ?? '?').slice(0, 1).toUpperCase();

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      {/* 侧栏（工作台形态）：品牌 + 主导航 + 底部用户卡 */}
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-hairline bg-surface-1">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-semibold text-on-primary">
            K
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-tight">kapibala</div>
            <div className="text-[10px] text-ink-tertiary">运营控制台</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2.5" aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors duration-150',
                  isActive
                    ? 'bg-surface-2 font-medium text-ink'
                    : 'text-ink-subtle hover:bg-surface-2/60 hover:text-ink',
                )
              }
            >
              <item.icon size={15} aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-hairline p-3">
          <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-medium text-ink-muted">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <div data-testid="session-user" className="truncate text-xs text-ink">
                {session?.user.username}
                <span className="text-ink-tertiary">（{session?.user.role}）</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void onLogout()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-hairline px-2 py-1 text-xs text-ink-subtle transition-colors duration-150 hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
            >
              <LogOut size={12} aria-hidden />
              登出
            </button>
          </div>
        </div>
      </aside>
      {/* 内容列：告警横幅 + 页面 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <RealtimeBanner />
        <div className="min-w-0 flex-1">{props.children}</div>
      </div>
    </div>
  );
}
