// 登录页（T-P5-01；DES/15 §2 页面 1、REQ §4、DES/09 §5）。
// 契约：POST /api/auth/login → 存 access（refresh 走 HttpOnly cookie，本页不碰）；
// 错误按 error.code 显示（UNAUTHORIZED = 用户名或密码错误——服务端统一文案不区分）；
// 成功跳 /dashboard（工作台是落地页——DES/15 §2 页面 2；早前版本写 /accounts 已过时）。
import { LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { isApiError, useAuth } from '../auth/AuthProvider.js';
import { Button, Field, Input } from '../ui/primitives.js';

/** code → 用户可读文案（§2 页面 1：按 error.code 显示） */
function errorText(err: unknown): string {
  if (isApiError(err)) {
    switch (err.code) {
      case 'UNAUTHORIZED':
        return '用户名或密码错误';
      case 'VALIDATION_ERROR':
        return '请输入用户名和密码';
      default:
        return `登录失败（${err.code}）`;
    }
  }
  return '网络错误，请稍后重试';
}

export function LoginPage(): JSX.Element {
  const { login, session } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 已登录直接进 console（声明式重定向——渲染期调 navigate 会触发渲染期更新警告）
  if (session !== null) {
    return <Navigate to="/dashboard" replace />;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-lg font-semibold text-on-primary">
            K
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">kapibala console</h1>
          <p className="text-sm text-ink-subtle">多账号群组消息平台 · 运营控制台</p>
        </div>
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface-1 p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
        >
          <Field label="用户名" htmlFor="login-username">
            <Input
              id="login-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </Field>
          <Field label="密码" htmlFor="login-password">
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          {error !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full">
            <LogIn size={14} aria-hidden />
            {busy ? '登录中…' : '登录'}
          </Button>
        </form>
      </div>
    </main>
  );
}
