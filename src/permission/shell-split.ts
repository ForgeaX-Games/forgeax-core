/**
 * Shell command splitter (E-01) — 权限内容级匹配的 shell 结构感知拆分。
 *
 * core 机制层禁第三方依赖(rules.ts 现行约束),故自写一个**保守**的最小
 * tokenizer:引号感知地把命令串按 top-level 控制算子(`&&` `||` `;` `|` `&`
 * 及换行)拆成子命令;检测命令替换 `$()` / 反引号、子 shell `(...)`、进程替换
 * `<()` `>()` 等无法安全静态判定的结构 → 标记 `unsafe`。
 *
 * 匹配语义由调用方(rules.ts)据 bucket 决定,遵循 fail-closed:
 *   - allow:需**所有**子命令各自命中 allow 规则,且命令 `!unsafe`(否则不成立 → 落 ask);
 *     env 前缀**不剥离**(带 env 前缀视为不命中 allow,更保守)。
 *   - deny/ask:**任一**子命令命中即触发;匹配前**剥离** env 前缀(`FOO=1 rm` → `rm`)。
 *
 * 纯函数,无 IO、无 import —— Boundary 自然满足,便于单测。
 */

export interface ShellSplit {
  /** top-level 子命令(已 trim、去空)。 */
  segments: string[];
  /** 含命令替换 `$()`/反引号、子 shell `(`、进程替换 `<(`/`>(` 等无法静态安全判定的结构。 */
  unsafe: boolean;
}

/** 把命令串按 top-level 控制算子拆成子命令(引号内不拆),并标记 unsafe 结构。 */
export function splitShellCommand(command: string): ShellSplit {
  const segments: string[] = [];
  let unsafe = false;
  let buf = '';
  let inSingle = false;
  let inDouble = false;

  const flush = (): void => {
    const t = buf.trim();
    if (t) segments.push(t);
    buf = '';
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];

    // 单引号:内部一切原样,直到闭合(shell 单引号不解释任何东西)。
    if (inSingle) {
      if (c === "'") inSingle = false;
      buf += c;
      continue;
    }
    // 双引号:命令替换仍会被解释 → 需侦测 $()/反引号;反斜杠转义下一个字符。
    if (inDouble) {
      if (c === '\\') {
        buf += c;
        if (next !== undefined) {
          buf += next;
          i++;
        }
        continue;
      }
      if (c === '`') unsafe = true;
      if (c === '$' && next === '(') unsafe = true;
      if (c === '"') inDouble = false;
      buf += c;
      continue;
    }

    // ── 不在引号内 ──
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      buf += c;
      continue;
    }
    if (c === '\\') {
      buf += c;
      if (next !== undefined) {
        buf += next;
        i++;
      }
      continue;
    }
    // unsafe 结构:命令替换 / 进程替换 / 子 shell。
    if (c === '`') {
      unsafe = true;
      buf += c;
      continue;
    }
    if (c === '$' && next === '(') {
      unsafe = true;
      buf += c;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      unsafe = true;
      buf += c;
      continue;
    }
    if (c === '(') {
      unsafe = true;
      buf += c;
      continue;
    }
    // top-level 控制算子 → 切分。
    if (c === '&' && next === '&') {
      flush();
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      flush();
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n') {
      flush();
      continue;
    }
    buf += c;
  }
  flush();
  return { segments, unsafe };
}

/** 剥离命令前的 env-var 赋值前缀(`FOO=bar BAZ="x" cmd …` → `cmd …`)。仅 deny/ask 用。 */
const ENV_PREFIX_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
export function stripEnvAssignments(segment: string): string {
  return segment.replace(ENV_PREFIX_RE, '').trim();
}

/** 是否 shell 类工具(bash/sh/shell,大小写不敏感)。内容级规则对其走结构感知匹配。 */
export function isShellToolName(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'bash' || n === 'sh' || n === 'shell';
}
