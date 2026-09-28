// 群列表页（DES/15 §2 页面骨架、DES/04 §2.1/§7、REQ §4 页面 3 前置入口）。
// 列表：GET /api/groups → GroupView[]（server 不含 'creating' 内部态——建群中行不可见，
//   成功后经 refetch 出现；行点击/链接 → /groups/:id）。
// 建群（admin only，canWrite 收口；服务端 auth:'write' 仍是权威）：
//   POST /api/groups 受理形状逐字 { creatorAccountId, memberAccountIds }（create-job.ts
//   acceptCreateGroup：members ≥1、去重、排除 creator；受理校验 ACCOUNT_NOT_ONLINE——
//   选择器只列 online 账号做前置过滤）；202 → { jobId } 异步 job → 轮询
//   GET /api/jobs/:jobId（返回 { status, errors }；终态 finished/failed——JobStatus 逐字）；
//   finished → 重拉列表 + 展示新群链接（新行 = refetch 后与提交前快照的差集——job 响应
//   不带 groupId，diff 是唯一可靠关联途径）；failed → errors[{step,code}] 逐字展示
//   （INVITE_NOT_READY 等失败码不转译）。
// 时间戳列：当前 GET /api/groups 不输出 createdAt（server query.ts §5 输出形状逐字）——
//   列保留、缺值渲染「—」，后端补字段后自动生效。
import { Check, Loader2, MessageSquare, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { canWrite, isApiError, useAuth } from '../auth/AuthProvider.js';
import type { GroupView } from '../lib/api-types.js';
import { Button, Card, EmptyState, Field, Select, StatusBadge } from '../ui/primitives.js';
import { GROUP_TONE, toneOf } from '../ui/status.js';
/** 建群 job 轮询节拍（~1s；测试经 props 注入 0 走即实轮询） */
const JOB_POLL_MS = 1000;
/** 轮询上限：超出仍在 running → 提示但不判失败（恢复器可能还在推进） */
const JOB_POLL_MAX = 300;

/** GET /api/accounts 行的建群选择器所需子集（server modules/accounts/list.ts 逐字） */
interface AccountOption {
  readonly id: string;
  readonly status: string;
  readonly platformUserId: string | null;
}

/** 列表行：GroupView + 可选 createdAt（server 当前不投影该列——缺值渲染「—」） */
type GroupListItem = GroupView & { readonly createdAt?: string | null };

/** GET /api/jobs/:jobId 响应（routes/jobs.ts 逐字：{status, errors}） */
interface JobView {
  readonly status: string;
  readonly errors: unknown;
}

function errorText(err: unknown): string {
  if (isApiError(err)) return `${err.code}：${err.message}`;
  return '请求失败（网络错误）';
}

/** ISO 8601 → 'YYYY-MM-DD HH:mm:ss'（UTC 截断，逐字段直取不做时区换算） */
export function formatTimestamp(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

/** job errors → 逐字展示串：[{step,code}] → 'step:code'；其余形状 JSON 原样透出 */
function jobErrorText(errors: unknown): string {
  if (Array.isArray(errors)) {
    const parts = errors.map((e) => {
      if (typeof e === 'object' && e !== null) {
        const rec = e as { step?: unknown; code?: unknown };
        if (typeof rec.step === 'string' || typeof rec.code === 'string') {
          return `${typeof rec.step === 'string' ? rec.step : '?'}:${typeof rec.code === 'string' ? rec.code : '?'}`;
        }
      }
      return JSON.stringify(e);
    });
    if (parts.length > 0) return parts.join('；');
  }
  if (errors !== null && errors !== undefined) return JSON.stringify(errors);
  return '未知错误（job failed 无 errors 明细）';
}

export function GroupsPage(props: { jobPollMs?: number }): JSX.Element {
  const pollMs = props.jobPollMs ?? JOB_POLL_MS;
  const { client, session } = useAuth();
  const writable = canWrite(session);
  const navigate = useNavigate();

  const [groups, setGroups] = useState<GroupListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 建群表单（admin only）
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [creator, setCreator] = useState('');
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null); // 进行中 job（进度行 + 提交禁用）
  const [createError, setCreateError] = useState<string | null>(null);
  const [createDone, setCreateDone] = useState<{ groupId: string | null } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<GroupListItem[] | null> => {
    try {
      const list = await client.request<GroupListItem[]>('/api/groups');
      setGroups(list);
      setError(null);
      return list;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  }, [client]);

  useEffect(() => {
    void reload();
    if (writable) {
      client
        .request<AccountOption[]>('/api/accounts')
        .then(setAccounts)
        .catch((err: unknown) => setError(errorText(err))); // 账号拉取失败 → 表单为空 + 页级错误
    }
  }, [reload, client, writable]);

  const onlineAccounts = accounts.filter((a) => a.status === 'online');
  const memberCandidates = onlineAccounts.filter((a) => a.id !== creator);

  function toggleMember(id: string): void {
    setMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createGroup(): Promise<void> {
    setCreateError(null);
    setCreateDone(null);
    if (creator === '') {
      setCreateError('需要选择群主账号');
      return;
    }
    if (members.size === 0) {
      setCreateError('需要至少 1 个成员账号');
      return;
    }
    const before = new Set((groups ?? []).map((g) => g.id));
    let res: { jobId: string };
    try {
      res = await client.request<{ jobId: string }>('/api/groups', {
        method: 'POST',
        body: JSON.stringify({ creatorAccountId: creator, memberAccountIds: [...members] }),
      });
    } catch (err) {
      setCreateError(errorText(err)); // 422 ACCOUNT_NOT_ONLINE / VALIDATION_ERROR 等原码透出
      return;
    }
    if (!mounted.current) return;
    setJobId(res.jobId);
    // 轮询至终态（finished/failed）；running 超时只提示不判失败
    for (let i = 0; i < JOB_POLL_MAX; i += 1) {
      // 轮询节拍（pollMs 可注入：测试 0ms 即实轮询）；lib ES2023 无 Promise.withResolvers → executor
      await new Promise<void>((resolve) => {
        setTimeout(resolve, pollMs);
      });
      if (!mounted.current) return;
      let job: JobView;
      try {
        job = await client.request<JobView>(`/api/jobs/${res.jobId}`);
      } catch (err) {
        if (!mounted.current) return;
        setJobId(null);
        setCreateError(errorText(err)); // JOB_NOT_FOUND / 网络错误 → 页面可见
        return;
      }
      if (job.status === 'running') continue;
      if (!mounted.current) return;
      setJobId(null);
      if (job.status === 'finished') {
        const list = await reload(); // refetch 失败时列表错误已上页级 error，下面做空集兜底
        const created = (list ?? []).find((g) => !before.has(g.id));
        setCreateDone({ groupId: created?.id ?? null });
        setCreator('');
        setMembers(new Set());
      } else {
        // failed：errors[{step,code}] 逐字展示（INVITE_NOT_READY 等码不转译）
        setCreateError(`建群失败：${jobErrorText(job.errors)}`);
      }
      return;
    }
    if (!mounted.current) return;
    setJobId(null);
    setCreateError(`轮询超时：job ${res.jobId} 仍在进行中，可稍后在 GET /api/jobs 查看`);
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">群</h1>
          <p className="mt-0.5 text-xs text-ink-subtle">群列表 — 点行进详情</p>
        </div>
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          {groups === null ? (
            <p className="py-10 text-center text-sm text-ink-subtle">加载中…</p>
          ) : groups.length === 0 ? (
            <EmptyState icon={<MessageSquare size={20} aria-hidden />}>无群</EmptyState>
          ) : (
            <Card className="overflow-hidden p-0">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs text-ink-subtle">
                    <th className="px-4 py-2.5 font-medium">ID</th>
                    <th className="px-4 py-2.5 font-medium">gatewayGroupId</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">成员数</th>
                    <th className="px-4 py-2.5 font-medium">agent</th>
                    <th className="px-4 py-2.5 font-medium">autoKick</th>
                    <th className="px-4 py-2.5 font-medium">创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <tr
                      key={g.id}
                      data-testid={`group-row-${g.id}`}
                      className="cursor-pointer border-b border-hairline/60 transition-colors duration-150 last:border-b-0 hover:bg-surface-2"
                      onClick={() => navigate(`/groups/${g.id}`)}
                    >
                      <td className="px-4 py-2.5 font-mono text-xs">
                        <Link
                          to={`/groups/${g.id}`}
                          className="text-info hover:text-primary-hover hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {g.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-subtle">
                        {g.gatewayGroupId ?? '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge
                          tone={toneOf(GROUP_TONE, g.status)}
                          data-testid={`group-status-${g.id}`}
                        >
                          {g.status}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">{g.members.length}</td>
                      <td className="px-4 py-2.5">
                        {g.agentEnabled ? (
                          <Check size={14} className="text-ok" aria-hidden />
                        ) : (
                          <span className="text-ink-tertiary">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {g.autoKickEnabled ? (
                          <Check size={14} className="text-ok" aria-hidden />
                        ) : (
                          <span className="text-ink-tertiary">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink-subtle">
                        {g.createdAt != null ? formatTimestamp(g.createdAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        {writable && (
          <Card title="建群" data-testid="create-group-form" className="self-start">
            <div className="flex flex-col gap-4">
              <Field label="群主账号（creator）">
                <Select
                  data-testid="create-creator"
                  value={creator}
                  onChange={(e) => setCreator(e.target.value)}
                >
                  <option value="">—</option>
                  {onlineAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.platformUserId ?? a.id}
                    </option>
                  ))}
                </Select>
              </Field>
              <fieldset className="rounded-md border border-hairline p-3">
                <legend className="px-1 text-xs text-ink-subtle">
                  成员账号（online，不含群主）
                </legend>
                {memberCandidates.length === 0 ? (
                  <span data-testid="create-no-members" className="text-xs text-ink-tertiary">
                    （无可选 online 账号）
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {memberCandidates.map((a) => (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted"
                      >
                        <input
                          type="checkbox"
                          data-testid={`create-member-${a.id}`}
                          checked={members.has(a.id)}
                          onChange={() => toggleMember(a.id)}
                          className="h-3.5 w-3.5 cursor-pointer accent-[#5e6ad2]"
                        />
                        <span className="font-mono">{a.platformUserId ?? a.id}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  data-testid="create-submit"
                  disabled={jobId !== null}
                  onClick={() => void createGroup()}
                >
                  <Plus size={14} aria-hidden />
                  建群
                </Button>
                {jobId !== null && (
                  <span
                    data-testid="create-progress"
                    className="inline-flex items-center gap-1.5 text-xs text-ink-subtle"
                  >
                    <Loader2 size={13} className="animate-spin" aria-hidden />
                    建群中…（jobId={jobId}）
                  </span>
                )}
              </div>
              {createDone !== null && (
                <p
                  data-testid="create-done"
                  className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok"
                >
                  建群完成
                  {createDone.groupId !== null && (
                    <>
                      ：
                      <Link
                        to={`/groups/${createDone.groupId}`}
                        className="font-mono underline underline-offset-2 hover:text-ink"
                      >
                        {createDone.groupId.slice(0, 8)}
                      </Link>
                    </>
                  )}
                </p>
              )}
              {createError !== null && (
                <p
                  role="alert"
                  data-testid="create-error"
                  className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                >
                  {createError}
                </p>
              )}
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
