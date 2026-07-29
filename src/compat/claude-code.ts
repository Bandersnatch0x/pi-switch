/**
 * Claude Code request-shape compatibility for relays that fingerprint clients
 * (notably anyrouter.top).
 *
 * Evidence (live anyrouter probes + Claude Code capture + historical CC source):
 *   - metadata.user_id must be a JSON string with device_id from Claude's
 *     getOrCreateUserID() (~/.claude.json `userID`, 64 hex chars).
 *   - system must start with the Agent SDK prefix used by non-interactive CLI:
 *       "You are a Claude agent, built on Anthropic's Claude Agent SDK."
 *     (src/constants/system.ts AGENT_SDK_PREFIX)
 *   - context-1m-2025-08-07 beta is still required (handled elsewhere for headers).
 *
 * Pi exposes before_provider_request / before_provider_headers hooks; we reshape
 * the anthropic-messages payload there. Tool lists stay Pi's own tools — spoofing
 * Claude Code tool schemas would break execution.
 */

import { isAnyrouterBaseUrl } from "../headers/anyrouter.ts";
import { mergeAnthropicBetaFlag, ANYROUTER_CONTEXT_1M_BETA } from "../headers/anyrouter.ts";
import { BUNDLED_CLAUDE_CODE_TOOLS } from "./claude-code-tools-data.ts";

/** Claude Agent SDK system prefix (CC non-interactive default). */
export const AGENT_SDK_SYSTEM_PREFIX =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/** Interactive CLI prefix (OAuth / first-party path in CC). Kept for config choice. */
export const CLAUDE_CODE_CLI_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Claude Code tool names anyrouter fingerprints (order from live CC capture).
 * Stubs with these names pass the gate; Pi keeps its own tools for execution.
 * Live probe: ≥10 distinct CC names required; minimal schemas OK.
 */
export const CLAUDE_CODE_FINGERPRINT_TOOL_NAMES = [
  "Agent",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterWorktree",
  "ExitWorktree",
  "Glob",
  "Grep",
  "NotebookEdit",
  "PowerShell",
  "Read",
  "ReportFindings",
  "ScheduleWakeup",
  "SendMessage",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
] as const;

/** Minimum distinct CC tool names observed to pass anyrouter gate. */
export const CLAUDE_CODE_MIN_FINGERPRINT_TOOLS = 10;

/** Betas Claude Code 2.1.x sends (order matters less than membership). */
export const CLAUDE_CODE_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
  "fallback-credit-2026-06-01",
] as const;

export type ClaudeCodeCompatMode = "auto" | "always" | "never";
export type ClaudeCodeSystemPrefixKind = "agent-sdk" | "claude-code-cli" | "none";

export interface ClaudeCodeCompatConfig {
  /**
   * auto (default): only when current provider baseUrl matches anyrouter (or
   *   configured hosts) and api is anthropic-messages.
   * always: every anthropic-shaped payload.
   * never: off.
   */
  mode?: ClaudeCodeCompatMode;
  /** Extra hostnames (exact or suffix) that opt into auto mode. */
  hosts?: string[];
  /** Prefer ~/.claude.json userID; else generate/persist local id. */
  deviceIdSource?: "claude-json" | "generate" | "explicit";
  /** Used when deviceIdSource is explicit, or as override. */
  deviceId?: string;
  /** Which system prefix to prepend (default agent-sdk — matches anyrouter gate). */
  systemPrefix?: ClaudeCodeSystemPrefixKind;
  injectMetadata?: boolean;
  injectSystemPrefix?: boolean;
  injectHeaders?: boolean;
  /**
   * Pad tools[] with stub Claude Code tool names (default true).
   * Required by anyrouter; stubs are not executed by Pi.
   */
  injectToolFingerprint?: boolean;
}

export interface ClaudeCodeCompatResolved {
  enabled: boolean;
  deviceId: string;
  deviceIdSource: "claude-json" | "generate" | "explicit" | "fallback";
  systemPrefix: string | null;
  injectMetadata: boolean;
  injectSystemPrefix: boolean;
  injectHeaders: boolean;
}

export interface DeviceIdFs {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
}

