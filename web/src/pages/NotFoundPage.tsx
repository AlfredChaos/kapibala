// 404 兜底页（DES/15 §1 路由表 `*` 行）：不再静默重定向——未知路径显式落此页，
// 导航壳仍在（AppShell 由 RequireAuth 装配，本页也挂在其子树内）。
import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';

export function NotFoundPage(): JSX.Element {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center px-5 py-24 text-center">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-hairline bg-surface-1 text-ink-tertiary">
        <Compass size={22} aria-hidden />
      </span>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">404</h1>
      <p className="mt-2 text-sm text-ink-subtle">页面不存在。</p>
      <Link
        to="/dashboard"
        className="mt-6 rounded-md border border-hairline bg-surface-1 px-3.5 py-2 text-sm text-ink transition-colors duration-150 hover:border-hairline-strong hover:bg-surface-2"
      >
        返回工作台
      </Link>
    </main>
  );
}
