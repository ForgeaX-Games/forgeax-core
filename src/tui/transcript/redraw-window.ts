/**
 * redraw-window —— resize 重灌的回放窗口(纯函数,可单测)。
 *
 * 病根:resize 干净重绘(use-resize-redraw)清屏+清 scrollback 后,把 committed
 * transcript **整段**重新 emit,重灌量 ∝ 会话长度。长会话切终端 tab / 拖宽度时,
 * 字节洪峰灌满 pty(1024B/块切碎同步更新),终端(尤其 VS Code xterm.js)的视口
 * 跟随在洪峰中间歇失效,最终停在 scrollback 半中间——「快速滚动但不落底」。
 *
 * 修法:resize 重灌只回放**末尾 REDRAW_SCREENS 屏**(行数按 displayWidth 粗估),
 * 把重灌从 O(会话) 压到 O(屏幕)。更早的历史 resize 后不再重灌——3J 反正已清、
 * 旧行也已被终端 reflow 弄乱;取舍与 cc 一致(cc resize 后 scrollback 全丢,这里
 * 至少保住最近几屏)。/resume 的全量重灌不走本窗口(恢复完整历史是它的语义)。
 *
 * 行数是**粗估**(markdown 装饰、工具卡截断都按常数近似),只用来划窗口边界,
 * 宁可少算多回放几行,不追求逐行精确。
 *
 * Boundary(HOST 层):仅 core 相对 import,无 react/ink,纯函数。
 */
import type { TranscriptItem, AgentEvent } from './items';
import { displayWidth } from '../text-width';

/** resize 重灌回放的视口倍数(末尾 N 屏)。 */
export const REDRAW_SCREENS = 3;

/** 工具卡渲染高度粗估:头行 + 截断预览(各工具视图都截断输出)。 */
const TOOL_CARD_LINES = 6;
/** 折叠态 thinking 的高度粗估(一行摘要 + 留白)。 */
const THINKING_COLLAPSED_LINES = 2;

/** 多行文本按宽 cols 硬换行后的行数(逐行 displayWidth/cols 向上取整)。 */
function textLines(text: string, cols: number): number {
  if (!text) return 1;
  let n = 0;
  for (const line of text.split('\n')) {
    n += Math.max(1, Math.ceil(displayWidth(line) / cols));
  }
  return n;
}

/** assistant 事件里 text 块拼接 + 是否带 thinking(块形状对齐 views/messages/Thinking)。 */
function assistantContent(ev: Extract<AgentEvent, { type: 'assistant' }>): {
  text: string;
  hasThinking: boolean;
} {
  const content = (ev.message.payload as { content?: Array<{ type: string; text?: string }> })
    ?.content;
  if (!Array.isArray(content)) return { text: '', hasThinking: false };
  return {
    text: content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n'),
    hasThinking: content.some((b) => b.type === 'thinking'),
  };
}

function estimateItemLines(item: TranscriptItem, cols: number): number {
  switch (item.kind) {
    case 'user':
    case 'notice':
      return textLines(item.text, cols);
    case 'tool':
      return TOOL_CARD_LINES;
    case 'assistant': {
      if (item.event.type !== 'assistant') return 1;
      const { text, hasThinking } = assistantContent(item.event);
      return textLines(text, cols) + (hasThinking ? THINKING_COLLAPSED_LINES : 0);
    }
  }
}

/**
 * 回放窗口起点:从末尾向前累计估行(每条 +1 行条目间距),超过 rows*screens 停。
 * 至少包含最后一条(条目不可截断,单条超窗也整条回放)。空数组 → 0。
 */
export function tailStartIndex(
  items: TranscriptItem[],
  cols: number,
  rows: number,
  screens: number = REDRAW_SCREENS,
): number {
  const budget = Math.max(1, rows) * Math.max(1, screens);
  const width = Math.max(20, cols);
  let lines = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    lines += estimateItemLines(items[i]!, width) + 1; // +1 = 条目 marginTop
    if (lines > budget) return Math.min(i + 1, Math.max(0, items.length - 1));
  }
  return 0;
}
