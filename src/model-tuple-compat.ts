/**
 * Exact-model tuple wire compatibility
 * (issue #64 Chat Completions + #67 Anthropic Messages).
 *
 * Scope: exact Provider/model only. Never Provider/global/default.
 * Authority is independent of model capability and Provider wire compat.
 *
 * Canonical shape under modelOverrides.<exactId>.compat:
 *   Chat: { api: "openai-completions", supportsDeveloperRole?, … }
 *   Anthropic: { api: "anthropic-messages", forceAdaptiveThinking?, supportsTemperature? }
 *
 * Legacy flat modelMeta fields (thinkingFormat / supportsDeveloperRole /
 * requiresReasoningContentOnAssistantMessages) still load with deprecation for Chat.
 */

import type { ModelMetaOverride, ThinkingFormat } from "./types.ts";
import { isThinkingFormat } from "./types.ts";

export const CHAT_COMPLETIONS_API = "openai-completions" as const;
export const ANTHROPIC_MESSAGES_API = "anthropic-messages" as const;

export const MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"] as const;
export type MaxTokensField = (typeof MAX_TOKENS_FIELDS)[number];

export function isMaxTokensField(v: string): v is MaxTokensField {
  return (MAX_TOKENS_FIELDS as readonly string[]).includes(v);
}

const CHAT_TUPLE_KEYS = new Set([
  "api",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "maxTokensField",
  "thinkingFormat",
  "requiresReasoningContentOnAssistantMessages",
]);

const ANTHROPIC_TUPLE_KEYS = new Set([
  "api",
  "forceAdaptiveThinking",
  "supportsTemperature",
]);

/** Canonical Chat exact-model tuple wire dialect (#64). */
export interface ChatTupleCompat {
  api: typeof CHAT_COMPLETIONS_API;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: MaxTokensField;
  thinkingFormat?: ThinkingFormat;
  requiresReasoningContentOnAssistantMessages?: boolean;
}

/** Canonical Anthropic exact-model tuple wire dialect (#67). */
export interface AnthropicTupleCompat {
  api: typeof ANTHROPIC_MESSAGES_API;
  forceAdaptiveThinking?: boolean;
  supportsTemperature?: boolean;
}

export type ModelTupleCompat = ChatTupleCompat | AnthropicTupleCompat;

export type TupleCompatSource =
  | "user-exact-tuple"
  | "legacy-flat"
  | "official-adapter";

export type TupleCompatField =
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "maxTokensField"
  | "thinkingFormat"
  | "requiresReasoningContentOnAssistantMessages"
  | "forceAdaptiveThinking"
  | "supportsTemperature";

export interface ResolvedTupleField<T> {
  value: T;
  source: TupleCompatSource;
  scope: "exact-model";
  /** True when a legacy flat field contributed (deprecation surface). */
  deprecated?: boolean;
}

export interface ResolvedChatTupleCompat {
  api: typeof CHAT_COMPLETIONS_API;
  modelId: string;
  scope: "exact-model";
  fields: {
    supportsDeveloperRole?: ResolvedTupleField<boolean>;
    supportsReasoningEffort?: ResolvedTupleField<boolean>;
    maxTokensField?: ResolvedTupleField<MaxTokensField>;
    thinkingFormat?: ResolvedTupleField<ThinkingFormat>;
    requiresReasoningContentOnAssistantMessages?: ResolvedTupleField<boolean>;
  };
  /** One deprecation note when legacy flat fields were used. */
  deprecations: string[];
}

export interface ResolvedAnthropicTupleCompat {
  api: typeof ANTHROPIC_MESSAGES_API;
  modelId: string;
  scope: "exact-model";
  fields: {
    forceAdaptiveThinking?: ResolvedTupleField<boolean>;
    supportsTemperature?: ResolvedTupleField<boolean>;
  };
  deprecations: string[];
}

export type ResolvedModelTupleCompat =
  | ResolvedChatTupleCompat
  | ResolvedAnthropicTupleCompat;

