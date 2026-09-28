// 账号状态转移面板（T-P5-03；DES/15 §2 页面 2 逐字、DES/03 §3、REQ A1/D3-4）。
// 契约：
//   expectedFrom = 打开面板时的当前状态（CAS 语义——提交时服务端再校验，CAS_CONFLICT 留给并发）；
//   to 只列该状态的合法目标（legalTargets 与 server transitions.ts 同源，parity 测试钉死）；
//   非法目标不出现在 UI——ILLEGAL_TRANSITION 是并发竞争通道，不是用户可选路径；
//   to='rate_limited' 必须填 rateLimitedUntil（未来 ISO 8601），否则提交禁用（D3-4 前端半边）。
import { useState } from 'react';
import type { AccountStatus } from '@kapibala/contract';
import { legalTargets } from '../lib/account-transitions.js';
import { Button, Field, Input, Modal, Select } from '../ui/primitives.js';
export interface TransitionPanelProps {
  /** 打开面板时账号的当前状态（= 提交的 expectedFrom） */
  readonly current: AccountStatus;
  /** 父层提交进行中 → 禁用全部控件 */
  readonly pending: boolean;
  /** 上一次提交的错误文案（CAS_CONFLICT 等，父层管） */
  readonly error: string | null;
  readonly onSubmit: (to: AccountStatus, rateLimitedUntil?: string) => void;
  readonly onClose: () => void;
}

const STATUS_LABELS: Record<AccountStatus, string> = {
  idle: 'idle（空闲）',
  online: 'online（在线）',
  rate_limited: 'rate_limited（限流中）',
  disconnected: 'disconnected（离线）',
  suspended: 'suspended（已停用）',
  session_expired: 'session_expired（会话失效）',
};

/** D3-4：rateLimitedUntil 必须是未来时刻的合法日期（datetime-local 值 → Date 解析） */
export function isValidFutureInstant(value: string): boolean {
  if (value === '') return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t > Date.now();
}

export function TransitionPanel(props: TransitionPanelProps): JSX.Element {
  const targets = legalTargets(props.current);
  const [to, setTo] = useState<AccountStatus | ''>('');
  const [until, setUntil] = useState('');
  const needsUntil = to === 'rate_limited';
  // D3-4 提交闸门：选了 rate_limited 但没给合法的未来时间 → 禁用（服务端同样 400，前端先挡）
  const canSubmit = !props.pending && to !== '' && (!needsUntil || isValidFutureInstant(until));

  return (
    <Modal
      title="调整状态"
      aria-label="状态转移"
      data-testid="transition-panel"
      footer={
        <button
          type="button"
          onClick={props.onClose}
          disabled={props.pending}
          className="cursor-pointer rounded-sm px-2 py-1 text-xs text-ink-subtle transition-colors duration-150 hover:text-ink"
        >
          取消
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-subtle">
          当前状态：
          <strong data-testid="panel-from" className="ml-1 font-mono text-ink">
            {props.current}
          </strong>
        </p>
        <Field label="目标状态" htmlFor="transition-to">
          <Select
            id="transition-to"
            value={to}
            onChange={(e) => setTo(e.target.value as AccountStatus)}
            disabled={props.pending}
          >
            <option value="">选择目标…</option>
            {targets.map((t) => (
              <option key={t} value={t}>
                {STATUS_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {needsUntil && (
          <Field label="限流截止（rateLimitedUntil，必填）" htmlFor="rate-limited-until">
            <Input
              id="rate-limited-until"
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              disabled={props.pending}
            />
          </Field>
        )}
        {props.error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {props.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={!canSubmit}
            onClick={() => {
              if (to === '') return;
              // datetime-local 是本地时间——提交前转 ISO 8601 UTC（契约字段形状）
              props.onSubmit(to, needsUntil ? new Date(until).toISOString() : undefined);
            }}
          >
            确认转移
          </Button>
        </div>
      </div>
    </Modal>
  );
}
