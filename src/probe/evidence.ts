/**
 * Probe evidence classification + durable normalization (tickets 1–2).
 *
 * Raw request/response stay in memory only. Persistence uses Normalized*
 * facts: wide category, signature ID, allowlisted header names, redacted summary.
 */

import type {
  ProbeAssistantMessage,
  ProbeContractId,
  ProbeFailureCategory,
  ProbeRunResult,
  ProbeStageResult,
  ProbeStageStatus,
  ProbeStoppedReason,
  ProbeTarget,
  ProbeTransportResult,
  ProbeBudgetSnapshot,
} from "./types.ts";

// ── Ticket 1: in-memory classification ──────────────────────────────────────

export interface ClassifiedFailure {
  category: ProbeFailureCategory;
  unrepairable: boolean;
  /** Hard stop for the whole run (401/429/5xx). */
  hardStop: boolean;
  summary: string;
}

/**
 * Classify HTTP status for stop / unrepairable decisions.
 * Spec: 401/429/5xx → unrepairable, stop immediately.
 */
export function classifyHttpStatus(status: number): ClassifiedFailure | undefined {
  if (status === 401 || status === 403) {
    return {
      category: "auth",
      unrepairable: true,
      hardStop: true,
      summary: `HTTP ${status}: authentication or authorization failed`,
    };
  }
  if (status === 429) {
    return {
      category: "auth",
      unrepairable: true,
      hardStop: true,
      summary: "HTTP 429: rate limited",
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      category: "protocol",
      unrepairable: true,
      hardStop: true,
      summary: `HTTP ${status}: upstream server error`,
    };
  }
  if (status === 404) {
    return {
      category: "model",
      unrepairable: false,
      hardStop: false,
      summary: "HTTP 404: model or endpoint not found",
    };
  }
  if (status >= 400 && status <= 499) {
    return {
      category: "unknown",
      unrepairable: false,
      hardStop: false,
      summary: `HTTP ${status}: client error`,
    };
  }
  return undefined;
}

function hasText(message: ProbeAssistantMessage): boolean {
  return message.content.some((b) => b.type === "text" && b.text.trim().length > 0);
}

function hasThinking(message: ProbeAssistantMessage): boolean {
  return message.content.some(
    (b) => b.type === "thinking" && b.thinking.trim().length > 0,
  );
}

function hasProbeEchoToolCall(message: ProbeAssistantMessage): boolean {
  return message.content.some(
    (b) => b.type === "toolCall" && b.name === "probe_echo",
  );
}

export type ContractEval =
  | { ok: true; summary: string }
  | { ok: false; category: ProbeFailureCategory; summary: string };

/**
 * Evaluate whether a transport result satisfies the Probe Contract.
 * Ambiguous outcomes stay category "unknown" (no guessing).
 */
export function evaluateContract(
  contract: ProbeContractId,
  result: ProbeTransportResult,
): ContractEval {
  const { message, httpStatus } = result;

  if (httpStatus !== undefined && httpStatus >= 400) {
    const classified = classifyHttpStatus(httpStatus);
    if (classified) {
      return {
        ok: false,
        category: classified.category,
        summary: classified.summary,
      };
    }
  }

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      ok: false,
      category: "unknown",
      summary:
        message.errorMessage?.trim() ||
        `provider returned stopReason=${message.stopReason}`,
    };
  }

  switch (contract) {
    case "basic":
      if (hasText(message)) {
        return { ok: true, summary: "basic text response received" };
      }
      return {
        ok: false,
        category: "protocol",
        summary: "basic contract: no text content in assistant response",
      };

    case "reasoning":
      // Controlled reasoning: request was sent with reasoning option.
      // Pass when the call completes without error. Thinking block is preferred
      // but not required (some relays strip thinking while accepting the param).
      if (message.stopReason === "stop" || message.stopReason === "length") {
        if (hasThinking(message) || hasText(message)) {
          return {
            ok: true,
            summary: hasThinking(message)
              ? "reasoning response includes thinking"
              : "reasoning request completed without error",
          };
        }
      }
      return {
        ok: false,
        category: "protocol",
        summary: "reasoning contract: empty or unexpected response",
      };

    case "tool":
      if (message.stopReason === "toolUse" && hasProbeEchoToolCall(message)) {
        return { ok: true, summary: "probe_echo tool call received" };
      }
      if (hasProbeEchoToolCall(message)) {
        return { ok: true, summary: "probe_echo tool call received" };
      }
      return {
        ok: false,
        category: "tool",
        summary: "tool contract: expected probe_echo tool call",
      };
  }
}

