// 全局导航壳（DES/15 §1 路由表 + §2 页面骨架、REQ §4 页面框架）。
// 挂载点：router.tsx 的 RequireAuth——守卫通过后所有 authed 页面共享顶栏。
// 三块：① 左 NavLink 组（账号/群/序列，当前路由加粗+下划线）；② 右侧 username + role + 登出；
// ③ RealtimeBanner：WS inconsistency 帧（DES/08 §2.2/§2.3）收口——
//   kind='ws_backlog_expired' → 常驻红条「连接积压已过期，数据可能不完整」+「重新加载」
//   （lastSeq 水位失效：补发窗口过期，页面数据可能不完整，用户动作兜底 = 整页重载）——
//   走 DES/15 §3 末条设计收口 useWsBacklogExpired（WsClient.onBacklogExpired 的 React 侧
//   接线），inconsistency 订阅里同 kind 帧跳过避免双条；
//   其余 kind → 可关闭琥珀条（原文 kind/message 透出——对账告警逐字展示）。
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { useWsBacklogExpired, useWsEvent } from '../ws/useWsEvent.js';

const NAV_ITEMS = [
  { to: '/accounts', label: '账号' },
  { to: '/groups', label: '群' },
  { to: '/sequences', label: '序列' },
] as const;

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
          style={{ background: '#c00', color: '#fff', padding: '0.4rem 1rem' }}
        >
          连接积压已过期，数据可能不完整
          <button
            type="button"
            style={{ marginLeft: '0.8rem' }}
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
          style={{
            background: '#fff3cd',
            color: '#664d03',
            padding: '0.4rem 1rem',
            borderBottom: '1px solid #ffe69c',
          }}
        >
          {alert.kind}：{alert.message}
          <button
            type="button"
            aria-label="关闭"
            style={{ marginLeft: '0.8rem' }}
            onClick={() => setAlert(null)}
          >
            ×
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

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.5rem 1rem',
          borderBottom: '1px solid #ccc',
        }}
      >
        <nav style={{ display: 'flex', gap: '0.8rem' }} aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                fontWeight: isActive ? 'bold' : 'normal',
                textDecoration: isActive ? 'underline' : 'none',
                color: 'inherit',
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <span data-testid="session-user">
            {session?.user.username}（{session?.user.role}）
          </span>
          <button type="button" onClick={() => void onLogout()}>
            登出
          </button>
        </div>
      </header>
      <RealtimeBanner />
      {props.children}
    </div>
  );
}
