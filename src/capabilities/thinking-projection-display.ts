import type {
  NativeReasoningValue,
  ThinkingIntentProjection,
  ThinkingProjectionDecision,
} from "./thinking-projection.ts";
import { nativeReasoningEffort } from "./thinking-projection.ts";

function nativeLabel(value: NativeReasoningValue): string {
  const effort = nativeReasoningEffort(value);
  if (effort) return effort;
  switch (value.type) {
    case "toggle":
      return value.enabled ? "enabled" : "disabled";
    case "budget_tokens":
      return `${value.tokens} tokens`;
    case "composite":
      return value.values.map(nativeLabel).join("+");
    case "effort":
      return value.value;
  }
}

function sourceLabel(decision: ThinkingProjectionDecision): string {
  const source = decision.source ?? "unknown-source";
  return decision.observedAt ? `${source}@${decision.observedAt}` : source;
}

function hasUnrepresented(
  decision: ThinkingProjectionDecision,
  value: string,
): boolean {
  return decision.unrepresented.some(
    (candidate) => nativeReasoningEffort(candidate) === value,
  );
}

function projectionDetail(
  decision: ThinkingProjectionDecision,
  projection: ThinkingIntentProjection,
): string | undefined {
  if (projection.intent === "provider-default") {
    const native = projection.native ? `; native ${nativeLabel(projection.native)}` : "";
    const effective = projection.effectiveLevel
      ? `; effective ${projection.effectiveLevel}`
      : "";
    return `provider-default: no override sent${native}${effective}`;
  }

  if (projection.status === "exact" && projection.native) {
    return `${projection.intent} -> ${nativeLabel(projection.native)} (exact, ${sourceLabel(decision)})`;
  }

  if (projection.status === "lossy" && projection.native) {
    const providerValue = nativeLabel(projection.native);
    const scope = projection.scope ? `${projection.scope}, ` : "";
    const effective =
      projection.effectiveLevel && projection.effectiveLevel !== projection.intent
        ? ` -> effective ${projection.effectiveLevel}`
        : "";
    const displaced = hasUnrepresented(decision, projection.intent)
      ? `; native ${projection.intent} unavailable`
      : "";
    return `Pi ${projection.intent} -> provider ${providerValue}${effective} (${scope}${sourceLabel(decision)}${displaced})`;
  }

  if (projection.status === "unverified") {
    return `${projection.intent}: unverified${projection.reason ? ` (${projection.reason})` : ""}`;
  }

  if (projection.status === "unsupported" && decision.status === "unsupported") {
    return `${projection.intent}: unsupported${projection.reason ? ` (${projection.reason})` : ""}`;
  }

  return undefined;
}

/** Redacted projection detail for doctor/info surfaces. */
export function formatThinkingProjectionDetail(
  decision: ThinkingProjectionDecision,
): string {
  const displayedStatus =
    decision.status === "unsupported" &&
    decision.runtime.runtimeVerified &&
    !decision.runtime.payloadVerified
      ? "unsupported-runtime"
      : decision.status;
  const rows = [`thinking=${displayedStatus}`];
  if (decision.control?.type === "fixed") {
    rows.push("reasoning is fixed for this model; no selectable level");
  } else if (decision.control) {
    rows.push(`control=${decision.control.type}`);
  }

  for (const projection of decision.projections) {
    const detail = projectionDetail(decision, projection);
    if (detail) rows.push(detail);
  }

  for (const collision of decision.collisions) {
    rows.push(
      `collision: ${collision.intents.join("/")} -> effective ${collision.effectiveLevel} (provider ${collision.providerValues.join("/")})`,
    );
  }

  for (const value of decision.unrepresented) {
    rows.push(
      `${nativeLabel(value)} advertised but not selectable by this Pi runtime`,
    );
  }

  for (const warning of decision.warnings) rows.push(warning);
  if (decision.stale) rows.push("stale last-good reasoning profile");
  return rows.join("; ");
}

/** Projection states that should raise the shared capability check to WARN. */
export function thinkingProjectionNeedsWarning(
  decision: ThinkingProjectionDecision,
): boolean {
  return (
    decision.stale ||
    decision.status === "lossy" ||
    decision.status === "unsupported" ||
    decision.status === "unverified" ||
    decision.collisions.length > 0 ||
    decision.warnings.length > 0
  );
}
