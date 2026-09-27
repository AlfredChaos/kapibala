// 发送表单（T-P5-04；DES/15 §2 页面 3、REQ §4/§2.3 send 行）。
// 契约：选成员账号 + text；前端先做非空与 TEXT_MAX_LENGTH 校验（§2 逐字「前端先做」），
// 非法直接拦不发请求；合法 → POST /api/groups/:id/send → 202 {clientMsgId}。
// viewer 不渲染本组件（调用方 canWrite 收口；服务端写路径仍 403 兜底）。
import { useState } from 'react';
import { isApiError } from '../api/client.js';
import type { ApiClient } from '../api/client.js';
import { validateSendText, TEXT_MAX_LENGTH } from '../lib/text-limits.js';
import type { GroupMemberView } from '../lib/api-types.js';

export interface SendFormProps {
  readonly groupId: string;
  /** 可选发送账号 = 本群服务账号成员（POST /send 的 accountId 必须是成员，409 ACCOUNT_NOT_IN_GROUP） */
  readonly members: GroupMemberView[];
  readonly client: ApiClient;
  /** 发送成功回调（页面做 queued 占位行——clientMsgId 是行键，WS 回填 msgId 沿用同行） */
  readonly onSent: (res: { clientMsgId: string; accountId: string; text: string }) => void;
}

export function SendForm(props: SendFormProps): JSX.Element {
  const [accountId, setAccountId] = useState(props.members[0]?.accountId ?? '');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);

  const validationError = text === '' ? null : validateSendText(text); // 空文本未输入时不报错（提交时拦）
  const submitError = validateSendText(text); // 提交判定用：空/超长都拦

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const v = validateSendText(text);
    if (v !== null) {
      setError(v); // 前端先拦：非法文本不发请求（REQ §4 逐字）
      return;
    }
    if (accountId === '') {
      setError('请选择发送账号');
      return;
    }
    setBusy(true);
    setError(null);
    setSentId(null);
    try {
      const res = await props.client.request<{ clientMsgId: string }>(
        `/api/groups/${props.groupId}/send`,
        { method: 'POST', body: JSON.stringify({ accountId, text }) },
      );
      setSentId(res.clientMsgId);
      props.onSent({ clientMsgId: res.clientMsgId, accountId, text });
      setText('');
    } catch (err) {
      setError(isApiError(err) ? `${err.code}：${err.message}` : '发送失败（网络错误）');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="send-form"
      onSubmit={(e) => void onSubmit(e)}
      style={{ border: '1px solid #ddd', padding: '0.75rem', marginTop: '1rem' }}
    >
      <h3>发送消息</h3>
      <label htmlFor="send-account">发送账号</label>
      <select
        id="send-account"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        disabled={busy}
      >
        {props.members.map((m) => (
          <option key={m.accountId} value={m.accountId}>
            {m.platformUserId}（{m.accountId} · {m.role}）
          </option>
        ))}
      </select>
      <div>
        <label htmlFor="send-text">消息内容</label>
        <textarea
          id="send-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={3}
          style={{ display: 'block', width: '100%' }}
        />
        <small>
          {text.length}/{TEXT_MAX_LENGTH}
        </small>
      </div>
      {(validationError ?? null) !== null && (
        <p role="alert" data-testid="send-validation" style={{ color: '#b00' }}>
          {validationError}
        </p>
      )}
      {error !== null && (
        <p role="alert" data-testid="send-error" style={{ color: '#b00' }}>
          {error}
        </p>
      )}
      {sentId !== null && <p data-testid="send-accepted">已受理：{sentId}</p>}
      <button type="submit" disabled={busy || submitError !== null || props.members.length === 0}>
        发送
      </button>
    </form>
  );
}
