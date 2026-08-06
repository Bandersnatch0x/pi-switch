import type { BuiltProviderConfig } from "./register.ts";
import type { ResolvedProviderWireCompat } from "./provider-wire-compat.ts";
import type { CcProvider, FingerprintPreset } from "./types.ts";

const SENSITIVE_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

export type EffectiveConfigSource = "active" | "saved";

export type EffectiveProviderWireCompatSummary = {
  api: ResolvedProviderWireCompat["api"];
  scope: "provider";
  source: ResolvedProviderWireCompat["source"];
  /** Chat (#62). */
  supportsStore?: boolean;
  /** Anthropic (#65). */
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsLongCacheRetention?: boolean;
};

export type EffectiveConfigSummary = {
  source: EffectiveConfigSource;
  providerId: string;
  providerName: string;
  piName: string;
  appType: string;
  modelId: string;
  api: string;
  endpoint: string;
  apiKeyMode: "missing" | "literal" | "environment" | "command";
  authHeader: boolean;
  fingerprint: FingerprintPreset | "default";
  headerNames: string[];
  model: {
    reasoning: boolean;
    input: ("text" | "image")[];
    contextWindow: number;
    maxTokens: number;
    thinkingFormat?: string;
    thinkingLevelMap?: Record<string, string | null>;
    requiresReasoningContentOnAssistantMessages?: boolean;
    /**
     * When reasoning was unknown and runtime used conservative false (issue #63).
     * Display-only; never written back to config/cache.
     */
    reasoningProvenance?: "resolved" | "unknown→conservative false";
  };
  providerWireCompat?: EffectiveProviderWireCompatSummary;
};

function redactEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? raw;
  }
}

function apiKeyMode(apiKey: string): EffectiveConfigSummary["apiKeyMode"] {
  const value = apiKey.trim();
  if (!value) return "missing";
  if (value.startsWith("!")) return "command";
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) {
    return "environment";
  }
  return "literal";
}

function safeHeaderNames(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {})
    .filter((name) => !SENSITIVE_HEADER_NAMES.has(name.toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
}

/** Build a redacted, display-ready view of the config that registration would use. */
export function createEffectiveConfigSummary(input: {
  source: EffectiveConfigSource;
  provider: CcProvider;
  modelId: string;
  config: BuiltProviderConfig;
  fingerprint?: FingerprintPreset;
  providerWireCompat?: ResolvedProviderWireCompat;
  /** When true, reasoning was derived as unknown→conservative false (issue #63). */
  reasoningConservative?: boolean;
}): EffectiveConfigSummary {
  const model =
    input.config.models.find((candidate) => candidate.id === input.modelId) ??
    input.config.models[0];
  if (!model) throw new Error(`no effective model config for ${input.modelId}`);

  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as {
          thinkingFormat?: string;
          requiresReasoningContentOnAssistantMessages?: boolean;
        })
      : undefined;

  let providerWireCompat: EffectiveProviderWireCompatSummary | undefined;
  if (input.providerWireCompat) {
    const wire = input.providerWireCompat;
    if (wire.api === "openai-completions") {
      providerWireCompat = {
        api: wire.api,
        supportsStore: wire.value,
        scope: wire.scope,
        source: wire.source,
      };
    } else {
      providerWireCompat = {
        api: wire.api,
        scope: wire.scope,
        source: wire.source,
        supportsEagerToolInputStreaming:
          wire.fields.supportsEagerToolInputStreaming.value,
        supportsCacheControlOnTools: wire.fields.supportsCacheControlOnTools.value,
        supportsLongCacheRetention: wire.fields.supportsLongCacheRetention.value,
      };
    }
  }

  return {
    source: input.source,
    providerId: input.provider.id,
    providerName: input.provider.displayName,
    piName: input.provider.piName,
    appType: input.provider.appType,
    modelId: model.id,
    api: input.config.api,
    endpoint: redactEndpoint(input.config.baseUrl),
    apiKeyMode: apiKeyMode(input.config.apiKey),
    authHeader: input.config.authHeader,
    fingerprint: input.fingerprint ?? "default",
    headerNames: safeHeaderNames(input.config.headers),
    model: {
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(compat?.thinkingFormat ? { thinkingFormat: compat.thinkingFormat } : {}),
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      ...(typeof compat?.requiresReasoningContentOnAssistantMessages === "boolean"
        ? {
            requiresReasoningContentOnAssistantMessages:
              compat.requiresReasoningContentOnAssistantMessages,
          }
        : {}),
      ...(input.reasoningConservative
        ? { reasoningProvenance: "unknown→conservative false" as const }
        : { reasoningProvenance: "resolved" as const }),
    },
    ...(providerWireCompat ? { providerWireCompat } : {}),
  };
}

export function formatEffectiveConfigSummary(summary: EffectiveConfigSummary): string {
  const source = summary.source === "active" ? "current session" : "saved selection";
  const headers = summary.headerNames.length ? summary.headerNames.join(", ") : "(none)";
  const thinking = summary.model.thinkingFormat
    ? ` thinkingFormat=${summary.model.thinkingFormat}`
    : "";
  const levelMap = summary.model.thinkingLevelMap
    ? ` thinkingLevelMap=${Object.keys(summary.model.thinkingLevelMap).length}`
    : "";
  const requiresRc =
    typeof summary.model.requiresReasoningContentOnAssistantMessages === "boolean"
      ? ` requiresReasoningContentOnAssistantMessages=${summary.model.requiresReasoningContentOnAssistantMessages}`
      : "";
  const reasoningNote =
    summary.model.reasoningProvenance === "unknown→conservative false"
      ? " (unknown→conservative false)"
      : "";
  const lines = [
    "pi-switch effective config",
    `source: ${source}`,
    `provider: ${summary.providerName} (${summary.appType}) [${summary.piName}]`,
    `model: ${summary.modelId}`,
    `api: ${summary.api}`,
    `endpoint: ${summary.endpoint}`,
    `auth: apiKey=${summary.apiKeyMode} authHeader=${summary.authHeader}`,
    `fingerprint: ${summary.fingerprint}`,
    `headers: ${headers}`,
    `modelMeta: reasoning=${summary.model.reasoning}${reasoningNote} input=${summary.model.input.join(",")} contextWindow=${summary.model.contextWindow} maxTokens=${summary.model.maxTokens}${thinking}${levelMap}${requiresRc}`,
  ];
  if (summary.providerWireCompat) {
    const wire = summary.providerWireCompat;
    if (wire.api === "openai-completions") {
      lines.push(
        `providerWireCompat: supportsStore=${wire.supportsStore} scope=${wire.scope} source=${wire.source}`,
      );
    } else {
      lines.push(
        `providerWireCompat: eager=${wire.supportsEagerToolInputStreaming} cacheOnTools=${wire.supportsCacheControlOnTools} longRetention=${wire.supportsLongCacheRetention} scope=${wire.scope} source=${wire.source}`,
      );
    }
  }
  return lines.join("\n");
}
