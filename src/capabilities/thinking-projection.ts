/**
 * Provider reasoning profile projection.
 *
 * This is the pure seam between provider capability facts and Pi-facing
 * thinking metadata. It owns tuple identity, profile validation, precedence,
 * sparse-level fail-closed behavior, runtime expressibility, collisions, and
 * diagnostics. Callers consume one decision instead of re-deriving support.
 */

import { cleanThinkingLevelMap } from "../model-meta.ts";
import {
  THINKING_LEVELS,
  isThinkingLevel,
  type PiApi,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "../types.ts";

export const PROVIDER_REASONING_TUPLE_SCHEMA_VERSION =
  "provider-reasoning-tuple/v1" as const;

export const ACTIVE_THINKING_LEVELS = THINKING_LEVELS.filter(
  (level): level is Exclude<ThinkingLevel, "off"> => level !== "off",
);

export type ActiveThinkingLevel = (typeof ACTIVE_THINKING_LEVELS)[number];
export type ThinkingIntentKey = "provider-default" | ThinkingLevel;

export type ThinkingIntent =
  | { mode: "provider-default" }
  | { mode: "off" }
  | { mode: "level"; level: ActiveThinkingLevel };

export interface ProviderEndpointTupleInput {
  appType: string;
  providerId: string;
  api: PiApi;
  baseUrl: string;
  modelId: string;
}

export interface ProviderEndpointTuple extends ProviderEndpointTupleInput {
  tupleSchemaVersion: typeof PROVIDER_REASONING_TUPLE_SCHEMA_VERSION;
}

export type AtomicReasoningControl =
  | { type: "effort" }
  | { type: "toggle" }
  | {
      type: "budget_tokens";
      minTokens: number;
      maxTokensExclusive?: number;
    }
  | { type: "fixed"; enabled: boolean };

export type ReasoningControl =
  | AtomicReasoningControl
  | {
      type: "composite";
      controls: readonly Exclude<AtomicReasoningControl, { type: "fixed" }>[];
    };

export type ReasoningControlType = ReasoningControl["type"];

const PI_APIS = new Set<PiApi>([
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "google-generative-ai",
]);

const REASONING_CONTROL_TYPES = new Set<ReasoningControlType>([
  "effort",
  "toggle",
  "budget_tokens",
  "fixed",
  "composite",
]);

const ATOMIC_REASONING_CONTROL_TYPES = new Set<
  Exclude<ReasoningControlType, "composite">
>(["effort", "toggle", "budget_tokens", "fixed"]);

const PROFILE_SOURCES = new Set<ProviderReasoningProfileSource>([
  "codex-model-catalog",
  "provider-model-metadata",
  "built-in",
  "user",
]);

const RUNTIME_PROVIDER_DEFAULTS = new Set<
  PiThinkingRuntimeCapability["providerDefault"]
>(["supported", "unsupported"]);

const RUNTIME_OFF_VALUES = new Set<PiThinkingRuntimeCapability["off"]>([
  "supported",
  "unsupported",
  "indistinguishable-from-provider-default",
]);

export type NativeAtomicReasoningValue =
  | { type: "effort"; value: string }
  | { type: "toggle"; enabled: boolean }
  | { type: "budget_tokens"; tokens: number };

export type NativeReasoningValue =
  | NativeAtomicReasoningValue
  | {
      type: "composite";
      values: readonly NativeAtomicReasoningValue[];
    };

export interface ProviderReasoningVariant {
  name: string;
  native: NativeReasoningValue;
  /** Omit for provider-only values such as `ultra`. Standard names infer themselves. */
  piLevel?: ThinkingLevel;
  /** Actual provider outcome; defaults to piLevel when represented. */
  effectiveLevel?: ThinkingLevel;
  description?: string;
}

export type ProviderReasoningProfileSource =
  | "codex-model-catalog"
  | "provider-model-metadata"
  | "built-in"
  | "user";

/**
 * Snapshot catalog variant. Codex keeps its compact effort-only wire shape;
 * provider metadata may publish the complete cross-provider native variant.
 */
export type ProviderReasoningCatalogVariant =
  | {
      value: string;
      description?: string;
    }
  | ProviderReasoningVariant;

export interface ProviderReasoningCatalogModel {
  control: ReasoningControl;
  defaultVariant?: string;
  variants: readonly ProviderReasoningCatalogVariant[];
}

/** Raw provider facts attached to the CcProvider snapshot that produced them. */
export interface ProviderReasoningCatalog {
  source: "codex-model-catalog" | "provider-model-metadata";
  observedAt: string;
  models: Readonly<Record<string, ProviderReasoningCatalogModel>>;
  stale?: boolean;
}

export interface ProviderReasoningProfile {
  tuple: ProviderEndpointTupleInput;
  profileVersion: string;
  control: ReasoningControl;
  variants: readonly ProviderReasoningVariant[];
  defaultVariant?: string;
  source: ProviderReasoningProfileSource;
  observedAt: string;
  stale?: boolean;
}

/** Exact-model user authority; tuple identity and source come from its config scope. */
export type UserReasoningProfileOverride = Omit<
  ProviderReasoningProfile,
  "tuple" | "source"
>;

export interface PiThinkingRuntimeCapability {
  version: string;
  /** True when this exact Pi release has a reviewed adapter fixture matrix. */
  runtimeVerified: boolean;
  /** True only after this installed runtime/API path passes a payload fixture. */
  payloadVerified: boolean;
  supportedControls: readonly ReasoningControlType[];
  providerDefault: "supported" | "unsupported";
  off:
    | "supported"
    | "unsupported"
    | "indistinguishable-from-provider-default";
}

export type UserThinkingMapScope =
  | "default"
  | "provider"
  | "exact-model"
  | "model-glob"
  | "none";

export type UserThinkingMapScopes = Readonly<
  Partial<Record<ThinkingLevel, UserThinkingMapScope>>
>;

export type ThinkingProjectionStatus =
  | "provider-default"
  | "exact"
  | "lossy"
  | "unsupported"
  | "unverified";

export type ThinkingProjectionSource =
  | ProviderReasoningProfileSource
  | "built-in-map"
  | "user-map";

export interface ThinkingIntentProjection {
  intent: ThinkingIntentKey;
  native?: NativeReasoningValue;
  effectiveLevel?: ThinkingLevel;
  status: ThinkingProjectionStatus;
  source?: ThinkingProjectionSource;
  /** User-map authority retained for diagnostics; only exact-model is verified. */
  scope?: UserThinkingMapScope;
  reason?: string;
}

export interface ThinkingProjectionCollision {
  effectiveLevel: ThinkingLevel;
  intents: ThinkingLevel[];
  providerValues: string[];
}

export type ThinkingProjectionDecisionStatus =
  | "none"
  | "provider-default"
  | "exact"
  | "lossy"
  | "unsupported"
  | "unverified";

export interface ThinkingProjectionDecision {
  tuple: ProviderEndpointTuple;
  tupleKey: string;
  profileVersion?: string;
  control?: ReasoningControl;
  map?: ThinkingLevelMap;
  advertised: NativeReasoningValue[];
  unrepresented: NativeReasoningValue[];
  projections: ThinkingIntentProjection[];
  collisions: ThinkingProjectionCollision[];
  source?: ProviderReasoningProfileSource;
  observedAt?: string;
  stale: boolean;
  status: ThinkingProjectionDecisionStatus;
  /** Installed Pi adapter evidence used to classify unsupported vs unverified. */
  runtime: PiThinkingRuntimeCapability;
  warnings: string[];
}

export interface ThinkingProjectionInput {
  tuple: ProviderEndpointTupleInput;
  profile?: ProviderReasoningProfile;
  runtime: PiThinkingRuntimeCapability;
  builtInMap?: ThinkingLevelMap;
  userMap?: ThinkingLevelMap;
  userMapScope: UserThinkingMapScope;
  /** Per-level provenance for deep-merged user maps; overrides userMapScope. */
  userMapScopes?: UserThinkingMapScopes;
}

export type ReasoningProfileErrorCode =
  | "invalid-tuple"
  | "tuple-mismatch"
  | "invalid-profile"
  | "invalid-runtime";

export class ReasoningProfileError extends Error {
  readonly name = "ReasoningProfileError";

  constructor(
    readonly code: ReasoningProfileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface NormalizedVariant extends ProviderReasoningVariant {
  name: string;
  native: NativeReasoningValue;
  piLevel?: ThinkingLevel;
  effectiveLevel?: ThinkingLevel;
}

interface NormalizedProfile extends Omit<ProviderReasoningProfile, "tuple" | "variants" | "control"> {
  tuple: ProviderEndpointTuple;
  control: ReasoningControl;
  variants: NormalizedVariant[];
}

interface MapLayer {
  value: string | null;
  source: "built-in-map" | "profile" | "user-map";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ReasoningProfileError(
      "invalid-tuple",
      `${field} must be a non-empty string`,
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ReasoningProfileError("invalid-tuple", `${field} must not be empty`);
  }
  return normalized;
}

function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== "string") {
    throw new ReasoningProfileError(
      "invalid-tuple",
      "baseUrl must be a valid absolute URL string",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ReasoningProfileError(
      "invalid-tuple",
      `baseUrl is not a valid absolute URL: ${input}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ReasoningProfileError(
      "invalid-tuple",
      "baseUrl must use http or https",
    );
  }
  if (parsed.username || parsed.password) {
    throw new ReasoningProfileError(
      "invalid-tuple",
      "baseUrl must not contain credentials",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new ReasoningProfileError(
      "invalid-tuple",
      "baseUrl must not contain query or fragment data",
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

export function canonicalProviderEndpointTuple(
  input: ProviderEndpointTupleInput,
): ProviderEndpointTuple {
  const record = asRecord(input);
  if (!record) {
    throw new ReasoningProfileError(
      "invalid-tuple",
      "provider endpoint tuple must be an object",
    );
  }
  const api = requireNonEmpty(record.api, "api");
  if (!PI_APIS.has(api as PiApi)) {
    throw new ReasoningProfileError(
      "invalid-tuple",
      `api is not a supported Pi API: ${api}`,
    );
  }
  return {
    tupleSchemaVersion: PROVIDER_REASONING_TUPLE_SCHEMA_VERSION,
    appType: requireNonEmpty(record.appType, "appType"),
    providerId: requireNonEmpty(record.providerId, "providerId"),
    api: api as PiApi,
    baseUrl: normalizeBaseUrl(record.baseUrl),
    modelId: requireNonEmpty(record.modelId, "modelId"),
  };
}

export function providerEndpointTupleKey(
  input: ProviderEndpointTupleInput,
): string {
  const tuple = canonicalProviderEndpointTuple(input);
  return JSON.stringify([
    tuple.tupleSchemaVersion,
    tuple.appType,
    tuple.providerId,
    tuple.api,
    tuple.baseUrl,
    tuple.modelId,
  ]);
}

function cloneNative(value: NativeReasoningValue): NativeReasoningValue {
  if (value.type === "composite") {
    return { type: "composite", values: value.values.map((item) => ({ ...item })) };
  }
  return { ...value };
}

function cloneControl(control: ReasoningControl): ReasoningControl {
  if (control.type === "composite") {
    return { type: "composite", controls: control.controls.map((item) => ({ ...item })) };
  }
  return { ...control };
}

function nativeValueKey(value: NativeReasoningValue): string {
  switch (value.type) {
    case "effort":
      return `effort:${value.value}`;
    case "toggle":
      return `toggle:${value.enabled}`;
    case "budget_tokens":
      return `budget_tokens:${value.tokens}`;
    case "composite":
      return `composite:${value.values.map(nativeValueKey).sort().join("+")}`;
  }
}

export function nativeReasoningEffort(
  value: NativeReasoningValue,
): string | undefined {
  if (value.type === "effort") return value.value;
  if (value.type !== "composite") return undefined;
  return value.values.find((item) => item.type === "effort")?.value;
}

function providerValueLabel(value: NativeReasoningValue): string {
  const effort = nativeReasoningEffort(value);
  if (effort) return effort;
  switch (value.type) {
    case "toggle":
      return value.enabled ? "enabled" : "disabled";
    case "budget_tokens":
      return String(value.tokens);
    case "composite":
      return value.values.map(nativeValueKey).sort().join("+");
    case "effort":
      return value.value;
  }
}

function validatePositiveInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ReasoningProfileError(
      "invalid-profile",
      `${field} must be a positive integer`,
    );
  }
}

function validateControl(control: ReasoningControl): void {
  const record = asRecord(control);
  if (!record) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "control must be an object",
    );
  }
  const type = record.type;
  if (
    typeof type !== "string" ||
    !REASONING_CONTROL_TYPES.has(type as ReasoningControlType)
  ) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "control.type is not supported",
    );
  }

  if (type === "fixed") {
    if (typeof record.enabled !== "boolean") {
      throw new ReasoningProfileError(
        "invalid-profile",
        "control.enabled must be a boolean",
      );
    }
    return;
  }
  if (type === "effort" || type === "toggle") return;

  if (type === "budget_tokens") {
    validatePositiveInteger(record.minTokens, "control.minTokens");
    if (record.maxTokensExclusive !== undefined) {
      validatePositiveInteger(
        record.maxTokensExclusive,
        "control.maxTokensExclusive",
      );
      if (
        (record.maxTokensExclusive as number) <= (record.minTokens as number)
      ) {
        throw new ReasoningProfileError(
          "invalid-profile",
          "control.maxTokensExclusive must be greater than minTokens",
        );
      }
    }
    return;
  }

  if (!Array.isArray(record.controls) || record.controls.length < 2) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "composite control must contain at least two atomic controls",
    );
  }
  const types = new Set<string>();
  for (const [index, atomic] of record.controls.entries()) {
    const atomicRecord = asRecord(atomic);
    const atomicType = atomicRecord?.type;
    if (
      typeof atomicType !== "string" ||
      !ATOMIC_REASONING_CONTROL_TYPES.has(
        atomicType as Exclude<ReasoningControlType, "composite">,
      ) ||
      atomicType === "fixed"
    ) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `control.controls[${index}] must be effort, toggle, or budget_tokens`,
      );
    }
    if (types.has(atomicType)) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `composite control repeats ${atomicType}`,
      );
    }
    types.add(atomicType);
    validateControl(atomic as AtomicReasoningControl);
  }
}

function budgetControlFor(
  control: ReasoningControl,
): Extract<AtomicReasoningControl, { type: "budget_tokens" }> | undefined {
  if (control.type === "budget_tokens") return control;
  if (control.type !== "composite") return undefined;
  return control.controls.find(
    (candidate): candidate is Extract<AtomicReasoningControl, { type: "budget_tokens" }> =>
      candidate.type === "budget_tokens",
  );
}

function isBudgetOffSentinel(value: NativeReasoningValue): boolean {
  if (value.type === "budget_tokens") return value.tokens === 0;
  return (
    value.type === "composite" &&
    value.values.some(
      (candidate) => candidate.type === "budget_tokens" && candidate.tokens === 0,
    )
  );
}

function validateAtomicNative(
  value: NativeAtomicReasoningValue,
  path: string,
  allowBudgetOffSentinel = false,
): void {
  const record = asRecord(value);
  if (!record) {
    throw new ReasoningProfileError(
      "invalid-profile",
      `${path} must be an object`,
    );
  }
  const type = record.type;
  if (type === "effort") {
    if (typeof record.value !== "string" || !record.value.trim()) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `${path}.value must be a non-empty string`,
      );
    }
    return;
  }
  if (type === "toggle") {
    if (typeof record.enabled !== "boolean") {
      throw new ReasoningProfileError(
        "invalid-profile",
        `${path}.enabled must be a boolean`,
      );
    }
    return;
  }
  if (type === "budget_tokens") {
    if (allowBudgetOffSentinel && record.tokens === 0) return;
    validatePositiveInteger(record.tokens, `${path}.tokens`);
    return;
  }
  throw new ReasoningProfileError(
    "invalid-profile",
    `${path}.type must be effort, toggle, or budget_tokens`,
  );
}

function validateNativeForControl(
  value: NativeReasoningValue,
  control: ReasoningControl,
  path: string,
  allowBudgetOffSentinel = false,
): void {
  if (control.type === "fixed") {
    throw new ReasoningProfileError(
      "invalid-profile",
      "fixed reasoning profiles must not advertise selectable variants",
    );
  }
  const valueRecord = asRecord(value);
  if (control.type === "composite") {
    if (
      valueRecord?.type !== "composite" ||
      !Array.isArray(valueRecord.values) ||
      valueRecord.values.length === 0
    ) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `${path} must be a non-empty composite value`,
      );
    }
    const allowed = new Set<string>(control.controls.map((item) => item.type));
    const seen = new Set<string>();
    for (const [index, atomic] of valueRecord.values.entries()) {
      const atomicRecord = asRecord(atomic);
      const atomicType = atomicRecord?.type;
      if (typeof atomicType !== "string" || !allowed.has(atomicType)) {
        throw new ReasoningProfileError(
          "invalid-profile",
          `${path}.values[${index}] is not declared by the composite control`,
        );
      }
      if (seen.has(atomicType)) {
        throw new ReasoningProfileError(
          "invalid-profile",
          `${path} repeats ${atomicType}`,
        );
      }
      seen.add(atomicType);
      validateAtomicNative(
        atomic as NativeAtomicReasoningValue,
        `${path}.values[${index}]`,
        allowBudgetOffSentinel,
      );
    }
  } else {
    if (valueRecord?.type !== control.type) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `${path}.type ${String(valueRecord?.type)} does not match control ${control.type}`,
      );
    }
    validateAtomicNative(
      value as NativeAtomicReasoningValue,
      path,
      allowBudgetOffSentinel,
    );
  }

  const budgetControl = budgetControlFor(control);
  const budgetValue =
    value.type === "budget_tokens"
      ? value
      : value.type === "composite"
        ? value.values.find(
            (candidate): candidate is Extract<NativeAtomicReasoningValue, { type: "budget_tokens" }> =>
              candidate.type === "budget_tokens",
          )
        : undefined;
  if (!budgetControl || !budgetValue) return;
  if (allowBudgetOffSentinel && budgetValue.tokens === 0) return;
  if (budgetValue.tokens < budgetControl.minTokens) {
    throw new ReasoningProfileError(
      "invalid-profile",
      `${path} budget ${budgetValue.tokens} is below ${budgetControl.minTokens}`,
    );
  }
  if (
    budgetControl.maxTokensExclusive !== undefined &&
    budgetValue.tokens >= budgetControl.maxTokensExclusive
  ) {
    throw new ReasoningProfileError(
      "invalid-profile",
      `${path} budget ${budgetValue.tokens} must be below ${budgetControl.maxTokensExclusive}`,
    );
  }
}

function normalizeProfile(
  profile: ProviderReasoningProfile,
  expectedTupleKey: string,
): NormalizedProfile {
  const record = asRecord(profile);
  if (!record) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "reasoning profile must be an object",
    );
  }
  const tuple = canonicalProviderEndpointTuple(
    record.tuple as ProviderEndpointTupleInput,
  );
  const actualTupleKey = providerEndpointTupleKey(tuple);
  if (actualTupleKey !== expectedTupleKey) {
    throw new ReasoningProfileError(
      "tuple-mismatch",
      `profile tuple ${actualTupleKey} does not match ${expectedTupleKey}`,
    );
  }
  if (
    typeof record.profileVersion !== "string" ||
    !record.profileVersion.trim()
  ) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "profileVersion must be a non-empty string",
    );
  }
  if (typeof record.observedAt !== "string" || !record.observedAt.trim()) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "observedAt must be a non-empty string",
    );
  }
  if (
    typeof record.source !== "string" ||
    !PROFILE_SOURCES.has(record.source as ProviderReasoningProfileSource)
  ) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "source is not a supported reasoning profile source",
    );
  }
  if (record.stale !== undefined && typeof record.stale !== "boolean") {
    throw new ReasoningProfileError(
      "invalid-profile",
      "stale must be a boolean when provided",
    );
  }
  if (!Array.isArray(record.variants)) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "variants must be an array",
    );
  }

  const control = record.control as ReasoningControl;
  validateControl(control);
  if (control.type === "fixed" && record.variants.length > 0) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "fixed reasoning profiles must have zero variants",
    );
  }

  const names = new Set<string>();
  const piLevels = new Set<ThinkingLevel>();
  const variants: NormalizedVariant[] = record.variants.map((rawVariant, index) => {
    const variant = asRecord(rawVariant);
    if (!variant) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `variants[${index}] must be an object`,
      );
    }
    if (typeof variant.name !== "string" || !variant.name.trim()) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `variants[${index}].name must be a non-empty string`,
      );
    }
    const name = variant.name.trim();
    const folded = name.toLowerCase();
    if (names.has(folded)) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `duplicate variant name: ${name}`,
      );
    }
    names.add(folded);

    if (
      variant.piLevel !== undefined &&
      (typeof variant.piLevel !== "string" ||
        !isThinkingLevel(variant.piLevel))
    ) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `variants[${index}].piLevel is not a Pi thinking level`,
      );
    }
    if (
      variant.effectiveLevel !== undefined &&
      (typeof variant.effectiveLevel !== "string" ||
        !isThinkingLevel(variant.effectiveLevel))
    ) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `variants[${index}].effectiveLevel is not a Pi thinking level`,
      );
    }
    if (
      variant.description !== undefined &&
      typeof variant.description !== "string"
    ) {
      throw new ReasoningProfileError(
        "invalid-profile",
        `variants[${index}].description must be a string`,
      );
    }

    const piLevel =
      (variant.piLevel as ThinkingLevel | undefined) ??
      (isThinkingLevel(name) ? name : undefined);
    if (piLevel) {
      if (piLevels.has(piLevel)) {
        throw new ReasoningProfileError(
          "invalid-profile",
          `multiple variants target Pi level ${piLevel}`,
        );
      }
      piLevels.add(piLevel);
    }
    const native = variant.native as NativeReasoningValue;
    validateNativeForControl(
      native,
      control,
      `variants[${index}].native`,
      piLevel === "off",
    );
    const effectiveLevel = variant.effectiveLevel as ThinkingLevel | undefined;
    const description = variant.description?.trim();
    return {
      name,
      native: cloneNative(native),
      ...(piLevel ? { piLevel } : {}),
      ...(effectiveLevel
        ? { effectiveLevel }
        : piLevel
          ? { effectiveLevel: piLevel }
          : {}),
      ...(description ? { description } : {}),
    };
  });
  if (
    record.defaultVariant !== undefined &&
    typeof record.defaultVariant !== "string"
  ) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "defaultVariant must be a string when provided",
    );
  }
  const defaultVariant = record.defaultVariant?.trim();
  if (record.defaultVariant !== undefined && !defaultVariant) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "defaultVariant must not be empty",
    );
  }
  if (defaultVariant && !names.has(defaultVariant.toLowerCase())) {
    throw new ReasoningProfileError(
      "invalid-profile",
      `defaultVariant ${defaultVariant} is not advertised`,
    );
  }

  return {
    tuple,
    profileVersion: record.profileVersion.trim(),
    observedAt: record.observedAt.trim(),
    control: cloneControl(control),
    variants,
    source: record.source as ProviderReasoningProfileSource,
    ...(record.stale === true ? { stale: true } : {}),
    ...(defaultVariant ? { defaultVariant } : {}),
  };
}

/** Validate and normalize a tuple-free exact-model user profile definition. */
export function normalizeUserReasoningProfileOverride(
  input: unknown,
): UserReasoningProfileOverride {
  const record = asRecord(input);
  if (!record) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "user reasoning profile must be an object",
    );
  }
  if (record.tuple !== undefined || record.source !== undefined) {
    throw new ReasoningProfileError(
      "invalid-profile",
      "user reasoning profile tuple and source come from its exact-model config scope",
    );
  }
  const validationTuple: ProviderEndpointTupleInput = {
    appType: "user-profile-validation",
    providerId: "user-profile-validation",
    api: "openai-responses",
    baseUrl: "https://validation.invalid/v1",
    modelId: "user-profile-validation",
  };
  const normalized = normalizeProfile(
    {
      ...record,
      tuple: validationTuple,
      source: "user",
    } as unknown as ProviderReasoningProfile,
    providerEndpointTupleKey(validationTuple),
  );
  const {
    tuple: _tuple,
    source: _source,
    ...override
  } = normalized;
  return override;
}

function validateRuntime(runtime: PiThinkingRuntimeCapability): void {
  const record = asRecord(runtime);
  if (!record) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime capability must be an object",
    );
  }
  if (typeof record.version !== "string" || !record.version.trim()) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime version must be a non-empty string",
    );
  }
  if (typeof record.payloadVerified !== "boolean") {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime payloadVerified must be a boolean",
    );
  }
  if (typeof record.runtimeVerified !== "boolean") {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime runtimeVerified must be a boolean",
    );
  }
  if (record.payloadVerified === true && record.runtimeVerified !== true) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime payloadVerified requires runtimeVerified",
    );
  }
  if (!Array.isArray(record.supportedControls)) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime supportedControls must be an array",
    );
  }
  for (const control of record.supportedControls) {
    if (
      typeof control !== "string" ||
      !REASONING_CONTROL_TYPES.has(control as ReasoningControlType)
    ) {
      throw new ReasoningProfileError(
        "invalid-runtime",
        `runtime supportedControls contains unsupported value ${String(control)}`,
      );
    }
  }
  if (
    new Set(record.supportedControls).size !== record.supportedControls.length
  ) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime supportedControls contains duplicates",
    );
  }
  if (
    typeof record.providerDefault !== "string" ||
    !RUNTIME_PROVIDER_DEFAULTS.has(
      record.providerDefault as PiThinkingRuntimeCapability["providerDefault"],
    )
  ) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime providerDefault is invalid",
    );
  }
  if (
    typeof record.off !== "string" ||
    !RUNTIME_OFF_VALUES.has(record.off as PiThinkingRuntimeCapability["off"])
  ) {
    throw new ReasoningProfileError(
      "invalid-runtime",
      "runtime off capability is invalid",
    );
  }
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function unsupportedProjection(
  intent: ThinkingLevel,
  reason: string,
): ThinkingIntentProjection {
  return { intent, status: "unsupported", reason };
}

function providerDefaultProjection(
  runtime: PiThinkingRuntimeCapability,
  profile: NormalizedProfile | undefined,
): ThinkingIntentProjection {
  if (runtime.providerDefault === "supported") {
    const advertisedDefault = profile?.defaultVariant
      ? profile.variants.find(
          (variant) =>
            variant.name.toLowerCase() === profile.defaultVariant?.toLowerCase(),
        )
      : undefined;
    return {
      intent: "provider-default",
      status: "provider-default",
      ...(advertisedDefault
        ? {
            native: cloneNative(advertisedDefault.native),
            ...(advertisedDefault.effectiveLevel
              ? { effectiveLevel: advertisedDefault.effectiveLevel }
              : {}),
            source: profile?.source,
          }
        : {}),
    };
  }
  return {
    intent: "provider-default",
    status: "unsupported",
    reason: "installed adapter cannot preserve provider-default by omission",
  };
}

function baseProfileProjection(
  level: ThinkingLevel,
  variant: NormalizedVariant | undefined,
  profile: NormalizedProfile,
  runtime: PiThinkingRuntimeCapability,
  controlSupported: boolean,
): ThinkingIntentProjection {
  if (!variant) {
    return unsupportedProjection(level, `profile does not advertise ${level}`);
  }
  const common = {
    intent: level,
    native: cloneNative(variant.native),
    ...(variant.effectiveLevel ? { effectiveLevel: variant.effectiveLevel } : {}),
    source: profile.source,
  } as const;

  if (runtime.runtimeVerified && !controlSupported) {
    return {
      ...common,
      status: "unsupported",
      reason: `Pi ${runtime.version} does not support ${profile.control.type} control for this tuple`,
    };
  }
  if (!runtime.payloadVerified) {
    return {
      ...common,
      status: "unverified",
      reason: `Pi ${runtime.version} has no passing payload fixture for this tuple`,
    };
  }
  if (!controlSupported) {
    return {
      ...common,
      status: "unsupported",
      reason: `Pi ${runtime.version} does not support ${profile.control.type} control for this tuple`,
    };
  }
  if (level === "off" && runtime.off !== "supported") {
    return {
      ...common,
      status: "unsupported",
      reason:
        runtime.off === "indistinguishable-from-provider-default"
          ? "off is indistinguishable from provider-default in this adapter"
          : "installed adapter has no verified explicit off representation",
    };
  }

  const lossy =
    ((profile.control.type === "budget_tokens" ||
      budgetControlFor(profile.control) !== undefined) &&
      !(level === "off" && isBudgetOffSentinel(variant.native))) ||
    variant.effectiveLevel !== level;
  return { ...common, status: lossy ? "lossy" : "exact" };
}

function userProjection(
  level: ThinkingLevel,
  value: string | null,
  scope: UserThinkingMapScope,
  profile: NormalizedProfile | undefined,
  runtime: PiThinkingRuntimeCapability,
  controlSupported: boolean,
  warnings: string[],
): ThinkingIntentProjection {
  if (value === null) {
    return {
      intent: level,
      status: "unsupported",
      source: "user-map",
      reason: "user map explicitly marks this level unsupported",
    };
  }

  const advertised = profile?.variants.find(
    (variant) => nativeReasoningEffort(variant.native) === value,
  );
  const exactScope = scope === "exact-model";
  if (!exactScope) {
    addWarning(
      warnings,
      `user thinking map scope ${scope} is not exact-model and remains unverified`,
    );
  }
  if (!advertised) {
    addWarning(
      warnings,
      `user thinking map ${level}=${value} is not advertised by the exact profile`,
    );
  }
  if (!exactScope || !advertised || !profile) {
    return {
      intent: level,
      native: effortNative(value),
      status: "unverified",
      source: "user-map",
      scope,
      reason: "raw user map is retained as a compatibility escape hatch",
    };
  }

  const projected = baseProfileProjection(
    level,
    advertised,
    profile,
    runtime,
    controlSupported,
  );
  const status =
    projected.status === "exact" && advertised.piLevel !== level
      ? "lossy"
      : projected.status;
  return {
    ...projected,
    status,
    source: "user-map",
    scope,
  };
}

function effortNative(value: string): NativeReasoningValue {
  return { type: "effort", value };
}

/**
 * Encode structured native controls into Pi's closed map as a support mask.
 * The string is not treated as the provider contract for budget/toggle
 * adapters; those adapters consume the selected Pi level and emit the native
 * structure already recorded on the projection.
 */
function profileMapValue(
  level: ThinkingLevel,
  variant: NormalizedVariant | undefined,
  projection: ThinkingIntentProjection,
): string | null {
  if (
    !variant ||
    (projection.status !== "exact" && projection.status !== "lossy")
  ) {
    return null;
  }
  const effort = nativeReasoningEffort(variant.native);
  if (effort !== undefined) return effort;

  if (variant.native.type === "budget_tokens") {
    return level === "off" && variant.native.tokens === 0 ? "off" : level;
  }
  const toggle =
    variant.native.type === "toggle"
      ? variant.native
      : variant.native.type === "composite"
        ? variant.native.values.find((value) => value.type === "toggle")
        : undefined;
  if (!toggle || toggle.type !== "toggle") return null;
  if (!toggle.enabled) return level === "off" ? "off" : null;
  return level;
}

function builtInProjection(
  level: ThinkingLevel,
  value: string | null,
): ThinkingIntentProjection {
  if (value === null) {
    return {
      intent: level,
      status: "unsupported",
      source: "built-in-map",
      reason: "built-in map marks this level unsupported",
    };
  }
  return {
    intent: level,
    native: effortNative(value),
    status: "unverified",
    source: "built-in-map",
    reason: "built-in map has no exact profile authority",
  };
}

function collectCollisions(
  projections: ThinkingIntentProjection[],
): ThinkingProjectionCollision[] {
  const groups = new Map<ThinkingLevel, ThinkingIntentProjection[]>();
  for (const item of projections) {
    if (item.intent === "provider-default" || !item.effectiveLevel || !item.native) {
      continue;
    }
    if (item.status === "unsupported") continue;
    const group = groups.get(item.effectiveLevel) ?? [];
    group.push(item);
    groups.set(item.effectiveLevel, group);
  }

  const collisions: ThinkingProjectionCollision[] = [];
  for (const [effectiveLevel, group] of groups) {
    const intents = group.map((item) => item.intent as ThinkingLevel);
    if (new Set(intents).size < 2) continue;
    for (const item of group) {
      if (item.status === "exact") item.status = "lossy";
    }
    collisions.push({
      effectiveLevel,
      intents,
      providerValues: [
        ...new Set(group.map((item) => providerValueLabel(item.native as NativeReasoningValue))),
      ],
    });
  }
  return collisions;
}

function decisionStatus(input: {
  profile?: NormalizedProfile;
  map?: ThinkingLevelMap;
  projections: ThinkingIntentProjection[];
  stale: boolean;
}): ThinkingProjectionDecisionStatus {
  if (!input.profile && !input.map) return "none";
  const explicit = input.projections.filter(
    (item) => item.intent !== "provider-default",
  );
  if (input.stale || explicit.some((item) => item.status === "unverified")) {
    return "unverified";
  }
  if (explicit.some((item) => item.status === "lossy")) return "lossy";
  if (explicit.some((item) => item.status === "exact")) return "exact";
  if (input.profile && input.profile.variants.length > 0) return "unsupported";
  const defaultResult = input.projections.find(
    (item) => item.intent === "provider-default",
  );
  return defaultResult?.status === "provider-default"
    ? "provider-default"
    : "unsupported";
}

export function resolveThinkingProjection(
  input: ThinkingProjectionInput,
): ThinkingProjectionDecision {
  validateRuntime(input.runtime);
  const tuple = canonicalProviderEndpointTuple(input.tuple);
  const tupleKey = providerEndpointTupleKey(tuple);
  const profile = input.profile
    ? normalizeProfile(input.profile, tupleKey)
    : undefined;
  const warnings: string[] = [];
  const controlSupported = profile
    ? input.runtime.supportedControls.includes(profile.control.type)
    : false;
  const automaticProfile = Boolean(
    profile && input.runtime.payloadVerified && controlSupported,
  );

  if (profile?.stale) {
    addWarning(
      warnings,
      `reasoning profile ${profile.profileVersion} is stale last-good evidence`,
    );
  }
  if (profile && !input.runtime.payloadVerified) {
    addWarning(
      warnings,
      `Pi ${input.runtime.version} has no passing payload fixture for this tuple`,
    );
  } else if (profile && !controlSupported) {
    addWarning(
      warnings,
      `Pi ${input.runtime.version} does not support ${profile.control.type} control for this tuple`,
    );
  }
  if (profile && input.runtime.providerDefault === "unsupported") {
    addWarning(
      warnings,
      "installed adapter cannot preserve provider-default by omission",
    );
  }

  const variantsByLevel = new Map<ThinkingLevel, NormalizedVariant>();
  for (const variant of profile?.variants ?? []) {
    if (variant.piLevel) variantsByLevel.set(variant.piLevel, variant);
  }

  const baseByLevel = new Map<ThinkingLevel, ThinkingIntentProjection>();
  for (const level of THINKING_LEVELS) {
    baseByLevel.set(
      level,
      profile
        ? baseProfileProjection(
            level,
            variantsByLevel.get(level),
            profile,
            input.runtime,
            controlSupported,
          )
        : unsupportedProjection(level, "no exact provider reasoning profile"),
    );
  }

  const layers = new Map<ThinkingLevel, MapLayer>();
  const builtInMap = cleanThinkingLevelMap(input.builtInMap);
  if (builtInMap) {
    for (const level of THINKING_LEVELS) {
      if (Object.prototype.hasOwnProperty.call(builtInMap, level)) {
        layers.set(level, {
          value: builtInMap[level] as string | null,
          source: "built-in-map",
        });
      }
    }
  }

  if (profile && automaticProfile) {
    for (const level of THINKING_LEVELS) {
      const variant = variantsByLevel.get(level);
      const base = baseByLevel.get(level) as ThinkingIntentProjection;
      layers.set(level, {
        value: profileMapValue(level, variant, base),
        source: "profile",
      });
    }
  }

  const userMap = cleanThinkingLevelMap(input.userMap);
  if (userMap) {
    for (const level of THINKING_LEVELS) {
      if (Object.prototype.hasOwnProperty.call(userMap, level)) {
        layers.set(level, {
          value: userMap[level] as string | null,
          source: "user-map",
        });
      }
    }
  }

  const projections: ThinkingIntentProjection[] = [
    providerDefaultProjection(input.runtime, profile),
  ];
  for (const level of THINKING_LEVELS) {
    const layer = layers.get(level);
    if (!layer) {
      projections.push(baseByLevel.get(level) as ThinkingIntentProjection);
      continue;
    }
    if (layer.source === "profile") {
      projections.push(baseByLevel.get(level) as ThinkingIntentProjection);
      continue;
    }
    if (layer.source === "user-map") {
      projections.push(
        userProjection(
          level,
          layer.value,
          input.userMapScopes?.[level] ?? input.userMapScope,
          profile,
          input.runtime,
          controlSupported,
          warnings,
        ),
      );
      continue;
    }
    projections.push(builtInProjection(level, layer.value));
  }

  if (projections.some((item) => item.source === "built-in-map")) {
    addWarning(
      warnings,
      "built-in thinking map remains active without exact profile authority",
    );
  }
  const offProjection = projections.find((item) => item.intent === "off");
  if (
    profile &&
    variantsByLevel.has("off") &&
    offProjection?.status === "unsupported"
  ) {
    addWarning(warnings, offProjection.reason ?? "explicit off is unsupported");
  }

  const collisions = collectCollisions(projections);
  const map: ThinkingLevelMap | undefined =
    layers.size > 0
      ? Object.fromEntries(
          THINKING_LEVELS.flatMap((level) => {
            const layer = layers.get(level);
            return layer ? [[level, layer.value] as const] : [];
          }),
        )
      : undefined;

  const advertised = (profile?.variants ?? []).map((variant) =>
    cloneNative(variant.native),
  );
  const representedKeys = new Set(
    projections
      .filter((item) =>
        item.native && (item.status === "exact" || item.status === "lossy"),
      )
      .map((item) => nativeValueKey(item.native as NativeReasoningValue)),
  );
  const unrepresented = advertised.filter(
    (value) => !representedKeys.has(nativeValueKey(value)),
  );
  const stale = profile?.stale === true;

  return {
    tuple,
    tupleKey,
    ...(profile ? { profileVersion: profile.profileVersion } : {}),
    ...(profile ? { control: cloneControl(profile.control) } : {}),
    ...(map ? { map } : {}),
    advertised,
    unrepresented,
    projections,
    collisions,
    ...(profile ? { source: profile.source, observedAt: profile.observedAt } : {}),
    stale,
    status: decisionStatus({ profile, map, projections, stale }),
    runtime: {
      ...input.runtime,
      supportedControls: [...input.runtime.supportedControls],
    },
    warnings,
  };
}