/** Registration-facing model.compat slice for pi-ai. */
export interface RegistrationTupleCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: MaxTokensField;
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
  forceAdaptiveThinking?: boolean;
  supportsTemperature?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireBooleanField(
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

/** Parse exact-model tuple compat (Chat or Anthropic discriminator). */
export function parseModelTupleCompat(
  raw: unknown,
  path = "model tuple compat",
): ModelTupleCompat | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`invalid ${path}: expected an object`);
  }

  if (raw.api === CHAT_COMPLETIONS_API) {
    const unknownKeys = Object.keys(raw).filter((key) => !CHAT_TUPLE_KEYS.has(key));
    if (unknownKeys.length) {
      throw new Error(
        `invalid ${path}: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.join(", ")}`,
      );
    }
    const out: ChatTupleCompat = { api: CHAT_COMPLETIONS_API };
    const sd = requireBooleanField(raw, "supportsDeveloperRole", path);
    if (typeof sd === "boolean") out.supportsDeveloperRole = sd;
    const sre = requireBooleanField(raw, "supportsReasoningEffort", path);
    if (typeof sre === "boolean") out.supportsReasoningEffort = sre;
    if (hasOwn(raw, "maxTokensField")) {
      if (typeof raw.maxTokensField !== "string" || !isMaxTokensField(raw.maxTokensField)) {
        throw new Error(
          `invalid ${path}.maxTokensField: expected max_tokens|max_completion_tokens`,
        );
      }
      out.maxTokensField = raw.maxTokensField;
    }
    if (hasOwn(raw, "thinkingFormat")) {
      if (typeof raw.thinkingFormat !== "string" || !isThinkingFormat(raw.thinkingFormat)) {
        throw new Error(`invalid ${path}.thinkingFormat: expected a pi-ai thinkingFormat enum`);
      }
      out.thinkingFormat = raw.thinkingFormat;
    }
    const rr = requireBooleanField(raw, "requiresReasoningContentOnAssistantMessages", path);
    if (typeof rr === "boolean") out.requiresReasoningContentOnAssistantMessages = rr;
    return out;
  }

  if (raw.api === ANTHROPIC_MESSAGES_API) {
    const unknownKeys = Object.keys(raw).filter(
      (key) => !ANTHROPIC_TUPLE_KEYS.has(key),
    );
    if (unknownKeys.length) {
      throw new Error(
        `invalid ${path}: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.join(", ")}`,
      );
    }
    const out: AnthropicTupleCompat = { api: ANTHROPIC_MESSAGES_API };
    const fat = requireBooleanField(raw, "forceAdaptiveThinking", path);
    if (typeof fat === "boolean") out.forceAdaptiveThinking = fat;
    const st = requireBooleanField(raw, "supportsTemperature", path);
    if (typeof st === "boolean") out.supportsTemperature = st;
    return out;
  }

  throw new Error(
    `invalid ${path}.api: expected ${CHAT_COMPLETIONS_API} or ${ANTHROPIC_MESSAGES_API}`,
  );
}

/** @deprecated Prefer parseModelTupleCompat — Chat-only alias for #64 callers. */
export function parseChatTupleCompat(
  raw: unknown,
  path = "model tuple compat",
): ChatTupleCompat | undefined {
  const parsed = parseModelTupleCompat(raw, path);
  if (!parsed) return undefined;
  if (parsed.api !== CHAT_COMPLETIONS_API) {
    throw new Error(`invalid ${path}.api: expected ${CHAT_COMPLETIONS_API}`);
  }
  return parsed;
}

/** Legacy flat fields that map onto tuple compat (issue #64 deprecation path). */
export type LegacyFlatTupleFields = Pick<
  ModelMetaOverride,
  | "thinkingFormat"
  | "requiresReasoningContentOnAssistantMessages"
> & {
  supportsDeveloperRole?: boolean;
};

