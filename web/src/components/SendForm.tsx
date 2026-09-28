// 发送表单（T-P5-04；DES/15 §2 页面 3、REQ §4/§2.3 send 行）。
// 契约：选成员账号 + text；前端先做非空与 TEXT_MAX_LENGTH 校验（§2 逐字「前端先做」），
// 非法直接拦不发请求；合法 → POST /api/groups/:id/send → 202 {clientMsgId}。
// viewer 不渲染本组件（调用方 canWrite 收口；服务端写路径仍 403 兜底）。
import { Send } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '../api/client.js';
import type { ApiClient } from '../api/client.js';
import { validateSendText, TEXT_MAX_LENGTH } from '../lib/text-limits.js';
import type { GroupMemberView } from '../lib/api-types.js';
import { Button, Field, Select, Textarea } from '../ui/primitives.js';

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
      className="flex flex-col gap-3"
    >
      <div className="flex gap-3">
        <Field label="发送账号" htmlFor="send-account" className="w-64">
          <Select
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
          </Select>
        </Field>
      </div>
      <Field label="消息内容" htmlFor="send-text">
        <Textarea
          id="send-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={3}
        />
      </Field>
      <div className="flex items-center justify-between">
        <small className="font-mono text-[11px] text-ink-tertiary">
          {text.length}/{TEXT_MAX_LENGTH}
        </small>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || submitError !== null || props.members.length === 0}
        >
          <Send size={13} aria-hidden />
          发送
        </Button>
      </div>
      {(validationError ?? null) !== null && (
        <p
          role="alert"
          data-testid="send-validation"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {validationError}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          data-testid="send-error"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {sentId !== null && (
        <p
          data-testid="send-accepted"
          className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok"
        >
          已受理：{sentId}
        </p>
      )}
    </form>
  );
}
