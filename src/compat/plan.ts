import {
  applyClaudeCodeCompatHeaders,
  applyClaudeCodeCompatToPayload,
  type ClaudeCodeCompatConfig,
} from "./claude-code.ts";
import {
  applyGeminiToolCompatToPayload,
  isGeminiPayload,
  type GeminiToolCompatConfig,
} from "./gemini-tool-compat.ts";
import { fingerprintHeaderTemplates } from "../headers/fingerprints.ts";
import type { ProbeTarget } from "../probe/types.ts";

/**
 * The request-scoped facts needed to apply compatibility.
 *
 * A plan is deliberately not a provider/config snapshot: it contains only
 * effective, non-secret facts for one target and one request. In particular,
 * credentials, auth headers, device ids, payloads, and the source config never
 * cross this seam.
 */
export interface CompatibilityPlan {
  readonly target: Readonly<Pick<ProbeTarget, "provider" | "modelId">>;
  readonly api: string | null | undefined;
  readonly fingerprint?: Readonly<{
    preset: NonNullable<ProbeTarget["fingerprint"]>;
    headers: Readonly<Record<string, string>>;
  }>;
  readonly claude?: Readonly<{
    applyHeaders: boolean;
    systemPrefix: string | null;
    injectMetadata: boolean;
    injectSystemPrefix: boolean;
    injectToolFingerprint: boolean;
  }>;
  readonly gemini?: Readonly<{
    forceToolConfigMode: "AUTO" | "VALIDATED" | undefined;
    convertSchema: boolean;
  }>;
}

export interface BuildCompatibilityPlanInput {
  target: ProbeTarget;
  api: string | null | undefined;
  /** Already-resolved, non-secret fingerprint variables. */
  headerVars?: Record<string, string>;
  /**
   * Complete, already-resolved non-secret Claude application settings.
   * Required for an anthropic target with claudeCodeCompat enabled. Device id
   * remains an application-time input and must not cross into the plan.
   */
  claudeCompat?: {
    config: ClaudeCodeCompatConfig;
    systemPrefix: string | null;
  };
  geminiCompat?: GeminiToolCompatConfig;
}

/** Headers and payload are applied together, while secrets remain inputs. */
export interface ApplyCompatibilityPlanInput {
  plan: CompatibilityPlan;
  headers?: Record<string, string | null | undefined>;
  payload: unknown;
  /** Kept outside the plan because it is a stable user/device identifier. */
  claudeDeviceId?: string;
}

export interface AppliedCompatibilityPlan {
  headers: Record<string, string | null | undefined>;
  payload: unknown;
}

/**
 * Expand only the fingerprint templates selected for this target.
 * A template with a missing variable is omitted as a whole; no placeholder is
 * ever sent upstream. This is intentionally separate from auth/header maps.
 */
export function expandFingerprintHeaders(
  preset: NonNullable<ProbeTarget["fingerprint"]>,
  vars: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(fingerprintHeaderTemplates(preset))) {
    const refs = Array.from(template.matchAll(/\{(\w+)\}/g), (match) => match[1]);
    if (refs.some((key) => !(key in vars))) continue;
    out[name] = template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
  }
  return out;
}

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function mergeHeadersCaseInsensitive(
  defaults: Readonly<Record<string, string>>,
  input: Record<string, string | null | undefined>,
): Record<string, string | null | undefined> {
  const out: Record<string, string | null | undefined> = {};
  const keys = new Map<string, string>();

  const add = (name: string, value: string | null | undefined): void => {
    const folded = name.toLowerCase();
    const previous = keys.get(folded);
    if (previous !== undefined) delete out[previous];
    keys.set(folded, name);
    out[name] = value;
  };

  for (const [name, value] of Object.entries(defaults)) add(name, value);
  // Auth/provider headers are request inputs and deliberately override the
  // fingerprint defaults, regardless of header-name casing.
  for (const [name, value] of Object.entries(input)) add(name, value);
  return out;
}

