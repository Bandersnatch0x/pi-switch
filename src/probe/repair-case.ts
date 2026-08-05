/**
 * Repair Case dual-layer session records (ticket 2 / #44)
 * + session-context projection across Session Model switches (ticket 7 / #50).
 *
 * - custom_message: short redacted summary → enters model context
 * - custom: detailed normalized evidence → does NOT enter model context
 * Both layers share the same Case ID.
 *
 * Mirrors pi SessionManager entry shapes (CustomMessageEntry / CustomEntry /
 * model_change) and buildSessionContext rules without depending on the runtime
 * session API. Session Model changes never mutate recorded Probe Targets.
 */

import { redactProbeText, type NormalizedProbeRunEvidence } from "./evidence.ts";
import type { RepairOutcome } from "./repair.ts";
import type {
  ProbeContractId,
  ProbeFailureCategory,
  ProbeStageStatus,
  ProbeStoppedReason,
  ProbeTarget,
} from "./types.ts";

/** customType for the context-facing summary layer. */
export const REPAIR_CASE_SUMMARY_CUSTOM_TYPE = "ps-repair-case-summary";

/** customType for the out-of-context detail layer. */
export const REPAIR_CASE_DETAIL_CUSTOM_TYPE = "ps-repair-case-detail";

/** Concise summary carried on both the typed object and custom_message content. */
export interface RepairCaseSummaryData {
  caseId: string;
  target: { provider: string; modelId: string };
  ok: boolean;
  /** Short redacted one-liner (also used as custom_message content). */
  text: string;
  contracts: Array<{
    contract: ProbeContractId;
    status: ProbeStageStatus;
    category?: ProbeFailureCategory | "ok";
  }>;
  stoppedReason?: string;
}

export interface RepairCaseVerificationAttempt {
  pass: number;
  ok: boolean;
  requestCount: number;
  stoppedReason?: ProbeStoppedReason;
  stages: Array<{
    contract: ProbeContractId;
    status: ProbeStageStatus;
    category?: ProbeFailureCategory;
    httpStatus?: number;
    summary: string;
  }>;
}

export interface RepairCaseRepairRecord {
  status: RepairOutcome["status"] | "cancelled";
  persisted: boolean;
  recipe?:
    | {
        recipeId: string;
        signatureId: string;
        scope: "exact-model";
        affectedModels: string[];
      }
    | {
        recipeId: string;
        signatureId: string;
        scope: "provider-wide";
        provider: string;
      };
  verificationAttempts: RepairCaseVerificationAttempt[];
  switch?: {
    status: "not-offered" | "declined" | "succeeded" | "failed";
    target?: ProbeTarget;
    summary?: string;
  };
}

/** Detailed durable evidence for the custom entry (not sent to the LLM). */
export interface RepairCaseDetailData {
  caseId: string;
  target: ProbeTarget;
  ok: boolean;
  evidence: NormalizedProbeRunEvidence;
  recipeAttempts: RepairCaseVerificationAttempt[];
  repair?: RepairCaseRepairRecord;
}

/**
 * Session entry shape for CustomMessageEntry (participates in LLM context).
 * Matches pi-coding-agent SessionManager.appendCustomMessageEntry fields.
 */
export interface RepairCaseSummarySessionEntry {
  type: "custom_message";
  customType: typeof REPAIR_CASE_SUMMARY_CUSTOM_TYPE;
  content: string;
  display: boolean;
  details: { caseId: string };
}

/**
 * Session entry shape for CustomEntry (ignored by buildSessionContext).
 * Matches pi-coding-agent SessionManager.appendCustomEntry fields.
 */
export interface RepairCaseDetailSessionEntry {
  type: "custom";
  customType: typeof REPAIR_CASE_DETAIL_CUSTOM_TYPE;
  data: RepairCaseDetailData;
}

export interface RepairCaseSessionLayers {
  caseId: string;
  summary: RepairCaseSummaryData;
  detail: RepairCaseDetailData;
  summaryEntry: RepairCaseSummarySessionEntry;
  detailEntry: RepairCaseDetailSessionEntry;
}

/**
 * Create a Case ID. Inject clock + rng for tests.
 * Format: case_<utcCompact>_<base36noise>
 */
