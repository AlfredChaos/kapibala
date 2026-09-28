// 路由（T-P5-01；DES/15 §1 路由表 + 守卫规则）。
// 守卫逐字：未登录 → /login；viewer 不做页面级限制（按钮级控制，服务端仍是权威——
// 403 由调用方处理为提示）。authed 区统一包 AppShell（导航 + 登出 + inconsistency 横幅）；
// `*` 兜底改显式 NotFoundPage（仍在守卫内——未登录撞未知路径先去 /login）。
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider.js';
import { AppShell } from './components/AppShell.js';
import { LoginPage } from './pages/LoginPage.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { GroupsPage } from './pages/GroupsPage.js';
import { GroupDetailPage } from './pages/GroupDetailPage.js';
import { AgentRunPage } from './pages/AgentRunPage.js';
import { SequencesPage } from './pages/SequencesPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';

/** 路由守卫：无会话 → /login（replace 防历史栈污染）。导出供守卫行为测试直挂 */
export function RequireAuth(): JSX.Element {
  const { session } = useAuth();
  if (session === null) return <Navigate to="/login" replace />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <Navigate to="/accounts" replace /> },
      { path: '/accounts', element: <AccountsPage /> },
      { path: '/groups', element: <GroupsPage /> },
      { path: '/groups/:id', element: <GroupDetailPage /> },
      { path: '/agent-runs/:id', element: <AgentRunPage /> },
      { path: '/sequences', element: <SequencesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
