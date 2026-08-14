/**
 * Repair Case recorder.
 *
 * Callers provide normalized evidence and a closed Probe/Repair event. The
 * recorder owns durable conversion and always writes the context summary
 * before the out-of-context detail. Adapter failures propagate unchanged.
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

export const REPAIR_CASE_SUMMARY_CUSTOM_TYPE = "ps-repair-case-summary";
export const REPAIR_CASE_DETAIL_CUSTOM_TYPE = "ps-repair-case-detail";

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

export interface RepairCaseVerificationAttemptInput {
  kind: "verification-attempt";
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
  switch?: RepairCaseSwitchRecord;
}

export interface RepairCaseDetailData {
  caseId: string;
  target: ProbeTarget;
  ok: boolean;
  evidence: NormalizedProbeRunEvidence;
  recipeAttempts: RepairCaseVerificationAttempt[];
  repair?: RepairCaseRepairRecord;
}

export type RepairCaseSwitchRecord =
  | { status: "not-offered" }
  | { status: "declined"; target: ProbeTarget }
  | { status: "succeeded" | "failed"; target: ProbeTarget; summary: string };

export interface RepairCaseCancelledOutcome {
  status: "cancelled";
  persisted: false;
}

export type RepairCaseRecipePreview =
  | {
      recipeId: string;
      scope: "exact-model";
      affectedModels: string[];
    }
  | {
      recipeId: string;
      scope: "provider-wide";
      provider: string;
    };

export type RepairCaseRepairOutcome =
  | {
      status:
        | "headless-rejected"
        | "needs-confirmation"
        | "no-recipe"
        | "cancelled";
      persisted: false;
    }
  | {
      status: "verification-failed" | "cas-conflict" | "commit-error";
      persisted: false;
      recipe: { recipeId: string; signatureId: string };
      recipePreviews: RepairCaseRecipePreview[];
      verificationAttempts: RepairCaseVerificationAttemptInput[];
    }
  | {
      status: "committed";
      persisted: true;
      recipe: { recipeId: string; signatureId: string };
      recipePreviews: RepairCaseRecipePreview[];
      verificationAttempts: RepairCaseVerificationAttemptInput[];
    };

export type RepairCaseEvent =
  | { kind: "probe" }
  | {
      kind: "repair";
      outcome: RepairCaseRepairOutcome;
      switch: RepairCaseSwitchRecord;
    };

export type RepairCaseWrite =
  | {
      kind: "summary";
      customType: typeof REPAIR_CASE_SUMMARY_CUSTOM_TYPE;
      content: string;
      display: true;
      details: { caseId: string };
    }
  | {
      kind: "detail";
      customType: typeof REPAIR_CASE_DETAIL_CUSTOM_TYPE;
      data: RepairCaseDetailData;
    };

export interface RepairCaseWriteAdapter {
  write(write: RepairCaseWrite): void;
}

export interface RepairCaseRecorder {
  record(evidence: NormalizedProbeRunEvidence, event: RepairCaseEvent): void;
}

export interface InMemoryRepairCaseWriteAdapter extends RepairCaseWriteAdapter {
  readonly writes: RepairCaseWrite[];
}

export function createInMemoryRepairCaseWriteAdapter(): InMemoryRepairCaseWriteAdapter {
  const writes: RepairCaseWrite[] = [];
  return {
    writes,
    write: (write) => {
      writes.push(write);
    },
  };
}

export function createRepairCaseRecorder(
  adapter: RepairCaseWriteAdapter,
  options: {
    now?: () => Date;
    random?: () => number;
  } = {},
): RepairCaseRecorder {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;

  return {
    record(evidence, event) {
      const caseId = createCaseId(now, random);
      const repair = event.kind === "repair" ? buildRepairRecord(event) : undefined;
      const summary = buildSummaryWrite(caseId, evidence, repair);
      const detail = buildDetailWrite(caseId, evidence, repair);

      adapter.write(summary);
      adapter.write(detail);
    },
  };
}

export function createRepairCaseRepairEvent(
  outcome: RepairOutcome | RepairCaseCancelledOutcome,
  switchRecord: RepairCaseSwitchRecord,
): Extract<RepairCaseEvent, { kind: "repair" }> {
  if (!("recipe" in outcome)) {
    return {
      kind: "repair",
      outcome: { status: outcome.status, persisted: false },
      switch: switchRecord,
    };
  }

  const verificationAttempts = outcome.attempts.map((attempt) => ({
    kind: "verification-attempt" as const,
    ok: attempt.ok,
    requestCount: attempt.requestCount,
    ...(attempt.stoppedReason
      ? { stoppedReason: attempt.stoppedReason }
      : {}),
    stages: attempt.stages.map((stage) => ({
      contract: stage.contract,
      status: stage.status,
      ...(stage.category ? { category: stage.category } : {}),
      ...(stage.httpStatus !== undefined
        ? { httpStatus: stage.httpStatus }
        : {}),
      summary: stage.summary,
    })),
  }));
  const common = {
    recipe: {
      recipeId: outcome.recipe.recipeId,
      signatureId: outcome.recipe.signatureId,
    },
    recipePreviews: outcome.plan.preview.patches.map((preview) =>
      preview.scope === "exact-model"
        ? {
            recipeId: preview.recipeId,
            scope: preview.scope,
            affectedModels: [...preview.affectedModels],
          }
        : {
            recipeId: preview.recipeId,
            scope: preview.scope,
            provider: preview.provider,
          },
    ),
    verificationAttempts,
  };

  return {
    kind: "repair",
    outcome:
      outcome.status === "committed"
        ? { ...common, status: outcome.status, persisted: true }
        : { ...common, status: outcome.status, persisted: false },
    switch: switchRecord,
  };
}

function createCaseId(now: () => Date, random: () => number): string {
  const utc = now()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const noise = Math.floor(random() * 1e9)
    .toString(36)
    .padStart(6, "0")
    .slice(0, 6);
  return `case_${utc}_${noise}`;
}

function buildSummaryWrite(
  caseId: string,
  evidence: NormalizedProbeRunEvidence,
  repair?: RepairCaseRepairRecord,
): Extract<RepairCaseWrite, { kind: "summary" }> {
  return {
    kind: "summary",
    customType: REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
    content: formatSummaryText(caseId, evidence, repair),
    display: true,
    details: { caseId },
  };
}

function buildDetailWrite(
  caseId: string,
  evidence: NormalizedProbeRunEvidence,
  repair?: RepairCaseRepairRecord,
): Extract<RepairCaseWrite, { kind: "detail" }> {
  const recipeAttempts = repair?.verificationAttempts ?? [];
  return {
    kind: "detail",
    customType: REPAIR_CASE_DETAIL_CUSTOM_TYPE,
    data: {
      caseId,
      target: { ...evidence.target },
      ok: evidence.ok,
      evidence,
      recipeAttempts,
      ...(repair ? { repair } : {}),
    },
  };
}

function formatSummaryText(
  caseId: string,
  evidence: NormalizedProbeRunEvidence,
  repair?: RepairCaseRepairRecord,
): string {
  const target = `${evidence.target.provider}/${evidence.target.modelId}`;
  const contracts = evidence.stages.map((stage) => {
    if (stage.status === "pass") return `${stage.contract}=pass`;
    if (stage.status === "skip") return `${stage.contract}=skip`;
    if (stage.status === "stopped") return `${stage.contract}=stop`;
    return `${stage.contract}=${stage.category}`;
  });
  const stopped = evidence.stoppedReason
    ? ` stop=${evidence.stoppedReason}`
    : "";
  const repairStatus = repair ? ` repair=${repair.status}` : "";
  const switchStatus = repair?.switch
    ? ` switch=${repair.switch.status}`
    : "";
  return redactProbeText(
    `ps-repair-case ${caseId} ${evidence.ok ? "PASS" : "FAIL"} ${target}` +
      ` [${contracts.join(", ")}]${stopped}${repairStatus}${switchStatus}`,
  );
}

function buildRepairRecord(
  event: Extract<RepairCaseEvent, { kind: "repair" }>,
): RepairCaseRepairRecord {
  const { outcome } = event;
  const attempts =
    "verificationAttempts" in outcome ? outcome.verificationAttempts : [];
  let recipe: RepairCaseRepairRecord["recipe"];
  if ("recipe" in outcome) {
    const preview = outcome.recipePreviews.find(
      (item) => item.recipeId === outcome.recipe.recipeId,
    );
    if (!preview) {
      throw new Error(
        `Repair outcome is missing preview for recipe ${outcome.recipe.recipeId}`,
      );
    }
    recipe = buildRecipeRecord(outcome.recipe, preview);
  }

  return {
    status: outcome.status,
    persisted: outcome.persisted,
    ...(recipe ? { recipe } : {}),
    verificationAttempts: attempts.map((attempt, index) => ({
      pass: index + 1,
      ok: attempt.ok,
      requestCount: attempt.requestCount,
      ...(attempt.stoppedReason
        ? { stoppedReason: attempt.stoppedReason }
        : {}),
      stages: attempt.stages.map((stage) => ({
        contract: stage.contract,
        status: stage.status,
        ...(stage.category ? { category: stage.category } : {}),
        ...(stage.httpStatus !== undefined
          ? { httpStatus: stage.httpStatus }
          : {}),
        summary: redactProbeText(stage.summary),
      })),
    })),
    switch: redactSwitchRecord(event.switch),
  };
}

function buildRecipeRecord(
  recipe: { recipeId: string; signatureId: string },
  preview:
    | { scope: "exact-model"; affectedModels: string[] }
    | { scope: "provider-wide"; provider: string },
): NonNullable<RepairCaseRepairRecord["recipe"]> {
  const base = {
    recipeId: recipe.recipeId,
    signatureId: recipe.signatureId,
  };
  if (preview.scope === "exact-model") {
    return {
      ...base,
      scope: preview.scope,
      affectedModels: [...preview.affectedModels],
    };
  }
  return {
    ...base,
    scope: preview.scope,
    provider: preview.provider,
  };
}

function redactSwitchRecord(switchRecord: RepairCaseSwitchRecord): RepairCaseSwitchRecord {
  if (switchRecord.status === "not-offered") return switchRecord;
  if (switchRecord.status === "declined") {
    return { status: switchRecord.status, target: { ...switchRecord.target } };
  }
  return {
    status: switchRecord.status,
    target: { ...switchRecord.target },
    summary: redactProbeText(switchRecord.summary),
  };
}
