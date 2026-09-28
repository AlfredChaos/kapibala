// 账号列表页（T-P5-03；DES/15 §2 页面 2 逐字、DES/03 §1/§3、REQ §4 页面 2）。
// 逐字契约：
// - 每行：状态徽标 + platformUserId + rateLimitedUntil 倒计时（「3s 后恢复」/过期则「已到期」）；
// - 重连按钮（REQ §4「重连」= connect）：仅 idle/disconnected 可见可用（CONNECT_FROM 前置集合）；
// - 标记离线（→disconnected）/ 释放账号（→suspended）/ 调整状态（开转移面板）三枚写按钮，
//   只在对应转移合法时出现（REQ §4 页面 2 逐字「只在对应转移合法时出现」）；
// - 转移面板：expectedFrom=当前状态、to 只列合法目标、rate_limited 必填 rateLimitedUntil（D3-4）；
// - viewer：三枚写按钮 + 面板入口一律不渲染（canWrite 收口；服务端仍是权威——写接口 403）；
// - WS account_status_changed / account_terminal → 原地更新该行徽标（不整表重拉）。
import { RefreshCw, UserX, CircleSlash, SlidersHorizontal, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AccountStatus } from '@kapibala/contract';
import { isApiError, useAuth, canWrite } from '../auth/AuthProvider.js';
import { TransitionPanel } from '../components/TransitionPanel.js';
import { canConnect, legalTargets } from '../lib/account-transitions.js';
import { StatusBadge, EmptyState, Card } from '../ui/primitives.js';
import { ACCOUNT_TONE, toneOf } from '../ui/status.js';
import { useWsEvent } from '../ws/useWsEvent.js';
export interface AccountListItem {
  readonly id: string;
  readonly status: AccountStatus;
  readonly platformUserId: string | null;
  readonly rateLimitedUntil: string | null;
}

function errorText(err: unknown): string {
  if (isApiError(err)) return `${err.code}：${err.message}`;
  return '请求失败（网络错误）';
}

/** rateLimitedUntil 倒计时文案（测试用固定 now 断言，组件内每秒刷新驱动） */
export function rateLimitCountdownText(iso: string, nowMs: number): string {
  const ms = new Date(iso).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return '已到期';
  const s = Math.ceil(ms / 1000);
  return `${s}s 后恢复`;
}

