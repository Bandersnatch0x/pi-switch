/**
 * Chat Completions exact-model tuple wire compatibility (issue #64).
 *
 * Scope: exact Provider/model only. Never Provider/global/default.
 * Authority is independent of model capability and Provider wire compat.
 *
 * Canonical shape under modelOverrides.<exactId>.compat:
 *   { api: "openai-completions", supportsDeveloperRole?, supportsReasoningEffort?,
 *     maxTokensField?, thinkingFormat?, requiresReasoningContentOnAssistantMessages? }
 *
 * Legacy flat modelMeta fields (thinkingFormat / supportsDeveloperRole /
 * requiresReasoningContentOnAssistantMessages) still load with deprecation.
 */

import type { ModelMetaOverride, ThinkingFormat } from "./types.ts";
import { isThinkingFormat } from "./types.ts";

export const CHAT_COMPLETIONS_API = "openai-completions" as const;

export const MAX_TOKENS_FIELDS = ["max_tokens", "max_completion_tokens"] as const;
export type MaxTokensField = (typeof MAX_TOKENS_FIELDS)[number];

export function isMaxTokensField(v: string): v is MaxTokensField {
  return (MAX_TOKENS_FIELDS as readonly string[]).includes(v);
}

const TUPLE_COMPAT_KEYS = new Set([
  "api",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "maxTokensField",
  "thinkingFormat",
  "requiresReasoningContentOnAssistantMessages",
]);

/** Canonical Chat exact-model tuple wire dialect. */
export interface ChatTupleCompat {
  api: typeof CHAT_COMPLETIONS_API;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: MaxTokensField;
  thinkingFormat?: ThinkingFormat;
  requiresReasoningContentOnAssistantMessages?: boolean;
}

export type TupleCompatSource =
  | "user-exact-tuple"
  | "legacy-flat"
  | "official-adapter";

export type TupleCompatField =
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "maxTokensField"
  | "thinkingFormat"
  | "requiresReasoningContentOnAssistantMessages";

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

/** Registration-facing model.compat slice for pi-ai. */
export interface RegistrationTupleCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: MaxTokensField;
  thinkingFormat?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Parse the exact-model Chat tuple compat contract. */
export function parseChatTupleCompat(
  raw: unknown,
  path = "model tuple compat",
): ChatTupleCompat | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new Error(`invalid ${path}: expected an object`);
  }

  const unknownKeys = Object.keys(raw).filter((key) => !TUPLE_COMPAT_KEYS.has(key));
  if (unknownKeys.length) {
    throw new Error(
      `invalid ${path}: unknown key${unknownKeys.length === 1 ? "" : "s"} ${unknownKeys.join(", ")}`,
    );
  }
  if (raw.api !== CHAT_COMPLETIONS_API) {
    throw new Error(`invalid ${path}.api: expected ${CHAT_COMPLETIONS_API}`);
  }

  const out: ChatTupleCompat = { api: CHAT_COMPLETIONS_API };

  if (hasOwn(raw, "supportsDeveloperRole")) {
    if (typeof raw.supportsDeveloperRole !== "boolean") {
      throw new Error(`invalid ${path}.supportsDeveloperRole: expected boolean`);
    }
    out.supportsDeveloperRole = raw.supportsDeveloperRole;
  }
  if (hasOwn(raw, "supportsReasoningEffort")) {
    if (typeof raw.supportsReasoningEffort !== "boolean") {
      throw new Error(`invalid ${path}.supportsReasoningEffort: expected boolean`);
    }
    out.supportsReasoningEffort = raw.supportsReasoningEffort;
  }
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
  if (hasOwn(raw, "requiresReasoningContentOnAssistantMessages")) {
    if (typeof raw.requiresReasoningContentOnAssistantMessages !== "boolean") {
      throw new Error(
        `invalid ${path}.requiresReasoningContentOnAssistantMessages: expected boolean`,
      );
    }
    out.requiresReasoningContentOnAssistantMessages =
      raw.requiresReasoningContentOnAssistantMessages;
  }

  return out;
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
    throw new Error(
      `tuple compat api ${tuple.api} is not ${CHAT_COMPLETIONS_API}`,
    );
  }
  if (tuple && providerApi && providerApi !== CHAT_COMPLETIONS_API) {
    throw new Error(
      `tuple compat api ${tuple.api} does not match provider api ${providerApi}`,
    );
  }
  // Non-Chat providers never receive Chat tuple resolution.
  if (providerApi && providerApi !== CHAT_COMPLETIONS_API && !tuple) {
    return undefined;
  }

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
    tuple?.supportsDeveloperRole,
    legacy.supportsDeveloperRole,
  );
  mergeBool(
    "requiresReasoningContentOnAssistantMessages",
    tuple?.requiresReasoningContentOnAssistantMessages,
    legacy.requiresReasoningContentOnAssistantMessages,
  );

  // supportsReasoningEffort + maxTokensField: tuple-only (no legacy flat).
  if (typeof tuple?.supportsReasoningEffort === "boolean") {
    fields.supportsReasoningEffort = {
      value: tuple.supportsReasoningEffort,
      source: "user-exact-tuple",
      scope: "exact-model",
    };
  }
  if (tuple?.maxTokensField) {
    fields.maxTokensField = {
      value: tuple.maxTokensField,
      source: "user-exact-tuple",
      scope: "exact-model",
    };
  }

  // thinkingFormat: tuple or legacy flat
  {
    const hasTuple = typeof tuple?.thinkingFormat === "string";
    const hasLegacy = typeof legacy.thinkingFormat === "string";
    if (hasTuple && hasLegacy && tuple!.thinkingFormat !== legacy.thinkingFormat) {
      throw new Error(
        `tuple compat conflict on thinkingFormat: tuple=${tuple!.thinkingFormat} vs legacy flat=${legacy.thinkingFormat}`,
      );
    }
    if (hasTuple) {
      fields.thinkingFormat = {
        value: tuple!.thinkingFormat as ThinkingFormat,
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

/** Map resolved tuple to pi-ai model.compat registration fields. */
export function tupleCompatForRegistration(
  resolved: ResolvedChatTupleCompat | undefined,
): RegistrationTupleCompat | undefined {
  if (!resolved) return undefined;
  const out: RegistrationTupleCompat = {};
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
