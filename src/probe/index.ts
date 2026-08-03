/**
 * Compatibility Probe pure engine (issue #42 / tickets 1–7, 9).
 *
 * Recipe registry + evidence gate (#47) admit whitelist recipes only.
 * Recipe3 gemini tool compat (#49) enables per-provider geminiToolCompat.
 * Repair Case session context (#50) projects short summaries after Session Model switches.
 * Transport + doctor precheck + config store are always injectable; zero network in unit tests.
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
  buildRepairCaseLayers,
  createCaseId,
  createRepairCaseSession,
  formatRepairCaseSummaryText,
  projectRepairCaseIntoContext,
  projectSessionModelContext,
  recordRepairCase,
  switchSessionModel,
} from "./repair-case.ts";
export type {
  CreateRepairCaseSessionOptions,
  ProjectedSessionModelContext,
  RepairCaseDetailData,
  RepairCaseDetailSessionEntry,
  RepairCaseModelChangeEntry,
  RepairCaseSession,
  RepairCaseSessionLayers,
  RepairCaseSessionTranscriptEntry,
  RepairCaseSummaryData,
  RepairCaseSummarySessionEntry,
  SessionModelRef,
} from "./repair-case.ts";
export {
  PROBE_TARGET_PRECHECK_DIMENSIONS,
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
export { runProbe } from "./engine.ts";
export { formatProbeResultJson, formatProbeResultSummary } from "./format.ts";
export {
  applyPatchToTarget,
  matchRepairRecipes,
} from "./recipes.ts";
export type {
  RepairPatch,
  RepairPatchModelMeta,
  RepairPatchProviderFingerprint,
  RepairPatchProviderGeminiToolCompat,
  RepairRecipeId,
  RepairRecipeMatch,
} from "./recipes.ts";
export {
  CLIENT_FINGERPRINT_RECIPE_DEFINITION,
  DEFAULT_RECIPE_DEFINITIONS,
  GEMINI_TOOL_COMPAT_RECIPE_DEFINITION,
  REASONING_FALSE_RECIPE_DEFINITION,
  admitRecipes,
  createRecipeRegistry,
  evaluateRecipeGate,
  getAdmittedRecipe,
  isRecipeAdmitted,
  listAdmittedRecipes,
  registerRecipeDefinitions,
  resetRecipeRegistry,
} from "./recipe-registry.ts";
export type {
  RecipeAdmitResult,
  RecipeClass,
  RecipeFixture,
  RecipeGateDecision,
  RecipePatchScope,
  RecipeRegistry,
  RecipeSupportWindow,
  RepairRecipeDefinition,
} from "./recipe-registry.ts";
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
