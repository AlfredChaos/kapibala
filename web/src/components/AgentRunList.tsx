// Agent run 区块（T-P5-04；DES/15 §2 页面 3 逐字「agent run blocked 醒目提示——
// 顶部横幅 + run 区块标红，A5 audit_blocked 可操作员可见」）。
// 本组件只渲染列表 + 行级标红；「顶部横幅」由 GroupDetailPage 在有 blocked run 时渲染
// （横幅是页面级警示，不是列表行级装饰）。无视觉打磨（卡片 d 负面清单）——标红用
// data-blocked 标记 + 最小内联样式，A6 断言锚点。
import type { AgentRunView } from '../lib/api-types.js';

export interface AgentRunListProps {
  readonly runs: AgentRunView[];
}

export function AgentRunList(props: AgentRunListProps): JSX.Element {
  if (props.runs.length === 0) {
    return <p data-testid="runs-empty">暂无 agent run</p>;
  }
  return (
    <ul data-testid="agent-run-list" style={{ listStyle: 'none', padding: 0 }}>
      {props.runs.map((run) => {
        const blocked = run.status === 'blocked';
        return (
          <li
            key={run.id}
            data-testid={`agent-run-${run.id}`}
            data-blocked={blocked ? 'true' : undefined}
            style={{
              padding: '0.4rem 0.5rem',
              borderBottom: '1px solid #eee',
              // blocked 醒目（页面 3 逐字）：红底纹 + 红左边条
              background: blocked ? '#fdecec' : undefined,
              borderLeft: blocked ? '4px solid #c00' : undefined,
            }}
          >
            <strong>{run.id}</strong>
            <span style={{ marginLeft: '0.5rem' }}>{run.status}</span>
            {run.endReason !== null && (
              <span style={{ marginLeft: '0.5rem', color: blocked ? '#c00' : '#555' }}>
                {run.endReason}
              </span>
            )}
            <span style={{ marginLeft: '0.5rem', color: '#888' }}>{run.createdAt}</span>
          </li>
        );
      })}
    </ul>
  );
}
