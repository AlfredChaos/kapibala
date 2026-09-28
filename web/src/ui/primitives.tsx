// UI 基元层（web/DESIGN.md 附录「组件落地映射」）。
// 所有页面/组件只用这里的基元 + 语义 class，不直接写颜色 hex。
import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cx } from './cx.js';

/* ---------- Button（DESIGN.md button-primary/secondary/tertiary + 附录 button-danger） ---------- */

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-focus border border-transparent',
  secondary:
    'bg-surface-1 text-ink hover:bg-surface-2 border border-hairline hover:border-hairline-strong',
  tertiary: 'bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink border border-transparent',
  danger:
    'bg-transparent text-danger border border-danger/40 hover:bg-danger/10 hover:border-danger/70',
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-2 text-sm',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
  }
>(function Button({ variant = 'secondary', size = 'md', className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium leading-tight transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANT[variant],
        BUTTON_SIZE[size],
        className,
      )}
      {...rest}
    />
  );
});

/* ---------- StatusBadge（DESIGN.md status-badge + 附录语义色点） ---------- */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
};

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-ink-subtle',
};

const TONE_RING: Record<Tone, string> = {
  ok: 'border-ok/30',
  warn: 'border-warn/30',
  danger: 'border-danger/30',
  info: 'border-info/30',
  neutral: 'border-hairline-strong',
};

/** 状态徽标：彩点 + 文字（附录：surface-2 底 + 同色描边 + 6px 点） */
export function StatusBadge(props: {
  readonly tone: Tone;
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <span
      data-testid={props['data-testid']}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border bg-surface-2 px-2 py-0.5 text-xs leading-5',
        TONE_RING[props.tone],
        TONE_TEXT[props.tone],
        props.className,
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', TONE_DOT[props.tone])} aria-hidden />
      {props.children}
    </span>
  );
}

/** 无色强调徽标（角色、kind 等分类标签，不带语义色） */
export function Tag(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <span
      data-testid={props['data-testid']}
      className={cx(
        'inline-flex items-center rounded-sm border border-hairline bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-ink-muted',
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/* ---------- Card / Section（DESIGN.md feature-card/pricing-card） ---------- */

export function Card(props: {
  readonly title?: ReactNode;
  readonly extra?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <section
      data-testid={props['data-testid']}
      className={cx(
        'rounded-lg border border-hairline bg-surface-1 p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]',
        props.className,
      )}
    >
      {(props.title !== undefined || props.extra !== undefined) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-ink-muted">{props.title}</h2>
          {props.extra}
        </header>
      )}
      {props.children}
    </section>
  );
}

/* ---------- 表单 ---------- */

export function Field(props: {
  readonly label: ReactNode;
  readonly htmlFor?: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cx('flex flex-col gap-1.5', props.className)}>
      <label htmlFor={props.htmlFor} className="text-xs font-medium text-ink-subtle">
        {props.label}
      </label>
      {props.children}
      {props.hint !== undefined && <p className="text-xs text-ink-tertiary">{props.hint}</p>}
    </div>
  );
}

const INPUT_CLASS =
  'w-full rounded-md border border-hairline bg-surface-1 px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary transition-colors duration-150 hover:border-hairline-strong disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(INPUT_CLASS, className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(INPUT_CLASS, 'resize-y', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return (
      <select ref={ref} className={cx(INPUT_CLASS, 'cursor-pointer', className)} {...rest} />
    );
  },
);

/* ---------- Alert（附录 AlertBanner：danger 常驻 / warn 可关闭） ---------- */

const ALERT_TONE: Record<'danger' | 'warn' | 'info' | 'ok', string> = {
  danger: 'border-danger/40 bg-danger/10 text-danger',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  info: 'border-info/40 bg-info/10 text-info',
  ok: 'border-ok/40 bg-ok/10 text-ok',
};

export function Alert(props: {
  readonly tone: 'danger' | 'warn' | 'info' | 'ok';
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly role?: string;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <div
      role={props.role ?? 'alert'}
      data-testid={props['data-testid']}
      className={cx(
        'flex items-center gap-3 rounded-md border px-3 py-2 text-sm',
        ALERT_TONE[props.tone],
        props.className,
      )}
    >
      <div className="min-w-0 flex-1">{props.children}</div>
      {props.action}
    </div>
  );
}

/* ---------- EmptyState ---------- */

export function EmptyState(props: {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <div
      data-testid={props['data-testid']}
      className={cx(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline py-8 text-sm text-ink-subtle',
        props.className,
      )}
    >
      {props.icon !== undefined && <span className="text-ink-tertiary">{props.icon}</span>}
      {props.children}
    </div>
  );
}

/* ---------- Modal（附录：overlay 60% 黑 + surface-1 面板） ---------- */

export function Modal(props: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-overlay/60 p-6 pt-[10vh]">
      <section
        role="dialog"
        aria-label={props['aria-label']}
        data-testid={props['data-testid']}
        className="w-full max-w-2xl rounded-lg border border-hairline-strong bg-surface-1 p-5 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-medium text-ink">{props.title}</h2>
          {props.footer}
        </header>
        {props.children}
      </section>
    </div>
  );
}
