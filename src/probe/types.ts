/**
 * Compatibility Probe — shared types (issue #42 / ticket 1 #43).
 *
 * Domain: Probe Target, Probe Contract, Compatibility Probe.
 * Engine is pure: transport is injected; zero network by default.
 */

/** Hard budget for a single probe run. */
export const PROBE_MAX_REQUESTS = 9;
export const PROBE_TIMEOUT_MS = 15_000;
/**
 * Floor budget for every probe request (issue #83).
 *
 * The original 32 starved models that think before answering: they spent the
 * whole budget on thinking and emitted no text or tool call, so the stage was
 * scored as "relay does not support tools" — a false negative. The observed
 * failures included a target that does NOT claim reasoning, so the floor has to
 * cover the unannounced case on its own; the reasoning-claiming budget below is
 * additional headroom, not the fix.
 * ponytail: 256 is the issue's own calibration point, not a derived number —
 * raise it if a quiet thinker still truncates.
 */
export const PROBE_MAX_TOKENS = 256;
/** Extra headroom for targets that do claim reasoning (issue #83). */
export const PROBE_REASONING_MAX_TOKENS = 2048;

/**
 * Output budget for one probe request.
 * Single source of truth so the engine and repair verification cannot drift —
 * verification must pass the ORIGINAL target, since the reasoning-false recipe
 * flips the very flag this keys off.
 */
export function probeMaxTokensFor(
  target: Pick<ProbeTarget, "reasoning">,
  override?: number,
): number {
  if (override !== undefined) return override;
  return target.reasoning ? PROBE_REASONING_MAX_TOKENS : PROBE_MAX_TOKENS;
}

/** Named, isolated, minimal interaction whose expected behavior determines evidence. */
export type ProbeContractId = "basic" | "reasoning" | "tool";

/** Default stage order when contracts are not overridden. */
export const DEFAULT_PROBE_CONTRACTS: readonly ProbeContractId[] = [
  "basic",
  "reasoning",
  "tool",
] as const;

/**
 * Configured Provider + model pair evaluated by a Compatibility Probe.
 * Distinct from Session Model — probing never calls setModel.
 */
export interface ProbeTarget {
  provider: string;
  modelId: string;
  /**
   * Whether the target claims reasoning / thinking support.
   * When false or omitted, the reasoning contract is skipped.
   */
  reasoning?: boolean;
  /**
   * Candidate-only CLI fingerprint preset (Recipe2 in-memory verify).
   * Production transport may apply headers from this; pure engine ignores it.
   */
  fingerprint?: "claude-code" | "codex" | "gemini" | "none";
  /**
   * Candidate-only provider claudeCodeCompat force-on (Recipe2).
   * Pure engine ignores it; production transport wires request-shape compat.
   */
  claudeCodeCompat?: boolean;
  /**
   * Candidate / current provider geminiToolCompat force-on (Recipe3).
   * When true, Recipe3 does not re-propose the same switch (report only).
   * Pure engine ignores it; production transport wires toolConfig injection.
   */
  geminiToolCompat?: boolean;
}

/**
 * Wide failure categories for normalized evidence.
 * Durable evidence never stores prompts, response bodies, secrets, or query strings.
 */
export type ProbeFailureCategory =
  | "auth"
  | "model"
  | "protocol"
  | "streaming"
  | "tool"
  | "client-gate"
  | "unknown";

export type ProbeStageStatus = "pass" | "fail" | "skip" | "stopped";

export type ProbeStoppedReason = "failure" | "unrepairable" | "budget" | "precheck";

/** One stage outcome in a probe run. */
export interface ProbeStageResult {
  contract: ProbeContractId;
  status: ProbeStageStatus;
  category?: ProbeFailureCategory;
  /** True for 401 / 429 / 5xx (and similar hard stops). */
  unrepairable?: boolean;
  httpStatus?: number;
  summary: string;
  requestCount: number;
}

