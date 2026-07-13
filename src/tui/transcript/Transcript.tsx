/**
 * Transcript.tsx —— 提交生命周期的唯一 owner(梁②)。
 *
 * 持 flushedCount:
 *   - reduceTranscript(log[0..flushed]) → <Static>(committed,Ink 只渲染新增,
 *     承载海量历史,提交后不再重渲)。
 *   - reduceTranscript(log[flushed..]) → live 区(本轮进行中,实时重渲;工具卡
 *     才能从 running→✓/✗ 更新,不被 Static 冻结)。
 *   - turn 结束(!busy)推进 flushed = log.length。彻底解决 Static 冻结(梁② 病根)。
 *
 * **切分必须在 reduce 之前**(按 log 下标切),否则跨边界的 tool_call/tool_result
 * 会被切到两段而配不上对。reduce 各段内部各自配对;一个完整 turn 的 call+result
 * 同在 live 段,turn 结束后整段一起进 Static,配对关系完好。
 *
 * 单条渲染(P6 合龙已接真渲染器):
 *   - tool      → resolveToolByMeta(toolMeta, name):先经 driver.toolMeta(name).canonical
 *                 吃掉别名(`Bash`→`bash`),再按 canonical 真名查 views/tools/registry;
 *                 未命中落 Default(永不抛)。
 *   - assistant → views/messages:thinking(可折叠,expanded 控)+ text。
 *   - user / notice → views/messages 按 key 分发。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static } from 'ink';
import type { TranscriptItem, SessionEntry } from './items';
import { reduceTranscript, safeFlushBoundary } from './reduce';
import { tailStartIndex } from './redraw-window';
import { useTheme } from '../providers/theme';
import type { ThemeTokens } from '../contracts';
import { resolveToolByMeta } from '../views/tools/registry';
import { resolveMessageByItem, type MessageViewProps } from '../views/messages/registry';
import { ThinkingView, thinkingText } from '../views/messages/Thinking';
import { LiveThinking } from '../components/LiveThinking';
import { useResizeRedraw } from '../use-resize-redraw';
import { termWidth } from '../text-width';
import { shellMarksEnabled } from '../shell-marks';

/** driver.toolMeta 的最小形状(查工具卡只需 canonical;别名在此被吃掉)。 */
type ToolMetaFn = (name: string) => { canonical: string; displayName: string };

export interface TranscriptProps {
  /** session 真相:有序事件日志(梁②;user 输入 + 原生 AgentEvent)。 */
  log: SessionEntry[];
  /** 本轮是否进行中。!busy 时把 live 段提交进 Static(推进 flushed)。 */
  busy: boolean;
  /** driver.toolMeta:工具卡查表前经它解析 canonical(吃掉别名)。 */
  toolMeta: ToolMetaFn;
  /** ctrl+o 控制 thinking 是否展开(透传给 views/messages/Thinking)。 */
  expanded?: boolean;
  /** /resume 整体替换 transcript 时由上层自增:并入 <Static key> 强制重挂载 → 重新 emit
   *  恢复会话的全量历史(否则 Ink <Static> 只追加新条目,旧 transcript 不会被替换)。 */
  redrawNonce?: number;
  /** 本轮正在流式写入、尚未被 `assistant` 事件收口的文本(节流后)。空串=无在写文本。
   *  渲染在 live 尾部,与最终 assistant 条目走同一渲染路径(视觉零跳变)。 */
  streamingText?: string;
  /** 本轮正在流式写入的 thinking(节流后,F2)。空串=无在写 thinking。渲染在流式文本**之上**
   *  (thinking 先于答案),dim 呈现;`assistant` 事件到达即清空 → 由 durable 条目的折叠
   *  ThinkingView 接管(「先显示 → 折叠」)。 */
  streamingThinking?: string;
  /** 欢迎横幅等一次性头部:prepend 到 <Static> items 最前,发射一次随 scrollback 上滚;
   *  redrawNonce/resize 重挂载时白得重现(/clear 后横幅重现即由此而来)。
   *  渲染关切非会话数据 —— 不进 log,不参与 reduce/回放窗口计算。 */
  header?: React.ReactNode;
}

/** header 的 Static 哨兵条目。**刻意不进闭合 union `TranscriptItem`**(否则
 *  redraw-window 的穷尽 switch `estimateItemLines` 要加死分支);仅 Transcript 内部
 *  把 Static items 元素类型局部放宽为 `TranscriptItem | BannerItem`,render callback
 *  先按 kind==='banner' 分流。id=-2 哨兵(-1 已被流式合成条目占用,真实条目 ≥0)。 */
