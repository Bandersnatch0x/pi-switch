/**
 * Pi runtime payload-fixture matrix for provider reasoning controls.
 *
 * A profile is allowed to drive registration only when the installed Pi
 * version, API adapter, control shape, and required tuple dialect match a
 * passing fixture. Unknown and older runtimes remain diagnostic-only.
 */

import type {
  PiThinkingRuntimeCapability,
  ProviderReasoningProfile,
  ReasoningControlType,
} from "./thinking-projection.ts";

/**
 * Exact Pi releases whose provider payload fixtures have passed. Keep this
 * list closed: a newer adapter can change wire semantics without changing the
 * public thinking-level types.
 */
export const VERIFIED_PI_THINKING_RUNTIME_VERSIONS = ["0.81.1", "0.84.2"] as const;

const VERIFIED_PI_THINKING_RUNTIME_VERSION_SET = new Set<string>(
  VERIFIED_PI_THINKING_RUNTIME_VERSIONS,
);

export interface PiThinkingRuntimeInput {
  version?: string;
  profile?: ProviderReasoningProfile;
  anthropic?: {
    forceAdaptiveThinking?: boolean;
  };
  chat?: {
    thinkingFormat?: string;
    supportsReasoningEffort?: boolean;
  };
}

function capability(
  version: string,
  payloadVerified: boolean,
  control: ReasoningControlType | undefined,
  providerDefault: PiThinkingRuntimeCapability["providerDefault"] = "supported",
  off: PiThinkingRuntimeCapability["off"] = "unsupported",
): PiThinkingRuntimeCapability {
  return {
    version,
    runtimeVerified: VERIFIED_PI_THINKING_RUNTIME_VERSION_SET.has(version),
    payloadVerified,
    supportedControls: payloadVerified && control ? [control] : [],
    providerDefault,
    off,
  };
}

/** Resolve the exact installed-runtime adapter capability for one profile. */
export function resolvePiThinkingRuntimeCapability(
  input: PiThinkingRuntimeInput,
): PiThinkingRuntimeCapability {
  const version = input.version?.trim() || "unknown";
  const profile = input.profile;
  if (!VERIFIED_PI_THINKING_RUNTIME_VERSION_SET.has(version) || !profile) {
    return capability(version, false, undefined);
  }

  const { api } = profile.tuple;
  const control = profile.control.type;

  if (api === "openai-responses") {
    const verified = control === "effort" || control === "fixed";
    // Adapter semantics belong to the endpoint tuple, not the authority that
    // supplied the profile. An exact user profile must not erase Codex's
    // Simple Responses off/provider-default collision.
    const codexSimpleResponses =
      profile.tuple.appType === "codex" ||
      profile.source === "codex-model-catalog";
    return capability(
      version,
      verified,
      control,
      "supported",
      control === "effort"
        ? codexSimpleResponses
          ? "indistinguishable-from-provider-default"
          : "supported"
        : "unsupported",
    );
  }

  if (api === "anthropic-messages") {
    const adaptive = input.anthropic?.forceAdaptiveThinking === true;
    const verified =
      (control === "effort" && adaptive) ||
      (control === "budget_tokens" && !adaptive) ||
      control === "fixed";
    return capability(
      version,
      verified,
      control,
      "supported",
      "indistinguishable-from-provider-default",
    );
  }

  if (api === "google-generative-ai") {
    const verified =
      control === "effort" ||
      control === "budget_tokens" ||
      control === "fixed";
    return capability(
      version,
      verified,
      control,
      "unsupported",
      control === "budget_tokens" ? "supported" : "unsupported",
    );
  }

  if (api === "openai-completions") {
    const format = input.chat?.thinkingFormat;
    const effort = input.chat?.supportsReasoningEffort === true;
    if (control === "composite") {
      const verified =
        effort && (format === "deepseek" || format === "zai");
      return capability(
        version,
        verified,
        control,
        format === "zai" ? "unsupported" : "supported",
        format === "zai"
          ? "supported"
          : "indistinguishable-from-provider-default",
      );
    }
    if (control === "toggle") {
      const verified =
        format === "deepseek" ||
        format === "zai" ||
        format === "qwen" ||
        format === "together";
      return capability(
        version,
        verified,
        control,
        format === "zai" ? "unsupported" : "supported",
        format === "zai" ? "supported" : "unsupported",
      );
    }
    if (control === "effort") {
      return capability(version, effort, control, "supported", "supported");
    }
    if (control === "fixed") {
      return capability(version, true, control, "supported", "unsupported");
    }
  }

  return capability(version, false, undefined);
}