export function AccountsPage(): JSX.Element {
  const { client, session } = useAuth();
  const writable = canWrite(session);
  const [accounts, setAccounts] = useState<AccountListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelFor, setPanelFor] = useState<AccountListItem | null>(null);
  const [pending, setPending] = useState<string | null>(null); // 进行中的操作目标行 id
  const [panelError, setPanelError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const reload = useCallback(async (): Promise<void> => {
    try {
      setAccounts(await client.request<AccountListItem[]>('/api/accounts'));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 倒计时刷新：页面存在 rate_limited 行才走秒表（避免无谓重渲染）
  const hasRateLimited = (accounts ?? []).some(
    (a) => a.status === 'rate_limited' && a.rateLimitedUntil !== null,
  );
  useEffect(() => {
    if (!hasRateLimited) return undefined;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasRateLimited]);

  // WS 原地更新（DES/15 §2：account_status_changed / account_terminal 都在行上 patch）
  const patchStatus = useCallback((accountId: string, status: AccountStatus) => {
    setAccounts((prev) =>
      prev === null ? prev : prev.map((a) => (a.id === accountId ? { ...a, status } : a)),
    );
  }, []);
  useWsEvent('account_status_changed', (f) => patchStatus(f.payload.accountId, f.payload.to));
  useWsEvent('account_terminal', (f) => patchStatus(f.payload.accountId, f.payload.status));

  const doConnect = useCallback(
    async (id: string) => {
      setPending(id);
      try {
        await client.request(`/api/accounts/${id}/connect`, { method: 'POST' });
        await reload(); // connect 成功后行状态由 WS/重拉收敛
      } catch (err) {
        setError(errorText(err));
      } finally {
        setPending(null);
      }
    },
    [client, reload],
  );

  const doTransition = useCallback(
    async (account: AccountListItem, to: AccountStatus, rateLimitedUntil?: string) => {
      // 释放账号（→suspended）是终态转移：先确认再 POST（REQ §4 页面 2「不可恢复」门槛）
      if (to === 'suspended' && !window.confirm('释放后账号不可恢复，确认？')) return;
      setPending(account.id);
      try {
        await client.request(`/api/accounts/${account.id}/transition`, {
          method: 'POST',
          body: JSON.stringify({
            to,
            expectedFrom: account.status, // CAS：expectedFrom = 打开面板时的当前状态
            ...(rateLimitedUntil !== undefined ? { rateLimitedUntil } : {}),
          }),
        });
        setPanelFor(null);
        await reload();
      } catch (err) {
        setPanelError(errorText(err)); // CAS_CONFLICT / ILLEGAL_TRANSITION 展示在面板内
      } finally {
        setPending(null);
      }
    },
    [client, reload],
  );

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">账号</h1>
          <p className="mt-0.5 text-xs text-ink-subtle">
            服务账号健康总览 — 状态、限流倒计时与合法转移
          </p>
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
      {accounts === null ? (
        <p className="py-10 text-center text-sm text-ink-subtle">加载中…</p>
      ) : accounts.length === 0 ? (
        <EmptyState icon={<Users size={20} aria-hidden />}>无账号</EmptyState>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-ink-subtle">
                <th className="px-4 py-2.5 font-medium">ID</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">platformUserId</th>
                <th className="px-4 py-2.5 font-medium">限流截止</th>
                {writable && <th className="px-4 py-2.5 text-right font-medium">操作</th>}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const targets = legalTargets(a.status);
                return (
                  <tr
                    key={a.id}
                    className="border-b border-hairline/60 transition-colors duration-150 last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">{a.id}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge
                        tone={toneOf(ACCOUNT_TONE, a.status)}
                        data-testid={`status-badge-${a.id}`}
                      >
                        {a.status}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-subtle">
                      {a.platformUserId ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-subtle">
                      {a.rateLimitedUntil !== null
                        ? rateLimitCountdownText(a.rateLimitedUntil, nowMs)
                        : '—'}
                    </td>
                    {writable && (
                      <td className="px-4 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* REQ §4 逐字：三按钮只在对应转移合法时出现 */}
                          {canConnect(a.status) && (
                            <RowAction
                              icon={<RefreshCw size={13} aria-hidden />}
                              disabled={pending === a.id}
                              onClick={() => void doConnect(a.id)}
                            >
                              重连
                            </RowAction>
                          )}
                          {targets.includes('disconnected') && (
                            <RowAction
                              icon={<UserX size={13} aria-hidden />}
                              disabled={pending === a.id}
                              onClick={() => void doTransition(a, 'disconnected')}
                            >
                              标记离线
                            </RowAction>
                          )}
                          {targets.includes('suspended') && (
                            <RowAction
                              icon={<CircleSlash size={13} aria-hidden />}
                              danger
                              disabled={pending === a.id}
                              onClick={() => void doTransition(a, 'suspended')}
                            >
                              释放账号
                            </RowAction>
                          )}
                          {targets.length > 0 && (
                            <RowAction
                              icon={<SlidersHorizontal size={13} aria-hidden />}
                              disabled={pending === a.id}
                              onClick={() => {
                                setPanelFor(a);
                                setPanelError(null);
                              }}
                            >
                              调整状态…
                            </RowAction>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {panelFor !== null && (
        <TransitionPanel
          current={panelFor.status}
          pending={pending === panelFor.id}
          error={panelError}
          onSubmit={(to, until) => void doTransition(panelFor, to, until)}
          onClose={() => setPanelFor(null)}
        />
      )}
    </main>
  );
}

/** 行内动作小按钮（视觉一致性收口：图标 + 文案，危险项标红描边） */
function RowAction(props: {
  readonly icon: React.ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
        props.danger === true
          ? 'border-danger/40 text-danger hover:bg-danger/10'
          : 'border-hairline text-ink-muted hover:border-hairline-strong hover:bg-surface-2 hover:text-ink'
      }`}
    >
      {props.icon}
      {props.children}
    </button>
  );
}