/**
 * Map a failed contract evaluation + HTTP status into a full ClassifiedFailure
 * (adds hardStop / unrepairable for 401/429/5xx).
 *
 * When error text uniquely maps to a client fingerprint gate, classify as
 * `client-gate` (repairable) instead of generic auth/5xx unrepairable.
 */
export function classifyStageFailure(
  evalResult: Extract<ContractEval, { ok: false }>,
  httpStatus?: number,
  errorText?: string,
): ClassifiedFailure {
  const gateText = errorText?.trim() || evalResult.summary;
  const gate = detectUniqueClientGate(gateText);
  if (gate) {
    return {
      category: "client-gate",
      unrepairable: false,
      hardStop: false,
      summary: `client fingerprint gate: requires ${gate} identity`,
    };
  }

  if (httpStatus !== undefined) {
    const fromHttp = classifyHttpStatus(httpStatus);
    if (fromHttp) return fromHttp;
  }
  return {
    category: evalResult.category,
    unrepairable: false,
    hardStop: false,
    summary: evalResult.summary,
  };
}

// ── Ticket 5: unique client fingerprint gate detection ──────────────────────

/** CLI fingerprint identity uniquely demanded by a client-gate rejection. */
export type ClientGateFingerprint = "claude-code" | "codex" | "gemini";

const CLIENT_GATE_SIGNATURE: Record<ClientGateFingerprint, string> = {
  "claude-code": "client_gate_claude_code",
  codex: "client_gate_codex",
  gemini: "client_gate_gemini",
};

/**
 * Detect a *unique* client fingerprint gate from free text (error body / summary).
 *
 * Returns the single mapped CLI identity when the wording is distinctive and
 * maps to exactly one of Claude Code / Codex / Gemini. Returns undefined when
 * ambiguous, multi-match, or non-distinctive (callers must not guess).
 *
 * Pure; used by signature resolution and stage classification.
 */
export function detectUniqueClientGate(
  text: string | undefined,
): ClientGateFingerprint | undefined {
  if (!text || !text.trim()) return undefined;
  const t = text.toLowerCase();

  const hits: ClientGateFingerprint[] = [];

  // Claude Code — distinctive UA / Agent SDK / anthropic client markers
  if (
    /\bclaude[-_ ]?cli\b/.test(t) ||
    /\bclaude[-_ ]?code\b/.test(t) ||
    /\bclaude agent\b/.test(t) ||
    /\bagent sdk\b/.test(t) ||
    /\banthropic-version\b/.test(t) ||
    (/\bdevice_id\b/.test(t) && /\b(metadata|user_id|fingerprint)\b/.test(t))
  ) {
    hits.push("claude-code");
  }

  // Codex — distinctive codex_cli_rs / originator / window-id markers
  if (
    /\bcodex_cli(?:_rs)?\b/.test(t) ||
    /\bcodex[-_ ]?cli\b/.test(t) ||
    /\bx-codex-window-id\b/.test(t) ||
    (/\boriginator\b/.test(t) && /\bcodex\b/.test(t))
  ) {
    hits.push("codex");
  }

  // Gemini — distinctive GeminiCLI / x-goog-api-client markers
  if (
    /\bgemini[-_ ]?cli\b/.test(t) ||
    /\bx-goog-api-client\b/.test(t)
  ) {
    hits.push("gemini");
  }

  // Uniqueness: exactly one client family
  if (hits.length !== 1) return undefined;
  return hits[0];
}

export function clientGateSignatureId(
  fingerprint: ClientGateFingerprint,
): string {
  return CLIENT_GATE_SIGNATURE[fingerprint];
}

// ── Ticket 2: durable normalized evidence ───────────────────────────────────

/** Known durable signature IDs. Ambiguous evidence always uses "unknown". */
export type ProbeEvidenceSignatureId =
  | "pass"
  | "skip"
  | "stopped"
  | "http_auth_401"
  | "http_auth_403"
  | "http_rate_limit_429"
  | "http_server_5xx"
  | "http_model_404"
  | "contract_basic_no_text"
  | "contract_reasoning_empty"
  | "contract_tool_missing_echo"
  | "reasoning_param_rejected"
  | "client_gate_claude_code"
  | "client_gate_codex"
  | "client_gate_gemini"
  | "unknown";

/**
 * Response header names safe to record (names only — never values).
 * Sensitive auth headers are never listed.
 */