/** Paths Claude Code / pi-switch use for stable device identity. */
export function claudeJsonPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.claude.json`;
}

export function piSwitchDeviceIdPath(home: string): string {
  return `${home.replace(/[\\/]+$/, "")}/.pi/agent/pi-switch-device-id`;
}

/**
 * Resolve device_id the way Claude Code does when possible:
 *   1. explicit config
 *   2. ~/.claude.json userID (same bytes real CC sends)
 *   3. persisted local id under ~/.pi/agent/
 *   4. generate 32 random bytes hex and persist
 */
export function resolveDeviceId(input: {
  home: string;
  fs: DeviceIdFs;
  config?: ClaudeCodeCompatConfig;
  /** Inject for tests; default crypto.getRandomValues / Math.random fallback */
  randomHex?: (bytes: number) => string;
}): { deviceId: string; source: ClaudeCodeCompatResolved["deviceIdSource"] } {
  const cfg = input.config ?? {};
  const sourcePref = cfg.deviceIdSource ?? "claude-json";

  if (sourcePref === "explicit" || cfg.deviceId?.trim()) {
    const id = cfg.deviceId?.trim();
    if (id) return { deviceId: id, source: "explicit" };
  }

  if (sourcePref !== "generate") {
    const fromClaude = readClaudeUserId(input.fs, claudeJsonPath(input.home));
    if (fromClaude) return { deviceId: fromClaude, source: "claude-json" };
  }

  const localPath = piSwitchDeviceIdPath(input.home);
  try {
    if (input.fs.existsSync(localPath)) {
      const existing = input.fs.readFileSync(localPath, "utf8").trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) {
        return { deviceId: existing.toLowerCase(), source: "generate" };
      }
    }
  } catch {
    /* fall through */
  }

  const hex =
    input.randomHex?.(32) ??
    defaultRandomHex(32);
  try {
    input.fs.writeFileSync(localPath, hex + "\n", "utf8");
  } catch {
    /* best-effort persist */
  }
  return { deviceId: hex, source: "generate" };
}

export function readClaudeUserId(fs: DeviceIdFs, path: string): string | undefined {
  try {
    if (!fs.existsSync(path)) return undefined;
    const raw = JSON.parse(fs.readFileSync(path, "utf8")) as { userID?: unknown };
    if (typeof raw.userID === "string" && /^[a-f0-9]{64}$/i.test(raw.userID.trim())) {
      return raw.userID.trim().toLowerCase();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function defaultRandomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } })
    .crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build Anthropic metadata.user_id JSON string (CC getAPIMetadata shape). */
export function buildAnthropicUserIdMetadata(input: {
  deviceId: string;
  sessionId?: string;
  accountUuid?: string;
}): string {
  // anyrouter rejects empty session_id with 503 Service Unavailable.
  // Claude Code always sends a UUID from getSessionId().
  const sessionId = input.sessionId?.trim() || randomSessionId();
  return JSON.stringify({
    device_id: input.deviceId,
    account_uuid: input.accountUuid ?? "",
    session_id: sessionId,
  });
}

/** UUID v4-ish for metadata.session_id when Pi does not supply one. */
export function randomSessionId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  // RFC4122-ish fallback
  const hex = defaultRandomHex(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function resolveSystemPrefixText(
  kind: ClaudeCodeSystemPrefixKind | undefined,
): string | null {
  switch (kind ?? "agent-sdk") {
    case "agent-sdk":
      return AGENT_SDK_SYSTEM_PREFIX;
    case "claude-code-cli":
      return CLAUDE_CODE_CLI_SYSTEM_PREFIX;
    case "none":
      return null;
    default:
      return AGENT_SDK_SYSTEM_PREFIX;
  }
}

/**
 * Whether compat should run for this provider selection.
 * Pure decision — no IO.
 */
export function shouldApplyClaudeCodeCompat(input: {
  mode?: ClaudeCodeCompatMode;
  hosts?: string[];
  api?: string | null;
  baseUrl?: string | null;
  /** Per-provider force on/off; undefined = use mode rules */
  providerForce?: boolean | null;
}): boolean {
  if (input.providerForce === false) return false;
  if (input.providerForce === true) {
    return !input.api || input.api === "anthropic-messages";
  }

  const mode = input.mode ?? "auto";
  if (mode === "never") return false;
  if (input.api && input.api !== "anthropic-messages") return false;

  if (mode === "always") return true;

  // auto
  if (isAnyrouterBaseUrl(input.baseUrl)) return true;
  return hostMatches(input.baseUrl, input.hosts);
}

export function hostMatches(
  baseUrl: string | null | undefined,
  hosts: string[] | undefined,
): boolean {
  if (!baseUrl?.trim() || !hosts?.length) return false;
  let hostname: string;
  try {
    hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return hosts.some((h) => baseUrl.toLowerCase().includes(h.toLowerCase()));
  }
  return hosts.some((raw) => {
    const h = raw.trim().toLowerCase();
    if (!h) return false;
    return hostname === h || hostname.endsWith(`.${h}`);
  });
}

type SystemBlock = { type?: string; text?: string; cache_control?: unknown };

/**
 * Inject metadata.user_id + Agent SDK system prefix + Claude tool-name stubs
 * into an anthropic-messages request payload. Idempotent.
 */
export function applyClaudeCodeCompatToPayload(
  payload: unknown,
  opts: {
    deviceId: string;
    sessionId?: string;
    systemPrefix?: string | null;
    injectMetadata?: boolean;
    injectSystemPrefix?: boolean;
    injectToolFingerprint?: boolean;
    minFingerprintTools?: number;
  },
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const body = payload as Record<string, unknown>;
  // Only reshape Anthropic Messages bodies (have model + messages).
  if (typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return payload;
  }

  let changed = false;
  const out: Record<string, unknown> = { ...body };

  if (opts.injectMetadata !== false) {
    const existingMeta =
      out.metadata && typeof out.metadata === "object" && !Array.isArray(out.metadata)
        ? (out.metadata as Record<string, unknown>)
        : {};
    const existingUserId =
      typeof existingMeta.user_id === "string" ? existingMeta.user_id.trim() : "";

    // Keep a valid device_id if caller already sent one; always ensure non-empty
    // session_id (anyrouter 503s on ""). Prefer opts.sessionId, else parse
    // existing, else generate.
    let keepDevice = opts.deviceId;
    let keepSession = opts.sessionId?.trim() || "";
    if (existingUserId) {
      try {
        const parsed = JSON.parse(existingUserId) as {
          device_id?: unknown;
          session_id?: unknown;
        };
        if (typeof parsed.device_id === "string" && parsed.device_id.trim()) {
          keepDevice = parsed.device_id.trim();
        }
        if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
          keepSession = parsed.session_id.trim();
        }
      } catch {
        /* replace unparseable user_id */
      }
    }
    const nextUserId = buildAnthropicUserIdMetadata({
      deviceId: keepDevice,
      sessionId: keepSession || undefined,
    });
    if (existingUserId !== nextUserId) {
      out.metadata = {
        ...existingMeta,
        user_id: nextUserId,
      };
      changed = true;
    }
  }

  const prefix = opts.systemPrefix?.trim() || null;
  if (opts.injectSystemPrefix !== false && prefix) {
    const nextSystem = prependSystemPrefix(out.system, prefix);
    if (nextSystem !== out.system) {
      out.system = nextSystem;
      changed = true;
    }
  }

  if (opts.injectToolFingerprint !== false) {
    const minN = opts.minFingerprintTools ?? CLAUDE_CODE_MIN_FINGERPRINT_TOOLS;
    const nextTools = padClaudeCodeToolFingerprint(out.tools, minN);
    if (nextTools !== out.tools) {
      out.tools = nextTools;
      changed = true;
    }
  }

  // Pi high thinking → budget-based `enabled` thinking. anyrouter returns 503 for
  // that shape; Claude Code uses adaptive + output_config.effort instead.
  if (transformThinkingForClaudeCodeRelay(out)) {
    changed = true;
  }

  return changed ? out : payload;
}

/**
 * Convert budget-based thinking to adaptive (Claude Code shape).
 * Returns true if the body was mutated.
 */
export function transformThinkingForClaudeCodeRelay(
  body: Record<string, unknown>,
): boolean {
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) {
    return false;
  }
  const t = thinking as Record<string, unknown>;
  if (t.type !== "enabled") return false;

  // Map budget roughly to effort tiers (Claude Code uses adaptive + effort).
  const budget =
    typeof t.budget_tokens === "number" && Number.isFinite(t.budget_tokens)
      ? t.budget_tokens
      : 0;
  let effort: "low" | "medium" | "high" | "max" = "high";
  if (budget > 0 && budget < 2048) effort = "low";
  else if (budget >= 2048 && budget < 8192) effort = "medium";
  else if (budget >= 8192 && budget < 24000) effort = "high";
  else if (budget >= 24000) effort = "max";

  body.thinking = { type: "adaptive" };
  const existingOc =
    body.output_config && typeof body.output_config === "object" && !Array.isArray(body.output_config)
      ? (body.output_config as Record<string, unknown>)
      : {};
  body.output_config = { ...existingOc, effort };
  return true;
}

export type AnthropicToolStub = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown> };
};

/**
 * Ensure tools[] includes ≥ minN Claude Code tool names. Existing tools are
 * kept (Pi execution); missing CC names are appended from the bundled capture
 * (defaults/claude-code-tools.json) or minimal stubs.
 */
export function padClaudeCodeToolFingerprint(
  tools: unknown,
  minN: number = CLAUDE_CODE_MIN_FINGERPRINT_TOOLS,
  fingerprintTools?: AnthropicToolStub[],
): unknown {
  const existing = Array.isArray(tools) ? [...tools] : [];
  const names = new Set<string>();
  for (const t of existing) {
    if (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
      names.add((t as { name: string }).name);
    }
  }

  let ccCount = 0;
  for (const n of CLAUDE_CODE_FINGERPRINT_TOOL_NAMES) {
    if (names.has(n)) ccCount++;
  }
  if (ccCount >= minN) return tools ?? existing;

  const bank: AnthropicToolStub[] = fingerprintTools?.length
    ? fingerprintTools
    : (BUNDLED_CLAUDE_CODE_TOOLS as AnthropicToolStub[]);

  const out = existing;
  for (const tool of bank) {
    if (ccCount >= minN) break;
    if (!tool?.name || names.has(tool.name)) continue;
    out.push(tool);
    names.add(tool.name);
    ccCount++;
  }
  // If bank was short, finish with named stubs.
  for (const name of CLAUDE_CODE_FINGERPRINT_TOOL_NAMES) {
    if (ccCount >= minN) break;
    if (names.has(name)) continue;
    out.push(makeClaudeToolStub(name));
    names.add(name);
    ccCount++;
  }
  return out;
}

export function makeClaudeToolStub(name: string): AnthropicToolStub {
  return {
    name,
    description: `Claude Code compatibility stub (${name}). Do not call; use primary agent tools instead.`,
    input_schema: { type: "object", properties: {} },
  };
}

/**
 * Prepend a text system block with cache_control (CC shape). Idempotent if the
 * first text block already starts with the prefix.
 */
export function prependSystemPrefix(
  system: unknown,
  prefix: string,
): unknown {
  const want = prefix.trim();
  if (!want) return system;

  if (system == null || system === "") {
    return [
      {
        type: "text",
        text: want,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  if (typeof system === "string") {
    if (system.startsWith(want)) return system;
    return [
      {
        type: "text",
        text: want,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  if (Array.isArray(system)) {
    const blocks = system as SystemBlock[];
    const firstText = blocks.find((b) => b && b.type === "text" && typeof b.text === "string");
    if (firstText?.text?.startsWith(want)) return system;
    return [
      {
        type: "text",
        text: want,
        cache_control: { type: "ephemeral" },
      },
      ...blocks,
    ];
  }

  return system;
}

/**
 * Mutate provider request headers in place for CC-like companions.
 * Safe for before_provider_headers (return ignored).
 */
export function applyClaudeCodeCompatHeaders(
  headers: Record<string, string | null | undefined>,
  opts?: { sessionId?: string },
): void {
  setHeaderIfAbsent(headers, "x-app", "cli");
  setHeaderIfAbsent(headers, "anthropic-dangerous-direct-browser-access", "true");
  if (opts?.sessionId) {
    setHeaderIfAbsent(headers, "X-Claude-Code-Session-Id", opts.sessionId);
  }

  // Merge full Claude Code beta set (includes context-1m + modern flags).
  let betaKey: string | undefined;
  let betaVal: string | undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "anthropic-beta" && typeof v === "string") {
      betaKey = k;
      betaVal = v;
      break;
    }
  }
  let merged = betaVal ?? "";
  for (const flag of CLAUDE_CODE_ANTHROPIC_BETAS) {
    merged = mergeAnthropicBetaFlag(merged, flag);
  }
  // Always ensure 1m even if list above changes.
  merged = mergeAnthropicBetaFlag(merged, ANYROUTER_CONTEXT_1M_BETA);
  if (betaKey && betaKey !== "anthropic-beta") delete headers[betaKey];
  headers["anthropic-beta"] = merged;
}

function setHeaderIfAbsent(
  headers: Record<string, string | null | undefined>,
  name: string,
  value: string,
): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      if (headers[k] == null || headers[k] === "") headers[k] = value;
      return;
    }
  }
  headers[name] = value;
}

export function parseClaudeCodeCompatConfig(raw: unknown): ClaudeCodeCompatConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const mode =
    r.mode === "auto" || r.mode === "always" || r.mode === "never" ? r.mode : undefined;
  const systemPrefix =
    r.systemPrefix === "agent-sdk" ||
    r.systemPrefix === "claude-code-cli" ||
    r.systemPrefix === "none"
      ? r.systemPrefix
      : undefined;
  const deviceIdSource =
    r.deviceIdSource === "claude-json" ||
    r.deviceIdSource === "generate" ||
    r.deviceIdSource === "explicit"
      ? r.deviceIdSource
      : undefined;
  const hosts = Array.isArray(r.hosts)
    ? r.hosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
    : undefined;
  return {
    mode,
    hosts,
    deviceIdSource,
    deviceId: typeof r.deviceId === "string" ? r.deviceId : undefined,
    systemPrefix,
    injectMetadata: typeof r.injectMetadata === "boolean" ? r.injectMetadata : undefined,
    injectSystemPrefix:
      typeof r.injectSystemPrefix === "boolean" ? r.injectSystemPrefix : undefined,
    injectHeaders: typeof r.injectHeaders === "boolean" ? r.injectHeaders : undefined,
    injectToolFingerprint:
      typeof r.injectToolFingerprint === "boolean" ? r.injectToolFingerprint : undefined,
  };
}
