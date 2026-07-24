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

/** User config ~/.pi/agent/pi-switch.json */
export interface PiSwitchConfig {
  pageSize?: number;
  tabs?: string[];
  aliasCcs?: boolean;
  sqlitePath?: string | null;
  providerOverrides?: Record<
    string,
    {
      label?: string;
      headers?: Record<string, string>;
    }
  >;
  debug?: boolean;
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

export const HEADER_ALLOWLIST = new Set(
  ["user-agent", "originator", "anthropic-version", "anthropic-beta"].map((s) =>
    s.toLowerCase(),
  ),
);

/** Canonical casing for allowed header names. */
export const HEADER_CANONICAL: Record<string, string> = {
  "user-agent": "User-Agent",
  originator: "originator",
  "anthropic-version": "anthropic-version",
  "anthropic-beta": "anthropic-beta",
};

export const SETTINGS_KEY = "piSwitchSelection";
export const LEGACY_SETTINGS_KEY = "ccSwitchSelection";
export const DEFAULT_PAGE_SIZE = 12;
