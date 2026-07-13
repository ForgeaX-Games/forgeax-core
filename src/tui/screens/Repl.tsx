/**
 * Repl 屏(P6 合龙 —— 薄组合)。
 *
 * 地基方案 §3梁③ / §6 数据流 / §8 P6:
 *   - **唯一一个 useInput** 挂在本屏:normalizeKey → routeKey(按当前 InputMode 分发)→
 *     声明式 InputAction → 执行副作用。编辑/导航/esc 全是纯函数(input/router.ts),
 *     焦点打架结构性消失。
 *   - 渲染主体 = 梁② 的 <Transcript/>(owner 管 flushed/Static/live;reduceTranscript)。
 *     工具卡走 P4 resolveToolByMeta(driver.toolMeta, name);消息走 views/messages。
 *   - 审批/浮层走 P5 overlays(受控,自身无 useInput);本屏据 router 产出推进其 index /
 *     调 onDecision / 关闭。
 *   - session 真相 = 有序事件日志(SessionEntry[]),由 UiMessage[] 无损映射喂 reduceTranscript。
 *
 * 保留功能:取消(esc/ctrl+c 打断在飞 turn)、队列(turn 中排队、空闲消费)、/model 选择页、
 *   回退点面板、ctrl+o 展开 thinking、历史(↑↓)、删词(ctrl+w / alt+backspace)。
 *
 * 删除(对比旧 Repl):内联 deriveEntries(→ transcript/reduce)、散落 esc 逻辑(→ router 集中)、
 *   对老 tui/tools|messages|permissions 的裸名直查(→ views/overlays,查表前过 toolMeta().canonical)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type {
  AgentEvent,
  CommandCtx,
  ImageAttachment,
  InputMode,
  Key,
  PromptState,
  ProviderMessage,
  SessionEntry,
  SessionSummary,
  UiMessage,
} from '../contracts';
import {
  buildUserContent,
  imageB64Bytes,
  isWithinImageLimit,
  looksLikeImagePath,
  readClipboardImage,
  readImageFile,
} from '../input/imagePaste';
import { useTheme } from '../providers/theme';
import { useSession } from '../providers/session';
import { useStatusLine } from '../providers/status-line';
import { useInputHistory } from '../providers/input-history';
import { usePermissionQueue } from '../providers/permission';
import { useQuestionQueue } from '../providers/question';
import { useAgent } from '../driver/useAgent';
import { resolveCommand } from '../commands/registry';
import { createPasteAssembler } from '../input/pasteAssembler';
import { shouldCollapsePaste, pastePlaceholder, expandPastes } from '../input/pasteText';
import { routeKey, type RouterCtx } from '../input/router';
import { cleanRedraw } from '../use-resize-redraw';
import { deleteWordBefore, promptReducer } from '../input/promptReducer';
import { Transcript } from '../transcript/Transcript';
import { useStreamingText, extractStreamTextDelta, extractStreamThinkingDelta, streamingEnabled } from '../transcript/useStreamingText';
import { PromptInput } from '../input/PromptInput';
import { CommandMenu, filterCommands } from '../overlays/CommandMenu';
import { ModelPicker, modelList, fetchRemoteModels } from '../overlays/ModelPicker';
import { ResumePicker, filterSessions, initialResumeIndex } from '../overlays/ResumePicker';
import { RewindPanel, type Checkpoint, type RewindStage, type RewindAction } from '../overlays/RewindPanel';
import type { DiffStats, PendingRewindView } from '../contracts';
import { Permission, PERMISSION_OPTIONS } from '../overlays/Permission';
import { Question } from '../overlays/Question';
import { RemoteControl, remoteControlLength } from '../overlays/RemoteControl';
import { useRemote } from '../providers/remote';
import { appendAssistantText } from '../remote/reply';
import type { RemoteOrigin, RemoteInboundMsg } from '../remote/controller';
import { StatusLine } from '../components/StatusLine';
import { ThinkingIndicator } from '../components/ThinkingIndicator';
import { Queue } from '../components/Queue';

/** 一条待跑的轮:本地输入(origin 省略)或远端来源(带回复定址)。msgId=回退锚点(H-02)。 */
type QueuedTurn = { prompt: string; origin?: RemoteOrigin; images?: ImageAttachment[]; msgId?: string };

// ─── UiMessage[] → SessionEntry[](梁② reduce 的输入,无损映射)─────────────────
function toSessionLog(msgs: UiMessage[]): SessionEntry[] {
  return msgs.map((m) =>
    m.kind === 'user' ? { kind: 'user', text: m.text } : { kind: 'event', event: m.event },
  );
}

/** 会话条目 → 回退点(每个 user 轮一个;keep = 该轮之前保留的条数)。
 *  codeMsgIds = 有文件快照的锚点集合(driver.listCheckpoints 派生);决定该点 hasCode。 */
function buildCheckpoints(msgs: UiMessage[], codeMsgIds: Set<string>): Checkpoint[] {
  const cps: Checkpoint[] = [];
  msgs.forEach((m, i) => {
    if (m.kind === 'user') {
      const snip = m.text.replace(/\s+/g, ' ').slice(0, 40);
      const msgId = m.msgId ?? '';
      cps.push({
        label: `回退到此轮之前:${snip}${m.text.length > 40 ? '...' : ''}`,
        keep: i,
        msgId,
        hasCode: msgId !== '' && codeMsgIds.has(msgId),
      });
    }
  });
  return cps.reverse(); // 最近的回退点排最前
}

/** 把一段文本包成 assistant 文本条目(回退点提示等系统通知;与 ctx.print 同机制)。 */
function noticeMsg(text: string): UiMessage {
  return {
    kind: 'agent',
    event: { type: 'assistant', message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text }] } } } as AgentEvent,
  };
}