/** Freeze a plan deeply enough that request-local facts cannot drift. */
function freezePlan(plan: CompatibilityPlan): CompatibilityPlan {
  if (plan.fingerprint) {
    Object.freeze(plan.fingerprint.headers);
    Object.freeze(plan.fingerprint);
  }
  if (plan.claude) Object.freeze(plan.claude);
  if (plan.gemini) Object.freeze(plan.gemini);
  Object.freeze(plan.target);
  return Object.freeze(plan);
}

/**
 * Resolve one immutable plan for one Probe request.
 * API gating is performed here, before any application can touch a payload.
 */
export function buildCompatibilityPlan(
  input: BuildCompatibilityPlanInput,
): CompatibilityPlan {
  const target = {
    provider: input.target.provider,
    modelId: input.target.modelId,
  };
  const plan: {
    target: { provider: string; modelId: string };
    api: string | null | undefined;
    fingerprint?: CompatibilityPlan["fingerprint"];
    claude?: CompatibilityPlan["claude"];
    gemini?: CompatibilityPlan["gemini"];
  } = { target, api: input.api };

  if (input.target.fingerprint) {
    plan.fingerprint = {
      preset: input.target.fingerprint,
      headers: freezeRecord(
        expandFingerprintHeaders(input.target.fingerprint, input.headerVars),
      ),
    };
  }

  if (input.target.claudeCodeCompat === true && input.api === "anthropic-messages") {
    const facts = input.claudeCompat;
    if (
      !facts ||
      !facts.config ||
      !("systemPrefix" in facts) ||
      (facts.systemPrefix !== null && typeof facts.systemPrefix !== "string")
    ) {
      throw new Error(
        "Claude Code compatibility requires complete Claude application settings (config and systemPrefix)",
      );
    }
    const { config, systemPrefix } = facts;
    plan.claude = {
      applyHeaders: config.injectHeaders !== false,
      systemPrefix,
      injectMetadata: config.injectMetadata !== false,
      injectSystemPrefix: config.injectSystemPrefix !== false,
      injectToolFingerprint: config.injectToolFingerprint !== false,
    };
  }

  if (input.target.geminiToolCompat === true && input.api === "google-generative-ai") {
    plan.gemini = {
      forceToolConfigMode: input.geminiCompat?.forceToolConfigMode,
      convertSchema: input.geminiCompat?.convertSchema !== false,
    };
  }

  return freezePlan(plan);
}

/**
 * Apply all request-shape compatibility in one place. The caller owns auth and
 * network adapters; this interface never stores or returns those secrets in a
 * plan. Payload transforms remain the existing pure Claude/Gemini transforms.
 */
export function applyCompatibilityPlan(
  input: ApplyCompatibilityPlanInput,
): AppliedCompatibilityPlan {
  const { plan } = input;
  const headers: Record<string, string | null | undefined> =
    mergeHeadersCaseInsensitive(
      plan.fingerprint?.headers ?? {},
      input.headers ?? {},
    );

  if (plan.claude?.applyHeaders) {
    applyClaudeCodeCompatHeaders(headers);
  }

  let payload = input.payload;
  const claude = plan.claude;
  if (claude) {
    const claudeDeviceId = claude.injectMetadata
      ? (() => {
          if (
            typeof input.claudeDeviceId !== "string" ||
            input.claudeDeviceId.trim().length === 0
          ) {
            throw new Error(
              "local compatibility setup requires a non-empty Claude device ID when metadata injection is enabled",
            );
          }
          return input.claudeDeviceId.trim();
        })()
      : "";
    payload = applyClaudeCodeCompatToPayload(payload, {
      deviceId: claudeDeviceId,
      systemPrefix: claude.systemPrefix,
      injectMetadata: claude.injectMetadata,
      injectSystemPrefix: claude.injectSystemPrefix,
      injectToolFingerprint: claude.injectToolFingerprint,
    });
  }
  if (plan.gemini && isGeminiPayload(payload)) {
    payload = applyGeminiToolCompatToPayload(payload, {
      forceToolConfigMode: plan.gemini.forceToolConfigMode,
      convertSchema: plan.gemini.convertSchema,
    });
  }

  return { headers, payload };
}
