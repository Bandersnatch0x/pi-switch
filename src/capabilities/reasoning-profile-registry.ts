/**
 * Provider reasoning profile registry.
 *
 * Owns optional Codex catalog ingestion and reviewed built-in profiles. The
 * exported resolver always materializes a complete provider endpoint tuple;
 * callers never key reasoning facts by model id alone.
 */

import type { CcProvider, PiApi, ThinkingLevel } from "../types.ts";
import { isThinkingLevel } from "../types.ts";
import type {
  NativeAtomicReasoningValue,
  ProviderReasoningCatalog,
  ProviderReasoningCatalogModel,
  ProviderReasoningProfile,
  ProviderReasoningVariant,
  ReasoningControl,
  UserReasoningProfileOverride,
} from "./thinking-projection.ts";

export interface CodexReasoningCatalogParseResult {
  catalog?: ProviderReasoningCatalog;
  warnings: string[];
}

const BUILT_IN_OBSERVED_AT = "2026-08-17T00:00:00.000Z";
const BUILT_IN_PROFILE_VERSION = "pi-switch-reviewed-reasoning/v1";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function warning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function parseCatalogVariants(
  raw: unknown,
  modelId: string,
  warnings: string[],
): ProviderReasoningCatalogModel["variants"] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warning(
      warnings,
      `Codex modelCatalog ${modelId}.supported_reasoning_levels must be an array`,
    );
    return undefined;
  }

  const variants: Array<{ value: string; description?: string }> = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const record = asRecord(item);
    const value = trimmedString(record?.effort) ?? trimmedString(item);
    if (!value) {
      warning(
        warnings,
        `Codex modelCatalog ${modelId}.supported_reasoning_levels[${index}] has no effort string`,
      );
      return;
    }
    const folded = value.toLowerCase();
    if (seen.has(folded)) return;
    seen.add(folded);

    const description = trimmedString(record?.description);
    if (record && record.description !== undefined && !description) {
      warning(
        warnings,
        `Codex modelCatalog ${modelId}.supported_reasoning_levels[${index}].description must be a non-empty string`,
      );
    }
    variants.push({ value, ...(description ? { description } : {}) });
  });

  if (!variants.length) {
    warning(
      warnings,
      `Codex modelCatalog ${modelId}.supported_reasoning_levels has no valid efforts`,
    );
    return undefined;
  }
  return variants;
}

/** Parse non-fatal Codex modelCatalog reasoning facts from settings_config. */
export function parseCodexReasoningCatalog(
  config: unknown,
  observedAt: string,
): CodexReasoningCatalogParseResult {
  const warnings: string[] = [];
  const root = asRecord(config);
  if (!root || root.modelCatalog === undefined) return { warnings };

  const rawCatalog = asRecord(root.modelCatalog);
  if (!rawCatalog) {
    return {
      warnings: ["Codex modelCatalog must be an object"],
    };
  }
  if (!Array.isArray(rawCatalog.models)) {
    return {
      warnings: ["Codex modelCatalog.models must be an array"],
    };
  }

  const models: Record<string, ProviderReasoningCatalogModel> = {};
  rawCatalog.models.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      warning(warnings, `Codex modelCatalog.models[${index}] must be an object`);
      return;
    }
    const modelId = trimmedString(record.slug) ?? trimmedString(record.model);
    if (!modelId) {
      warning(
        warnings,
        `Codex modelCatalog.models[${index}] has no slug or legacy model id`,
      );
      return;
    }
    const variants = parseCatalogVariants(
      record.supported_reasoning_levels,
      modelId,
      warnings,
    );
    if (!variants) return;
    if (models[modelId]) {
      warning(warnings, `Codex modelCatalog repeats model ${modelId}; keeping first`);
      return;
    }

    let defaultVariant = trimmedString(record.default_reasoning_level);
    if (
      record.default_reasoning_level !== undefined &&
      !defaultVariant
    ) {
      warning(
        warnings,
        `Codex modelCatalog ${modelId}.default_reasoning_level must be a non-empty string`,
      );
    }
    if (
      defaultVariant &&
      !variants.some(
        (variant) =>
          ("value" in variant ? variant.value : variant.name).toLowerCase() ===
          defaultVariant!.toLowerCase(),
      )
    ) {
      warning(
        warnings,
        `Codex modelCatalog ${modelId}.default_reasoning_level ${defaultVariant} is not advertised`,
      );
      defaultVariant = undefined;
    }

    models[modelId] = {
      control: { type: "effort" },
      variants,
      ...(defaultVariant ? { defaultVariant } : {}),
    };
  });

  if (!Object.keys(models).length) return { warnings };
  return {
    catalog: {
      source: "codex-model-catalog",
      observedAt,
      models,
    },
    warnings,
  };
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function tupleFor(
  provider: Pick<CcProvider, "appType" | "id" | "api" | "baseUrl">,
  modelId: string,
): ProviderReasoningProfile["tuple"] | undefined {
  if (!provider.api) return undefined;
  return {
    appType: provider.appType,
    providerId: provider.id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    modelId,
  };
}

