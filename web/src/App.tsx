// 应用根（T-P5-01）：AuthProvider 包路由——守卫与会话接线都在 AuthProvider 内完成。
import { AuthProvider } from './auth/AuthProvider.js';
import { AppRouter } from './router.js';

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  );
}
