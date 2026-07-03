/**
 * streamWithRetry (T23) — wraps `LLMProvider.stream` with the C4 retry + model
 * fallback policy on the ACTUAL streaming path (PROV 留的集成点)。
 *
 * 流创建期/首事件前的可重试错误(429/5xx/conn)→ 指数退避重试;
 * `FallbackTriggeredError`(529 连发达阈值)→ 切 fallbackModel 重试。**一旦已吐出
 * 事件(mid-stream)就不再重试**(mid-stream fallback 不安全,会重复执行工具)——直接抛,
 * 由上层 LOOP 收尾(mid-stream fallback 不安全的谨慎处置)。
 * Boundary: 仅 core 相对 import。
 */
import type { LLMProvider, ProviderRequest, ProviderCallOpts, ProviderStreamEvent } from './types';
import { FallbackTriggeredError, StreamIdleError } from './types';
import { getRetryDelay, shouldRetry, getDefaultMaxRetries } from './retry';

/** 流式空闲(上游/代理 stall)mid-stream 重发上限。区别于通用 maxRetries(默认 10):idle 每次要等
 *  满整个空闲阈值(默认 5min)才触发,若也重发 10 次最坏 ~50min,故单独有界。对齐 cc「idle → 丢弃
 *  半截 partial + 重新发起」的有界重发(cc 也带 attemptNumber 计数)。 */
const MID_STREAM_IDLE_MAX_RETRIES = 2;

export interface StreamRetryConfig {
  maxRetries?: number;
  /** 测试可注入(默认 setTimeout)。 */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function retryAfterHeader(err: unknown): string | null {
  const e = err as { retryAfterMs?: number };
  if (typeof e?.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) {
    return String(Math.round(e.retryAfterMs / 1000));
  }
  return null;
}

export async function* streamWithRetry(
  provider: LLMProvider,
  req: ProviderRequest,
  opts: ProviderCallOpts,
  cfg: StreamRetryConfig = {},
): AsyncIterable<ProviderStreamEvent> {
  const maxRetries = cfg.maxRetries ?? getDefaultMaxRetries();
  const sleep = cfg.sleep ?? defaultSleep;
  let model = req.model;
  let idleRetries = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (opts.signal.aborted) return;
    let started = false;
    try {
      for await (const ev of provider.stream({ ...req, model }, opts)) {
        started = true;
        yield ev;
      }
      return; // 正常结束
    } catch (err) {
      // 模型 fallback:529 连发触发,切 fallbackModel 重来。
      if (err instanceof FallbackTriggeredError && opts.fallbackModel && !started) {
        opts.onStreamingFallback?.();
        model = opts.fallbackModel;
        continue;
      }
      // 流式空闲(StreamIdleError):**即使已吐事件也重发**——loop 在最终 assistant 事件前不提交
      //   任何状态,重发只丢弃临时 partial(等价 cc 的 idle→丢半截+re-issue)。单独有界(见常量),
      //   不与通用 maxRetries 共用计数;走到这条即不再落通用分支。
      if (err instanceof StreamIdleError) {
        if (idleRetries >= MID_STREAM_IDLE_MAX_RETRIES || opts.signal.aborted) throw err;
        idleRetries++;
        await sleep(getRetryDelay(idleRetries));
        continue;
      }
      // 已吐事件 / 不可重试 / 次数耗尽 → 抛给上层。
      if (started || !shouldRetry(err) || attempt > maxRetries || opts.signal.aborted) throw err;
      await sleep(getRetryDelay(attempt, retryAfterHeader(err)));
    }
  }
}
