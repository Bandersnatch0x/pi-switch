import {
  HEADER_ALLOWLIST,
  HEADER_CANONICAL,
  type HeaderRule,
  type PiApi,
} from "../types.ts";

export interface MergeHeadersInput {
  api: PiApi | null;
  /** From defaults/headers.json + provider-headers.json rules */
  rules: HeaderRule[];
  /** Per-dbId overrides (already extracted) */
  overrideHeaders?: Record<string, string>;
  /** Variable substitutions e.g. {codexVersion} */
  vars?: Record<string, string>;
  debug?: boolean;
  onReject?: (name: string, reason: string) => void;
}

/** Case-insensitive merge with allowlist filter. Higher priority sources last. */
export function mergeHeaders(input: MergeHeadersInput): Record<string, string> {
  const acc = new Map<string, string>(); // lower-name → value

  const apply = (headers: Record<string, string> | undefined, source: string) => {
    if (!headers) return;
    for (const [rawName, rawVal] of Object.entries(headers)) {
      const lower = rawName.toLowerCase();
      if (!HEADER_ALLOWLIST.has(lower)) {
        input.onReject?.(rawName, `not in allowlist (source=${source})`);
        continue;
      }
      if (typeof rawVal !== "string" || !rawVal.trim()) continue;
      acc.set(lower, substitute(rawVal, input.vars ?? {}));
    }
  };

  // 1. rules matching api (package defaults + shared file already merged by caller order)
  if (input.api) {
    for (const rule of input.rules) {
      if (rule.apis.map((a) => a.toLowerCase()).includes(input.api.toLowerCase())) {
        apply(rule.headers, `rule:${rule.name}`);
      }
    }
  }

  // 2. per-provider overrides win
  apply(input.overrideHeaders, "providerOverrides");

  const out: Record<string, string> = {};
  for (const [lower, value] of acc) {
    const canon = HEADER_CANONICAL[lower] ?? lower;
    out[canon] = value;
  }
  return out;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

/** Filter an arbitrary header map to the allowlist only. */
export function filterAllowlisted(
  headers: Record<string, string>,
  onReject?: (name: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (!HEADER_ALLOWLIST.has(lower)) {
      onReject?.(k);
      continue;
    }
    out[HEADER_CANONICAL[lower] ?? k] = v;
  }
  return out;
}
