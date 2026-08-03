/**
 * Compatibility Probe pure engine (issue #42 / tickets 1–2).
 *
 * Seam for later tickets: doctor precheck (#45), repair recipes (#46+).
 * Transport is always injected; evidence persistence is dual-layer Repair Case.
 */

export {
  DEFAULT_PROBE_CONTRACTS,
  PROBE_MAX_REQUESTS,
  PROBE_MAX_TOKENS,
  PROBE_TIMEOUT_MS,
} from "./types.ts";
export type {
  ProbeAssistantMessage,
  ProbeBudgetSnapshot,
  ProbeCompleteOptions,
  ProbeContentBlock,
  ProbeContext,
  ProbeContractId,
  ProbeEngineOptions,
  ProbeFailureCategory,
  ProbeRequest,
  ProbeRunResult,
  ProbeStageResult,
  ProbeStageStatus,
  ProbeStopReason,
  ProbeStoppedReason,
  ProbeTarget,
  ProbeToolDef,
  ProbeTransport,
  ProbeTransportResult,
  ProbeUserMessage,
} from "./types.ts";

export { PROBE_ECHO_TOOL, buildContractRequest } from "./contracts.ts";
export {
  classifyHttpStatus,
  classifyStageFailure,
  evaluateContract,
  normalizeProbeRun,
  normalizeStageEvidence,
  pickAllowedHeaderNames,
  redactProbeText,
  resolveSignatureId,
} from "./evidence.ts";
export type {
  ClassifiedFailure,
  ContractEval,
  NormalizeProbeRunInput,
  NormalizedEvidenceCategory,
  NormalizedProbeRunEvidence,
  NormalizedStageEvidence,
  ProbeEvidenceSignatureId,
  RawProbeObservation,
} from "./evidence.ts";
export {
  REPAIR_CASE_DETAIL_CUSTOM_TYPE,
  REPAIR_CASE_SUMMARY_CUSTOM_TYPE,
  buildRepairCaseLayers,
  createCaseId,
  formatRepairCaseSummaryText,
  projectRepairCaseIntoContext,
} from "./repair-case.ts";
export type {
  RepairCaseDetailData,
  RepairCaseDetailSessionEntry,
  RepairCaseSessionLayers,
  RepairCaseSummaryData,
  RepairCaseSummarySessionEntry,
} from "./repair-case.ts";
export { runProbe } from "./engine.ts";
export { formatProbeResultJson, formatProbeResultSummary } from "./format.ts";
