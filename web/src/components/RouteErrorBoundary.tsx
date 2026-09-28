// 路由级 ErrorBoundary（用户要求 2026-09-28）：子树渲染期抛错 → 兜底落 404 视觉页，
// 不让白屏/React 默认 unmount 行为裸奔到用户面前。
// 边界说明：React 18 + Data Router 下，组件 render 错误不被 errorElement 捕获
// （errorElement 只管 loader/action/路由层）——class boundary 是唯一可靠兜底；
// 挂在 RequireAuth 子树内：导航壳保留，仅内容区被替换。
// 有意不记日志上报：本仓无 telemetry 管道；console.error 已由 React 默认输出，不重复吞错。
import { Component, type ReactNode } from 'react';
import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly hasError: boolean;
}

export class RouteErrorBoundary extends Component<Props, State> {
  public constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    // 复用 NotFoundPage 的视觉形态（DES/15 §1 同一兜底语义），标题语义区分「不存在」与「出错」
    return (
      <main className="mx-auto flex max-w-md flex-col items-center px-5 py-24 text-center">
        <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-hairline bg-surface-1 text-ink-tertiary">
          <Compass size={22} aria-hidden />
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">404</h1>
        <p className="mt-2 text-sm text-ink-subtle">页面出错了，或内容不存在。</p>
        <Link
          to="/dashboard"
          className="mt-6 rounded-md border border-hairline bg-surface-1 px-3.5 py-2 text-sm text-ink transition-colors duration-150 hover:border-hairline-strong hover:bg-surface-2"
        >
          返回工作台
        </Link>
      </main>
    );
  }
}