type BannerItem = { kind: 'banner'; id: -2; node: React.ReactNode };
type StaticEntry = TranscriptItem | BannerItem;

/** 把在写文本包成一条合成 assistant 条目,复用 renderItem → AssistantView → Markdown。
 *  id 用 -1 哨兵(绝不与真实 log 下标 ≥0 冲突)。 */
function streamingItem(text: string): TranscriptItem {
  return {
    kind: 'assistant',
    id: -1,
    event: {
      type: 'assistant',
      message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text }] } },
    },
  } as TranscriptItem;
}

export function Transcript(props: TranscriptProps): React.ReactElement {
  const { log, busy, toolMeta, expanded, redrawNonce = 0, streamingText = '', streamingThinking = '', header } = props;
  const theme = useTheme();
  // shell-integration 标记(OSC 133)只挂 committed 的 user 条目(live 区每帧重画会重置终端
  //   command 记账 —— 绝不发)。enablement 两道闸走 shellMarksEnabled()(真 TTY + 未 env 关)。
  const shellMarks = shellMarksEnabled();

  // resize 干净重绘:staticKey 随终端 resize 自增,用作 <Static key> 触发重挂载 +
  //   重新 emit 整段 transcript(配合 patch 的 resetStaticOutput + clearTerminal,绕开
  //   stock ink resized() 在终端 reflow 后 eraseLines 擦错行数的残影)。见 use-resize-redraw。
  const staticKey = useResizeRedraw();
  // 实际 <Static> key:resize(staticKey)与 /resume 替换(redrawNonce)任一变化都重挂载重绘。
  const staticRenderKey = `${staticKey}:${redrawNonce}`;

  // ── 提交边界(增量):把「已定型」的前缀持续刷进 <Static>,而非憋到 turn 结束。
  //   旧实现把整轮输出全留在 live 动态区直到 !busy → 长输出时动态区超过终端高度,
  //   Ink 每帧整段擦除重画(还叠加 spinner / elapsed 高频刷),视口被反复拽回底部 →
  //   往上滚就被弹回、滚不到底。改为:
  //     ① 随日志推进到 safeFlushBoundary(所有已出现工具均已配对的最大前缀),单调不退;
  //        live 动态区只剩「仍在 running 的工具卡 + 其后尾巴」,恒压在一屏内。
  //     ② turn 结束(!busy)再兜底全量提交(含被 abort 的 running 卡 —— 其 result 永不再来,
  //        已是 terminal,可安全冻结)。
  //     ③ 日志缩短(rewind/clear)时把 flushed 夹回,避免越界 / committed 与 live 重复。
  const [flushed, setFlushed] = useState(0);
  const boundary = useMemo(() => safeFlushBoundary(log), [log]);
  useEffect(() => {
    setFlushed((f) => (f > log.length ? log.length : Math.max(f, boundary)));
  }, [boundary, log.length]);
  useEffect(() => {
    if (!busy) setFlushed(log.length);
  }, [busy, log.length]);

  // 先按 log 下标切,再各自 reduce(保证跨边界的 call/result 不被切散)。
  const committed = useMemo<TranscriptItem[]>(
    () => reduceTranscript(log.slice(0, flushed)),
    [log, flushed],
  );
  const live = useMemo<TranscriptItem[]>(
    () => reduceTranscript(log.slice(flushed)),
    [log, flushed],
  );

  // ── resize 重灌窗口:resize(staticKey 变)触发的 <Static> 重挂载只回放末尾 ~3 屏
  //   (redraw-window.ts;重灌 O(屏幕) 而非 O(会话),根治长会话切 tab 时的滚动风暴 +
  //   视口不落底)。/resume(redrawNonce 变)保持全量回放——恢复完整历史是它的语义。
  //   窗口起点只在重挂载瞬间重算并冻结:<Static> 内部按「已渲染条数」记账,窗口若在
  //   两次 remount 之间漂移,记账错位会导致条目漏发/复灌。
  const windowRef = useRef({ staticKey, redrawNonce, tailStart: 0 });
  if (windowRef.current.staticKey !== staticKey || windowRef.current.redrawNonce !== redrawNonce) {
    const resumeReplaced = windowRef.current.redrawNonce !== redrawNonce;
    windowRef.current = {
      staticKey,
      redrawNonce,
      tailStart: resumeReplaced
        ? 0
        : tailStartIndex(committed, termWidth(), process.stdout.rows ?? 24),
    };
  }
  // header(欢迎横幅哨兵)prepend 到**尾部切片之后**的 committed 最前:tailStartIndex 只
  //   吃纯 committed(TranscriptItem[]、永不见哨兵),重挂载重放时横幅恒在最前;尾窗切掉
  //   历史(tailStart>0)时横幅仍随尾部窗口重现。/clear 后横幅重现即由此而来。
  const tail =
    windowRef.current.tailStart > 0 ? committed.slice(windowRef.current.tailStart) : committed;
  const staticItems: StaticEntry[] =
    header != null ? [{ kind: 'banner', id: -2, node: header }, ...tail] : tail;

  return (
    <Box flexDirection="column">
      {/* committed:Ink <Static> 只渲染新增条目;key=staticRenderKey 让 resize / /resume 时
          整体重挂载重画(resize 只回放尾部窗口,见上方 windowRef)。
          每块上方留一行(marginTop=1)给透气感。 */}
      <Static key={staticRenderKey} items={staticItems}>
        {(item) => (
          <Box key={item.id} flexDirection="column" marginTop={1}>
            {item.kind === 'banner'
              ? item.node
              : renderItem(item, theme, toolMeta, expanded, shellMarks)}
          </Box>
        )}
      </Static>

      {/* live:本轮进行中条目(实时重渲;工具卡 running→✓/✗ 在此更新)。 */}
      {live.map((item) => (
        <Box key={item.id} flexDirection="column" marginTop={1}>
          {renderItem(item, theme, toolMeta, expanded)}
        </Box>
      ))}

      {/* 在写 thinking(流式,节流后,F2):渲染在流式文本**之上**(thinking 先于答案),dim;
          `assistant` 事件到达即清空 → 由 durable 条目的折叠 ThinkingView 接管(先显示→折叠)。 */}
      {streamingThinking ? (
        <Box key="streaming-thinking" flexDirection="column" marginTop={1}>
          <LiveThinking text={streamingThinking} />
        </Box>
      ) : null}

      {/* 在写文本(流式,节流后):live 尾部渲染合成 assistant 条目;`assistant` 事件到达即
          清空(streamingText 归 '') → 由上面 live 里的 durable 条目接管,视觉零跳变。 */}
      {streamingText ? (
        <Box key="streaming" flexDirection="column" marginTop={1}>
          {renderItem(streamingItem(streamingText), theme, toolMeta, expanded)}
        </Box>
      ) : null}
    </Box>
  );
}

