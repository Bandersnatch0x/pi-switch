/** Shared pure helpers for parsers. No IO. */

/** Trim only — never strip brackets, case-fold, or slug model ids (SPEC §5.10). */
export function trimModelId(raw: string): string {
  return raw.trim();
}

/**
 * cc-switch / Claude Code often tag 1M-context variants as `name[1M]` / `name[1m]`.
 * pi-switch hides these in pickers: anyrouter (and similar) treat the gate via
 * anthropic-beta, not via the bracket tag; listing both confuses selection.
 * Registration still accepts an explicit manual id if the user types one.
 */
export function isBracket1mModelId(id: string): boolean {
  return /\[1[Mm]\]\s*$/.test(id.trim());
}

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "").trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lowercase slug for piName / appType segments.
 * Keeps CJK so Chinese display names stay readable in the status bar.
 */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * Registration name shown in Pi status bar.
 * Prefer human-readable displayName slug; fall back to stable ps-<appType>-<dbId>.
 * Persistent identity remains dbId; piName is regenerative.
 */
export function makePiName(displayName: string, appType: string, dbId: string): string {
  const fromName = slug(displayName);
  if (fromName && fromName !== "unknown") return fromName;
  return `ps-${slug(appType)}-${dbId}`;
}

/**
 * Ensure piNames are unique within a provider list.
 * First occurrence keeps the readable base; later collisions get a short dbId suffix.
 */
export function uniquifyPiNames<T extends { id: string; piName: string }>(providers: T[]): T[] {
  const used = new Set<string>();
  return providers.map((p) => {
    let name = p.piName;
    if (used.has(name)) {
      const short = p.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "x";
      name = `${p.piName}-${short}`;
      let i = 2;
      while (used.has(name)) {
        name = `${p.piName}-${short}-${i++}`;
      }
    }
    used.add(name);
    return name === p.piName ? p : { ...p, piName: name };
  });
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
