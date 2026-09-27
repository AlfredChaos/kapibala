// /sequences 页面（T-P6-07；DES/15 §2 页面 5、DES/07 §1/§2/§6、REQ §4 页面 5）。
// 三块：① 序列定义表单（steps 编辑+校验 → POST /api/sequences，本地列表登记）；
// ② 启动表单（选群 + vars/stepVars JSON 编辑器 → POST /api/groups/:id/sequence-runs；
//   422 UNRESOLVED_PLACEHOLDER → stepIndex/key 定位并高亮序列定义里出错的步骤行；
//   201 → GET run → PreflightModal 逐步渲染 resolvedVars/varSources）；
// ③ 运行视图（status/currentStepIndex + 每步 status/scheduledAt/sentAt；
//   WS sequence_run 帧推进 currentStepIndex/status 并同步重拉详情拿步级 sentAt）。
// 注意：后端无 GET /api/sequences 定义列表路由（QR §1 逐字）——本地登记本会话内创建的序列。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError, useAuth } from '../auth/AuthProvider.js';
import { PreflightModal } from '../components/PreflightModal.js';
import { SequenceForm, type SequenceDraft } from '../components/SequenceForm.js';
import type {
  GroupView,
  SequenceRunView,
  SequenceStepDef,
} from '../lib/api-types.js';
import { useWsEvent } from '../ws/useWsEvent.js';

interface LocalSequence {
  readonly id: string;
  readonly name: string;
  readonly steps: SequenceStepDef[];
}