/** 单条渲染分发(无 switch on 渲染器;查表走 registry)。 */
function renderItem(
  item: TranscriptItem,
  theme: ThemeTokens,
  toolMeta: ToolMetaFn,
  expanded?: boolean,
  shellMarks?: boolean,
): React.ReactNode {
  if (item.kind === 'tool') {
    // 工具卡:经 toolMeta(name).canonical 解析(吃掉别名)→ views/tools/registry。
    const meta = toolMeta(item.name);
    const view = resolveToolByMeta(toolMeta, item.name);
    return view({
      name: meta.canonical,
      displayName: meta.displayName,
      input: item.input,
      result: item.result,
      status: item.status,
      isError: item.isError,
      theme,
    });
  }

  if (item.kind === 'assistant' && item.event.type === 'assistant') {
    // assistant:先渲染 thinking(若有,可折叠),再渲染 text(经 messages registry)。
    const hasThinking = thinkingText(item.event).length > 0;
    const props: MessageViewProps = { item, theme, expanded };
    const text = resolveMessageByItem(item);
    return (
      <>
        {hasThinking ? <Box key="thinking">{ThinkingView(props)}</Box> : null}
        <Box key="text">{text(props)}</Box>
      </>
    );
  }

  // user / notice / 其它 assistant → messages registry 按 key 分发。
  //   shellMarks 仅 UserView 消费(committed user 条目带 OSC 133;live 传 undefined→不带)。
  if (item.kind === 'user' || item.kind === 'notice' || item.kind === 'assistant') {
    const view = resolveMessageByItem(item);
    return view({ item, theme, expanded, shellMarks });
  }
  return null;
}
