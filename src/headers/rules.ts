import type { HeaderRule, HeaderRulesFile } from "../types.ts";

/** Parse a headers rules file (defaults or provider-headers.json). */
export function parseHeaderRulesFile(raw: unknown): HeaderRule[] {
  if (!raw || typeof raw !== "object") return [];
  const rules = (raw as HeaderRulesFile).rules;
  if (!Array.isArray(rules)) return [];
  const out: HeaderRule[] = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.name !== "string") continue;
    if (!Array.isArray(r.apis) || !r.headers || typeof r.headers !== "object") continue;
    out.push({
      name: r.name,
      apis: r.apis.filter((a): a is string => typeof a === "string"),
      headers: Object.fromEntries(
        Object.entries(r.headers).filter(
          (e): e is [string, string] => typeof e[0] === "string" && typeof e[1] === "string",
        ),
      ),
    });
  }
  return out;
}

/** Concatenate rule lists; later files should be appended so merge can still apply by api. */
export function combineRules(...lists: HeaderRule[][]): HeaderRule[] {
  return lists.flat();
}
