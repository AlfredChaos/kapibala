// 路由（T-P5-01；DES/15 §1 路由表 + 守卫规则）。
// 守卫逐字：未登录 → /login；viewer 不做页面级限制（按钮级控制，服务端仍是权威——
// 403 由调用方处理为提示）。后续页面的占位：pages/* 归各自 T-P5 卡片。
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider.js';
import { LoginPage } from './pages/LoginPage.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { GroupDetailPage } from './pages/GroupDetailPage.js';
import { AgentRunPage } from './pages/AgentRunPage.js';

/** 路由守卫：无会话 → /login（replace 防历史栈污染）。导出供守卫行为测试直挂 */
export function RequireAuth(): JSX.Element {
  const { session } = useAuth();
  if (session === null) return <Navigate to="/login" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <Navigate to="/accounts" replace /> },
      { path: '/accounts', element: <AccountsPage /> },
      { path: '/groups/:id', element: <GroupDetailPage /> },
      { path: '/agent-runs/:id', element: <AgentRunPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
