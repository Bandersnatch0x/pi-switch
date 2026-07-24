/**
 * CLI fingerprint presets (UA + companion headers).
 *
 * Inspired by CallmeLins/pi-switch disguise table, adapted for in-process
 * Pi registration (no local gateway). Defaults live in defaults/headers.json
 * and match by api; per-provider `fingerprint` can force a preset when the
 * upstream whitelist does not follow the protocol (e.g. OpenAI-compat relay
 * that expects Claude Code UA).
 *
 * `fingerprint: "none"` skips api-matched default rules entirely so only
 * explicit providerOverrides.headers (if any) are sent.
 */
import type { FingerprintPreset } from "../types.ts";

export type { FingerprintPreset };

/** Result of expanding fingerprint + explicit headers for mergeHeaders. */
export interface ResolvedOverrideHeaders {
  headers?: Record<string, string>;
  /**
   * When true, mergeHeaders must not apply defaults/provider-headers rules.
   * Set by fingerprint:"none".
   */
  skipRules?: boolean;
}

/** Expand a fingerprint preset into allowlisted header templates (with {vars}). */
export function fingerprintHeaderTemplates(
  preset: FingerprintPreset,
): Record<string, string> {
  switch (preset) {
    case "claude-code":
      return {
        "User-Agent": "claude-cli/{claudeCodeVersion} (external, cli)",
        "anthropic-version": "{anthropicVersion}",
        "anthropic-beta": "{anthropicBeta}",
      };
    case "codex":
      return {
        "User-Agent": "codex_cli_rs/{codexVersion} ({osInfo}) Terminal",
        originator: "{codexOriginator}",
      };
    case "gemini":
      return {
        "User-Agent": "GeminiCLI/{geminiVersion} ({osInfo})",
        "x-goog-api-client": "gemini-cli/{geminiVersion}",
      };
    case "none":
      // Clear path is skipRules in resolveOverrideHeaders, not an empty template map.
      return {};
    default:
      return {};
  }
}

const PRESETS: readonly FingerprintPreset[] = ["claude-code", "codex", "gemini", "none"];

export function isFingerprintPreset(v: string): v is FingerprintPreset {
  return (PRESETS as readonly string[]).includes(v);
}

/**
 * Resolve effective override headers for a provider:
 *   fingerprint preset templates  <  explicit headers (win)
 *
 * `none` sets skipRules so api-matched default rules are not applied;
 * only explicit headers remain (may be empty → bare provider).
 */
export function resolveOverrideHeaders(input: {
  fingerprint?: FingerprintPreset;
  headers?: Record<string, string>;
}): ResolvedOverrideHeaders {
  const out: Record<string, string> = {};
  const skipRules = input.fingerprint === "none";

  if (input.fingerprint && input.fingerprint !== "none") {
    Object.assign(out, fingerprintHeaderTemplates(input.fingerprint));
  }
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
  }

  const headers = Object.keys(out).length ? out : undefined;
  if (!headers && !skipRules) return {};
  return skipRules ? { headers, skipRules: true } : { headers };
}
