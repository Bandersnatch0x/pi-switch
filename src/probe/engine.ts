/**
 * Compatibility Probe engine — stages, budget, stop conditions (ticket 1 #43).
 *
 * Pure orchestration: inject transport (faux complete in tests).
 * Never calls setModel; never carries session history.
 */

import { buildContractRequest } from "./contracts.ts";
import { classifyStageFailure, evaluateContract } from "./evidence.ts";
import {
  DEFAULT_PROBE_CONTRACTS,
  PROBE_MAX_REQUESTS,
  PROBE_MAX_TOKENS,
  PROBE_TIMEOUT_MS,
  type ProbeContractId,
  type ProbeEngineOptions,
  type ProbeRunResult,
  type ProbeStageResult,
  type ProbeStoppedReason,
  type ProbeTarget,
} from "./types.ts";

function planContracts(
  target: ProbeTarget,
  contracts?: ProbeContractId[],
): {
  /** Contracts to execute (order preserved). */
  order: ProbeContractId[];
  /** Pre-built skip stages keyed by contract. */
  skips: Map<ProbeContractId, ProbeStageResult>;
} {
  const order = contracts?.length ? [...contracts] : [...DEFAULT_PROBE_CONTRACTS];
  const skips = new Map<ProbeContractId, ProbeStageResult>();

  for (const c of order) {
    if (c === "reasoning" && !target.reasoning) {
      skips.set(c, {
        contract: "reasoning",
        status: "skip",
        summary: "skipped: target does not claim reasoning support",
        requestCount: 0,
      });
    }
  }

  return { order, skips };
}

/**
 * Run a Compatibility Probe against a Probe Target.
 * Read-only: does not change configuration or Session Model.
 */
export async function runProbe(opts: ProbeEngineOptions): Promise<ProbeRunResult> {
  const maxRequests = opts.maxRequests ?? PROBE_MAX_REQUESTS;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? PROBE_MAX_TOKENS;
  const createSignal =
    opts.createSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const now = opts.now ?? (() => Date.now());

  const { order, skips } = planContracts(opts.target, opts.contracts);
  const stages: ProbeStageResult[] = [];

  let requestCount = 0;
  let stoppedReason: ProbeStoppedReason | undefined;
  let halt = false;
  let haltSummary = "";

  for (const contract of order) {
    const skip = skips.get(contract);
    if (skip) {
      stages.push(skip);
      continue;
    }

    if (halt) {
      stages.push({
        contract,
        status: "stopped",
        summary: haltSummary,
        requestCount: 0,
      });
      continue;
    }

    if (requestCount >= maxRequests) {
      halt = true;
      stoppedReason = "budget";
      haltSummary = "stopped: request budget exhausted";
      stages.push({
        contract,
        status: "stopped",
        summary: haltSummary,
        requestCount: 0,
      });
      continue;
    }

    const built = buildContractRequest(contract, now());
    const signal = createSignal(timeoutMs);

    requestCount += 1;
    const transportResult = await opts.transport({
      contract,
      model: opts.model,
      context: built.context,
      options: {
        maxTokens,
        signal,
        ...built.optionExtras,
      },
    });

    const evaluation = evaluateContract(contract, transportResult);

    if (evaluation.ok) {
      stages.push({
        contract,
        status: "pass",
        summary: evaluation.summary,
        requestCount: 1,
        httpStatus: transportResult.httpStatus,
      });
      continue;
    }

    const failure = classifyStageFailure(evaluation, transportResult.httpStatus);
    stages.push({
      contract,
      status: "fail",
      category: failure.category,
      unrepairable: failure.unrepairable || undefined,
      httpStatus: transportResult.httpStatus,
      summary: failure.summary,
      requestCount: 1,
    });

    halt = true;
    if (failure.hardStop) {
      stoppedReason = "unrepairable";
      haltSummary = `stopped: unrepairable (${failure.category})`;
    } else {
      stoppedReason = "failure";
      haltSummary = "stopped: previous stage failed";
    }
  }

  const hasFailOrStopped = stages.some(
    (s) => s.status === "fail" || s.status === "stopped",
  );
  const ok = !hasFailOrStopped;

  return {
    target: { ...opts.target },
    stages,
    ok,
    stoppedReason,
    requestCount,
    budget: {
      maxRequests,
      used: requestCount,
      maxTokens,
      timeoutMs,
    },
  };
}