function effortVariant(
  name: string,
  value = name,
  effectiveLevel?: ThinkingLevel,
  description?: string,
): ProviderReasoningVariant {
  const piLevel = isThinkingLevel(name) ? name : undefined;
  return {
    name,
    native: { type: "effort", value },
    ...(piLevel ? { piLevel } : {}),
    ...(effectiveLevel
      ? { effectiveLevel }
      : piLevel
        ? { effectiveLevel: piLevel }
        : {}),
    ...(description ? { description } : {}),
  };
}

function budgetVariant(
  level: Exclude<ThinkingLevel, "off">,
  tokens: number,
  effectiveLevel: ThinkingLevel = level,
): ProviderReasoningVariant {
  return {
    name: level,
    piLevel: level,
    native: { type: "budget_tokens", tokens },
    effectiveLevel,
  };
}

function budgetOffVariant(): ProviderReasoningVariant {
  return {
    name: "off",
    piLevel: "off",
    native: { type: "budget_tokens", tokens: 0 },
    effectiveLevel: "off",
  };
}

function compositeVariant(
  level: ThinkingLevel,
  values: NativeAtomicReasoningValue[],
  effectiveLevel: ThinkingLevel,
): ProviderReasoningVariant {
  return {
    name: level,
    piLevel: level,
    native: { type: "composite", values },
    effectiveLevel,
  };
}

function builtInProfile(
  provider: CcProvider,
  modelId: string,
  control: ReasoningControl,
  variants: ProviderReasoningVariant[],
  suffix: string,
): ProviderReasoningProfile | undefined {
  const tuple = tupleFor(provider, modelId);
  if (!tuple) return undefined;
  return {
    tuple,
    profileVersion: `${BUILT_IN_PROFILE_VERSION}/${suffix}`,
    control,
    variants,
    source: "built-in",
    observedAt: BUILT_IN_OBSERVED_AT,
  };
}

function catalogProfile(
  provider: CcProvider,
  modelId: string,
): ProviderReasoningProfile | undefined {
  const catalog = provider.reasoningCatalog;
  const model = catalog?.models[modelId];
  const tuple = tupleFor(provider, modelId);
  if (!catalog || !model || !tuple) return undefined;
  const variants = model.variants.map((variant) =>
    "native" in variant
      ? variant
      : effortVariant(
          variant.value,
          variant.value,
          undefined,
          variant.description,
        ),
  );
  return {
    tuple,
    profileVersion: `${catalog.source}/v1/${stableHash(model)}`,
    control: model.control,
    variants,
    ...(model.defaultVariant ? { defaultVariant: model.defaultVariant } : {}),
    source: catalog.source,
    observedAt: catalog.observedAt,
    ...(catalog.stale ? { stale: true } : {}),
  };
}

