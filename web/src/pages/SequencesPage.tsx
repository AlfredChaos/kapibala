// /sequences 页面（T-P6-07；DES/15 §2 页面 5、DES/07 §1/§2/§6、REQ §4 页面 5）。
// 三块：① 序列定义表单（steps 编辑+校验 → POST /api/sequences，成功后重拉定义列表）；
// ② 启动表单（选群 + vars/stepVars JSON 编辑器 → POST /api/groups/:id/sequence-runs；
//   422 UNRESOLVED_PLACEHOLDER → stepIndex/key 定位并高亮序列定义里出错的步骤行；
//   201 → GET run → PreflightModal 逐步渲染 resolvedVars/varSources）；
// ③ 运行视图（status/currentStepIndex + 每步 status/scheduledAt/sentAt；
//   WS sequence_run 帧推进 currentStepIndex/status 并同步重拉详情拿步级 sentAt）。
// 定义列表数据源：GET /api/sequences（DES/15 §2 页面 5 数据源行「GET（定义列表）」——后端端点见
// design/README 解释声明 #27）。列表内容由服务端裁决，刷新页面不再丢定义。
import { ArrowLeft, ListOrdered, Play, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { isApiError, useAuth } from '../auth/AuthProvider.js';
import { PreflightModal } from '../components/PreflightModal.js';
import { SequenceForm, type SequenceDraft } from '../components/SequenceForm.js';
import type { GroupView, SequenceListItem, SequenceRunView } from '../lib/api-types.js';
import { cx } from '../ui/cx.js';
import { Button, Card, EmptyState, Field, Input, Select, StatusBadge, Textarea } from '../ui/primitives.js';
import { RUN_TONE, STEP_TONE, toneOf } from '../ui/status.js';
import { useWsEvent } from '../ws/useWsEvent.js';
export function SequencesPage(): JSX.Element {
  const { client } = useAuth();
  const [sequences, setSequences] = useState<SequenceListItem[]>([]);
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

  // 定义列表 = 服务端唯一数据源；读失败按空列表渲染（与 /api/groups 同一处理，
  // 定义/启动的失败另有页面错误区承载）
  const loadSequences = useCallback(async (): Promise<void> => {
    try {
      setSequences(await client.request<SequenceListItem[]>('/api/sequences'));
    } catch {
      setSequences([]);
    }
  }, [client]);

  useEffect(() => {
    void loadSequences();
  }, [loadSequences]);

  const loadRun = useCallback(
    async (runId: string): Promise<void> => {
      try {
        setRunView(await client.request<SequenceRunView>(`/api/sequence-runs/${runId}`));
        setError(null);
      } catch (err) {
        // 静默 catch → 上页级错误区（WS 触发的重拉失败也应可见）
        setError(isApiError(err) ? `${err.code}：${err.message}` : '请求失败（网络错误）');
      }
    },
    [client],
  );

  // 定义提交：POST 成功后重拉列表（不再本地登记——steps 快照/createdAt 一律以 GET 返回为准）
  async function define(draft: SequenceDraft): Promise<void> {
    setError(null);
    try {
      await client.request<{ id: string }>('/api/sequences', {
        method: 'POST',
        body: JSON.stringify({ name: draft.name, steps: draft.steps }),
      });
      await loadSequences();
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
    <main className="mx-auto w-full max-w-6xl px-5 py-6">
      <p className="mb-3">
        <Link
          to="/groups"
          className="inline-flex items-center gap-1 text-xs text-ink-subtle transition-colors duration-150 hover:text-ink"
        >
          <ArrowLeft size={12} aria-hidden />
          返回群列表
        </Link>
      </p>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">序列</h1>
        <p className="mt-0.5 text-xs text-ink-subtle">
          定时序列 — 定义、启动（先预检）与运行进度
        </p>
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <SequenceForm
          highlightStepIndex={precheckHit?.stepIndex ?? null}
          highlightKey={precheckHit?.key ?? null}
          onDefine={define}
        />

        {/* 已定义序列（GET /api/sequences 的服务端列表） */}
        <Card title="已定义序列" className="self-start">
          {sequences.length === 0 ? (
            <EmptyState data-testid="seq-empty" icon={<ListOrdered size={20} aria-hidden />}>
              （暂无定义）
            </EmptyState>
          ) : (
            <ul className="divide-y divide-hairline/60">
              {sequences.map((s) => (
                <li
                  key={s.id}
                  data-testid={`seq-item-${s.id}`}
                  className="flex items-center gap-2 py-2 text-sm"
                >
                  <code className="font-mono text-xs text-info">{s.id}</code>
                  <span className="min-w-0 flex-1 truncate text-ink-muted">{s.name}</span>
                  <span className="shrink-0 text-xs text-ink-tertiary">
                    （{s.steps.length} 步）
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* 启动表单 */}
      <Card title="启动 run" data-testid="launch-form" className="mt-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field label="群" className="w-64">
              <Select
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
              </Select>
            </Field>
            <Field label="序列" className="w-64">
              <Select
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
              </Select>
            </Field>
          </div>
          <Field label="vars（JSON）">
            <Textarea
              data-testid="launch-vars"
              rows={2}
              className="font-mono text-xs"
              value={varsText}
              onChange={(e) => setVarsText(e.target.value)}
            />
          </Field>
          {/* 选中序列的步骤行——422 stepIndex/key 定位时在此高亮出错行（页面 5 逐字） */}
          {editingSteps.length > 0 && (
            <ol data-testid="launch-steps" className="flex flex-col gap-1.5">
              {editingSteps.map((s) => {
                const hit = precheckHit !== null && s.index === precheckHit.stepIndex;
                return (
                  <li
                    key={s.index}
                    data-testid={`launch-step-${s.index}`}
                    className={cx(
                      'rounded-md border px-3 py-2 font-mono text-xs transition-colors duration-150',
                      hit
                        ? 'border-danger/60 bg-danger/10 text-danger'
                        : 'border-hairline bg-surface-2/40 text-ink-muted',
                    )}
                  >
                    #{s.index} {s.accountRole} delay={s.delaySeconds}s — {s.text}
                    {hit && precheckHit.key !== null && (
                      <span
                        data-testid={`launch-hit-${s.index}`}
                        className="ml-2 inline-flex items-center gap-1 font-semibold text-danger"
                      >
                        <TriangleAlert size={12} aria-hidden /> ⚠ {'{'}
                        {precheckHit.key}
                        {'}'} 未解析
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <Field label={'stepVars（JSON，{ "<index>": { "key": "value" } } 形态）'}>
            <Textarea
              data-testid="launch-stepvars"
              rows={2}
              className="font-mono text-xs"
              value={stepVarsText}
              onChange={(e) => setStepVarsText(e.target.value)}
            />
          </Field>
          {/* 预检失败行高亮（编辑区步骤行；非本序列时只显示定位信息） */}
          {precheckHit !== null && editingSteps.length > 0 && (
            <p
              data-testid="precheck-hit-banner"
              className="flex items-center gap-1.5 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              <TriangleAlert size={14} aria-hidden />
              步骤 {precheckHit.stepIndex}
              {precheckHit.key !== null ? ` 的占位符 {${precheckHit.key}}` : ''} 未解析
            </p>
          )}
          {launchError !== null && (
            <p
              role="alert"
              data-testid="launch-error"
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              {launchError}
            </p>
          )}
          <div>
            <Button
              variant="primary"
              data-testid="launch-submit"
              onClick={() => void launch()}
            >
              <Play size={13} aria-hidden />
              预检并启动
            </Button>
          </div>
        </div>
      </Card>

      {/* 预检成功弹窗 */}
      <PreflightModal run={preflightRun} onClose={() => setPreflightRun(null)} />

      {/* 运行视图 */}
      <Card title="运行视图" data-testid="run-view" className="mt-5">
        <div className="flex items-end gap-3">
          <Field label="run id" className="w-80">
            <Input
              data-testid="run-id-input"
              className="font-mono text-xs"
              value={runIdInput}
              onChange={(e) => setRunIdInput(e.target.value)}
            />
          </Field>
          <Button
            data-testid="run-load"
            onClick={() => {
              if (runIdInput !== '') void loadRun(runIdInput);
            }}
          >
            载入
          </Button>
        </div>
        {runView !== null && (
          <div data-testid="run-detail" className="mt-4">
            <p className="mb-3 flex items-center gap-2 text-sm text-ink-subtle">
              status=
              <StatusBadge
                tone={toneOf(RUN_TONE, runView.status)}
                data-testid="run-status"
              >
                {runView.status}
              </StatusBadge>
              <span className="text-ink-tertiary">·</span>
              currentStepIndex=
              <strong data-testid="run-current" className="font-mono text-ink">
                {runView.currentStepIndex}
              </strong>
            </p>
            <ol className="flex flex-col gap-1.5">
              {currentSteps.map((s) => (
                <li
                  key={s.index}
                  data-testid={`run-step-${s.index}`}
                  className="flex items-center gap-2 rounded-md border border-hairline bg-surface-2/40 px-3 py-2 font-mono text-xs text-ink-muted"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[10px] text-ink-subtle">
                    {s.index}
                  </span>
                  <StatusBadge
                    tone={toneOf(STEP_TONE, s.status)}
                    data-testid={`run-step-status-${s.index}`}
                  >
                    {s.status}
                  </StatusBadge>
                  <span className="text-ink-tertiary">scheduledAt=</span>
                  <span data-testid={`run-step-scheduled-${s.index}`}>
                    {s.scheduledAt ?? '—'}
                  </span>
                  <span className="text-ink-tertiary">sentAt=</span>
                  <span data-testid={`run-step-sent-${s.index}`}>{s.sentAt ?? '—'}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Card>
    </main>
  );
}