function legacyFlatTuple(flat: LegacyFlatTupleFields | undefined): {
  supportsDeveloperRole?: boolean;
  thinkingFormat?: ThinkingFormat;
  requiresReasoningContentOnAssistantMessages?: boolean;
} {
  if (!flat) return {};
  const out: {
    supportsDeveloperRole?: boolean;
    thinkingFormat?: ThinkingFormat;
    requiresReasoningContentOnAssistantMessages?: boolean;
  } = {};
  if (typeof flat.supportsDeveloperRole === "boolean") {
    out.supportsDeveloperRole = flat.supportsDeveloperRole;
  }
  if (typeof flat.thinkingFormat === "string" && isThinkingFormat(flat.thinkingFormat)) {
    out.thinkingFormat = flat.thinkingFormat;
  }
  if (typeof flat.requiresReasoningContentOnAssistantMessages === "boolean") {
    out.requiresReasoningContentOnAssistantMessages =
      flat.requiresReasoningContentOnAssistantMessages;
  }
  return out;
}

/**
 * Resolve exact-model tuple wire dialect.
 * - Canonical tuple wins when present.
 * - Legacy flat fields load with deprecation when tuple omits the field.
 * - Same values: one effective value + one deprecation note.
 * - Conflicting values: throw (config fail).
 */
