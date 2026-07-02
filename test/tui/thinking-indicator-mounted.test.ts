/**
 * 08.9 回归:ThinkingIndicator 不再是死代码,busy 时状态栏有 spinner + thinking 文案。
 *
 * 两层验证:
 *  1. 源码层 —— Repl.tsx 必须 import/挂载 ThinkingIndicator(证明零引用死代码已消除)。
 *  2. 渲染层 —— busy=true 输出含 "thinking";busy=false 输出为空(与 StatusLine 一致,非 busy 不占位)。
 */
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/tui/providers/theme';
import { ThinkingIndicator } from '../../src/tui/components/ThinkingIndicator';

describe('08.9 ThinkingIndicator mounted (no longer dead code)', () => {
  test('源码层:Repl.tsx 引用了 ThinkingIndicator', () => {
    const replPath = fileURLToPath(new URL('../../src/tui/screens/Repl.tsx', import.meta.url));
    const src = readFileSync(replPath, 'utf8');
    expect(src).toContain('ThinkingIndicator');
  });

  test('渲染层:busy=true 显示 thinking 文案', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, null, React.createElement(ThinkingIndicator, { busy: true })),
    );
    expect(lastFrame() ?? '').toContain('thinking');
  });

  test('渲染层:busy=false 不占位(输出为空)', () => {
    const { lastFrame } = render(
      React.createElement(ThemeProvider, null, React.createElement(ThinkingIndicator, { busy: false })),
    );
    expect((lastFrame() ?? '').trim()).toBe('');
  });
});
