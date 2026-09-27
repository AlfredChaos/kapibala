// 占位组件（T-P0-01）：仅让 web 骨架可启动。页面/路由/数据层归 T-P5 各任务。
export function App(): JSX.Element {
  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>kapibala console</h1>
      <p>web scaffold (T-P0-01) — pages land with T-P5 tasks.</p>
    </main>
  );
}
