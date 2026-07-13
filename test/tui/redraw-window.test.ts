/**
 * redraw-window 纯函数单测 —— resize 重灌的回放窗口(tailStartIndex)。
 *
 * 覆盖:
 *   - 空数组 → 0
 *   - 内容不足一个窗口 → 0(全量回放)
 *   - 超窗 → 起点使尾部估行 ≤ 预算,且窗口外确实放不下(边界精确)
 *   - 单条超窗的末条 → 至少回放最后一条
 *   - CJK 宽字符按显示宽度折行计入
 *   - 工具卡 / 带 thinking 的 assistant 按常数粗估计入
 *
 * 纯函数测试,不依赖 react/ink。
 */
import { test, expect, describe } from 'bun:test';
import { tailStartIndex } from '../../src/tui/transcript/redraw-window';
import type { TranscriptItem, AgentEvent } from '../../src/tui/transcript/items';
import type { CoreEvent } from '../../src/events/types';

const user = (id: number, text: string): TranscriptItem => ({ kind: 'user', id, text });

function assistant(id: number, text: string, thinking = false): TranscriptItem {
  const content: Array<{ type: string; text?: string; thinking?: string }> = [
    { type: 'text', text },
  ];
  if (thinking) content.unshift({ type: 'thinking', thinking: 'hmm' });
  const message: CoreEvent = { type: 'message', ts: 0, payload: { content } };
  const event: AgentEvent = { type: 'assistant', message };
  return { kind: 'assistant', id, event };
}

const tool = (id: number): TranscriptItem => ({
  kind: 'tool',
  id,
  toolUseId: `t${id}`,
  name: 'bash',
  input: {},
  status: 'ok',
});

describe('tailStartIndex', () => {
  test('空数组 → 0', () => {
    expect(tailStartIndex([], 80, 24)).toBe(0);
  });

  test('内容不足一个窗口 → 0(全量回放)', () => {
    const items = [user(0, 'hi'), assistant(1, 'hello')];
    expect(tailStartIndex(items, 80, 24)).toBe(0);
  });

  test('超窗时窗口边界精确:尾部恰好填满预算', () => {
    // 每条 user('hi') 估 1 行 + 1 行间距 = 2 行;预算 rows=10 × screens=3 = 30 行。
    // 20 条 × 2 = 40 行 > 30 → 尾部恰好容 15 条(30 行),起点 = 5。
    const items = Array.from({ length: 20 }, (_, i) => user(i, 'hi'));
    expect(tailStartIndex(items, 80, 10, 3)).toBe(5);
  });

  test('单条超窗的末条 → 仍回放最后一条', () => {
    const huge = Array.from({ length: 200 }, () => 'line').join('\n');
    const items = [user(0, 'hi'), user(1, huge)];
    expect(tailStartIndex(items, 80, 10, 3)).toBe(1);
  });

  test('CJK 按显示宽度折行:全角字符占 2 列', () => {
    // cols=20,一行 30 个全角字 = 显示宽 60 → 3 行 + 1 间距 = 4 行/条。
    // 预算 rows=10 × 2 屏 = 20 行 → 容 5 条;8 条时起点 = 3。
    const cjk = '汉'.repeat(30);
    const items = Array.from({ length: 8 }, (_, i) => user(i, cjk));
    expect(tailStartIndex(items, 20, 10, 2)).toBe(3);
  });

  test('工具卡与 thinking 按常数粗估计入', () => {
    // tool 卡估 6 行 + 1 间距 = 7 行;预算 rows=7 × 2 = 14 行 → 恰容 2 张;3 张时起点 = 1。
    const tools = [tool(0), tool(1), tool(2)];
    expect(tailStartIndex(tools, 80, 7, 2)).toBe(1);
    // 带 thinking 的 assistant:1 行文本 + 2 行 thinking + 1 间距 = 4 行;
    // 预算 rows=4 × 2 = 8 行 → 恰容 2 条;3 条时起点 = 1。
    const withThinking = [assistant(0, 'a', true), assistant(1, 'b', true), assistant(2, 'c', true)];
    expect(tailStartIndex(withThinking, 80, 4, 2)).toBe(1);
  });
});