function userProfile(
  provider: CcProvider,
  modelId: string,
  override: UserReasoningProfileOverride | undefined,
): ProviderReasoningProfile | undefined {
  const tuple = tupleFor(provider, modelId);
  if (!override || !tuple) return undefined;
  return {
    tuple,
    profileVersion: override.profileVersion,
    control: override.control,
    variants: override.variants,
    ...(override.defaultVariant
      ? { defaultVariant: override.defaultVariant }
      : {}),
    source: "user",
    observedAt: override.observedAt,
    ...(override.stale ? { stale: true } : {}),
  };
}

function reviewedBuiltInProfile(
  provider: CcProvider,
  modelId: string,
): ProviderReasoningProfile | undefined {
  const id = modelId.toLowerCase();
  const api: PiApi | null = provider.api;

  if (api === "anthropic-messages" && /^claude-3[.-]7(?:[.-]|$)/.test(id)) {
    return builtInProfile(
      provider,
      modelId,
      { type: "budget_tokens", minTokens: 1024 },
      [
        budgetVariant("minimal", 1024),
        budgetVariant("low", 2048),
        budgetVariant("medium", 8192),
        budgetVariant("high", 16_384),
        budgetVariant("xhigh", 16_384, "high"),
        budgetVariant("max", 16_384, "high"),
      ],
      "anthropic-manual",
    );
  }

  if (
    api === "anthropic-messages" &&
    /^claude-(?:opus|sonnet|fable)-(?:4[.-][5-9]|[5-9])(?:[.-]|$)/.test(id)
  ) {
    return builtInProfile(
      provider,
      modelId,
      { type: "effort" },
      ["low", "medium", "high", "xhigh", "max"].map((level) =>
        effortVariant(level),
      ),
      "anthropic-adaptive",
    );
  }

  if (
    api === "openai-completions" &&
    /^deepseek-(?:r1|reasoner)(?:[-.]|$)/.test(id)
  ) {
    return builtInProfile(
      provider,
      modelId,
      { type: "fixed", enabled: true },
      [],
      "deepseek-fixed",
    );
  }

  if (api === "openai-completions" && /^deepseek-v4(?:[-.]|$)/.test(id)) {
    const on = (effort: string): NativeAtomicReasoningValue[] => [
      { type: "toggle", enabled: true },
      { type: "effort", value: effort },
    ];
    return builtInProfile(
      provider,
      modelId,
      { type: "composite", controls: [{ type: "toggle" }, { type: "effort" }] },
      [
        compositeVariant("off", [{ type: "toggle", enabled: false }], "off"),
        compositeVariant("low", on("low"), "low"),
        compositeVariant("medium", on("high"), "high"),
        compositeVariant("high", on("high"), "high"),
        compositeVariant("xhigh", on("high"), "high"),
        compositeVariant("max", on("max"), "max"),
      ],
      "deepseek-v4",
    );
  }

  if (api === "openai-completions" && /^glm-5[.-]2(?:[-.]|$)/.test(id)) {
    const on = (effort: string): NativeAtomicReasoningValue[] => [
      { type: "toggle", enabled: true },
      { type: "effort", value: effort },
    ];
    return builtInProfile(
      provider,
      modelId,
      { type: "composite", controls: [{ type: "toggle" }, { type: "effort" }] },
      [
        compositeVariant("off", [{ type: "toggle", enabled: false }], "off"),
        // Z.AI accepts a native minimal effort, but documents it as the same
        // effective reasoning outcome as off. Preserve the wire value so Pi
        // can send it, and retain the semantic collision for diagnostics.
        compositeVariant("minimal", on("minimal"), "off"),
        compositeVariant("low", on("low"), "high"),
        compositeVariant("medium", on("medium"), "high"),
        compositeVariant("high", on("high"), "high"),
        compositeVariant("xhigh", on("xhigh"), "max"),
        compositeVariant("max", on("max"), "max"),
      ],
      "glm-5.2",
    );
  }

  if (api === "openai-completions" && /^glm(?:[-.]|$)/.test(id)) {
    return builtInProfile(
      provider,
      modelId,
      { type: "toggle" },
      [
        {
          name: "off",
          piLevel: "off",
          native: { type: "toggle", enabled: false },
          effectiveLevel: "off",
        },
        {
          name: "high",
          piLevel: "high",
          native: { type: "toggle", enabled: true },
          effectiveLevel: "high",
        },
      ],
      "glm-toggle",
    );
  }

  if (api === "google-generative-ai" && /^gemini-2[.-]5-pro(?:[-.]|$)/.test(id)) {
    return builtInProfile(
      provider,
      modelId,
      { type: "budget_tokens", minTokens: 128, maxTokensExclusive: 32_769 },
      [
        budgetOffVariant(),
        budgetVariant("minimal", 128),
        budgetVariant("low", 2048),
        budgetVariant("medium", 8192),
        budgetVariant("high", 32_768),
      ],
      "gemini-2.5-pro",
    );
  }

  if (
    api === "google-generative-ai" &&
    /^gemini-2[.-]5-flash-lite(?:[-.]|$)/.test(id)
  ) {
    return builtInProfile(
      provider,
      modelId,
      { type: "budget_tokens", minTokens: 512, maxTokensExclusive: 24_577 },
      [
        budgetOffVariant(),
        budgetVariant("minimal", 512),
        budgetVariant("low", 2048),
        budgetVariant("medium", 8192),
        budgetVariant("high", 24_576),
      ],
      "gemini-2.5-flash-lite",
    );
  }

  if (
    api === "google-generative-ai" &&
    /^gemini-2[.-]5-flash(?:[-.]|$)/.test(id)
  ) {
    return builtInProfile(
      provider,
      modelId,
      { type: "budget_tokens", minTokens: 128, maxTokensExclusive: 24_577 },
      [
        budgetOffVariant(),
        budgetVariant("minimal", 128),
        budgetVariant("low", 2048),
        budgetVariant("medium", 8192),
        budgetVariant("high", 24_576),
      ],
      "gemini-2.5-flash",
    );
  }

  if (
    api === "google-generative-ai" &&
    /^gemini-3(?:[.-]\d+)?-pro(?:[-.]|$)/.test(id)
  ) {
    return builtInProfile(
      provider,
      modelId,
      { type: "effort" },
      [
        effortVariant("minimal", "LOW", "low"),
        effortVariant("low", "LOW", "low"),
        effortVariant("medium", "HIGH", "high"),
        effortVariant("high", "HIGH", "high"),
      ],
      "gemini-3-pro",
    );
  }

  if (
    api === "google-generative-ai" &&
    (/^gemini-3(?:[.-]\d+)?-flash(?:[-.]|$)/.test(id) ||
      id === "gemini-flash-latest" ||
      id === "gemini-flash-lite-latest")
  ) {
    return builtInProfile(
      provider,
      modelId,
      { type: "effort" },
      [
        effortVariant("minimal", "MINIMAL"),
        effortVariant("low", "LOW"),
        effortVariant("medium", "MEDIUM"),
        effortVariant("high", "HIGH"),
      ],
      "gemini-3-flash",
    );
  }

  return undefined;
}

/** Resolve exact user, snapshot metadata/catalog, then reviewed built-ins. */
export function resolveProviderReasoningProfile(
  provider: CcProvider,
  modelId: string,
  userOverride?: UserReasoningProfileOverride,
): ProviderReasoningProfile | undefined {
  const exactModelId = modelId.trim();
  if (!exactModelId || !provider.api) return undefined;
  return (
    userProfile(provider, exactModelId, userOverride) ??
    catalogProfile(provider, exactModelId) ??
    reviewedBuiltInProfile(provider, exactModelId)
  );
}
