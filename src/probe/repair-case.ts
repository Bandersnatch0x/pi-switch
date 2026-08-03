/**
 * Repair Case dual-layer session records (ticket 2 / #44).
 *
 * - custom_message: short redacted summary → enters model context
 * - custom: detailed normalized evidence → does NOT enter model context
 * Both layers share the same Case ID.
 *
 * Mirrors pi SessionManager entry shapes (CustomMessageEntry / CustomEntry)
 * without depending on the runtime session API.
 */

import { redactProbeText, type NormalizedProbeRunEvidence } from "./evidence.ts";
import type { ProbeContractId, ProbeFailureCategory, ProbeStageStatus } from "./types.ts";

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

/** Detailed durable evidence for the custom entry (not sent to the LLM). */
export interface RepairCaseDetailData {
  caseId: string;
  target: { provider: string; modelId: string; reasoning?: boolean };
  ok: boolean;
  evidence: NormalizedProbeRunEvidence;
  /** Reserved for later tickets (recipe attempts). */
  recipeAttempts: unknown[];
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
  const raw = `ps-repair-case ${caseId} ${head} ${target} [${parts.join(", ")}]${stop}`;
  return redactProbeText(raw);
}

/**
 * Build dual-layer Repair Case records sharing one Case ID.
 * Summary → custom_message (context); detail → custom (no context).
 */
export function buildRepairCaseLayers(input: {
  evidence: NormalizedProbeRunEvidence;
  caseId?: string;
  now?: () => Date;
  random?: () => number;
}): RepairCaseSessionLayers {
  const caseId =
    input.caseId ?? createCaseId(input.now ?? (() => new Date()), input.random ?? Math.random);
  const { evidence } = input;

  const text = formatRepairCaseSummaryText(caseId, evidence);

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
    target: {
      provider: evidence.target.provider,
      modelId: evidence.target.modelId,
      ...(evidence.target.reasoning !== undefined
        ? { reasoning: evidence.target.reasoning }
        : {}),
    },
    ok: evidence.ok,
    evidence,
    recipeAttempts: [],
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
