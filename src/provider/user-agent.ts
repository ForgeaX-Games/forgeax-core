/**
 * 统一的出站请求标识 header。
 *
 * 缺省的 fetch UA(如 `Bun/1.3.10`)过于简陋且不体现来源。
 * 所有 provider 出站请求统一带上 forgeax-core 自己的 `User-Agent`,
 * 便于上游/网关侧识别与统计。
 *
 * 版本号与 CLI `--version` 保持一致(见 src/cli/main.ts)。
 */

/** forgeax-core 版本号(与 package.json / CLI --version 对齐)。 */
export const FORGEAX_CORE_VERSION = '0.1.0';

/** 出站 User-Agent,形如 `forgeax-core/0.1.0 (Bun/1.3.10; darwin arm64)`。 */
export const FORGEAX_USER_AGENT = buildUserAgent();

function buildUserAgent(): string {
  const parts: string[] = [];
  // 运行时(Bun / Node)。
  const bunVer = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  if (bunVer) parts.push(`Bun/${bunVer}`);
  else if (typeof process !== 'undefined' && process.versions?.node) {
    parts.push(`Node/${process.versions.node}`);
  }
  // 平台信息。
  if (typeof process !== 'undefined' && process.platform) {
    parts.push(`${process.platform} ${process.arch ?? ''}`.trim());
  }
  const suffix = parts.length ? ` (${parts.join('; ')})` : '';
  return `forgeax-core/${FORGEAX_CORE_VERSION}${suffix}`;
}