export function Repl(): React.ReactElement {
  const theme = useTheme();
  const session = useSession();
  const status = useStatusLine();
  const history = useInputHistory();
  const permissions = usePermissionQueue();
  const questions = useQuestionQueue();
  const agent = useAgent();
  const remote = useRemote();
  const { exit } = useApp();

  // ── 流式在写文本(节流累积,不进 session 日志;见 useStreamingText)。turn 内边流边显,
  //   `assistant` 事件收口、`done` 保留残留。开关 FORGEAX_NO_STREAM=1 → 回退整块渲染。
  //   解构:displayText(streamingText)随流变化;feed/finalize/reset 稳定引用(免 callback 抖动)。 ──
  const { displayText: streamingText, feed: streamFeed, finalize: streamFinalize, reset: streamReset } = useStreamingText();
  // F2:thinking 走同一节流通道的第二个实例(与 streamingText 对称)。turn 内边流边显(dim,
  //   渲染在流式文本之上),`assistant` 事件收口 → 由折叠 ThinkingView 接管(「先显示 → 折叠」)。
  const { displayText: streamingThinking, feed: thinkFeed, finalize: thinkFinalize, reset: thinkReset } = useStreamingText();
  const streamOn = streamingEnabled();

  // ── 输入框状态(单一真相:value + cursor;编辑全经 promptReducer 纯函数)──
  const [prompt, setPrompt] = useState<PromptState>({ value: '', cursor: 0 });
  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  // ── 浮层开关 + 高亮 index(浮层受控,index 由本屏持有)──
  const [showRewind, setShowRewind] = useState(false);
  // 回退点面板子态:list 选点 / confirm 看 diff 确认 / pending 挂起态动作。
  const [rewindStage, setRewindStage] = useState<RewindStage>('list');
  const [rewindPick, setRewindPick] = useState<{ cp: Checkpoint; diff: DiffStats | null } | null>(null);
  const [pendingView, setPendingView] = useState<PendingRewindView | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  // 远端模型表(/v1/models):null=未拉过;[]=拉过但失败/空(modelList 退 KNOWN_MODELS 兜底)。
  const [remoteModels, setRemoteModels] = useState<string[] | null>(null);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const [showRemoteControl, setShowRemoteControl] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]); // /resume 打开时快照
  const [overlayIndex, setOverlayIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [redrawNonce, setRedrawNonce] = useState(0); // /resume 整体替换 transcript 时自增 → 强制 <Static> 重绘

  // ── 队列 / 取消 / esc 计时 ──
  const [queued, setQueued] = useState<QueuedTurn[]>([]);
  const busyRef = useRef(false);
  const tokenTickRef = useRef(0); // 上次刷 tokens 的时刻(节流,见 runTurn;耗时已收口到 status-line provider 墙钟)
  const escArmedRef = useRef(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interruptedRef = useRef(false);
  // ── 粘贴图片:待提交的图片附件 + 在飞的异步读取(submit 前须 await,防「粘图后立刻回车」丢图)。
  const pendingImagesRef = useRef<ImageAttachment[]>([]);
  const pendingReadsRef = useRef<Promise<void>[]>([]);
  // ── 粘贴文本折叠:多行粘贴的正文另存(索引=占位 #N);提交时 expandPastes 展开回原文喂模型。
  const pendingPastesRef = useRef<string[]>([]);
  // ── bracketed paste 有状态拼装器(跨事件缓冲 ESC[200~…ESC[201~;整 TUI 唯一,随屏生命周期)。
  const pasteAsmRef = useRef(createPasteAssembler());
  const { stdout } = useStdout();

  // ── 当前 InputMode(从浮层 / 审批队列派生;router 据此分发)──
  const pending = permissions.pending[0];
  const q = questions.pending[0];
  const showCommandMenu =
    prompt.value.startsWith('/') &&
    !showRewind &&
    !showModelPicker &&
    !showResumePicker &&
    !showRemoteControl &&
    permissions.pending.length === 0 &&
    questions.pending.length === 0;
  const mode: InputMode = pending
    ? 'permission'
    : q
      ? 'question'
      : showModelPicker
        ? 'model-picker'
        : showResumePicker
          ? 'resume-picker'
          : showRewind
            ? 'rewind'
            : showRemoteControl
              ? 'remote-control'
              : showCommandMenu
                ? 'command-menu'
                : 'prompt';

  // ── 浮层条目(供 router 算 overlayLength + 渲染)──
  const menuCommands = useMemo(
    () => (showCommandMenu ? filterCommands(prompt.value.slice(1)) : []),
    [showCommandMenu, prompt.value],
  );
  // 远端表未返回前列表为空(浮层只显 loading,不闪默认表);返回后失败/空才退 KNOWN_MODELS 兜底。
  const modelsLoading = remoteModels === null;
  const models = useMemo(
    () => (remoteModels === null ? [] : modelList(agent.model, remoteModels)),
    [agent.model, remoteModels],
  );
  // 首次打开 /model 时懒拉远端模型表(key/base 取 env;失败落 [] 不重试,退静态兜底)。
  useEffect(() => {
    if (!showModelPicker || remoteModels !== null) return;
    let alive = true;
    void fetchRemoteModels().then((ids) => {
      if (alive) setRemoteModels(ids);
    });
    return () => {
      alive = false;
    };
  }, [showModelPicker, remoteModels]);
  const checkpoints = useMemo(() => {
    const codeMsgIds = new Set(agent.listCheckpoints().filter((e) => e.hasCode).map((e) => e.msgId));
    return buildCheckpoints(session.messages, codeMsgIds);
  }, [session.messages, agent]);
  // pending 子态的动作列表(由当前挂起态派生)。
  const pendingActions = useMemo<RewindAction[]>(() => {
    if (!pendingView) return [];
    const acts: RewindAction[] = [{ key: 'redo', label: '恢复(Redo)— 撤销这次回退' }];
    if (pendingView.hasCode && pendingView.keptDirty.length > 0) {
      acts.push({ key: 'overwrite', label: `这些文件也回退(${pendingView.keptDirty.length})` });
    }
    if (pendingView.hasCode && pendingView.hasOverwrite) {
      acts.push({ key: 'undo', label: '撤销「这些文件也回退」' });
    }
    acts.push({ key: 'more', label: '选择更早的回退点…' });
    return acts;
  }, [pendingView]);
  const filteredSessions = useMemo(
    () => (showResumePicker ? filterSessions(sessions, prompt.value) : []),
    [showResumePicker, sessions, prompt.value],
  );
  const overlayLength =
    mode === 'command-menu'
      ? menuCommands.length
      : mode === 'model-picker'
        ? models.length
        : mode === 'resume-picker'
          ? filteredSessions.length
          : mode === 'rewind'
            ? rewindStage === 'confirm'
              ? 1
              : rewindStage === 'pending'
                ? pendingActions.length
                : checkpoints.length
            : mode === 'remote-control'
              ? remoteControlLength(remote.accounts)
            : mode === 'permission'
              ? PERMISSION_OPTIONS.length
              : mode === 'question'
                ? (q?.items[q.cursor]?.options.length ?? 0) + 1 // +1:末尾恒补「其它/自填」行
                : 0;

  // mode 切换 / 过滤列表长度变化时复位高亮(收窄匹配时跳回最佳项,且避免越界)。
  //   例外:resume-picker 刚打开(搜索框为空)→ 默认高亮**当前激活会话**,不在列表则回退第一条;
  //   一旦开始输入搜索词,则按常规归零到过滤结果首项。
  useEffect(() => {
    if (mode === 'resume-picker' && prompt.value === '') {
      setOverlayIndex(initialResumeIndex(filteredSessions, agent.sessionId));
      return;
    }
    setOverlayIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, menuCommands.length, models.length, filteredSessions.length, q?.id, q?.cursor]);

  // 某账号「新近转 online」时:① 往 transcript 推一条「已连接」提示(否则扫码后直接回输入框,
  //   用户不知是否连上);② 自动收起远端控制面板,焦点交回聊天界面。
  //   只对「本帧首次进入 online」的 id 触发:已在线账号重开面板不会重复提示/被立刻关掉。
  const prevOnlineRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const onlineAccts = remote.accounts.filter((a) => a.status === 'online');
    const newly = onlineAccts.filter((a) => !prevOnlineRef.current.has(a.id));
    prevOnlineRef.current = new Set(onlineAccts.map((a) => a.id));
    if (newly.length === 0) return;
    for (const a of newly) session.push(noticeMsg(`✅ 已连接 ${a.label}`));
    if (showRemoteControl) setShowRemoteControl(false);
  }, [remote.accounts, showRemoteControl, session]);

  // 渲染/路由用的安全高亮:过滤收窄那一帧(effect 尚未跑)夹到合法区间,避免越界取项。
  const safeOverlayIndex = Math.min(overlayIndex, Math.max(0, overlayLength - 1));

  // ── 开启 bracketed paste(DEC 2004):终端把粘贴内容包在 ESC[200~ … ESC[201~,使「粘贴」
  //   能与「逐字键入」精确区分,且 Cmd+V 图片时发一个**空粘贴**(normalize 转 paste-image-probe)。
  //   Ink 6.x 不自管 2004,须由输入 owner 自己进/退时 set/reset。
  useEffect(() => {
    stdout?.write('\x1b[?2004h');
    return () => {
      stdout?.write('\x1b[?2004l');
    };
  }, [stdout]);

  // ── 跑一轮:把 AgentEvent reduce 进 session(有序日志)+ 更新状态栏 ──
  const runTurn = useCallback(
    async (text: string, origin?: RemoteOrigin, images?: ImageAttachment[], msgId?: string) => {
      busyRef.current = true;
      status.set({ busy: true, model: agent.model }); // 墙钟耗时由 StatusLineProvider 据 busy 自走(SSOT)
      tokenTickRef.current = 0;
      streamReset(); // 新一轮:清掉上一轮可能残留的在写文本
      thinkReset(); // F2:同上,清在写 thinking
      // 远端来源:边流边收集本轮 assistant 文本,turn 收尾后发回对端(双向中转出站半场)。
      let replyAcc = '';
      try {
        await agent.driveTurn(text, (e: AgentEvent) => {
          if (origin) replyAcc = appendAssistantText(replyAcc, e);
          // 流式文本走 ephemeral 通道:delta 喂 stream(不入 session 日志,免 reduce 每帧
          //   O(n²) 空扫);`assistant` 事件到达先 finalize(清空 → 由下面 push 的 durable
          //   条目接管,视觉零跳变);`done`(含 abort)保留残留为一条 assistant 条目。
          if (e.type === 'stream') {
            if (streamOn) {
              const d = extractStreamTextDelta(e);
              if (d) streamFeed(d);
              const td = extractStreamThinkingDelta(e); // F2:thinking delta 喂第二个流式通道
              if (td) thinkFeed(td);
            }
            // stream 事件不入 session;但 token 节流仍需推进(见下)——落到统一节流块。
          } else {
            if (e.type === 'assistant') {
              streamFinalize(); // 收口:清空 → 下面 push 的条目接管
              thinkFinalize(); // F2:thinking 收口 → 由 durable 条目的折叠 ThinkingView 接管
            }
            if (e.type === 'done') {
              // 打断保留:abort 时无 assistant 事件收口 → 残留半截文本先作条目留屏(不进 LLM
              //   历史),再 push done(其 notice「已中断」排在残留之后)。正常完成 partial='' 无副作用。
              const partial = streamFinalize();
              if (partial) session.push(noticeMsg(partial));
              thinkFinalize(); // F2:abort 时清在写 thinking(无 assistant 收口则丢弃残留,不留悬空)
            }
            session.push({ kind: 'agent', event: e });
          }
          if (e.type === 'turn_end' && e.usageContextRatio != null) {
            status.set({ ctxPct: Math.round(e.usageContextRatio * 100) });
          }
          // tokens 节流:tokens 只在事件到达时变(上下文窗口占用 input+cache,非累计 + 在飞
          //   output 估算,对齐 cc 状态栏),每 200ms 顶多刷一次降低 StatusLine 重渲。耗时不再
          //   在此刷——已收口到 StatusLineProvider 墙钟,与事件解耦(空闲期也平滑递增)。
          const now = Date.now();
          if (now - tokenTickRef.current >= 200) {
            tokenTickRef.current = now;
            status.set({ tokens: agent.getContextTokens() });
          }
        }, images, msgId);
      } finally {
        busyRef.current = false;
        status.set({ busy: false, tokens: agent.getContextTokens() }); // elapsedMs 由 provider 在 busy 收尾时定格
        // 远端中转出站:把回复发回来源对端(best-effort,失败不抛断本地)。
        if (origin && replyAcc.trim()) void remote.controller.send(origin, replyAcc);
      }
    },
    [agent, session, status, remote, streamFeed, streamFinalize, streamReset, thinkFeed, thinkFinalize, thinkReset, streamOn],
  );

  // ── transcript 整体替换/截短的唯一闸门(SSOT)──
  //   Ink <Static> 只「追加」已 commit 的旧历史,数据被替换/截短/清空都不会自行抹掉
  //   已打印的行。凡是让 session 变短或整体换内容(resume / rewind / clear)都必须经此:
  //   先 cleanRedraw 清屏 + 清 ink Static 累加器 → 跑数据变更 → bump redrawNonce 让 <Static>
  //   换 key 重挂载,按新的(更短的)log 重新 emit。漏掉任一步 → 旧条目残留在屏上(回退/清屏「没生效」)。
  const replaceTranscript = useCallback((mutate: () => void) => {
    cleanRedraw();
    streamReset(); // 清空在写文本,避免整体替换/截短后残留漂在新 transcript 上
    thinkReset(); // F2:同上,清在写 thinking
    mutate();
    setRedrawNonce((n) => n + 1);
  }, [streamReset, thinkReset]);

  // ── 恢复会话:agent.resumeSession(id) 既 reseed 下一轮 LLM 历史,又重建 transcript 回灌(替换当前)──
  const doResume = useCallback(
    async (id: string): Promise<boolean> => {
      const msgs = await agent.resumeSession(id);
      const notice = (text: string): UiMessage => ({
        kind: 'agent',
        event: { type: 'assistant', message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text }] } } },
      });
      if (!msgs) {
        session.push(notice(`❌ 未找到会话 ${id} 或其历史为空。`));
        return false;
      }
      // 整体替换 transcript → 经 replaceTranscript(清屏 + 换 log + 重挂载 <Static> 重绘)。
      replaceTranscript(() => {
        session.replaceAll(msgs); // 替换当前 transcript
        session.push(notice(`✅ 已恢复会话 ${id}(${msgs.length} 条),下一轮从该历史续接。`));
      });
      // ↑/↓ 输入历史也换栈:用恢复会话的 user prompts 重播种,否则翻的还是 resume 前敲过的内容。
      history.reset(msgs.filter((m): m is Extract<UiMessage, { kind: 'user' }> => m.kind === 'user').map((m) => m.text));
      return true;
    },
    [agent, session, replaceTranscript, history],
  );

  // ── slash 命令上下文 ──
  const ctx = useMemo<CommandCtx>(
    () => ({
      send: (t: string, images?: ImageAttachment[]) => session.push({ kind: 'user', text: t, images }),
      // /clear:既清显示(transcript)又清 driver 的 LLM 历史(convo)——只清前者会让
      //   下一轮仍把全部旧历史发给 provider(/clear「没生效」)。
      clear: () =>
        replaceTranscript(() => {
          agent.clearHistory();
          session.clear();
        }),
      exit: () => exit(),
      setModel: (id: string) => {
        agent.setModel(id);
        status.set({ model: id });
      },
      // 命令输出口:文本作 assistant 文本条目推进 session(与「未知命令」提示同机制)。
      print: (text: string) =>
        session.push({
          kind: 'agent',
          event: { type: 'assistant', message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text }] } } },
        }),
      // —— 命令补齐批次(025):委派给 driver(读 host/opts/rules/mode)——
      getUsage: () => agent.getUsage(),
      getContextStats: () => agent.getContextStats(),
      listMcp: () => agent.listMcp(),
      getPermissionRules: () => agent.getPermissionRules(),
      setPermissionMode: (m) => {
        agent.setMode(m);
        status.set({ model: agent.model });
      },
      listSessions: () => agent.listSessions(),
      resume: (id) => agent.resume(id),
      resumeInto: (id) => doResume(id),
      listAgents: () => agent.listAgents(),
      listMemory: () => agent.listMemory(),
      listSkills: () => agent.listSkills(),
      listPlugins: () => agent.listPlugins(),
      listHooks: () => agent.listHooks(),
      getStatus: () => agent.getStatus(),
      runDoctor: () => agent.runDoctor(),
      triggerCompact: (instr) => agent.triggerCompact(instr),
      runInit: (force) => agent.runInit(force),
    }),
    [session, exit, agent, status, doResume, replaceTranscript],
  );

  // ── 提交:slash 命令分发 / 普通消息入轮或排队 ──
  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      setPrompt({ value: '', cursor: 0 });
      if (!text) return;

      if (text.startsWith('/')) {
        const [name, ...rest] = text.slice(1).split(/\s+/);
        const arg = rest.join(' ').trim();
        history.add(text);
        // /model 无参 → 拉起模型选择页;带参走命令直切。
        if (name === 'model' && !arg) {
          setShowModelPicker(true);
          return;
        }
        // /remote-control 无参 → 拉起远端控制面板(同 /model 套路:特判拉浮层,带参走命令)。
        if (name === 'remote-control' && !arg) {
          setShowRemoteControl(true);
          return;
        }
        // /resume 无参 → 拉起会话选择页(快照列表;空则提示);带参走命令直接恢复(ctx.resumeInto)。
        if (name === 'resume' && !arg) {
          const ss = agent.listSessions();
          if (!ss.length) {
            session.push({
              kind: 'agent',
              event: { type: 'assistant', message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text: '没有可恢复的会话。' }] } } },
            });
            return;
          }
          setSessions(ss);
          setShowResumePicker(true);
          return;
        }
        const cmd = resolveCommand(name ?? '');
        if (!cmd) {
          session.push({
            kind: 'agent',
            event: { type: 'assistant', message: { type: 'message', ts: 0, payload: { content: [{ type: 'text', text: `未知命令 /${name}。输入 /help 查看。` }] } } },
          });
          return;
        }
        // file 指令(~/.forgeax/commands 等):展开 prompt → 作为一轮 user 输入提交。
        //   transcript 显示用户敲的 `/name args`(非庞大的展开正文);展开正文喂给模型行动。
        if (cmd.source === 'file' && cmd.expand) {
          setPendingView(null);
          const msgId = agent.checkpointTurn() ?? undefined;
          session.push({ kind: 'user', text, msgId });
          const expanded = cmd.expand(arg);
          if (busyRef.current) {
            setQueued((q) => [...q, { prompt: expanded, msgId }]);
            return;
          }
          await runTurn(expanded, undefined, undefined, msgId);
          return;
        }
        await cmd.run(ctx, arg);
        return;
      }

      // 收拢本轮图片附件:先 await 在飞的剪贴板/文件读取(防「粘图后立刻回车」竞态丢图),
      //   再取快照并清空 pending(下一轮从零)。
      if (pendingReadsRef.current.length) {
        await Promise.allSettled(pendingReadsRef.current);
        pendingReadsRef.current = [];
      }
      const images = pendingImagesRef.current.length ? pendingImagesRef.current : undefined;
      pendingImagesRef.current = [];
      // 折叠粘贴正文:显示/历史留占位(text),喂模型用展开原文(modelText)。
      const pastes = pendingPastesRef.current.length ? pendingPastesRef.current : undefined;
      pendingPastesRef.current = [];
      const modelText = expandPastes(text, pastes);

      // 新用户消息到达 → 定格上一个挂起的回退点(此后不可 Redo),并对 cwd 拍快照作本轮锚点。
      //   ⚠️ busy 排队路径下,快照时刻早于该消息真正入轮,锚点轻微偏早(可接受,见 plan 非目标)。
      agent.finalizeRewind();
      setPendingView(null);
      const msgId = agent.checkpointTurn() ?? undefined;
      history.add(text);
      session.push({ kind: 'user', text, msgId, images, pastes });

      // turn 进行中 → 排队(turn 结束后顺序发)。本地输入 origin 省略。喂模型用展开文本。
      if (busyRef.current) {
        setQueued((q) => [...q, { prompt: modelText, images, msgId }]);
        return;
      }
      await runTurn(modelText, undefined, images, msgId);
    },
    [history, session, ctx, runTurn, agent],
  );

  // ── 图片附件:把读到的图片入 pending + 在输入框插入占位符 `[Image #n]`。 ──
  const ingestImage = useCallback((img: ImageAttachment) => {
    // 5MB 硬闸:读取层已尽力缩放(macOS sips),仍超限则明确告知并跳过——绝不发注定被拒的请求。
    if (!isWithinImageLimit(img)) {
      const mb = (imageB64Bytes(img) / (1024 * 1024)).toFixed(1);
      session.push(noticeMsg(`⚠️ Image too large (${mb}MB, limit 5MB) and could not be shrunk — skipped.`));
      return;
    }
    pendingImagesRef.current = [...pendingImagesRef.current, img];
    const n = pendingImagesRef.current.length;
    const placeholder = `[Image #${n}]`;
    setPrompt((p) => {
      const arr = Array.from(p.value);
      const needSpace = p.value.length > 0 && !/\s$/.test(p.value);
      const insert = (needSpace ? ' ' : '') + placeholder + ' ';
      const value = p.value + insert;
      return { value, cursor: arr.length + Array.from(insert).length };
    });
  }, [session]);

  // ── 空 bracketed paste(Cmd+V 图片)→ 异步读系统剪贴板;读到则入 pending + 占位。 ──
  const handleImageProbe = useCallback(() => {
    const p = readClipboardImage()
      .then((img) => {
        if (img) ingestImage(img);
      })
      .catch(() => {
        /* best-effort:读失败静默(无图/无权限);不打断输入 */
      });
    pendingReadsRef.current = [...pendingReadsRef.current, p];
  }, [ingestImage]);

  // ── 拖入图片文件:粘贴文本整块是「若干存在的图片文件路径」→ 读为附件,消费该 paste。
  //   返回 true=已作为图片处理(调用方吞掉该键);false=普通文本粘贴,照常编辑。 ──
  const tryIngestImagePaths = useCallback(
    (pastedText: string): boolean => {
      const tokens = pastedText.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0 || !tokens.every(looksLikeImagePath)) return false;
      const p = Promise.resolve().then(() => {
        for (const t of tokens) {
          const img = readImageFile(t);
          if (img) ingestImage(img);
        }
      });
      pendingReadsRef.current = [...pendingReadsRef.current, p];
      return true;
    },
    [ingestImage],
  );

  // ── 大段/多行文本粘贴:另存正文 + 在光标处插折叠占位 `[Pasted text #N +L lines]`。
  //   提交时由 expandPastes 展开回原文喂模型;transcript/输入框只见折叠占位。 ──
  const ingestPastedText = useCallback((text: string) => {
    pendingPastesRef.current = [...pendingPastesRef.current, text];
    const n = pendingPastesRef.current.length;
    const placeholder = pastePlaceholder(n, text);
    // 在光标处插占位(复用 promptReducer 的 paste 插入语义,占位本身单行,不再触发折叠)。
    setPrompt((p) => promptReducer(p, { kind: 'paste', text: placeholder }));
  }, []);

  // ── 远端入站中转:微信消息 → 本地 transcript 标注 + 入轮/排队(带回复定址 origin)。
  //   sink 由 controller 持有(单一);用 ref 让它始终调到最新逻辑,避免 stale 闭包。
  const relayInbound = useCallback(
    (m: RemoteInboundMsg) => {
      const origin: RemoteOrigin = { remoteId: m.remoteId, peer: m.peer };
      const display = `[微信:${m.peer.name}] ${m.text}`;
      agent.finalizeRewind();
      setPendingView(null);
      const msgId = agent.checkpointTurn() ?? undefined;
      session.push({ kind: 'user', text: display, msgId });
      // turn 在飞 → 排队(带 origin);否则即跑。跑的是原文 m.text,显示用标注 display。
      if (busyRef.current) {
        setQueued((q) => [...q, { prompt: m.text, origin, msgId }]);
        return;
      }
      void runTurn(m.text, origin, undefined, msgId);
    },
    [agent, session, runTurn],
  );
  const relayRef = useRef(relayInbound);
  relayRef.current = relayInbound;
  useEffect(() => {
    remote.controller.setInbound((m) => relayRef.current(m));
    return () => remote.controller.setInbound(() => {});
  }, [remote.controller]);

  // ── 队列消费:turn 空闲且队列非空 → 取队首跑(连同其 origin)。 ──
  useEffect(() => {
    if (busyRef.current || status.busy) return;
    if (queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    void runTurn(next!.prompt, next!.origin, next!.images, next!.msgId);
  }, [status.busy, queued, runTurn]);

  // turn 结束后复位 interrupt 标记,允许下一轮再 abort。
  useEffect(() => {
    if (!status.busy) interruptedRef.current = false;
  }, [status.busy]);

  // ── 浮层选中处理(router 产出 overlay-select 后按 mode 执行)──
  // ── 回退点面板三子态选中处理(list 选点 → confirm 看 diff → 执行;pending 执行动作)──
  const handleRewindSelect = useCallback(
    async (index: number) => {
      // list:选回退点 → 算 diff 预览 → 进 confirm(不立即还原)。
      if (rewindStage === 'list') {
        const cp = checkpoints[index];
        if (!cp) {
          setShowRewind(false);
          return;
        }
        const diff = cp.hasCode && cp.msgId ? agent.previewRewind(cp.msgId) : null;
        setRewindPick({ cp, diff });
        setRewindStage('confirm');
        setOverlayIndex(0);
        return;
      }

      // confirm:执行回退(对话截断 + 文件还原)→ 进挂起态。
      if (rewindStage === 'confirm') {
        const pick = rewindPick;
        if (!pick) {
          setShowRewind(false);
          return;
        }
        const cp = pick.cp;
        // ⚠️ 先把**全量** messages 交给 driver 存 pre 快照(Redo 用),再截断屏上。
        //   keepUserTurns = 保留前缀里的用户轮数(WAL 遮蔽 boundary 锚点);下一轮历史由 driver
        //   从 WAL fold(H-03),不再在此有损重建。
        const keepUserTurns = session.messages.slice(0, cp.keep).filter((m) => m.kind === 'user').length;
        const r = await agent.rewind({
          msgId: cp.msgId,
          hasCode: cp.hasCode,
          keepUserTurns,
          currentMessages: session.messages,
        });
        if ('error' in r) {
          replaceTranscript(() => session.push(noticeMsg(`回退失败:${r.error}`)));
        } else {
          replaceTranscript(() => {
            session.rewindTo(cp.keep);
            const detail = cp.hasCode
              ? `,文件 ${r.filesChanged.length} 处变更${r.keptDirty.length ? `,保留 ${r.keptDirty.length} 处手改` : ''}`
              : '(仅对话)';
            session.push(noticeMsg(`已回退到此轮之前${detail}。再次双击 ESC 可恢复(Redo)。`));
          });
          setPendingView(agent.pendingRewind());
        }
        setRewindStage('list');
        setRewindPick(null);
        setShowRewind(false);
        return;
      }

      // pending:执行挂起态动作(Redo / 这些文件也回退 / 撤销 / 选更早回退点)。
      const act = pendingActions[index];
      if (!act) {
        setShowRewind(false);
        return;
      }
      if (act.key === 'more') {
        setRewindStage('list');
        setOverlayIndex(0);
        return;
      }
      if (act.key === 'redo') {
        const r = await agent.cancelRewind();
        if ('error' in r) {
          session.push(noticeMsg(`恢复失败:${r.error}`));
        } else {
          replaceTranscript(() => {
            session.replaceAll(r.messages);
            session.push(noticeMsg('已恢复(Redo):对话与文件回到回退前。'));
          });
        }
        setPendingView(null);
        setShowRewind(false);
        return;
      }
      if (act.key === 'overwrite') {
        const r = await agent.overwriteDirty();
        session.push(noticeMsg('error' in r ? `失败:${r.error}` : `已回退保留的 ${r.files.length} 个手改文件。`));
        setPendingView(agent.pendingRewind());
        setOverlayIndex(0);
        return;
      }
      if (act.key === 'undo') {
        const r = await agent.undoOverwrite();
        session.push(noticeMsg('error' in r ? `失败:${r.error}` : `已撤销「这些文件也回退」(${r.files.length} 文件)。`));
        setPendingView(agent.pendingRewind());
        setOverlayIndex(0);
        return;
      }
    },
    [rewindStage, checkpoints, rewindPick, pendingActions, agent, session, replaceTranscript],
  );

  const selectOverlay = useCallback(
    (m: InputMode, index: number) => {
      if (m === 'command-menu') {
        const cmd = menuCommands[index];
        if (cmd) void submit(`/${cmd.name}`);
        return;
      }
      if (m === 'model-picker') {
        const id = models[index];
        if (id) {
          agent.setModel(id);
          status.set({ model: id });
        }
        setShowModelPicker(false);
        return;
      }
      if (m === 'resume-picker') {
        const s = filteredSessions[index];
        setShowResumePicker(false);
        setPrompt({ value: '', cursor: 0 }); // 清搜索框
        if (s) void doResume(s.id);
        return;
      }
      if (m === 'rewind') {
        void handleRewindSelect(index);
        return;
      }
      if (m === 'remote-control') {
        // 第 0 行 = 添加微信账号;选中即新建并连接(扫码),把高亮移到新账号行以展示其二维码。
        //   账号行(index>0)无副作用——详情已由高亮展示。
        if (index === 0) {
          // addAccount 在 await connect 之前就同步把新账号 append 进 controller;故紧接着读
          //   controller 权威列表长度即新账号行号(row0=添加行 → 末账号行 = 列表长度)。
          //   不从 stale React 快照(remote.accounts)推位置,避免 SSOT 重复 + 竞态。
          void remote.addAccount('wechat');
          setOverlayIndex(remote.controller.listRemotes().length);
        }
        return;
      }
      if (m === 'permission' && pending) {
        const decision = PERMISSION_OPTIONS[index]?.value;
        if (decision === 'deny') permissions.decide(pending.id, false);
        else if (decision === 'allow-once') permissions.decide(pending.id, true);
        else if (decision === 'allow-always') {
          agent.allowAlways(pending.use.name);
          permissions.decide(pending.id, true);
        }
        return;
      }
      if (m === 'question' && q) {
        // 确认当前题:provider 据单/多选取选项 → 推进下一题或末题 resolve answers。
        questions.confirm(q.id, index);
      }
    },
    [menuCommands, models, filteredSessions, doResume, agent, status, permissions, pending, questions, q, submit, handleRewindSelect, remote],
  );

  // ── tab 补全:把输入框填成高亮命令(command-menu 专用;留个尾随空格便于接着敲参数)──
  const completeOverlay = useCallback(
    (index: number) => {
      const cmd = menuCommands[index];
      if (!cmd) return;
      const next = `/${cmd.name} `;
      setPrompt({ value: next, cursor: Array.from(next).length });
    },
    [menuCommands],
  );

  // ── 关浮层(router 产出 overlay-close)──
  const closeOverlay = useCallback((m: InputMode) => {
    if (m === 'model-picker') setShowModelPicker(false);
    else if (m === 'resume-picker') {
      setShowResumePicker(false);
      setPrompt({ value: '', cursor: 0 }); // 清搜索框
    }
    else if (m === 'rewind') {
      // confirm 子态 esc → 回 list(不整体关闭);list/pending → 关闭。
      if (rewindStage === 'confirm') {
        setRewindStage('list');
        setRewindPick(null);
        setOverlayIndex(0);
      } else {
        setShowRewind(false);
      }
    }
    else if (m === 'remote-control') setShowRemoteControl(false); // esc 关闭远端控制面板(账号仍在后台连接)
    else if (m === 'command-menu') setPrompt({ value: '', cursor: 0 }); // 清掉前导 '/' 即关菜单
    else if (m === 'permission' && pending) permissions.decide(pending.id, false); // esc = 取消 = deny
    else if (m === 'question' && q) questions.cancel(q.id); // esc = 跳过整组提问(每题空选)
  }, [pending, permissions, q, questions, rewindStage]);

  // ── 中断 / 退出(ctrl-c / esc 在 prompt busy 时打断在飞 turn)──
  const interrupt = useCallback(() => {
    if (busyRef.current) {
      if (!interruptedRef.current) {
        interruptedRef.current = true;
        agent.abort('user interrupt');
      }
      return;
    }
    exit(); // 无在飞 turn → 退出(dispose 在 app.tsx finally await)。
  }, [agent, exit]);

  // ── 执行一枚归一化 Key:routeKey → action → 副作用 ───────────────────────────
  const dispatchKey = useCallback(
    (key: Key) => {
      // ctrl+o:展开/折叠 thinking(router 不预设语义,本屏直接处理)。
      if (key.kind === 'ctrl-o') {
        setExpanded((e) => !e);
        return;
      }

      // 拖入图片文件:prompt 模式下,若整块粘贴是「存在的图片文件路径」→ 作附件读入,吞掉该键
      //   (不进 promptReducer,避免把长路径塞进输入框)。非图片路径 → 落回正常粘贴编辑。
      if (key.kind === 'paste' && mode === 'prompt' && key.text && tryIngestImagePaths(key.text)) {
        return;
      }
      // 大段/多行文本粘贴:折叠成占位 `[Pasted text #N +L lines]`,不把整段塞进输入框。
      if (key.kind === 'paste' && mode === 'prompt' && key.text && shouldCollapsePaste(key.text)) {
        ingestPastedText(key.text);
        return;
      }

      // question 自填行(末行)聚焦时,把「该题自填缓冲」喂给 router 当编辑目标(而非聊天草稿),
      //   故 edit 落到 questions.editOther、绝不污染 promptRef。其余模式仍编辑聊天草稿。
      const qOtherActive =
        mode === 'question' && !!q && safeOverlayIndex === (q.items[q.cursor]?.options.length ?? 0);
      const routerPrompt =
        qOtherActive && q ? q.others[q.cursor] ?? { value: '', cursor: 0 } : promptRef.current;
      const rctx: RouterCtx = {
        mode,
        prompt: routerPrompt,
        overlayIndex: safeOverlayIndex,
        overlayLength,
        escArmed: escArmedRef.current,
        busy: busyRef.current,
      };
      const action = routeKey(rctx, key);

      switch (action.kind) {
        case 'edit':
          if (mode === 'question' && q) {
            questions.editOther(q.id, action.next); // 写自填缓冲,不动聊天草稿
            return;
          }
          setPrompt(action.next);
          return;
        case 'open-command-menu':
          setPrompt(action.next);
          return;
        case 'submit':
          void submit(action.value);
          return;
        case 'history-prev': {
          const h = history.prev(promptRef.current.value);
          if (h != null) setPrompt({ value: h, cursor: Array.from(h).length });
          return;
        }
        case 'history-next': {
          const h = history.next();
          if (h != null) setPrompt({ value: h, cursor: Array.from(h).length });
          return;
        }
        case 'prompt-esc-arm':
          // 第一次 esc:武装,600ms 内第二次 esc 才清空/回退。
          escArmedRef.current = true;
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          escTimerRef.current = setTimeout(() => {
            escArmedRef.current = false;
          }, 600);
          return;
        case 'prompt-clear':
          // 空闲态双击 esc 清空输入(busy 态 router 已把单次 esc 直接转 interrupt,不会走到这)。
          escArmedRef.current = false;
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          setPrompt({ value: '', cursor: 0 });
          return;
        case 'open-rewind': {
          // 空闲态空输入双击 esc 拉起回退点面板(busy 态同上,不会走到这)。
          escArmedRef.current = false;
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          // 有挂起态 → 直接进 pending 动作面板;否则进回退点列表。
          const pv = agent.pendingRewind();
          setPendingView(pv);
          setRewindStage(pv ? 'pending' : 'list');
          setRewindPick(null);
          setOverlayIndex(0);
          setShowRewind(true);
          return;
        }
        case 'overlay-move':
          setOverlayIndex(action.index);
          return;
        case 'overlay-select':
          selectOverlay(mode, action.index);
          return;
        case 'overlay-toggle':
          // 仅 question 多选题有意义;provider 对单选题 no-op。
          if (mode === 'question' && q) questions.toggle(q.id, action.index);
          return;
        case 'overlay-complete':
          completeOverlay(action.index);
          return;
        case 'overlay-close':
          closeOverlay(mode);
          return;
        case 'interrupt':
          interrupt();
          return;
        case 'paste-image-probe':
          // 空 bracketed paste(Cmd+V 图片)→ 异步读系统剪贴板(读到则入 pending + 占位)。
          handleImageProbe();
          return;
        case 'scroll':
        case 'none':
        default:
          return;
      }
    },
    [mode, safeOverlayIndex, overlayLength, submit, history, interrupt, selectOverlay, completeOverlay, closeOverlay, questions, q, tryIngestImagePaths, ingestPastedText, handleImageProbe],
  );

  // ── 唯一 useInput(梁③:整 TUI 单一输入 owner)────────────────────────────────
  useInput((input, raw) => {
    // 删词:ctrl+w / (ctrl|meta)+backspace —— Ink raw key 直判,先于拼装(仅 prompt 模式且非粘贴态)。
    if (mode === 'prompt' && !pasteAsmRef.current.active) {
      if ((raw.ctrl && input === 'w') || ((raw.backspace || raw.delete) && (raw.ctrl || raw.meta))) {
        setPrompt(deleteWordBefore(promptRef.current));
        return;
      }
    }
    // bracketed paste 有状态拼装(跨事件);非粘贴输入透传 normalizeKey。
    for (const key of pasteAsmRef.current.feed(input, raw)) dispatchKey(key);
  });

  // ── 渲染 ───────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* 主体:transcript(owner 管 Static/live;工具卡走 toolMeta→views/tools)。 */}
      <Transcript
        log={toSessionLog(session.messages)}
        busy={status.busy}
        toolMeta={agent.toolMeta}
        expanded={expanded}
        redrawNonce={redrawNonce}
        streamingText={streamingText}
        streamingThinking={streamingThinking}
      />

      {/* 审批卡(受控浮层;查表前已由本屏经 toolMeta 解析 canonical)。 */}
      {pending ? (
        <Box>
          <Permission
            use={pending.use}
            perm={pending.perm}
            theme={theme}
            canonical={agent.toolMeta(pending.use.name).canonical}
            index={overlayIndex}
            onDecision={() => {/* 决策走 router → selectOverlay,不在此 */}}
          />
        </Box>
      ) : null}

      {/* 结构化提问卡(AskUserQuestion 工具;一次渲染当前题,逐题推进)。 */}
      {q && !pending ? (
        <Box>
          <Question
            item={q.items[q.cursor]!}
            cursor={q.cursor}
            total={q.items.length}
            index={safeOverlayIndex}
            selected={q.selections[q.cursor] ?? []}
            other={q.others[q.cursor] ?? { value: '', cursor: 0 }}
            theme={theme}
          />
        </Box>
      ) : null}

      {/* 回退点面板(空输入 esc-esc 拉起)。 */}
      {showRewind ? (
        <RewindPanel
          stage={rewindStage}
          checkpoints={checkpoints}
          index={safeOverlayIndex}
          pick={rewindPick}
          actions={pendingActions}
        />
      ) : null}

      {/* 模型选择页(/model 无参拉起)。 */}
      {showModelPicker ? <ModelPicker models={models} current={agent.model} index={overlayIndex} loading={modelsLoading} /> : null}

      {/* 远端控制面板(/remote-control 无参拉起):扫码连接微信 + 已连接状态。 */}
      {showRemoteControl ? <RemoteControl accounts={remote.accounts} index={safeOverlayIndex} /> : null}

      {/* 会话选择页(/resume 无参拉起);列表在搜索框上方,输入框复用为搜索框(实时收窄)。 */}
      {showResumePicker ? (
        <ResumePicker sessions={filteredSessions} index={safeOverlayIndex} query={prompt.value} now={Date.now()} />
      ) : null}

      {/* 命令菜单(/ 开头时模糊过滤);菜单在输入框上方,输入框保持可见可编辑(实时收窄)。 */}
      {showCommandMenu ? (
        <CommandMenu filter={prompt.value.slice(1)} commands={menuCommands} index={safeOverlayIndex} />
      ) : null}

      {/* 排队中的下一条(远端来源标注来源对端)。 */}
      <Queue items={queued.map((t) => (t.origin ? `[微信:${t.origin.peer.name}] ${t.prompt}` : t.prompt))} />

      {/* 输入框:prompt / command-menu / resume-picker 都显示(后两者是「编辑+导航」混合态,需边敲边过滤);
          纯浮层/审批挂起时才让位(键已交给浮层 nav)。resume-picker 时输入框即搜索框。 */}
      {mode === 'prompt' || mode === 'command-menu' || mode === 'resume-picker' ? (
        <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}>{/* 与 transcript 留一行间距(对齐 cc) */}
          <PromptInput
            value={prompt.value}
            cursor={prompt.cursor}
            placeholder={mode === 'resume-picker' ? '搜索会话...  enter 恢复 | esc 返回' : '输入消息...  /help 看命令 | esc esc 清空/回退'}
          />
        </Box>
      ) : null}

      {/* 状态栏(边框外,缩进对齐):只显示 token | 耗时 | 模型,其余提示一律不渲染(用户要求极简)。 */}
      <Box flexDirection="column" paddingX={1}>
        <ThinkingIndicator busy={status.busy} />
        <StatusLine />
      </Box>
    </Box>
  );
}