const ALLOWED_RESPONSE_HEADER_NAMES = new Set([
  "content-type",
  "content-length",
  "www-authenticate",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
  "server",
]);

const SENSITIVE_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-goog-api-key",
]);

/**
 * In-memory only observation of one transport call.
 * Must never be serialized to disk / session detail as-is.
 */
export interface RawProbeObservation {
  contract: ProbeContractId;
  request?: {
    messages?: Array<{ role: string; content: string }>;
    headers?: Record<string, string>;
    url?: string;
    tools?: unknown;
  };
  response?: {
    message?: ProbeAssistantMessage;
    httpStatus?: number;
    responseHeaders?: Record<string, string>;
    /** Raw HTTP body — memory only; never persisted. */
    rawBody?: string;
  };
}

/** Durable category including pass sentinel. */
export type NormalizedEvidenceCategory = ProbeFailureCategory | "ok";

/**
 * One stage of durable probe evidence.
 * Contains only normalized facts — no prompts, bodies, secrets, or query strings.
 */
export interface NormalizedStageEvidence {
  contract: ProbeContractId;
  status: ProbeStageStatus;
  category: NormalizedEvidenceCategory;
  /** Recipe-matching signature; "unknown" when evidence is ambiguous. */
  signatureId: ProbeEvidenceSignatureId | string;
  /** Allowlisted response header *names* only (never values). */
  allowedHeaderNames: string[];
  /** Redacted human-readable summary. */
  summary: string;
  httpStatus?: number;
  unrepairable?: boolean;
  requestCount: number;
}

/** Full durable probe run evidence (safe to persist outside model context). */
export interface NormalizedProbeRunEvidence {
  target: ProbeTarget;
  stages: NormalizedStageEvidence[];
  ok: boolean;
  stoppedReason?: ProbeStoppedReason;
  requestCount: number;
  budget: ProbeBudgetSnapshot;
  /** ISO-8601 capture time. */
  capturedAt: string;
}

/**
 * Redact secrets, bearer tokens, and query strings from free text.
 * Used for durable summaries only — not a substitute for omitting raw bodies.
 */
