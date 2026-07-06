/**
 * walEventsToUiMessages —— 纯函数:会话 WAL 的原始事件流(CoreEvent[])→ 可渲染的
 * UiMessage[](供 /resume 把历史会话回灌进当前 transcript)。
 *
 * 这是 reduce.ts 的「上游补片」:live 路径里 driver 把 agent.run 吐的 AgentEvent 直接
 * push 进 session;resume 路径没有 live AgentEvent 流,只有落盘的 CoreEvent WAL。本函数
 * 把 WAL 事件**逆映射**回与 live 同构的 AgentEvent,包成 UiMessage,使 reduceTranscript
 * 渲染出与当时一模一样的 transcript(对齐 cc:恢复 = 用全量 messages 重建 REPL)。
 *
 * 映射(只取有视图意义的 4 类;其余 turn 生命周期 / stop / session / stage 等跳过):
 *   - user_prompt.submit → { kind:'user', text: payload.prompt }
 *   - assistant.message  → { kind:'agent', event:{ type:'assistant', message: <该 CoreEvent> } }
 *   - tool.requested     → { kind:'agent', event:{ type:'tool_call', toolName, toolUseId, input } }
 *   - tool.result        → { kind:'agent', event:{ type:'tool_result', toolUseId, result: <该 CoreEvent> } }
 *
 * 形状对齐:AgentEvent 联合(agent/types.ts)+ events 目录 payload(events.ts)+
 *   history/llm-fold-adapter.ts(同一组事件的 LLM 侧投影)。tool_result 的 `result` 持有
 *   整条 CoreEvent,reduceTranscript 读 `result.payload`(含 isError)判错,与 live 一致。
 *
 * Boundary(HOST 层):仅 core 类型 + 相对 import,无 react/ink。纯函数,可单测。
 */
import type { CoreEvent } from '../../events/types';
import { computeRewindShadow } from '../../history/rewind-mask';
import type { AgentEvent, UiMessage } from '../contracts';

/** loop 自吐的 assistant 会话事件类型(非 CoreEventType 成员;与 llm-fold-adapter 同源)。 */
const ASSISTANT_MESSAGE = 'assistant.message';
const USER_PROMPT = 'user_prompt.submit';
const TOOL_REQUESTED = 'tool.requested';
const TOOL_RESULT = 'tool.result';

export function walEventsToUiMessages(events: CoreEvent[]): UiMessage[] {
  const out: UiMessage[] = [];
  // H-01:被回退遮蔽的事件不进重建 transcript(与 foldFromStore 共用同一份 mask 逻辑)。
  const shadow = computeRewindShadow(events);
  for (let i = 0; i < events.length; i++) {
    if (shadow[i]) continue;
    const e = events[i];
    switch (e.type) {
      case USER_PROMPT: {
        const p = e.payload as { prompt?: unknown; msgId?: unknown };
        const text = typeof p.prompt === 'string' ? p.prompt : String(p.prompt ?? '');
        // H-02:WAL 携带的回退锚点 msgId 直接还原 → 历史轮文件回退可用。旧 WAL 无 → 走 relinkMsgIds ordinal fallback。
        out.push(typeof p.msgId === 'string' ? { kind: 'user', text, msgId: p.msgId } : { kind: 'user', text });
        break;
      }
      case ASSISTANT_MESSAGE: {
        // message 即该 assistant.message CoreEvent(payload.content),与 live 'assistant' 事件同构。
        out.push({ kind: 'agent', event: { type: 'assistant', message: e } as AgentEvent });
        break;
      }
      case TOOL_REQUESTED: {
        const p = e.payload as { toolName?: string; toolUseId?: string; input?: unknown };
        out.push({
          kind: 'agent',
          event: {
            type: 'tool_call',
            toolName: String(p.toolName ?? ''),
            toolUseId: String(p.toolUseId ?? ''),
            input: p.input,
          },
        });
        break;
      }
      case TOOL_RESULT: {
        const p = e.payload as { toolUseId?: string };
        out.push({
          kind: 'agent',
          event: { type: 'tool_result', toolUseId: String(p.toolUseId ?? ''), result: e } as AgentEvent,
        });
        break;
      }
      // 其余事件(turn.*/stop/session.*/stage/compaction.* 等)无 transcript 视图意义 → 跳过。
      default:
        break;
    }
  }
  return out;
}

/** 回退锚点 id + 是否有代码快照(= CheckpointManager.list() 的子集形状)。 */
export interface CheckpointRef {
  msgId: string;
  hasCode: boolean;
}

/**
 * H-02 ordinal fallback —— 给**旧 WAL**(user_prompt.submit 无 msgId 载荷)的历史轮次按序
 * 回填 msgId,使 /resume 后文件回退仍可用。新 WAL 已由 rehydrate 直接还原 msgId,本函数对已
 * 带 msgId 的 user 轮不改(幂等)。
 *
 * fail-soft(不误链):仅当**缺 msgId 的 user 轮数 == checkpoints 条数**时才按序配对回填;
 * 数量不一致(WAL 被截断 / 部分轮无锚点)→ 原样返回(降级纯对话回退),绝不错配。
 * 空 checkpoints 且有缺 msgId 的 user 轮 → 数量不等 → 不动。
 */
export function relinkMsgIds(messages: UiMessage[], checkpoints: CheckpointRef[]): UiMessage[] {
  const missing = messages.filter((m) => m.kind === 'user' && !m.msgId);
  if (missing.length === 0) return messages; // 新 WAL:全带 msgId,无需回填
  if (missing.length !== checkpoints.length) return messages; // 数量不一致 → 保守放弃
  let i = 0;
  return messages.map((m) => {
    if (m.kind === 'user' && !m.msgId) {
      const ref = checkpoints[i++];
      return { ...m, msgId: ref.msgId };
    }
    return m;
  });
}
