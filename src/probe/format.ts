/**
 * Headless / structured output for Compatibility Probe results.
 */

import type { ProbeRunResult } from "./types.ts";

/** JSON string suitable for CI / headless consumers (no interaction). */
export function formatProbeResultJson(result: ProbeRunResult): string {
  return JSON.stringify(result, null, 2);
}

/** Compact single-line summary for logs / notify. */
export function formatProbeResultSummary(result: ProbeRunResult): string {
  const target = `${result.target.provider}/${result.target.modelId}`;
  const parts = result.stages.map((s) => {
    const tag =
      s.status === "pass"
        ? "pass"
        : s.status === "skip"
          ? "skip"
          : s.status === "stopped"
            ? "stop"
            : s.category ?? "fail";
    return `${s.contract}=${tag}`;
  });
  const head = result.ok ? "PASS" : "FAIL";
  const stop = result.stoppedReason ? ` stop=${result.stoppedReason}` : "";
  const pre =
    result.precheck && result.precheck.status !== "pass"
      ? ` precheck=${result.precheck.status}`
      : "";
  return `ps-probe ${head} ${target} [${parts.join(", ")}] req=${result.requestCount}/${result.budget.maxRequests}${stop}${pre}`;
}