export function createCaseId(
  now: () => Date = () => new Date(),
  random: () => number = Math.random,
): string {
  const d = now();
  const utc = d
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const noise = Math.floor(random() * 1e9)
    .toString(36)
    .padStart(6, "0")
    .slice(0, 6);
  return `case_${utc}_${noise}`;
}

/** Build the short redacted summary text for model context. */
export function formatRepairCaseSummaryText(
  caseId: string,
  evidence: NormalizedProbeRunEvidence,
  repair?: RepairCaseRepairRecord,
): string {
  const target = `${evidence.target.provider}/${evidence.target.modelId}`;
  const parts = evidence.stages.map((s) => {
    if (s.status === "pass") return `${s.contract}=pass`;
    if (s.status === "skip") return `${s.contract}=skip`;
    if (s.status === "stopped") return `${s.contract}=stop`;
    return `${s.contract}=${s.category}`;
  });
  const head = evidence.ok ? "PASS" : "FAIL";
  const stop = evidence.stoppedReason ? ` stop=${evidence.stoppedReason}` : "";
  const repairStatus = repair ? ` repair=${repair.status}` : "";
  const switchStatus = repair?.switch
    ? ` switch=${repair.switch.status}`
    : "";
  const raw =
    `ps-repair-case ${caseId} ${head} ${target} [${parts.join(", ")}]` +
    `${stop}${repairStatus}${switchStatus}`;
  return redactProbeText(raw);
}

/**
 * Build dual-layer Repair Case records sharing one Case ID.
 * Summary → custom_message (context); detail → custom (no context).
 */
export function buildRepairCaseLayers(input: {
  evidence: NormalizedProbeRunEvidence;
  repair?: RepairCaseRepairRecord;
  caseId?: string;
  now?: () => Date;
  random?: () => number;
}): RepairCaseSessionLayers {
  const caseId =
    input.caseId ?? createCaseId(input.now ?? (() => new Date()), input.random ?? Math.random);
  const { evidence } = input;

  const text = formatRepairCaseSummaryText(caseId, evidence, input.repair);

  const summary: RepairCaseSummaryData = {
    caseId,
    target: {
      provider: evidence.target.provider,
      modelId: evidence.target.modelId,
    },
    ok: evidence.ok,
    text,
    contracts: evidence.stages.map((s) => {
      if (s.status === "pass") {
        return { contract: s.contract, status: "pass" as const, category: "ok" as const };
      }
      if (s.status === "fail") {
        return {
          contract: s.contract,
          status: "fail" as const,
          category: (s.category === "ok" ? "unknown" : s.category) as ProbeFailureCategory | "ok",
        };
      }
      return { contract: s.contract, status: s.status };
    }),
    ...(evidence.stoppedReason !== undefined
      ? { stoppedReason: evidence.stoppedReason }
      : {}),
  };

  const detail: RepairCaseDetailData = {
    caseId,
    target: { ...evidence.target },
    ok: evidence.ok,
    evidence,
    recipeAttempts: input.repair?.verificationAttempts ?? [],
    ...(input.repair ? { repair: input.repair } : {}),
  };

  const summaryEntry: RepairCaseSummarySessionEntry = {
    type: "custom_message",
    customType: REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
    content: text,
    display: true,
    details: { caseId },
  };

  const detailEntry: RepairCaseDetailSessionEntry = {
    type: "custom",
    customType: REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    data: detail,
  };

  return {
    caseId,
    summary,
    detail,
    summaryEntry,
    detailEntry,
  };
}

/**
 * Project dual-layer case into what the model would see vs what stays out.
 * Mirrors pi buildSessionContext: custom_message → user text; custom → ignored.
 */
export function projectRepairCaseIntoContext(layers: RepairCaseSessionLayers): {
  contextMessages: Array<{ role: "user"; content: string }>;
  excludedFromContext: RepairCaseDetailSessionEntry[];
} {
  return {
    contextMessages: [
      {
        role: "user",
        content: layers.summaryEntry.content,
      },
    ],
    excludedFromContext: [layers.detailEntry],
  };
}

// ── Ticket 7: session transcript + model-context projection ─────────────────

/** Session Model identity (independent of Probe Target). */
export interface SessionModelRef {
  provider: string;
  modelId: string;
}

/**
 * model_change entry shape (pi SessionManager.appendModelChange).
 * Records Session Model switches; does not enter LLM message list as content
 * but updates the active session model for the next request.
 */
