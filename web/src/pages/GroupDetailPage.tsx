// 群详情页骨架（T-P5-04；DES/15 §2 页面 3、DES/04 §5、REQ §4 页面 3）。
// 数据流：GET /api/groups/:id + GET /api/groups/:id/agent-runs 首屏；
// WS group_updated → 重拉群详情（开关成员同步）；agent_run → 重拉 run 列表（含新建）；
// message/sequence_run 等时间线事件归 T-P5-05（本页骨架不含时间线区）。
// 开关 PATCH /api/groups/:id（admin 可写；viewer 只读 disabled——服务端仍 403 权威）。
// blocked run → 顶部横幅 + 行标红（页面 3 逐字「醒目提示」；A5 audit_blocked 可见）。
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isApiError, useAuth, canWrite } from '../auth/AuthProvider.js';
import { AgentRunList } from '../components/AgentRunList.js';
import { GroupMembers } from '../components/GroupMembers.js';
import { SendForm } from '../components/SendForm.js';
import type { AgentRunView, GroupView } from '../lib/api-types.js';
import { useWsEvent } from '../ws/useWsEvent.js';

function errorText(err: unknown): string {
  if (isApiError(err)) return `${err.code}：${err.message}`;
  return '请求失败（网络错误）';
}

export function GroupDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { client, session } = useAuth();
  const writable = canWrite(session);
  const [group, setGroup] = useState<GroupView | null>(null);
  const [runs, setRuns] = useState<AgentRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);

  const reloadGroup = useCallback(async (): Promise<void> => {
    if (id === undefined) return;
    try {
      setGroup(await client.request<GroupView>(`/api/groups/${id}`));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [client, id]);

  const reloadRuns = useCallback(async (): Promise<void> => {
    if (id === undefined) return;
    try {
      setRuns(await client.request<AgentRunView[]>(`/api/groups/${id}/agent-runs`));
    } catch {
      // run 列表失败不盖主页错误（首屏并行时群详情优先）
    }
  }, [client, id]);

  useEffect(() => {
    void reloadGroup();
    void reloadRuns();
  }, [reloadGroup, reloadRuns]);

  // WS 驱动刷新（DES/15 §2：group_updated → 群详情；agent_run → run 列表）
  // WS 驱动（DES/15 §2 + DES/08 §2.3）：
  // group_updated → 就地更新开关/status（事件携带新值，无需重拉——§2.3 注释逐字）
  useWsEvent('group_updated', (f) => {
    if (f.payload.groupId !== id) return;
    setGroup((prev) =>
      prev === null || prev.id !== f.payload.groupId
        ? prev
        : {
            ...prev,
            status: f.payload.status,
            agentEnabled: f.payload.agentEnabled,
            autoKickEnabled: f.payload.autoKickEnabled,
          },
    );
  });
  // agent_run → 就地 patch 已知行；未知 runId（新建）→ 重拉列表拿完整行。
  // 纪律：setState updater 必须纯——StrictMode 会双调 updater，副作用（重拉）放 updater 外。
  useWsEvent('agent_run', (f) => {
    if (f.payload.groupId !== id) return;
    const known = (runs ?? []).some((r) => r.id === f.payload.runId);
    if (!known) {
      void reloadRuns(); // 新 run：列表项形状（createdAt/summary）需服务端行
      return;
    }
    setRuns((prev) =>
      (prev ?? []).map((r) =>
        r.id === f.payload.runId
          ? { ...r, status: f.payload.status, endReason: f.payload.endReason }
          : r,
      ),
    );
  });

  const toggle = useCallback(
    async (key: 'agentEnabled' | 'autoKickEnabled', value: boolean) => {
      if (id === undefined || toggleBusy) return;
      setToggleBusy(true);
      try {
        await client.request(`/api/groups/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ [key]: value }),
        });
        // 服务端同事务推 group_updated——WS 就地更新；本地也立即重拉收敛（双保险）
        await reloadGroup();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setToggleBusy(false);
      }
    },
    [client, id, reloadGroup, toggleBusy],
  );

  const blockedRuns = (runs ?? []).filter((r) => r.status === 'blocked');

  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: '52rem', margin: '2rem auto' }}>
      <h1>群详情 {id ?? ''}</h1>
      {/* 页面 3 逐字：blocked 的 run → 顶部横幅醒目提示 */}
      {blockedRuns.length > 0 && (
        <div
          role="alert"
          data-testid="blocked-banner"
          style={{ background: '#c00', color: '#fff', padding: '0.6rem 0.8rem' }}
        >
          ⚠ {blockedRuns.length} 个 agent run 被审计拦截（blocked）——请检查最近 run
        </div>
      )}
      {error !== null && (
        <p role="alert" style={{ color: '#b00' }}>
          {error}
        </p>
      )}
      {group === null ? (
        <p>加载中…</p>
      ) : (
        <>
          <section>
            <h2>状态</h2>
            <p>
              status={group.status} · gatewayGroupId={group.gatewayGroupId ?? '—'} · creator=
              {group.creatorAccountId}
            </p>
            <label>
              <input
                type="checkbox"
                data-testid="toggle-agentEnabled"
                checked={group.agentEnabled}
                disabled={!writable || toggleBusy}
                onChange={(e) => void toggle('agentEnabled', e.target.checked)}
              />
              agentEnabled
            </label>
            <label style={{ marginLeft: '1rem' }}>
              <input
                type="checkbox"
                data-testid="toggle-autoKickEnabled"
                checked={group.autoKickEnabled}
                disabled={!writable || toggleBusy}
                onChange={(e) => void toggle('autoKickEnabled', e.target.checked)}
              />
              autoKickEnabled
            </label>
          </section>
          <section>
            <h2>成员</h2>
            <GroupMembers members={group.members} />
          </section>
          {writable && (
            <SendForm
              groupId={group.id}
              members={group.members}
              client={client}
              onSent={() => {
                /* 时间线归 T-P5-05；受理回执由表单内 sentId 提示 */
              }}
            />
          )}
          <section>
            <h2>最近 agent run</h2>
            {runs === null ? <p>加载中…</p> : <AgentRunList runs={runs} />}
          </section>
        </>
      )}
    </main>
  );
}
