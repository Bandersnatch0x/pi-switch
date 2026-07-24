/**
 * UA/伪装变量探测 — 移植自 pi-provider-headers 的版本/os 探测逻辑。
 *
 * 版本号优先级：配置显式 > 本机 CLI 探测 > 兜底常量。
 * 兜底常量对齐真实 codex/claude/gemini CLI 基线，并与 anthropic-beta flags 时间线一致，
 * 避免旧值 claudeCodeVersion "1.0.0" 与 beta "claude-code-20250219" 自相矛盾。
 *
 * 探测逻辑纯函数化 + 依赖注入，便于单测；不在此处 import node:child_process。
 */

export interface ProbeDeps {
  /**
   * 同步执行命令（execFileSync 语义：文件 + 参数数组，不经 shell，无注入风险）。
   * 返回 stdout（失败抛异常）。
   */
  execFileSync: (file: string, args: string[], opts: Record<string, unknown>) => string;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
  /** os 模块子集，避免顶层 import 强耦合。 */
  platform: string;
  arch: string;
  release: string;
  homedir: string;
}

/** 从 CLI 输出中提取 semver。 */
export function extractSemver(text: string): string | undefined {
  const m = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m?.[1];
}

/** 从 package.json 读取 version 字段。 */
export function readPackageVersion(
  deps: Pick<ProbeDeps, "existsSync" | "readFileSync">,
  pkgJsonPath: string,
): string | undefined {
  try {
    if (!deps.existsSync(pkgJsonPath)) return undefined;
    const version = JSON.parse(deps.readFileSync(pkgJsonPath, "utf8"))?.version;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按 CLI → 全局 npm package → 候选路径顺序探测版本。
 * 返回 semver 或 undefined。execFileSync 语义，不经 shell。
 */
export function detectCliVersion(
  deps: ProbeDeps,
  command: string,
  packageName: string,
  candidates: string[],
): string | undefined {
  try {
    const out = deps.execFileSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    const version = extractSemver(out);
    if (version) return version;
  } catch {
    // CLI 不在 PATH 或执行失败 — 继续下一个源
  }

  try {
    const root = deps.execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    const version = readPackageVersion(deps, joinPath(root, packageName, "package.json"));
    if (version) return version;
  } catch {
    // npm root -g 不可用 — 继续候选路径
  }

  for (const path of candidates) {
    const version = readPackageVersion(deps, path);
    if (version) return version;
  }
  return undefined;
}

/** 跨平台常见 npm 全局 package 路径。 */
function commonNpmPackagePaths(homedir: string, packageName: string): string[] {
  const unix = [
    joinPath(homedir, `.npm-global/lib/node_modules/${packageName}/package.json`),
    `/usr/local/lib/node_modules/${packageName}/package.json`,
    `/opt/homebrew/lib/node_modules/${packageName}/package.json`,
  ];
  // Windows: %APPDATA%\npm\node_modules\<pkg>\package.json
  const appData = processEnv("APPDATA");
  const win = appData
    ? [joinPath(appData, `npm/node_modules/${packageName}/package.json`)]
    : [joinPath(homedir, `AppData/Roaming/npm/node_modules/${packageName}/package.json`)];
  return [...unix, ...win];
}

/** Codex CLI 版本探测的候选路径（跨平台）。 */
export function codexCandidatePaths(homedir: string): string[] {
  return commonNpmPackagePaths(homedir, "@openai/codex");
}

/** Claude Code 版本探测的候选路径（跨平台）。 */
export function claudeCandidatePaths(homedir: string): string[] {
  return commonNpmPackagePaths(homedir, "@anthropic-ai/claude-code");
}

/** Gemini CLI 版本探测的候选路径（跨平台）。 */
export function geminiCandidatePaths(homedir: string): string[] {
  return [
    ...commonNpmPackagePaths(homedir, "@google/gemini-cli"),
    ...commonNpmPackagePaths(homedir, "gemini-cli"),
  ];
}

export type VersionSource = "config" | "local" | "fallback";

/**
 * 解析单个版本号：配置 > 探测 > 兜底。
 */
export function resolveVersion(
  configured: string | undefined,
  detect: () => string | undefined,
  fallback: string,
): { version: string; source: VersionSource } {
  if (configured) return { version: configured, source: "config" };
  const detected = detect();
  if (detected) return { version: detected, source: "local" };
  return { version: fallback, source: "fallback" };
}

/**
 * 检测系统信息，格式参照 codex CLI：`Windows 10.0; x64` / `MacOS 15.7.2; arm64`。
 * macOS 用 sw_vers 取产品版本（os.release() 返回 Darwin 内核版本，与产品版本不一致）。
 */
export function detectOsInfo(deps: ProbeDeps): string {
  const arch = deps.arch;
  if (deps.platform === "darwin") {
    let version: string;
    try {
      version = deps.execFileSync("sw_vers", ["-productVersion"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
    } catch {
      version = deps.release;
    }
    return `MacOS ${version}; ${arch}`;
  }
  const osName = deps.platform === "win32" ? "Windows" : "Linux";
  return `${osName} ${deps.release}; ${arch}`;
}

/** 兜底版本（探测全部失败时）。对齐真实 CLI 基线。 */
export const FALLBACK_CODEX_VERSION = "0.141.0";
export const FALLBACK_CLAUDE_CODE_VERSION = "2.1.178";
export const FALLBACK_GEMINI_VERSION = "0.9.0";

/** Claude Code 指纹配套字段（与 FALLBACK_CLAUDE_CODE_VERSION 时间线对齐）。 */
export const FALLBACK_ANTHROPIC_VERSION = "2023-06-01";
export const FALLBACK_ANTHROPIC_BETA =
  "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";

/** Codex 官方 originator 约定。 */
export const FALLBACK_CODEX_ORIGINATOR = "codex_cli_rs";

export interface HeaderVars {
  codexVersion: string;
  claudeCodeVersion: string;
  geminiVersion: string;
  osInfo: string;
  anthropicVersion: string;
  anthropicBeta: string;
  codexOriginator: string;
  /** 探测来源，供 debug 日志用。 */
  codexVersionSource: VersionSource;
  claudeCodeVersionSource: VersionSource;
  geminiVersionSource: VersionSource;
}

export interface ConfiguredHeaderVars {
  codexVersion?: string;
  claudeCodeVersion?: string;
  geminiVersion?: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
  codexOriginator?: string;
}

/**
 * 组装完整 header 变量。configuredVars 可覆盖探测结果（如 pi-switch.json 的 vars）。
 */
export function buildHeaderVars(
  deps: ProbeDeps,
  configuredVars?: ConfiguredHeaderVars,
): HeaderVars {
  const codex = resolveVersion(
    configuredVars?.codexVersion,
    () => detectCliVersion(deps, "codex", "@openai/codex", codexCandidatePaths(deps.homedir)),
    FALLBACK_CODEX_VERSION,
  );
  const claude = resolveVersion(
    configuredVars?.claudeCodeVersion,
    () =>
      detectCliVersion(
        deps,
        "claude",
        "@anthropic-ai/claude-code",
        claudeCandidatePaths(deps.homedir),
      ),
    FALLBACK_CLAUDE_CODE_VERSION,
  );
  const gemini = resolveVersion(
    configuredVars?.geminiVersion,
    () => {
      const fromGemini = detectCliVersion(
        deps,
        "gemini",
        "@google/gemini-cli",
        geminiCandidatePaths(deps.homedir),
      );
      if (fromGemini) return fromGemini;
      return detectCliVersion(deps, "gemini-cli", "gemini-cli", geminiCandidatePaths(deps.homedir));
    },
    FALLBACK_GEMINI_VERSION,
  );

  return {
    codexVersion: codex.version,
    claudeCodeVersion: claude.version,
    geminiVersion: gemini.version,
    osInfo: detectOsInfo(deps),
    anthropicVersion: configuredVars?.anthropicVersion?.trim() || FALLBACK_ANTHROPIC_VERSION,
    anthropicBeta: configuredVars?.anthropicBeta?.trim() || FALLBACK_ANTHROPIC_BETA,
    codexOriginator: configuredVars?.codexOriginator?.trim() || FALLBACK_CODEX_ORIGINATOR,
    codexVersionSource: codex.source,
    claudeCodeVersionSource: claude.source,
    geminiVersionSource: gemini.source,
  };
}

/** POSIX join that tolerates mixed separators on Windows (candidates use / ). */
function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function processEnv(name: string): string | undefined {
  try {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[name];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}