export interface RepairCaseModelChangeEntry {
  type: "model_change";
  provider: string;
  modelId: string;
}

/** Ordered session entries relevant to Repair Case context projection. */
export type RepairCaseSessionTranscriptEntry =
  | RepairCaseSummarySessionEntry
  | RepairCaseDetailSessionEntry
  | RepairCaseModelChangeEntry;

/**
 * In-memory session transcript for Repair Cases.
 * Production wires the same dual-layer appends onto pi SessionManager;
 * this pure store is the unit-test seam (zero network / zero disk).
 */
export interface RepairCaseSession {
  /** Mutable ordered transcript (append-only by helpers). */
  entries: RepairCaseSessionTranscriptEntry[];
  /** Latest Session Model from model_change entries (or create-time seed). */
  sessionModel?: SessionModelRef;
}

export interface CreateRepairCaseSessionOptions {
  sessionModel?: SessionModelRef;
}

/** Create an empty Repair Case session transcript. */
export function createRepairCaseSession(
  options: CreateRepairCaseSessionOptions = {},
): RepairCaseSession {
  return {
    entries: [],
    ...(options.sessionModel !== undefined
      ? { sessionModel: { ...options.sessionModel } }
      : {}),
  };
}

/**
 * Append dual-layer Repair Case entries to the session transcript.
 * Summary (custom_message) + detail (custom) share the case Case ID.
 * Does not call setModel and does not mutate Session Model.
 */
export function recordRepairCase(
  session: RepairCaseSession,
  layers: RepairCaseSessionLayers,
): void {
  // Append order mirrors pi: message-like context entry then opaque custom state.
  session.entries.push({
    type: "custom_message",
    customType: REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
    content: layers.summaryEntry.content,
    display: layers.summaryEntry.display,
    details: { caseId: layers.summaryEntry.details.caseId },
  });
  session.entries.push({
    type: "custom",
    customType: REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    data: layers.detailEntry.data,
  });
}

/**
 * Record a Session Model switch (pi appendModelChange).
 * Never mutates recorded Probe Targets or Repair Case detail.
 */
export function switchSessionModel(
  session: RepairCaseSession,
  provider: string,
  modelId: string,
): void {
  session.entries.push({ type: "model_change", provider, modelId });
  session.sessionModel = { provider, modelId };
}

export interface ProjectedSessionModelContext {
  /** Messages the LLM would receive (custom_message only for Repair Cases). */
  contextMessages: Array<{ role: "user"; content: string }>;
  /** custom detail entries retained offline — never sent to the model. */
  excludedFromContext: RepairCaseDetailSessionEntry[];
  /** Latest Session Model after walking model_change entries. */
  sessionModel?: SessionModelRef;
}

/**
 * Project a session transcript into model context.
 *
 * Mirrors pi buildSessionContext rules for Repair Case entries:
 * - custom_message → user text (enters context)
 * - custom → ignored (detail stays out)
 * - model_change → updates sessionModel only (no content message)
 *
 * Summaries remain visible after Session Model switches because they live on
 * the session path, not on a per-model cache.
 */
export function projectSessionModelContext(
  session: RepairCaseSession,
): ProjectedSessionModelContext {
  const contextMessages: Array<{ role: "user"; content: string }> = [];
  const excludedFromContext: RepairCaseDetailSessionEntry[] = [];

  // Replay transcript so projection is pure over entries.
  // model_change entries are the source of truth for Session Model; fall back
  // to the create-time seed when no switch has been recorded yet.
  const hasModelChange = session.entries.some((e) => e.type === "model_change");
  let sessionModel: SessionModelRef | undefined =
    !hasModelChange && session.sessionModel
      ? { ...session.sessionModel }
      : undefined;

  for (const entry of session.entries) {
    if (entry.type === "custom_message") {
      contextMessages.push({ role: "user", content: entry.content });
      continue;
    }
    if (entry.type === "custom") {
      excludedFromContext.push(entry);
      continue;
    }
    if (entry.type === "model_change") {
      sessionModel = { provider: entry.provider, modelId: entry.modelId };
    }
  }

  return {
    contextMessages,
    excludedFromContext,
    ...(sessionModel !== undefined ? { sessionModel } : {}),
  };
}