export function SequencesPage(): JSX.Element {
  const { client } = useAuth();
  const [sequences, setSequences] = useState<LocalSequence[]>([]);
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 启动表单
  const [launchGroupId, setLaunchGroupId] = useState('');
  const [launchSeqId, setLaunchSeqId] = useState('');
  const [varsText, setVarsText] = useState('{}');
  const [stepVarsText, setStepVarsText] = useState('{}');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [precheckHit, setPrecheckHit] = useState<{ stepIndex: number; key: string | null } | null>(
    null,
  );

  // 预检弹窗 + 运行视图
  const [preflightRun, setPreflightRun] = useState<SequenceRunView | null>(null);
  const [runView, setRunView] = useState<SequenceRunView | null>(null);
  const [runIdInput, setRunIdInput] = useState('');

  useEffect(() => {
    void client
      .request<GroupView[]>('/api/groups')
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [client]);

  const loadRun = useCallback(
    async (runId: string): Promise<void> => {
      try {
        setRunView(await client.request<SequenceRunView>(`/api/sequence-runs/${runId}`));
      } catch {
        /* 详情拉取失败不挡主流程 */
      }
    },
    [client],
  );

  // 定义提交
  async function define(draft: SequenceDraft): Promise<void> {
    setError(null);
    try {
      const res = await client.request<{ id: string }>('/api/sequences', {
        method: 'POST',
        body: JSON.stringify({ name: draft.name, steps: draft.steps }),
      });
      setSequences((prev) => [
        ...prev,
        { id: res.id, name: draft.name, steps: draft.steps },
      ]);
    } catch (err) {
      setError(isApiError(err) ? `${err.code}：${err.message}` : '创建失败');
    }
  }

  // 启动提交：422 → stepIndex/key 高亮；201 → 拉详情进弹窗 + 运行视图
  async function launch(): Promise<void> {
    setLaunchError(null);
    setPrecheckHit(null);
    let vars: Record<string, string>;
    let stepVars: Record<string, Record<string, string>>;
    try {
      const v: unknown = JSON.parse(varsText);
      vars = (typeof v === 'object' && v !== null ? v : {}) as Record<string, string>;
    } catch {
      setLaunchError('vars JSON 解析失败');
      return;
    }
    try {
      const sv: unknown = JSON.parse(stepVarsText);
      stepVars = (typeof sv === 'object' && sv !== null ? sv : {}) as Record<
        string,
        Record<string, string>
      >;
    } catch {
      setLaunchError('stepVars JSON 解析失败');
      return;
    }
    if (launchGroupId === '' || launchSeqId === '') {
      setLaunchError('需要选择群和序列');
      return;
    }
    try {
      const res = await client.request<{ runId: string }>(
        `/api/groups/${launchGroupId}/sequence-runs`,
        { method: 'POST', body: JSON.stringify({ sequenceId: launchSeqId, vars, stepVars }) },
      );
      const detail = await client.request<SequenceRunView>(`/api/sequence-runs/${res.runId}`);
      setPreflightRun(detail); // 预检成功弹窗：resolvedVars/varSources 逐步展示
      setRunView(detail);
    } catch (err) {
      if (isApiError(err) && err.status === 422 && err.code === 'UNRESOLVED_PLACEHOLDER') {
        // 页面 5 逐字：stepIndex/key 定位并高亮出错步骤行
        const stepIndex =
          typeof err.extra?.['stepIndex'] === 'number' ? err.extra['stepIndex'] : null;
        const key = typeof err.extra?.['key'] === 'string' ? err.extra['key'] : null;
        if (stepIndex !== null) setPrecheckHit({ stepIndex, key });
        setLaunchError(`预检失败：${err.message}`);
      } else {
        setLaunchError(isApiError(err) ? `${err.code}：${err.message}` : '启动失败');
      }
    }
  }

  // 运行视图：WS sequence_run → 推进 status/currentStepIndex + 重拉步级 sentAt
  useWsEvent('sequence_run', (f) => {
    if (runView === null || f.payload.runId !== runView.id) return;
    setRunView((prev) =>
      prev === null
        ? prev
        : { ...prev, status: f.payload.status, currentStepIndex: f.payload.currentStepIndex },
    );
    void loadRun(f.payload.runId);
  });

  const currentSteps = runView?.steps ?? [];
  const editingSteps = sequences.find((s) => s.id === launchSeqId)?.steps ?? [];

  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: '60rem', margin: '2rem auto' }}>
      <p>
        <Link to="/groups">← 返回群列表</Link>
      </p>
      <h1>序列</h1>
      {error !== null && (
        <p role="alert" style={{ color: '#b00' }}>
          {error}
        </p>
      )}

      <SequenceForm
        highlightStepIndex={precheckHit?.stepIndex ?? null}
        highlightKey={precheckHit?.key ?? null}
        onDefine={define}
      />

      {/* 序列列表（本地登记，后端无 GET /api/sequences 路由） */}
      <section>
        <h3>已定义序列</h3>
        {sequences.length === 0 ? (
          <p data-testid="seq-empty">（本会话暂无定义）</p>
        ) : (
          <ul>
            {sequences.map((s) => (
              <li key={s.id} data-testid={`seq-item-${s.id}`}>
                <code>{s.id}</code> {s.name}（{s.steps.length} 步）
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 启动表单 */}
      <section data-testid="launch-form" style={{ border: '1px solid #ddd', padding: '0.8rem' }}>
        <h3>启动 run</h3>
        <label>
          群：
          <select
            data-testid="launch-group"
            value={launchGroupId}
            onChange={(e) => setLaunchGroupId(e.target.value)}
          >
            <option value="">—</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.gatewayGroupId ?? g.id}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          序列：
          <select
            data-testid="launch-seq"
            value={launchSeqId}
            onChange={(e) => setLaunchSeqId(e.target.value)}
          >
            <option value="">—</option>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <label>
            vars（JSON）：
            <textarea
              data-testid="launch-vars"
              rows={2}
              style={{ width: '100%', fontFamily: 'monospace' }}
              value={varsText}
              onChange={(e) => setVarsText(e.target.value)}
            />
          </label>
        </div>
        {/* 选中序列的步骤行——422 stepIndex/key 定位时在此高亮出错行（页面 5 逐字） */}
        {editingSteps.length > 0 && (
          <ol style={{ listStyle: 'none', padding: 0 }} data-testid="launch-steps">
            {editingSteps.map((s) => {
              const hit = precheckHit !== null && s.index === precheckHit.stepIndex;
              return (
                <li
                  key={s.index}
                  data-testid={`launch-step-${s.index}`}
                  style={{
                    padding: '0.2rem 0.4rem',
                    border: hit ? '2px solid #c00' : undefined,
                    background: hit ? '#fdecec' : undefined,
                  }}
                >
                  #{s.index} {s.accountRole} delay={s.delaySeconds}s — {s.text}
                  {hit && precheckHit.key !== null && (
                    <span data-testid={`launch-hit-${s.index}`} style={{ color: '#c00' }}>
                      {' '}⚠ {'{'}
                      {precheckHit.key}
                      {'}'} 未解析
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <div>
          <label>
            stepVars（JSON，{'{ "<index>": { "key": "value" } }'} 形态）：
            <textarea
              data-testid="launch-stepvars"
              rows={2}
              style={{ width: '100%', fontFamily: 'monospace' }}
              value={stepVarsText}
              onChange={(e) => setStepVarsText(e.target.value)}
            />
          </label>
        </div>
        {/* 预检失败行高亮（编辑区步骤行；非本序列时只显示定位信息） */}
        {precheckHit !== null && editingSteps.length > 0 && (
          <p data-testid="precheck-hit-banner" style={{ color: '#c00' }}>
            步骤 {precheckHit.stepIndex}
            {precheckHit.key !== null ? ` 的占位符 {${precheckHit.key}}` : ''} 未解析
          </p>
        )}
        {launchError !== null && (
          <p role="alert" data-testid="launch-error" style={{ color: '#b00' }}>
            {launchError}
          </p>
        )}
        <button data-testid="launch-submit" onClick={() => void launch()}>
          预检并启动
        </button>
      </section>

      {/* 预检成功弹窗 */}
      <PreflightModal run={preflightRun} onClose={() => setPreflightRun(null)} />

      {/* 运行视图 */}
      <section data-testid="run-view" style={{ border: '1px solid #ddd', padding: '0.8rem' }}>
        <h3>运行视图</h3>
        <label>
          run id：
          <input
            data-testid="run-id-input"
            value={runIdInput}
            onChange={(e) => setRunIdInput(e.target.value)}
          />
        </label>{' '}
        <button
          data-testid="run-load"
          onClick={() => {
            if (runIdInput !== '') void loadRun(runIdInput);
          }}
        >
          载入
        </button>
        {runView !== null && (
          <div data-testid="run-detail">
            <p>
              status=<strong data-testid="run-status">{runView.status}</strong> · currentStepIndex=
              <strong data-testid="run-current">{runView.currentStepIndex}</strong>
            </p>
            <ol>
              {currentSteps.map((s) => (
                <li key={s.index} data-testid={`run-step-${s.index}`}>
                  <span data-testid={`run-step-status-${s.index}`}>{s.status}</span>
                  {' · '}scheduledAt=
                  <span data-testid={`run-step-scheduled-${s.index}`}>{s.scheduledAt ?? '—'}</span>
                  {' · '}sentAt=
                  <span data-testid={`run-step-sent-${s.index}`}>{s.sentAt ?? '—'}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
    </main>
  );
}
