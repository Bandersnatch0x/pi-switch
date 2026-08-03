/**
 * Compatibility Probe pure engine (issue #42 / ticket 1 #43).
 *
 * Seam for later tickets: evidence persistence (#44), doctor precheck (#45),
 * repair recipes (#46+). Transport is always injected.
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
} from "./evidence.ts";
export { runProbe } from "./engine.ts";
export { formatProbeResultJson, formatProbeResultSummary } from "./format.ts";
