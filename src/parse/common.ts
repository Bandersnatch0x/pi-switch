/** Shared pure helpers for parsers. No IO. */

/** Trim only — never strip brackets, case-fold, or slug model ids (SPEC §5.10). */
export function trimModelId(raw: string): string {
  return raw.trim();
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "").trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase slug for appType segment of piName. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

/** Stable registration name: ps-<slug(appType)>-<full dbId> */
export function makePiName(appType: string, dbId: string): string {
  return `ps-${slug(appType)}-${dbId}`;
}

/** Read a `key = "value"` string assignment from a TOML fragment. */
export function extractTomlValue(toml: string, key: string): string | undefined {
  const m = toml.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`));
  return m?.[1];
}

/** Read unquoted TOML string or simple identifier assignment. */
export function extractTomlLoose(toml: string, key: string): string | undefined {
  const quoted = extractTomlValue(toml, key);
  if (quoted !== undefined) return quoted;
  const m = toml.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*([^\\n#]+)`));
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

export function uniqueModels(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = trimModelId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function safeJsonParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseMeta(metaRaw: string | null | undefined): Record<string, unknown> {
  if (!metaRaw) return {};
  const v = safeJsonParse(metaRaw);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
