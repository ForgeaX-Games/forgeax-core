/**
 * input/pasteText.ts —— 大段/多行文本粘贴的"折叠占位"(占位形如 `[Pasted text #N +L lines]`)。
 *
 * 动机(见截图反馈):把多行文本整块塞进输入框会淹没输入区。做法是——粘贴的多行文本在
 * 输入框/transcript 里**折叠成一行占位** `[Pasted text #1 +20 lines]`,真正的正文另存;**提交时
 * 再展开**回原文喂给模型。本模块提供折叠判定 / 占位串 / 展开三件套(纯函数,可单测)。
 *
 * 数据流(Repl 持有 `pendingPastesRef: string[]`,索引 = 占位里的 #N):
 *   多行 paste → ingestPastedText:存正文 + 在光标处插占位 → submit 时 expandPastes(显示文本, pastes)
 *   → 展开文本作为**模型 prompt**;session 里 user 条目仍存**占位文本 + pastes**(显示折叠、历史可展开)。
 *
 * Boundary(HOST 层):零依赖纯函数。
 */

/** 占位串正则:`[Pasted text #<n> +<lines> lines]`。展开时按 #n 取 pastes[n-1]。 */
const PLACEHOLDER_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;

/** 是否该折叠:多行粘贴(含换行)即折叠;单行(哪怕较长)保持内联可编辑,行为最不意外。 */
export function shouldCollapsePaste(text: string): boolean {
  return /\r|\n/.test(text);
}

/** 行数(用于占位里的 `+L lines`)。 */
export function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/** 生成占位串。n=第几段粘贴(1-based);行数取自正文。 */
export function pastePlaceholder(n: number, text: string): string {
  return `[Pasted text #${n} +${countLines(text)} lines]`;
}

/**
 * 把显示文本里的占位展开回原文(提交给模型 / 重建历史时用)。
 * @param text   含占位的显示文本
 * @param pastes 正文数组(pastes[n-1] 对应 `#n`);缺项 → 保留占位原样(不误删)。
 */
export function expandPastes(text: string, pastes?: readonly string[]): string {
  if (!pastes || pastes.length === 0) return text;
  return text.replace(PLACEHOLDER_RE, (m, n: string) => pastes[Number(n) - 1] ?? m);
}
