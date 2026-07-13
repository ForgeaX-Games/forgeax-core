/**
 * Banner + Transcript header(设计稿 §3.2):
 *   - Banner 呈现版本/模型/会话/截断 cwd;truncateHead 头部截断(宽字符感知)。
 *   - Transcript 挂 header 后:横幅经 <Static> 发射且排最前;redrawNonce bump
 *     (重挂载重放,= /clear 语义)后重发。
 *   - 哨兵不进闭合 union:redraw-window 的 tailStartIndex/estimateItemLines 输入
 *     仍是 TranscriptItem[](类型即证明);行为上窗口计算与 header 无关。
 */
import { test, expect, describe } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Banner, truncateHead } from '../../src/tui/components/Banner';
import { Transcript } from '../../src/tui/transcript/Transcript';
import { tailStartIndex } from '../../src/tui/transcript/redraw-window';
import { reduceTranscript } from '../../src/tui/transcript/reduce';
import { FORGEAX_CORE_VERSION } from '../../src/version';
// 消息视图自注册(app.tsx 同款副作用 import,否则 user/assistant 落 thin 兜底)。
import '../../src/tui/views/messages/index';
import '../../src/tui/views/tools/index';

const toolMeta = (name: string): { canonical: string; displayName: string } => ({
  canonical: name,
  displayName: name,
});

describe('truncateHead', () => {
  test('short strings pass through', () => {
    expect(truncateHead('/a/b', 20)).toBe('/a/b');
  });
  test('long strings keep the tail with … prefix, within budget', () => {
    const out = truncateHead('/Users/you/github/forgeax-studio3/packages/core', 20);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('packages/core')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });
  test('CJK-aware (wide chars count 2 columns)', () => {
    const out = truncateHead('/项目/目录/子目录', 8);
    expect(out.startsWith('…')).toBe(true);
  });
});

describe('Banner', () => {
  test('renders name, version, model, session and cwd', () => {
    const { lastFrame } = render(
      <Banner version={FORGEAX_CORE_VERSION} model="claude-opus-4-8" sessionId="20260713-x" cwd="/tmp/proj" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('forgeax-core');
    expect(frame).toContain(`v${FORGEAX_CORE_VERSION}`);
    expect(frame).toContain('claude-opus-4-8');
    expect(frame).toContain('session 20260713-x');
    expect(frame).toContain('/tmp/proj');
  });
  test('omits session segment when sessionId absent', () => {
    const { lastFrame } = render(<Banner version="1.0.0" model="m" cwd="/tmp" />);
    expect(lastFrame()).not.toContain('session');
  });
});

describe('Transcript header (banner via <Static>)', () => {
  const log = [{ kind: 'user' as const, text: 'hello world question' }];
  const banner = <Banner version={FORGEAX_CORE_VERSION} model="claude-opus-4-8" cwd="/tmp/proj" />;

  test('banner is emitted and appears before transcript content', () => {
    const { lastFrame } = render(
      <Transcript log={log} busy={false} toolMeta={toolMeta} header={banner} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('forgeax-core');
    expect(frame).toContain('hello world question');
    expect(frame.indexOf('forgeax-core')).toBeLessThan(frame.indexOf('hello world question'));
  });

  test('no header → no banner text', () => {
    const { lastFrame } = render(<Transcript log={log} busy={false} toolMeta={toolMeta} />);
    expect(lastFrame()).not.toContain('forgeax-core');
  });

  test('redrawNonce bump (remount = /clear·resize·resume) re-emits the banner', () => {
    const { rerender, frames } = render(
      <Transcript log={log} busy={false} toolMeta={toolMeta} header={banner} redrawNonce={0} />,
    );
    rerender(
      <Transcript log={[]} busy={false} toolMeta={toolMeta} header={banner} redrawNonce={1} />,
    );
    // 重挂载 → <Static> 重放,横幅第二次发射(真实 TUI 里 replaceTranscript 先 cleanRedraw
    // 清屏,故用户看到的是「/clear 后横幅重现」;测试库不清屏,以发射次数断言)。
    const all = frames.join('\n');
    const emits = all.split('forgeax-core').length - 1;
    expect(emits).toBeGreaterThanOrEqual(2);
  });

  test('redraw window math is header-agnostic (sentinel never enters TranscriptItem[])', () => {
    // tailStartIndex 的输入是 reduce 出的 TranscriptItem[] —— header 根本不在其中,
    // 类型上哨兵进不去(闭合 union),行为上窗口起点与 header 无关。
    const items = reduceTranscript(log);
    expect(tailStartIndex(items, 80, 24)).toBe(0);
  });
});
