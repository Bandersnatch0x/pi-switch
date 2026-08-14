/**
 * Compatibility Probe pure engine (issue #42 / tickets 1–9).
 *
 * Static first-party recipes admit normalized evidence only.
 * Recipe3 gemini tool compat (#49) enables per-provider geminiToolCompat.
 * Repair Case session context (#50) projects short summaries after Session Model switches.
 * Target pick + post-success switch action (#51) default/reselect without setModel;
 * explicit repaired-target switch routes through injected lifecycle activate.
 * Transport + doctor precheck + config store are always injectable; zero network in unit tests.
 */

export {
  DEFAULT_PROBE_CONTRACTS,
  PROBE_MAX_REQUESTS,
  PROBE_MAX_TOKENS,
  PROBE_REASONING_MAX_TOKENS,
  PROBE_TIMEOUT_MS,
  probeMaxTokensFor,
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
  ProbePrecheckInput,
  ProbeRequest,
  ProbeRunPrecheckSnapshot,
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
  ProbeVerificationOptions,
  ProbeVerifier,
} from "./types.ts";

export { PROBE_ECHO_TOOL, buildContractRequest } from "./contracts.ts";
export {
  classifyHttpStatus,
  classifyStageFailure,
  clientGateSignatureId,
  detectUniqueClientGate,
  evaluateContract,
  hasEmptyProbeEchoArgs,
  normalizeProbeRun,
  normalizeStageEvidence,
  pickAllowedHeaderNames,
  redactProbeText,
  resolveSignatureId,
} from "./evidence.ts";
export type {
  ClassifiedFailure,
  ClientGateFingerprint,
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
  createInMemoryRepairCaseWriteAdapter,
  createRepairCaseRepairEvent,
  createRepairCaseRecorder,
} from "./repair-case.ts";
export type {
  InMemoryRepairCaseWriteAdapter,
  RepairCaseCancelledOutcome,
  RepairCaseDetailData,
  RepairCaseEvent,
  RepairCaseRecorder,
  RepairCaseRepairRecord,
  RepairCaseRepairOutcome,
  RepairCaseRecipePreview,
  RepairCaseSwitchRecord,
  RepairCaseVerificationAttempt,
  RepairCaseVerificationAttemptInput,
  RepairCaseWrite,
  RepairCaseWriteAdapter,
} from "./repair-case.ts";
export {
  PROBE_TARGET_PRECHECK_DIMENSIONS,
  capabilitySoftCheck,
  runTargetDoctorPrecheck,
} from "./precheck.ts";
export type {
  ProbePrecheckCheck,
  ProbePrecheckDimension,
  ProbePrecheckResult,
  ProbePrecheckSoftCheck,
  ProbePrecheckStatus,
  TargetDoctorPrecheckInput,
} from "./precheck.ts";
export { createProbeVerifier, runProbe } from "./engine.ts";
export { formatProbeResultJson, formatProbeResultSummary } from "./format.ts";
export {
  FIRST_PARTY_REPAIR_RECIPES,
  applyRepairCandidateToConfigDocument,
  applyRepairCandidateToProbeTarget,
  matchRepairRecipes,
} from "./recipes.ts";
export type {
  FirstPartyRepairRecipe,
  ProtocolGenericRepairRecipe,
  RecipeClass,
  RecipeFixture,
  RecipePatchScope,
  RecipeSupportWindow,
  RelaySpecificRepairRecipe,
  RepairCandidate,
  RepairCandidateModelMeta,
  RepairCandidateProviderFingerprint,
  RepairCandidateProviderGeminiToolCompat,
  RepairRecipeId,
  RepairRecipeMatch,
} from "./recipes.ts";
export { buildRepairPlan, runRepair } from "./repair.ts";
export type {
  RepairConfigCommitInput,
  RepairConfigCommitResult,
  RepairConfigSnapshot,
  RepairConfigStore,
  RepairMode,
  RepairOutcome,
  RepairPlan,
  RepairPlanPreview,
  RepairPlanPreviewPatch,
  RepairSwitchAction,
  RunRepairOptions,
} from "./repair.ts";
export {
  defaultProbeTargetHighlight,
  findProviderForProbeTarget,
  resolveProbeTarget,
  selectProbeTarget,
} from "./target-pick.ts";
export type {
  DefaultProbeTargetHighlightInput,
  ExplicitProbeTargetPick,
  OnSetModelSpy,
  ProbeTargetEnrichment,
  ProbeTargetPickHint,
  ProbeTargetSource,
  ResolveProbeTargetErr,
  ResolveProbeTargetInput,
  ResolveProbeTargetOk,
  ResolveProbeTargetReason,
  ResolveProbeTargetResult,
  SelectProbeTargetOptions,
} from "./target-pick.ts";
export {
  executeRepairSwitchAction,
  hasRepairSwitchAction,
} from "./switch-action.ts";
export type {
  ExecuteRepairSwitchDeps,
  ExecuteRepairSwitchErr,
  ExecuteRepairSwitchOk,
  ExecuteRepairSwitchResult,
  LifecycleActivationResult,
  LifecycleSwitchTarget,
} from "./switch-action.ts";
