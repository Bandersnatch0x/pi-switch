import type { PiApi } from "../types.ts";

const MAP: Record<string, PiApi> = {
  anthropic: "anthropic-messages",
  anthropic_messages: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
  anthropic_message: "anthropic-messages",
  openai_responses: "openai-responses",
  responses: "openai-responses",
  "openai-responses": "openai-responses",
  openai_chat: "openai-completions",
  chat: "openai-completions",
  "chat/completions": "openai-completions",
  "openai-completions": "openai-completions",
  openai_completions: "openai-completions",
  completions: "openai-completions",
  google: "google-generative-ai",
  gemini: "google-generative-ai",
  "google-generative-ai": "google-generative-ai",
  google_generative_ai: "google-generative-ai",
};

export type ResolveApiResult =
  | { ok: true; api: PiApi; source: string }
  | { ok: false; reason: string };

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Map a known protocol string to PiApi, or undefined if unknown. */
export function mapKnownApi(raw: string): PiApi | undefined {
  const key = normalizeKey(raw);
  if (MAP[key]) return MAP[key];
  // soft aliases
  if (key.includes("anthropic")) return "anthropic-messages";
  if (key.includes("response")) return "openai-responses";
  if (key.includes("chat") || key.includes("completion")) return "openai-completions";
  if (key.includes("gemini") || key.includes("google")) return "google-generative-ai";
  return undefined;
}

/**
 * Resolve API per SPEC §5.1:
 * 1. Explicit meta.apiFormat — if present and unmappable → fail (no silent fallback)
 * 2. type-specific hint
 * 3. app_type default only when no explicit format was declared
 */
export function resolveApi(opts: {
  apiFormat?: string | null;
  typeHint?: string | null;
  appTypeDefault?: PiApi | null;
}): ResolveApiResult {
  const explicit = opts.apiFormat?.trim();
  if (explicit) {
    const mapped = mapKnownApi(explicit);
    if (mapped) return { ok: true, api: mapped, source: "apiFormat" };
    return { ok: false, reason: `unsupported apiFormat: ${explicit}` };
  }

  const hint = opts.typeHint?.trim();
  if (hint) {
    const mapped = mapKnownApi(hint);
    if (mapped) return { ok: true, api: mapped, source: "typeHint" };
  }

  if (opts.appTypeDefault) {
    return { ok: true, api: opts.appTypeDefault, source: "appTypeDefault" };
  }

  return { ok: false, reason: "unable to resolve api protocol" };
}

/** Map opencode npm package to api. */
export function apiFromOpencodeNpm(npm: string | undefined): PiApi | undefined {
  if (!npm) return undefined;
  const n = npm.toLowerCase();
  if (n.includes("anthropic")) return "anthropic-messages";
  if (n.includes("google") || n.includes("gemini")) return "google-generative-ai";
  // openai-compatible and other openai-family packages
  if (n.includes("openai") || n.includes("ai-sdk")) return "openai-completions";
  return undefined;
}
