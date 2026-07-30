/** Supported Pi API protocols for registration. */
export type PiApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai";

/** One row from cc-switch `providers` table (sqlite3 -json). */
export interface ProviderRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  is_current: number | boolean;
  website_url?: string | null;
  notes?: string | null;
  meta?: string | null;
  provider_type?: string | null;
  sort_index?: number | null;
}

/** Normalized provider used throughout pi-switch. */
export interface CcProvider {
  id: string;
  piName: string;
  displayName: string;
  appType: string;
  /** null when protocol is unsupported → not switchable */
  api: PiApi | null;
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  configModels: string[];
  apiFormat?: string;
  meta: Record<string, unknown>;
  isCurrentInCc: boolean;
  parseError?: string;
  websiteUrl?: string;
  notes?: string;
  modelsUrl?: string;
  isFullUrl?: boolean;
}

/** Persisted selection in ~/.pi/agent/settings.json */
export interface PiSwitchSelection {
  dbId: string;
  model: string;
  tab?: string;
  appType?: string;
  /** Regenerable registration name; not used for identity matching */
  provider?: string;
}

/** Optional CLI version / fingerprint overrides for UA templates. */
export interface PiSwitchVars {
  codexVersion?: string;
  claudeCodeVersion?: string;
  geminiVersion?: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
  codexOriginator?: string;
}

/** Force a CLI fingerprint preset regardless of api-matched default rules. */
export type FingerprintPreset = "claude-code" | "codex" | "gemini" | "none";

/** Per-provider model registration overrides (Pi model config fields). */
export interface ModelMetaOverride {
  reasoning?: boolean;
  thinkingFormat?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** Local pin of a provider+model pair (not an expose center). */
export interface PinEntry {
  dbId: string;
  model: string;
  label?: string;
}

/** Last-N successful switches. */
export interface RecentEntry {
  dbId: string;
  model: string;
  at: number;
}

/**
 * Claude Code request-shape compat for relays that fingerprint clients
 * (see src/compat/claude-code.ts). Default mode is `auto` (anyrouter hosts).
 */
export interface ClaudeCodeCompatConfig {
  /** auto | always | never — default auto */
  mode?: "auto" | "always" | "never";
  /** Extra hostnames for auto mode (exact or parent domain). */
  hosts?: string[];
  /** claude-json (default) | generate | explicit */
  deviceIdSource?: "claude-json" | "generate" | "explicit";
  /** Explicit device_id override (64 hex preferred). */
  deviceId?: string;
  /** agent-sdk (default, anyrouter gate) | claude-code-cli | none */
  systemPrefix?: "agent-sdk" | "claude-code-cli" | "none";
  injectMetadata?: boolean;
  injectSystemPrefix?: boolean;
  injectHeaders?: boolean;
  /** Pad tools[] with Claude Code tool-name stubs (default true; required by anyrouter). */
  injectToolFingerprint?: boolean;
}

/**
 * Gemini tool-calling compat for third-party proxies that need
 * explicit `toolConfig` to enforce parameter schemas.
 * Default mode is `auto` (all Gemini API providers).
 */
export interface GeminiToolCompatConfig {
  /** auto (default) | always | never */
  mode?: "auto" | "always" | "never";
  /** Restrict auto mode to these host substrings (empty = all Gemini). */
  hosts?: string[];
  /** Force toolConfig mode: AUTO (default) or VALIDATED (Gemini 3+). */
  forceToolConfigMode?: "AUTO" | "VALIDATED";
  /** Block tool calls with empty args so the model regenerates (default true). */
  blockEmptyToolCalls?: boolean;
  /** Convert parametersJsonSchema to parameters for proxy compatibility (default true). */
  convertSchema?: boolean;
}

/** User config ~/.pi/agent/pi-switch.json */
export interface PiSwitchConfig {
  tabs?: string[];
  aliasCcs?: boolean;
  sqlitePath?: string | null;
  /** Override detected codex/claude/gemini CLI versions used in User-Agent. */
  vars?: PiSwitchVars;
  /**
   * Default modelMeta applied when a provider has no explicit override.
   * Use for fleet-wide relay-safe defaults (e.g. reasoning:false).
   */
  defaultModelMeta?: ModelMetaOverride;
  /**
   * Reshape anthropic-messages requests to match Claude Code fingerprints
   * required by some relays (anyrouter 503 without metadata + Agent SDK prefix).
   */
  claudeCodeCompat?: ClaudeCodeCompatConfig;
  /**
   * Inject `toolConfig` + convert schema for Gemini proxies that
   * need it to enforce parameter schemas (prevents `read({})`).
   */
  geminiToolCompat?: GeminiToolCompatConfig;
  providerOverrides?: Record<
    string,
    {
      label?: string;
      /**
       * Force a CLI fingerprint preset (claude-code / codex / gemini / none).
       * Preset templates expand before explicit headers (explicit wins).
       * `none` skips defaults/provider-headers rules so only explicit headers remain.
       */
      fingerprint?: FingerprintPreset;
      headers?: Record<string, string>;
      /**
       * Per-provider model meta overrides (e.g. reasoning:false for gateways
       * that reject thinking/reasoning params, like a claude-protocol → GLM relay).
       */
      modelMeta?: ModelMetaOverride;
      /**
       * Per-model overrides inside this provider, keyed by model id.
       * Keys may be exact ids (`glm-4.6`) or globs (`gpt-5*`, `*sonnet*`).
       * Merged on top of provider `modelMeta`, which merges on top of
       * `defaultModelMeta`. Most specific glob wins.
       */
      modelOverrides?: Record<string, ModelMetaOverride>;
      /**
       * Force Claude Code compat on/off for this provider.
       * undefined = follow global claudeCodeCompat.mode rules.
       */
      claudeCodeCompat?: boolean;
      /**
       * Force Gemini tool compat on/off for this provider.
       * undefined = follow global geminiToolCompat.mode rules.
       */
      geminiToolCompat?: boolean;
    }
  >;
  /** Pinned provider/model shortcuts (local only). */
  pins?: PinEntry[];
  /** Recent successful switches (local only). */
  recent?: RecentEntry[];
  /** Max recent entries to keep (default 8). */
  recentLimit?: number;
  debug?: boolean;
}

/** Pi SDK thinkingFormat literals (model-config.d.ts). Invalid values are rejected. */
export const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "together",
  "deepseek",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
] as const;