export function resolveChatTupleCompat(input: {
  modelId: string;
  providerApi: string | null | undefined;
  tuple?: ChatTupleCompat;
  legacyFlat?: LegacyFlatTupleFields;
  /**
   * Official OpenAI Chat Completions endpoint: keeps developer role native
   * when no explicit override exists.
   */
  officialOpenAi?: boolean;
}): ResolvedChatTupleCompat | undefined {
  const { modelId, providerApi, tuple, legacyFlat, officialOpenAi } = input;
  if (tuple && tuple.api !== CHAT_COMPLETIONS_API) {
    // Soft-ignore wrong-API leftover (Anthropic tuple on Chat provider).
    if (tuple.api === ANTHROPIC_MESSAGES_API) {
      // Fall through as if no tuple — still allow legacy flat Chat fields.
    } else {
      throw new Error(
        `tuple compat api ${tuple.api} is not ${CHAT_COMPLETIONS_API}`,
      );
    }
  }
  const chatTuple =
    tuple && tuple.api === CHAT_COMPLETIONS_API ? tuple : undefined;
  if (chatTuple && providerApi && providerApi !== CHAT_COMPLETIONS_API) {
    throw new Error(
      `tuple compat api ${chatTuple.api} does not match provider api ${providerApi}`,
    );
  }
  // Non-Chat providers never receive Chat tuple resolution.
  if (providerApi && providerApi !== CHAT_COMPLETIONS_API && !chatTuple) {
    return undefined;
  }
  // Use chatTuple instead of tuple below.
  const tupleChat = chatTuple;

  const legacy = legacyFlatTuple(legacyFlat);
  const deprecations: string[] = [];
  const fields: ResolvedChatTupleCompat["fields"] = {};

  const mergeBool = (
    field: "supportsDeveloperRole" | "requiresReasoningContentOnAssistantMessages",
    tupleValue: boolean | undefined,
    legacyValue: boolean | undefined,
  ) => {
    const hasTuple = typeof tupleValue === "boolean";
    const hasLegacy = typeof legacyValue === "boolean";
    if (hasTuple && hasLegacy && tupleValue !== legacyValue) {
      throw new Error(
        `tuple compat conflict on ${field}: tuple=${tupleValue} vs legacy flat=${legacyValue}`,
      );
    }
    if (hasTuple) {
      fields[field] = {
        value: tupleValue as boolean,
        source: "user-exact-tuple",
        scope: "exact-model",
        ...(hasLegacy ? { deprecated: true } : {}),
      };
      if (hasLegacy) {
        deprecations.push(
          `legacy flat ${field} matches tuple; prefer modelOverrides.<id>.compat`,
        );
      }
      return;
    }
    if (hasLegacy) {
      fields[field] = {
        value: legacyValue as boolean,
        source: "legacy-flat",
        scope: "exact-model",
        deprecated: true,
      };
      deprecations.push(
        `legacy flat ${field} is deprecated; migrate to modelOverrides.<id>.compat`,
      );
    }
  };

  mergeBool(
    "supportsDeveloperRole",
    tupleChat?.supportsDeveloperRole,
    legacy.supportsDeveloperRole,
  );
  mergeBool(
    "requiresReasoningContentOnAssistantMessages",
    tupleChat?.requiresReasoningContentOnAssistantMessages,
    legacy.requiresReasoningContentOnAssistantMessages,
  );

  // supportsReasoningEffort + maxTokensField: tuple-only (no legacy flat).
  if (typeof tupleChat?.supportsReasoningEffort === "boolean") {
    fields.supportsReasoningEffort = {
      value: tupleChat.supportsReasoningEffort,
      source: "user-exact-tuple",
      scope: "exact-model",
    };
  }
  if (tupleChat?.maxTokensField) {
    fields.maxTokensField = {
      value: tupleChat.maxTokensField,
      source: "user-exact-tuple",
      scope: "exact-model",
    };
  }

  // thinkingFormat: tuple or legacy flat
  {
    const hasTuple = typeof tupleChat?.thinkingFormat === "string";
    const hasLegacy = typeof legacy.thinkingFormat === "string";
    if (hasTuple && hasLegacy && tupleChat!.thinkingFormat !== legacy.thinkingFormat) {
      throw new Error(
        `tuple compat conflict on thinkingFormat: tuple=${tupleChat!.thinkingFormat} vs legacy flat=${legacy.thinkingFormat}`,
      );
    }
    if (hasTuple) {
      fields.thinkingFormat = {
        value: tupleChat!.thinkingFormat as ThinkingFormat,
        source: "user-exact-tuple",
        scope: "exact-model",
        ...(hasLegacy ? { deprecated: true } : {}),
      };
      if (hasLegacy) {
        deprecations.push(
          "legacy flat thinkingFormat matches tuple; prefer modelOverrides.<id>.compat",
        );
      }
    } else if (hasLegacy) {
      fields.thinkingFormat = {
        value: legacy.thinkingFormat as ThinkingFormat,
        source: "legacy-flat",
        scope: "exact-model",
        deprecated: true,
      };
      deprecations.push(
        "legacy flat thinkingFormat is deprecated; migrate to modelOverrides.<id>.compat",
      );
    }
  }

  // Official OpenAI: keep developer role native when no explicit override.
  if (
    officialOpenAi &&
    !fields.supportsDeveloperRole &&
    providerApi === CHAT_COMPLETIONS_API
  ) {
    fields.supportsDeveloperRole = {
      value: true,
      source: "official-adapter",
      scope: "exact-model",
    };
  }

  if (!Object.keys(fields).length) return undefined;

  // Dedupe deprecation notes (same values → one note).
  const uniqueDeprecations = [...new Set(deprecations)];

  return {
    api: CHAT_COMPLETIONS_API,
    modelId,
    scope: "exact-model",
    fields,
    deprecations: uniqueDeprecations,
  };
}

/**
 * Resolve Anthropic exact-model tuple (#67).
 * Only explicit exact-model config produces fields — no protocol/id/models.dev
 * guessing and no Provider wire inheritance.
 */
