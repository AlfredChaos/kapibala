// 仪表盘图表基元（纯 SVG，零图表库依赖；token 走语义类不落 hex）。
import type { ReactNode } from 'react';
import { cx } from './cx.js';
import type { Tone } from './primitives.js';

/* ---------- StatCard：顶部指标卡 ---------- */

const STAT_TONE: Record<Tone | 'ink', string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-ink-subtle',
  ink: 'text-ink',
};

export function StatCard(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: Tone | 'ink';
}): JSX.Element {
  return (
    <div className="rounded-lg border border-hairline bg-surface-1 p-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-subtle">{props.label}</span>
        <span className="text-ink-tertiary">{props.icon}</span>
      </div>
      <div
        className={cx(
          'mt-2 text-2xl font-semibold tracking-tight',
          STAT_TONE[props.tone ?? 'ink'],
        )}
      >
        {props.value}
      </div>
      {props.hint !== undefined && (
        <div className="mt-1 text-[11px] text-ink-tertiary">{props.hint}</div>
      )}
    </div>
  );
}

/* ---------- BarsChart：分钟桶活动柱状图（SVG） ---------- */

export function BarsChart(props: {
  /** 桶计数，旧→新顺序 */
  readonly values: readonly number[];
  readonly height?: number;
  readonly className?: string;
}): JSX.Element {
  const h = props.height ?? 72;
  const max = Math.max(1, ...props.values);
  const n = Math.max(1, props.values.length);
  const barW = 100 / n;
  return (
    <svg
      role="img"
      aria-label="消息活动柱状图"
      viewBox={`0 0 100 ${h}`}
      preserveAspectRatio="none"
      className={cx('block w-full', props.className)}
      style={{ height: h }}
    >
      {props.values.map((v, i) => {
        const bh = v === 0 ? 0 : Math.max(2, (v / max) * (h - 4));
        return (
          <rect
            key={i}
            x={i * barW + barW * 0.15}
            y={h - bh}
            width={barW * 0.7}
            height={bh}
            rx={1}
            className={v === 0 ? 'fill-surface-2' : 'fill-primary/70'}
          >
            <title>{`${v} 条`}</title>
          </rect>
        );
      })}
      {/* 基线 */}
      <rect x={0} y={h - 1} width={100} height={0.5} className="fill-hairline" />
    </svg>
  );
}

/* ---------- MeterRow：标签 + 占比条 + 计数 ---------- */

const METER_FILL: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
};

export function MeterRow(props: {
  readonly label: string;
  readonly value: number;
  readonly total: number;
  readonly tone: Tone;
}): JSX.Element {
  const pct = props.total === 0 ? 0 : Math.round((props.value / props.total) * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-[11px] text-ink-subtle">{props.label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cx('h-full rounded-full transition-[width] duration-300', METER_FILL[props.tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-xs text-ink-muted">
        {props.value}
      </span>
    </div>
  );
}