export interface ProbeBudgetSnapshot {
  maxRequests: number;
  used: number;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Target doctor precheck outcome (ticket 3).
 * Kept structurally local so types.ts does not import doctor modules.
 * Shape matches ProbePrecheckResult in precheck.ts.
 */
export interface ProbeRunPrecheckSnapshot {
  status: "pass" | "warn" | "fail";
  allowProbe: boolean;
  checks: Array<{
    id: string;
    dimension: string;
    title: string;
    status: "pass" | "warn" | "fail";
    detail: string;
    fix?: string;
  }>;
  summary: string;
}

/** Structured headless-friendly probe outcome. */
export interface ProbeRunResult {
  target: ProbeTarget;
  stages: ProbeStageResult[];
  /** True when every non-skipped stage passed (and precheck did not block). */
  ok: boolean;
  stoppedReason?: ProbeStoppedReason;
  requestCount: number;
  budget: ProbeBudgetSnapshot;
  /** Present when a target doctor precheck ran (pass/warn/fail). */
  precheck?: ProbeRunPrecheckSnapshot;
}

/** Synthetic user message built by the engine (never session history). */
export interface ProbeUserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface ProbeToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProbeContext {
  systemPrompt?: string;
  messages: ProbeUserMessage[];
  tools?: ProbeToolDef[];
}

export interface ProbeCompleteOptions {
  maxTokens: number;
  signal: AbortSignal;
  /** Thinking level for the reasoning contract (when applicable). */
  reasoning?: "minimal" | "low" | "medium" | "high";
}

/**
 * One transport invocation. The engine builds this from a Probe Contract;
 * callers never inject conversation history into it.
 */
export interface ProbeRequest {
  contract: ProbeContractId;
  /**
   * Target this request is being sent under. For repair verification this is
   * the in-memory candidate (patch applied); production transport reads
   * fingerprint / claudeCodeCompat / geminiToolCompat from here. Pure engine
   * only forwards it — never interprets it.
   */
  target: ProbeTarget;
  /** Opaque model handle (e.g. pi-ai Model) resolved by the caller. */
  model: unknown;
  context: ProbeContext;
  options: ProbeCompleteOptions;
}

export type ProbeStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type ProbeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface ProbeAssistantMessage {
  role: "assistant";
  content: ProbeContentBlock[];
  stopReason: ProbeStopReason;
  errorMessage?: string;
}

/** Result of one transport call (HTTP status optional when transport cannot observe it). */
export interface ProbeTransportResult {
  message: ProbeAssistantMessage;
  httpStatus?: number;
  responseHeaders?: Record<string, string>;
}

/**
 * Injectable transport. Production wires this to complete() + onResponse;
 * unit tests use a faux complete with zero network.
 */
export type ProbeTransport = (request: ProbeRequest) => Promise<ProbeTransportResult>;

/**
 * Injectable target doctor precheck (ticket 3).
 * May be a precomputed result or an async function (no network in unit tests).
 */
export type ProbePrecheckInput =
  | ProbeRunPrecheckSnapshot
  | (() => ProbeRunPrecheckSnapshot | Promise<ProbeRunPrecheckSnapshot>);

export interface ProbeEngineOptions {
  target: ProbeTarget;
  /** Opaque model handle passed through to transport. */
  model: unknown;
  transport: ProbeTransport;
  /**
   * Optional target-scoped doctor precheck.
   * FAIL (allowProbe=false) blocks all transport calls; WARN continues.
   * Omitted → precheck skipped (prior engine behavior).
   */
  precheck?: ProbePrecheckInput;
  /**
   * Contracts to run. Default: basic → reasoning → tool
   * (reasoning skipped when target does not claim support).
   * Repair retest can pass only failed contracts.
   */
  contracts?: ProbeContractId[];
  maxRequests?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** Factory for per-request AbortSignal (default AbortSignal.timeout). */
  createSignal?: (timeoutMs: number) => AbortSignal;
  /** Clock for synthetic message timestamps. */
  now?: () => number;
}