export function redactProbeText(input: string): string {
  let s = input;

  // Strip URL query / fragment entirely
  s = s.replace(
    /(https?:\/\/[^\s"'<>]+)/gi,
    (url) => {
      try {
        const u = new URL(url);
        u.username = "";
        u.password = "";
        u.search = "";
        u.hash = "";
        return u.toString();
      } catch {
        return url.split(/[?#]/, 1)[0] ?? url;
      }
    },
  );

  // Authorization: Bearer … / bearer sk-…
  s = s.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");

  // Common API key shapes
  s = s.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, "[REDACTED_KEY]");
  s = s.replace(/\bsecret-api-key\b/gi, "[REDACTED]");
  s = s.replace(
    /\b(api[_-]?key|access[_-]?token|token)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );

  // Naked query-like pairs that survived URL redaction
  s = s.replace(
    /([?&])(api_key|key|token|access_token)=[^&\s"']+/gi,
    "$1$2=[REDACTED]",
  );

  return s;
}

/** Select allowlisted header names present on the response (names only). */
export function pickAllowedHeaderNames(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) return [];
  const names: string[] = [];
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower)) continue;
    if (ALLOWED_RESPONSE_HEADER_NAMES.has(lower)) {
      names.push(lower);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve a durable signature ID from stage + optional in-memory observation.
 * Ambiguous evidence → "unknown" (no guessing).
 */
export function resolveSignatureId(input: {
  stage: ProbeStageResult;
  observation?: RawProbeObservation;
}): ProbeEvidenceSignatureId | string {
  const { stage } = input;

  if (stage.status === "pass") return "pass";
  if (stage.status === "skip") return "skip";
  if (stage.status === "stopped") return "stopped";

  const status = stage.httpStatus ?? input.observation?.response?.httpStatus;
  const summary = stage.summary ?? "";
  const err = input.observation?.response?.message?.errorMessage ?? "";
  const rawBody =
    typeof input.observation?.response?.rawBody === "string"
      ? input.observation.response.rawBody
      : "";
  const combined = `${summary}\n${err}\n${rawBody}`;

  // Unique client-gate fingerprints take precedence over generic HTTP status
  // signatures (e.g. distinctive 403 must not collapse to http_auth_403).
  const gate = detectUniqueClientGate(combined);
  if (gate) {
    return clientGateSignatureId(gate);
  }

  if (status === 401) return "http_auth_401";
  if (status === 403) return "http_auth_403";
  if (status === 429) return "http_rate_limit_429";
  if (status === 404) return "http_model_404";
  if (status !== undefined && status >= 500 && status <= 599) {
    return "http_server_5xx";
  }

  // Contract-shaped failures with known summaries (no guessing beyond that)
  const summaryLower = summary.toLowerCase();
  if (stage.category === "protocol" && summaryLower.includes("no text content")) {
    return "contract_basic_no_text";
  }
  if (
    stage.category === "protocol" &&
    summaryLower.includes("reasoning contract")
  ) {
    return "contract_reasoning_empty";
  }
  if (stage.category === "tool" && summaryLower.includes("probe_echo")) {
    return "contract_tool_missing_echo";
  }

  // Distinctive protocol error patterns (Recipe 1)
  const combinedLower = combined.toLowerCase();
  if (
    /\b(reasoning|thinking)\b/.test(combinedLower) &&
    /\b(unsupported|not supported|unknown|invalid|unexpected)\b/.test(
      combinedLower,
    )
  ) {
    return "reasoning_param_rejected";
  }

  // Ambiguous 4xx / generic errors: never invent a fingerprint or recipe match.
  return "unknown";
}

function categoryForStage(
  stage: ProbeStageResult,
  signatureId: string,
): NormalizedEvidenceCategory {
  if (stage.status === "pass") return "ok";
  // Unique client-gate signatures always surface as client-gate category.
  if (
    signatureId === "client_gate_claude_code" ||
    signatureId === "client_gate_codex" ||
    signatureId === "client_gate_gemini"
  ) {
    return "client-gate";
  }
  if (stage.category) return stage.category;
  if (stage.status === "skip" || stage.status === "stopped") return "unknown";
  return "unknown";
}

/**
 * Normalize one stage into durable evidence.
 * Raw observation is used only for header names + signature hints; never copied.
 */
export function normalizeStageEvidence(input: {
  stage: ProbeStageResult;
  observation?: RawProbeObservation;
}): NormalizedStageEvidence {
  const { stage, observation } = input;
  const signatureId = resolveSignatureId({ stage, observation });
  const allowedHeaderNames = pickAllowedHeaderNames(
    observation?.response?.responseHeaders,
  );
  const summary = redactProbeText(stage.summary ?? "");

  const out: NormalizedStageEvidence = {
    contract: stage.contract,
    status: stage.status,
    category: categoryForStage(stage, signatureId),
    signatureId,
    allowedHeaderNames,
    summary,
    requestCount: stage.requestCount,
  };

  if (stage.httpStatus !== undefined) out.httpStatus = stage.httpStatus;
  else if (observation?.response?.httpStatus !== undefined) {
    out.httpStatus = observation.response.httpStatus;
  }
  // Unique client-gate is repairable even when HTTP layer marked 403 unrepairable.
  if (
    stage.unrepairable &&
    signatureId !== "client_gate_claude_code" &&
    signatureId !== "client_gate_codex" &&
    signatureId !== "client_gate_gemini"
  ) {
    out.unrepairable = true;
  }

  return out;
}

export interface NormalizeProbeRunInput {
  result: ProbeRunResult;
  /** In-memory observations keyed by contract (first match wins). Never persisted. */
  observations?: RawProbeObservation[];
  capturedAt?: string;
}

/**
 * Normalize a full probe run into durable evidence safe for Repair Case detail.
 * Does not retain prompts, response bodies, secrets, or query strings.
 */
export function normalizeProbeRun(
  input: NormalizeProbeRunInput,
): NormalizedProbeRunEvidence {
  const { result } = input;
  const byContract = new Map<ProbeContractId, RawProbeObservation>();
  for (const obs of input.observations ?? []) {
    if (!byContract.has(obs.contract)) byContract.set(obs.contract, obs);
  }

  const stages = result.stages.map((stage) =>
    normalizeStageEvidence({
      stage,
      observation: byContract.get(stage.contract),
    }),
  );

  return {
    target: {
      provider: result.target.provider,
      modelId: result.target.modelId,
      ...(result.target.reasoning !== undefined
        ? { reasoning: result.target.reasoning }
        : {}),
    },
    stages,
    ok: result.ok,
    ...(result.stoppedReason !== undefined
      ? { stoppedReason: result.stoppedReason }
      : {}),
    requestCount: result.requestCount,
    budget: { ...result.budget },
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}
