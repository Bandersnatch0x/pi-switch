/**
 * Provider-scoped request-wire compatibility
 * (issue #62 Chat store + #65 Anthropic + #66 Chat remaining fields).
 *
 * Independent of model capability and exact-model tuple compat. Never derived
 * from models.dev, model id tags, or CC Switch meta.
 */

import type { CcProvider } from "./types.ts";
import {
  isOfficialOpenAiChatEndpoint,
  isOfficialAnthropicEndpoint,
} from "./endpoints.ts";

export const CHAT_COMPLETIONS_API = "openai-completions" as const;
export const ANTHROPIC_MESSAGES_API = "anthropic-messages" as const;

/** Chat Provider wire fields (issue #62 + #66). */
export const CHAT_WIRE_FIELDS = [
  "supportsStore",
  "supportsUsageInStreaming",
  "supportsStrictMode",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
] as const;

export type ChatWireField = (typeof CHAT_WIRE_FIELDS)[number];

export const ANTHROPIC_WIRE_FIELDS = [
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsLongCacheRetention",
] as const;

export type AnthropicWireField = (typeof ANTHROPIC_WIRE_FIELDS)[number];

const CHAT_WIRE_KEYS = new Set<string>(["api", ...CHAT_WIRE_FIELDS]);
const ANTHROPIC_WIRE_KEYS = new Set<string>(["api", ...ANTHROPIC_WIRE_FIELDS]);