export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

export function isThinkingFormat(v: string): v is ThinkingFormat {
  return (THINKING_FORMATS as readonly string[]).includes(v);
}

export interface HeaderRule {
  name: string;
  apis: string[];
  headers: Record<string, string>;
}

export interface HeaderRulesFile {
  rules: HeaderRule[];
}

export const DEFAULT_MODEL_META = {
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
} as const;

export interface ApiModelMeta {
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
}

/**
 * Per-api conservative meta defaults (SPEC review #4).
 * cc-switch DB carries no per-model context/cost, so we tier by protocol
 * instead of one hardcoded value. Values are safe lower-bounds; users can
 * override via pi modelOverrides if a specific model differs.
 */
export const API_MODEL_META: Record<PiApi, ApiModelMeta> = {
  "anthropic-messages": {
    contextWindow: 200_000,
    maxTokens: 64_000,
    input: ["text", "image"],
    reasoning: true,
  },
  "openai-responses": {
    contextWindow: 400_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    reasoning: true,
  },
  "openai-completions": {
    contextWindow: 128_000,
    maxTokens: 32_000,
    input: ["text"],
    reasoning: false,
  },
  "google-generative-ai": {
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    input: ["text", "image"],
    reasoning: true,
  },
};

/**
 * Header allowlist — the ONLY header names pi-switch may inject or override.
 *
 * Defaults include fingerprint fields via defaults/headers.json templates:
 * originator (codex), anthropic-version/beta (claude-code), x-goog-api-client
 * (gemini). Overridable via providerOverrides.fingerprint / .headers / vars.
 */
export const HEADER_ALLOWLIST = new Set(
  [
    "user-agent",
    "originator",
    "anthropic-version",
    "anthropic-beta",
    "x-goog-api-client",
  ].map((s) => s.toLowerCase()),
);

/** Canonical casing for allowed header names. */
export const HEADER_CANONICAL: Record<string, string> = {
  "user-agent": "User-Agent",
  originator: "originator",
  "anthropic-version": "anthropic-version",
  "anthropic-beta": "anthropic-beta",
  "x-goog-api-client": "x-goog-api-client",
};

export const SETTINGS_KEY = "piSwitchSelection";
export const LEGACY_SETTINGS_KEY = "ccSwitchSelection";
export const DEFAULT_PAGE_SIZE = 12;
export const DEFAULT_RECENT_LIMIT = 8;