export function resolveAnthropicTupleCompat(input: {
  modelId: string;
  providerApi: string | null | undefined;
  tuple?: AnthropicTupleCompat;
}): ResolvedAnthropicTupleCompat | undefined {
  const { modelId, providerApi, tuple } = input;
  if (tuple && tuple.api !== ANTHROPIC_MESSAGES_API) {
    // Soft-ignore Chat leftover on Anthropic provider.
    if (tuple.api === CHAT_COMPLETIONS_API) return undefined;
    throw new Error(
      `tuple compat api ${(tuple as { api: string }).api} is not ${ANTHROPIC_MESSAGES_API}`,
    );
  }
  // Soft-ignore leftover Anthropic tuple on a non-Anthropic provider.
  if (tuple && providerApi && providerApi !== ANTHROPIC_MESSAGES_API) {
    return undefined;
  }
  if (providerApi && providerApi !== ANTHROPIC_MESSAGES_API && !tuple) {
    return undefined;
  }
  if (!tuple) return undefined;

  const fields: ResolvedAnthropicTupleCompat["fields"] = {};
  if (typeof tuple.forceAdaptiveThinking === "boolean") {
    fields.forceAdaptiveThinking = {
      value: tuple.forceAdaptiveThinking,
      source: "user-exact-tuple",
      scope: "exact-model",
    };
  }
  if (typeof tuple.supportsTemperature === "boolean") {
    fields.supportsTemperature = {
      value: tuple.supportsTemperature,
      source: "user-exact-tuple",
      scope: "exact-model",
    };
  }
  if (!Object.keys(fields).length) return undefined;

  return {
    api: ANTHROPIC_MESSAGES_API,
    modelId,
    scope: "exact-model",
    fields,
    deprecations: [],
  };
}

/** Dispatch resolve by provider API / tuple discriminator. */
export function resolveModelTupleCompat(input: {
  modelId: string;
  providerApi: string | null | undefined;
  tuple?: ModelTupleCompat;
  legacyFlat?: LegacyFlatTupleFields;
  officialOpenAi?: boolean;
}): ResolvedModelTupleCompat | undefined {
  const { providerApi, tuple } = input;
  if (tuple?.api === ANTHROPIC_MESSAGES_API || providerApi === ANTHROPIC_MESSAGES_API) {
    return resolveAnthropicTupleCompat({
      modelId: input.modelId,
      providerApi,
      tuple: tuple?.api === ANTHROPIC_MESSAGES_API ? tuple : undefined,
    });
  }
  return resolveChatTupleCompat({
    modelId: input.modelId,
    providerApi,
    tuple: tuple?.api === CHAT_COMPLETIONS_API ? tuple : undefined,
    legacyFlat: input.legacyFlat,
    officialOpenAi: input.officialOpenAi,
  });
}

/** Map resolved tuple to pi-ai model.compat registration fields. */
export function tupleCompatForRegistration(
  resolved: ResolvedModelTupleCompat | undefined,
): RegistrationTupleCompat | undefined {
  if (!resolved) return undefined;
  const out: RegistrationTupleCompat = {};

  if (resolved.api === ANTHROPIC_MESSAGES_API) {
    const f = resolved.fields;
    if (f.forceAdaptiveThinking) {
      out.forceAdaptiveThinking = f.forceAdaptiveThinking.value;
    }
    if (f.supportsTemperature) {
      out.supportsTemperature = f.supportsTemperature.value;
    }
    return Object.keys(out).length ? out : undefined;
  }

  const f = resolved.fields;
  // Official adapter developer role stays native — do not emit an override.
  if (
    f.supportsDeveloperRole &&
    f.supportsDeveloperRole.source !== "official-adapter"
  ) {
    out.supportsDeveloperRole = f.supportsDeveloperRole.value;
  }
  if (f.supportsReasoningEffort) {
    out.supportsReasoningEffort = f.supportsReasoningEffort.value;
  }
  if (f.maxTokensField) {
    out.maxTokensField = f.maxTokensField.value;
  }
  if (f.thinkingFormat) {
    out.thinkingFormat = f.thinkingFormat.value;
  }
  if (f.requiresReasoningContentOnAssistantMessages) {
    out.requiresReasoningContentOnAssistantMessages =
      f.requiresReasoningContentOnAssistantMessages.value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function isOfficialOpenAiChatEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

export function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}
