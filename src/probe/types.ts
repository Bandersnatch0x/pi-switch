/**
 * Compatibility Probe — shared types (issue #42 / ticket 1 #43).
 *
 * Domain: Probe Target, Probe Contract, Compatibility Probe.
 * Engine is pure: transport is injected; zero network by default.
 */

/** Hard budget for a single probe run. */
export const PROBE_MAX_REQUESTS = 9;
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_MAX_TOKENS = 32;

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

export type ProbeStoppedReason = "failure" | "unrepairable" | "budget";

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

/** Structured headless-friendly probe outcome. */
export interface ProbeRunResult {
  target: ProbeTarget;
  stages: ProbeStageResult[];
  /** True when every non-skipped stage passed. */
  ok: boolean;
  stoppedReason?: ProbeStoppedReason;
  requestCount: number;
  budget: ProbeBudgetSnapshot;
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

export interface ProbeEngineOptions {
  target: ProbeTarget;
  /** Opaque model handle passed through to transport. */
  model: unknown;
  transport: ProbeTransport;
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
