// 登录页（T-P5-01；DES/15 §2 页面 1、REQ §4、DES/09 §5）。
// 契约：POST /api/auth/login → 存 access（refresh 走 HttpOnly cookie，本页不碰）；
// 错误按 error.code 显示（UNAUTHORIZED = 用户名或密码错误——服务端统一文案不区分）；
// 成功跳 /accounts。
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { isApiError, useAuth } from '../auth/AuthProvider.js';

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
    return <Navigate to="/accounts" replace />;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate('/accounts', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: '22rem', margin: '4rem auto' }}>
      <h1>kapibala console</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label htmlFor="login-username">用户名</label>
        <input
          id="login-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <label htmlFor="login-password">密码</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error !== null && (
          <p role="alert" style={{ color: 'crimson' }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
