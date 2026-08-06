/**
 * Provider-scoped request-wire compatibility (issue #62 Chat + #65 Anthropic).
 *
 * Independent of model capability and exact-model tuple compat. Never derived
 * from models.dev, model id tags, or CC Switch meta.
 */

import type { CcProvider } from "./types.ts";

export const CHAT_COMPLETIONS_API = "openai-completions" as const;
export const ANTHROPIC_MESSAGES_API = "anthropic-messages" as const;

const CHAT_WIRE_KEYS = new Set(["api", "supportsStore"]);
const ANTHROPIC_WIRE_KEYS = new Set([
  "api",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsLongCacheRetention",
]);

export const ANTHROPIC_WIRE_FIELDS = [
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsLongCacheRetention",
] as const;

export type AnthropicWireField = (typeof ANTHROPIC_WIRE_FIELDS)[number];

export interface ChatProviderWireCompat {
  api: typeof CHAT_COMPLETIONS_API;
  supportsStore?: boolean;
}

export interface AnthropicProviderWireCompat {
  api: typeof ANTHROPIC_MESSAGES_API;
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsLongCacheRetention?: boolean;
}

export type ProviderWireCompat = ChatProviderWireCompat | AnthropicProviderWireCompat;

export type ProviderWireCompatSource =
  | "user-provider"
  | "official-adapter"
  | "conservative-default";

export type ProviderWireCompatField =
  | "supportsStore"
  | AnthropicWireField;

export interface ProviderWireCompatConflict {
  field: ProviderWireCompatField;
  effective: boolean;
  effectiveSource: "user-provider";
  overridden: boolean;
  overriddenSource: "official-adapter";
}

export interface ResolvedWireField {
  value: boolean;
  source: ProviderWireCompatSource;
}

/** Chat (#62): single supportsStore fact, kept as `value` for back-compat. */
export interface ResolvedChatProviderWireCompat {
  api: typeof CHAT_COMPLETIONS_API;
  /** supportsStore effective value (back-compat with #62 callers). */
  value: boolean;
  source: ProviderWireCompatSource;
  scope: "provider";
  conflicts: ProviderWireCompatConflict[];
  fields: { supportsStore: ResolvedWireField };
}

/** Anthropic (#65): three independent wire facts. */
export interface ResolvedAnthropicProviderWireCompat {
  api: typeof ANTHROPIC_MESSAGES_API;
  scope: "provider";
  /**
   * Dominant source for doctor one-liners: user-provider if any field is
   * user-set, else official-adapter / conservative-default.
   */
  source: ProviderWireCompatSource;
  conflicts: ProviderWireCompatConflict[];
  fields: {
    supportsEagerToolInputStreaming: ResolvedWireField;
    supportsCacheControlOnTools: ResolvedWireField;
    supportsLongCacheRetention: ResolvedWireField;
  };
}

export type ResolvedProviderWireCompat =
  | ResolvedChatProviderWireCompat
  | ResolvedAnthropicProviderWireCompat;

export type RegistrationProviderWireCompat =
  | { supportsStore: boolean }
  | {
      supportsEagerToolInputStreaming?: boolean;
      supportsCacheControlOnTools?: boolean;
      supportsLongCacheRetention?: boolean;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireBoolean(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (!hasOwn(raw, key)) return undefined;
  if (typeof raw[key] !== "boolean") {
    throw new Error(`invalid ${path}.${key}: expected boolean`);
  }
  return raw[key] as boolean;
}

/** Parse Provider-only wire compatibility (Chat or Anthropic discriminator). */
export function parseProviderWireCompat(
  raw: unknown,
  path = "provider compat",
): ProviderWireCompat | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`invalid ${path}: expected an object`);
  }

  if (raw.api === CHAT_COMPLETIONS_API) {
    const unknownKeys = Object.keys(raw).filter((key) => !CHAT_WIRE_KEYS.has(key));
    if (unknownKeys.length) {
      throw new Error(
        `invalid ${path}: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.join(", ")}`,
      );
    }
    const supportsStore = requireBoolean(raw, "supportsStore", path);
    return {
      api: CHAT_COMPLETIONS_API,
      ...(typeof supportsStore === "boolean" ? { supportsStore } : {}),
    };
  }

  if (raw.api === ANTHROPIC_MESSAGES_API) {
    const unknownKeys = Object.keys(raw).filter(
      (key) => !ANTHROPIC_WIRE_KEYS.has(key),
    );
    if (unknownKeys.length) {
      throw new Error(
        `invalid ${path}: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.join(", ")}`,
      );
    }
    const out: AnthropicProviderWireCompat = { api: ANTHROPIC_MESSAGES_API };
    for (const field of ANTHROPIC_WIRE_FIELDS) {
      const value = requireBoolean(raw, field, path);
      if (typeof value === "boolean") out[field] = value;
    }
    return out;
  }

  throw new Error(
    `invalid ${path}.api: expected ${CHAT_COMPLETIONS_API} or ${ANTHROPIC_MESSAGES_API}`,
  );
}

function isOfficialOpenAiEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function resolveChatWire(input: {
  provider: Pick<CcProvider, "api" | "baseUrl">;
  override?: ProviderWireCompat;
}): ResolvedChatProviderWireCompat | undefined {
  const { provider, override } = input;
  if (provider.api !== CHAT_COMPLETIONS_API) return undefined;

  const effectiveOverride =
    override && override.api === CHAT_COMPLETIONS_API ? override : undefined;

  const officialValue = isOfficialOpenAiEndpoint(provider.baseUrl)
    ? true
    : undefined;

  if (typeof effectiveOverride?.supportsStore === "boolean") {
    const value = effectiveOverride.supportsStore;
    const conflicts: ProviderWireCompatConflict[] =
      typeof officialValue === "boolean" && value !== officialValue
        ? [
            {
              field: "supportsStore",
              effective: value,
              effectiveSource: "user-provider",
              overridden: officialValue,
              overriddenSource: "official-adapter",
            },
          ]
        : [];
    return {
      api: CHAT_COMPLETIONS_API,
      value,
      source: "user-provider",
      scope: "provider",
      conflicts,
      fields: { supportsStore: { value, source: "user-provider" } },
    };
  }

  if (officialValue === true) {
    return {
      api: CHAT_COMPLETIONS_API,
      value: true,
      source: "official-adapter",
      scope: "provider",
      conflicts: [],
      fields: { supportsStore: { value: true, source: "official-adapter" } },
    };
  }
  return {
    api: CHAT_COMPLETIONS_API,
    value: false,
    source: "conservative-default",
    scope: "provider",
    conflicts: [],
    fields: { supportsStore: { value: false, source: "conservative-default" } },
  };
}

function resolveAnthropicWire(input: {
  provider: Pick<CcProvider, "api" | "baseUrl">;
  override?: ProviderWireCompat;
}): ResolvedAnthropicProviderWireCompat | undefined {
  const { provider, override } = input;
  if (provider.api !== ANTHROPIC_MESSAGES_API) return undefined;

  const effectiveOverride =
    override && override.api === ANTHROPIC_MESSAGES_API ? override : undefined;

  const official = isOfficialAnthropicEndpoint(provider.baseUrl);
  // Official Anthropic adapter facts (pi-ai defaults): all three supported.
  const officialFacts: Record<AnthropicWireField, boolean> = {
    supportsEagerToolInputStreaming: true,
    supportsCacheControlOnTools: true,
    supportsLongCacheRetention: true,
  };

  const fields = {} as ResolvedAnthropicProviderWireCompat["fields"];
  const conflicts: ProviderWireCompatConflict[] = [];
  let anyUser = false;

  for (const field of ANTHROPIC_WIRE_FIELDS) {
    const userValue =
      effectiveOverride && typeof effectiveOverride[field] === "boolean"
        ? effectiveOverride[field]
        : undefined;

    if (typeof userValue === "boolean") {
      anyUser = true;
      fields[field] = { value: userValue, source: "user-provider" };
      if (official && userValue !== officialFacts[field]) {
        conflicts.push({
          field,
          effective: userValue,
          effectiveSource: "user-provider",
          overridden: officialFacts[field],
          overriddenSource: "official-adapter",
        });
      }
      continue;
    }

    if (official) {
      fields[field] = {
        value: officialFacts[field],
        source: "official-adapter",
      };
    } else {
      // Unknown Anthropic relay: conservative unsupported when field absent.
      fields[field] = { value: false, source: "conservative-default" };
    }
  }

  const source: ProviderWireCompatSource = anyUser
    ? "user-provider"
    : official
      ? "official-adapter"
      : "conservative-default";

  return {
    api: ANTHROPIC_MESSAGES_API,
    scope: "provider",
    source,
    conflicts,
    fields,
  };
}

/**
 * Resolve Provider wire authority without consulting model ids, models.dev, or
 * CC Switch metadata.
 *
 * Soft-fails on stale/mismatched overrides: wrong-API leftover compat is
 * ignored so doctor / info / switch stay operational.
 */
export function resolveProviderWireCompat(input: {
  provider: Pick<CcProvider, "api" | "baseUrl">;
  override?: ProviderWireCompat;
}): ResolvedProviderWireCompat | undefined {
  const { provider } = input;
  if (provider.api === CHAT_COMPLETIONS_API) {
    return resolveChatWire(input);
  }
  if (provider.api === ANTHROPIC_MESSAGES_API) {
    return resolveAnthropicWire(input);
  }
  return undefined;
}

/**
 * Official adapter facts remain native (no registration override).
 * Other resolved values are explicit booleans for pi-ai model.compat.
 */
export function providerWireCompatForRegistration(
  resolved: ResolvedProviderWireCompat | undefined,
): RegistrationProviderWireCompat | undefined {
  if (!resolved) return undefined;
  if (resolved.source === "official-adapter") return undefined;

  if (resolved.api === CHAT_COMPLETIONS_API) {
    return { supportsStore: resolved.value };
  }

  // Anthropic: only emit fields that are user-set or conservative (all non-official).
  const out: {
    supportsEagerToolInputStreaming?: boolean;
    supportsCacheControlOnTools?: boolean;
    supportsLongCacheRetention?: boolean;
  } = {};
  for (const field of ANTHROPIC_WIRE_FIELDS) {
    const entry = resolved.fields[field];
    if (entry.source === "official-adapter") continue;
    out[field] = entry.value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function isChatProviderWireCompat(
  value: ResolvedProviderWireCompat | undefined,
): value is ResolvedChatProviderWireCompat {
  return value?.api === CHAT_COMPLETIONS_API;
}

export function isAnthropicProviderWireCompat(
  value: ResolvedProviderWireCompat | undefined,
): value is ResolvedAnthropicProviderWireCompat {
  return value?.api === ANTHROPIC_MESSAGES_API;
}
