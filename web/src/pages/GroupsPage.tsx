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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { canWrite, isApiError, useAuth } from '../auth/AuthProvider.js';
import type { GroupView } from '../lib/api-types.js';

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
    <main style={{ fontFamily: 'sans-serif', maxWidth: '60rem', margin: '2rem auto' }}>
      <h1>群列表</h1>
      {error !== null && (
        <p role="alert" style={{ color: '#b00' }}>
          {error}
        </p>
      )}
      {groups === null ? (
        <p>加载中…</p>
      ) : groups.length === 0 ? (
        <p>无群</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
              <th>ID</th>
              <th>gatewayGroupId</th>
              <th>状态</th>
              <th>成员数</th>
              <th>agent</th>
              <th>autoKick</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr
                key={g.id}
                data-testid={`group-row-${g.id}`}
                style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
                onClick={() => navigate(`/groups/${g.id}`)}
              >
                <td>
                  <Link to={`/groups/${g.id}`}>{g.id.slice(0, 8)}</Link>
                </td>
                <td>{g.gatewayGroupId ?? '—'}</td>
                <td>
                  <span data-testid={`group-status-${g.id}`}>{g.status}</span>
                </td>
                <td>{g.members.length}</td>
                <td>{g.agentEnabled ? '✓' : '—'}</td>
                <td>{g.autoKickEnabled ? '✓' : '—'}</td>
                <td>{g.createdAt != null ? formatTimestamp(g.createdAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {writable && (
        <section
          data-testid="create-group-form"
          style={{ border: '1px solid #ddd', padding: '0.8rem', marginTop: '1.2rem' }}
        >
          <h3>建群</h3>
          <label>
            群主账号（creator）：
            <select
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
            </select>
          </label>
          <fieldset style={{ marginTop: '0.6rem' }}>
            <legend>成员账号（memberAccountIds，online，不含群主）</legend>
            {memberCandidates.length === 0 ? (
              <span data-testid="create-no-members">（无可选 online 账号）</span>
            ) : (
              memberCandidates.map((a) => (
                <label key={a.id} style={{ marginRight: '0.8rem' }}>
                  <input
                    type="checkbox"
                    data-testid={`create-member-${a.id}`}
                    checked={members.has(a.id)}
                    onChange={() => toggleMember(a.id)}
                  />
                  {a.platformUserId ?? a.id}
                </label>
              ))
            )}
          </fieldset>
          <button
            type="button"
            data-testid="create-submit"
            disabled={jobId !== null}
            onClick={() => void createGroup()}
          >
            建群
          </button>
          {jobId !== null && (
            <span data-testid="create-progress" style={{ marginLeft: '0.8rem' }}>
              建群中…（jobId={jobId}）
            </span>
          )}
          {createDone !== null && (
            <p data-testid="create-done" style={{ color: '#070' }}>
              建群完成
              {createDone.groupId !== null && (
                <>
                  ：
                  <Link to={`/groups/${createDone.groupId}`}>{createDone.groupId.slice(0, 8)}</Link>
                </>
              )}
            </p>
          )}
          {createError !== null && (
            <p role="alert" data-testid="create-error" style={{ color: '#b00' }}>
              {createError}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