export interface ChatProviderWireCompat {
  api: typeof CHAT_COMPLETIONS_API;
  supportsStore?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
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

export type ProviderWireCompatField = ChatWireField | AnthropicWireField;

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

/**
 * Chat (#62 + #66): multi-field wire facts.
 * `value` remains supportsStore for #62 back-compat callers.
 */
export interface ResolvedChatProviderWireCompat {
  api: typeof CHAT_COMPLETIONS_API;
  /** supportsStore effective value (back-compat with #62 callers). */
  value: boolean;
  source: ProviderWireCompatSource;
  scope: "provider";
  conflicts: ProviderWireCompatConflict[];
  fields: {
    supportsStore: ResolvedWireField;
    supportsUsageInStreaming: ResolvedWireField;
    supportsStrictMode: ResolvedWireField;
    requiresToolResultName: ResolvedWireField;
    requiresAssistantAfterToolResult: ResolvedWireField;
  };
}

/** Anthropic (#65): three independent wire facts. */
export interface ResolvedAnthropicProviderWireCompat {
  api: typeof ANTHROPIC_MESSAGES_API;
  scope: "provider";
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

export type RegistrationChatWireCompat = {
  supportsStore?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
};

export type RegistrationAnthropicWireCompat = {
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsLongCacheRetention?: boolean;
};

export type RegistrationProviderWireCompat =
  | RegistrationChatWireCompat
  | RegistrationAnthropicWireCompat;

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
    const out: ChatProviderWireCompat = { api: CHAT_COMPLETIONS_API };
    for (const field of CHAT_WIRE_FIELDS) {
      const value = requireBoolean(raw, field, path);
      if (typeof value === "boolean") out[field] = value;
    }
    return out;
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

/**
 * Official OpenAI Chat Completions adapter facts (pi-ai defaults).
 * Unknown relays use conservative unsupported for every field when absent.
 */
const OFFICIAL_CHAT_FACTS: Record<ChatWireField, boolean> = {
  supportsStore: true,
  supportsUsageInStreaming: true,
  supportsStrictMode: true,
  // Official OpenAI does not require these quirks.
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
};

const CONSERVATIVE_CHAT_FACTS: Record<ChatWireField, boolean> = {
  supportsStore: false,
  supportsUsageInStreaming: false,
  supportsStrictMode: false,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
};

function resolveMultiFieldWire<F extends string>(input: {
  fields: readonly F[];
  official: boolean;
  officialFacts: Record<F, boolean>;
  conservativeFacts: Record<F, boolean>;
  userOverride: Partial<Record<F, boolean>> | undefined;
}): {
  fields: Record<F, ResolvedWireField>;
  conflicts: ProviderWireCompatConflict[];
  source: ProviderWireCompatSource;
  anyUser: boolean;
} {
  const fields = {} as Record<F, ResolvedWireField>;
  const conflicts: ProviderWireCompatConflict[] = [];
  let anyUser = false;

  for (const field of input.fields) {
    const userValue =
      input.userOverride && typeof input.userOverride[field] === "boolean"
        ? (input.userOverride[field] as boolean)
        : undefined;

    if (typeof userValue === "boolean") {
      anyUser = true;
      fields[field] = { value: userValue, source: "user-provider" };
      if (input.official && userValue !== input.officialFacts[field]) {
        conflicts.push({
          field: field as ProviderWireCompatField,
          effective: userValue,
          effectiveSource: "user-provider",
          overridden: input.officialFacts[field],
          overriddenSource: "official-adapter",
        });
      }
      continue;
    }

    if (input.official) {
      fields[field] = {
        value: input.officialFacts[field],
        source: "official-adapter",
      };
    } else {
      fields[field] = {
        value: input.conservativeFacts[field],
        source: "conservative-default",
      };
    }
  }

  const source: ProviderWireCompatSource = anyUser
    ? "user-provider"
    : input.official
      ? "official-adapter"
      : "conservative-default";

  return { fields, conflicts, source, anyUser };
}

function resolveChatWire(input: {
  provider: Pick<CcProvider, "api" | "baseUrl">;
  override?: ProviderWireCompat;
}): ResolvedChatProviderWireCompat | undefined {
  const { provider, override } = input;
  if (provider.api !== CHAT_COMPLETIONS_API) return undefined;

  const effectiveOverride =
    override && override.api === CHAT_COMPLETIONS_API ? override : undefined;

  const official = isOfficialOpenAiChatEndpoint(provider.baseUrl);
  const userOverride: Partial<Record<ChatWireField, boolean>> = {};
  if (effectiveOverride) {
    for (const field of CHAT_WIRE_FIELDS) {
      if (typeof effectiveOverride[field] === "boolean") {
        userOverride[field] = effectiveOverride[field];
      }
    }
  }

  const resolved = resolveMultiFieldWire({
    fields: CHAT_WIRE_FIELDS,
    official,
    officialFacts: OFFICIAL_CHAT_FACTS,
    conservativeFacts: CONSERVATIVE_CHAT_FACTS,
    userOverride,
  });

  return {
    api: CHAT_COMPLETIONS_API,
    value: resolved.fields.supportsStore.value,
    source: resolved.source,
    scope: "provider",
    conflicts: resolved.conflicts,
    fields: resolved.fields,
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
  const officialFacts: Record<AnthropicWireField, boolean> = {
    supportsEagerToolInputStreaming: true,
    supportsCacheControlOnTools: true,
    supportsLongCacheRetention: true,
  };
  const conservativeFacts: Record<AnthropicWireField, boolean> = {
    supportsEagerToolInputStreaming: false,
    supportsCacheControlOnTools: false,
    supportsLongCacheRetention: false,
  };

  const userOverride: Partial<Record<AnthropicWireField, boolean>> = {};
  if (effectiveOverride) {
    for (const field of ANTHROPIC_WIRE_FIELDS) {
      if (typeof effectiveOverride[field] === "boolean") {
        userOverride[field] = effectiveOverride[field];
      }
    }
  }

  const resolved = resolveMultiFieldWire({
    fields: ANTHROPIC_WIRE_FIELDS,
    official,
    officialFacts,
    conservativeFacts,
    userOverride,
  });

  return {
    api: ANTHROPIC_MESSAGES_API,
    scope: "provider",
    source: resolved.source,
    conflicts: resolved.conflicts,
    fields: resolved.fields,
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
 *
 * When any field is user-set or conservative, emit only non-official fields so
 * mixed official+user states stay precise (e.g. official OpenAI with one
 * explicit false still emits that one field).
 */
export function providerWireCompatForRegistration(
  resolved: ResolvedProviderWireCompat | undefined,
): RegistrationProviderWireCompat | undefined {
  if (!resolved) return undefined;

  if (resolved.api === CHAT_COMPLETIONS_API) {
    // Pure official: leave adapter native.
    if (resolved.source === "official-adapter") return undefined;
    const out: RegistrationChatWireCompat = {};
    for (const field of CHAT_WIRE_FIELDS) {
      const entry = resolved.fields[field];
      if (entry.source === "official-adapter") continue;
      out[field] = entry.value;
    }
    return Object.keys(out).length ? out : undefined;
  }

  if (resolved.source === "official-adapter") return undefined;
  const out: RegistrationAnthropicWireCompat = {};
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
