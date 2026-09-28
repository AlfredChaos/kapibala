// 404 兜底页（DES/15 §1 路由表 `*` 行）：不再静默重定向——未知路径显式落此页，
// 导航壳仍在（AppShell 由 RequireAuth 装配，本页也挂在其子树内）。
import { Link } from 'react-router-dom';

export function NotFoundPage(): JSX.Element {
  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: '40rem', margin: '4rem auto' }}>
      <h1>404</h1>
      <p>页面不存在。</p>
      <p>
        <Link to="/accounts">返回账号列表</Link>
      </p>
    </main>
  );
}
