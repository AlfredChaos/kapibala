// @vitest-environment happy-dom
// RouteErrorBoundary（用户要求 2026-09-28）：子树渲染期抛错 → 兜底落 404 视觉页；
// 无错时透传 children。Link 依赖 Router context——测试用 MemoryRouter 包裹。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { RouteErrorBoundary } from '../src/components/RouteErrorBoundary.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Bomb(): JSX.Element {
  throw new Error('boom');
}

describe('RouteErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('子树正常渲染 → 透传 children', () => {
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(
              RouteErrorBoundary,
              null,
              createElement('p', { 'data-testid': 'ok' }, 'fine'),
            ),
          ),
        ),
      );
    });
    expect(container.querySelector('[data-testid="ok"]')?.textContent).toBe('fine');
  });

  it('子树 render 抛错 → 兜底 404 视觉页 + 返回工作台链接', () => {
    // React 会对捕获的错误 console.error——压噪不影响断言
    const silence = console.error;
    console.error = () => undefined;
    try {
      act(() => {
        root.render(
          createElement(
            MemoryRouter,
            null,
            createElement(RouteErrorBoundary, null, createElement(Bomb)),
          ),
        );
      });
    } finally {
      console.error = silence;
    }
    const heading = container.querySelector('h1');
    expect(heading?.textContent).toBe('404');
    expect(container.textContent).toContain('页面出错了');
    const back = container.querySelector('a[href="/dashboard"]');
    expect(back?.textContent).toContain('返回工作台');
  });
});
