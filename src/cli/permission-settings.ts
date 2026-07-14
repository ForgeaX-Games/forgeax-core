/**
 * settings.permissions → PermissionRuleSet loader(楔子1 · 任务 046)。
 *
 * 把分层 settings(`getMergedSettings`,user<project<local)里的
 *   `permissions.{deny,ask,allow}: string[]`(cc 同款 `Bash(git *)` 语法)
 * 转成 engine 消费的 `PermissionRuleSet`,让「在配置里写一条 deny」对
 * forgeax-core(独立 CLI/TUI + Studio-经-sidecar)真正生效——引擎决策顺序
 * ① deny > ② ask > ⑦ allow(见 permission/engine.ts)。
 *
 * SSOT:规则模型与解析复用 `permission/rules.ts` 的 `parseRuleString`(不另造一套匹配器)。
 * fail-safe(§5):非对象 permissions / 非数组桶 → 空桶;非字符串条目、形状非法
 *   (`parseRuleString` 返回 null)→ 丢弃该条(不当成授予)。
 *
 * Boundary(HOST 层):可 import 机制层 `../permission/rules` + 同层 `./settings`。
 */
import { parseRuleString, type PermissionRule, type PermissionRuleSet } from '../permission/rules';
import { coercePermissionMode } from '../permission/inspect';
import type { PermissionMode } from '../permission/engine';
import { getMergedSettings } from './settings';

/** 三个规则桶(即 behavior);顺序即 engine 读取顺序,仅用于遍历。 */
const BEHAVIORS = ['deny', 'ask', 'allow'] as const;

/**
 * 把 settings 的 `permissions` 段(未知形状)解析成 `PermissionRuleSet`。纯函数,
 * 便于单测(无需落盘)。非法输入一律安全降级为空/丢弃,永不抛。
 */
export function rulesFromPermissionsSetting(perms: unknown): PermissionRuleSet {
  const out: PermissionRuleSet = { deny: [], ask: [], allow: [] };
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return out;
  const obj = perms as Record<string, unknown>;
  for (const behavior of BEHAVIORS) {
    const bucket = obj[behavior];
    if (!Array.isArray(bucket)) continue;
    const rules: PermissionRule[] = out[behavior];
    for (const entry of bucket) {
      if (typeof entry !== 'string') continue;
      const rule = parseRuleString(entry, behavior, `settings.permissions.${behavior}`);
      if (rule) rules.push(rule);
    }
  }
  return out;
}

/**
 * 从分层合并的 settings 读出 `permissions` 段并转成 `PermissionRuleSet`。
 * `cwd` 决定 project/local settings 的解析基准(默认 `process.cwd()`,与 host-context
 * 读 hooks 同口径)。settings 缺失/无 permissions → 三空桶(不改变默认 tier 行为)。
 */
export function loadPermissionRulesFromSettings(cwd: string = process.cwd()): PermissionRuleSet {
  return rulesFromPermissionsSetting(getMergedSettings(cwd).permissions);
}

// ── settings.permissions.defaultMode(同名同语义:启动初始权限模式)──

/** defaultMode 解析结果的三态:未配置(安静回退 default)/ 合法 / 配置了但非法
 *  (由 CLI 启动 boundary 决定是否警告后回退;本模块不打印)。 */
export type DefaultPermissionModeSetting =
  | { kind: 'unset' }
  | { kind: 'valid'; mode: PermissionMode }
  | { kind: 'invalid'; value: unknown };

/**
 * 解析 settings 的 `permissions.defaultMode`(未知形状 → 结构化三态)。纯函数,永不抛。
 * 校验复用 `coercePermissionMode`(与 /permissions、--permission-mode 同一份合法值真相)。
 */
export function parseDefaultModeFromPermissionsSetting(perms: unknown): DefaultPermissionModeSetting {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return { kind: 'unset' };
  const obj = perms as Record<string, unknown>;
  if (!('defaultMode' in obj)) return { kind: 'unset' };
  const mode = coercePermissionMode(obj.defaultMode);
  return mode ? { kind: 'valid', mode } : { kind: 'invalid', value: obj.defaultMode };
}

/** 从分层合并的 settings 读出 defaultMode(user<project<local,与规则桶同口径)。 */
export function loadDefaultPermissionModeFromSettings(
  cwd: string = process.cwd(),
): DefaultPermissionModeSetting {
  return parseDefaultModeFromPermissionsSetting(getMergedSettings(cwd).permissions);
}
