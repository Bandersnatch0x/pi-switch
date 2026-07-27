/**
 * Spike 001 — throwaway. Do NOT ship.
 *
 * Validates whether anyrouter.top needs anthropic-beta context-1m
 * (and/or contextWindow=1M metadata) for models with [1M] suffix.
 *
 * Usage:
 *   bun spikes/001-anyrouter-1m-beta/probe.mjs
 *   ANYROUTER_KEY=sk-... ANYROUTER_BASE=https://anyrouter.top bun ...
 *
 * Key resolution: env ANYROUTER_KEY → first claude anyrouter row in cc-switch.db
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.ANYROUTER_BASE ?? "https://anyrouter.top").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 25_000);
const RESULTS_PATH = join(import.meta.dir, "results.json");

const FALLBACK_BETA =
  "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
const CONTEXT_1M = "context-1m-2025-08-07";

function resolveKeys() {
  if (process.env.ANYROUTER_KEY?.trim()) return [process.env.ANYROUTER_KEY.trim()];
  const db = process.env.CC_SWITCH_DB?.trim() || join(homedir(), ".cc-switch", "cc-switch.db");
  if (!existsSync(db)) throw new Error(`no key: set ANYROUTER_KEY or provide ${db}`);
  // Both anyrouter claude keys — first account previously returned real 1M-context errors.
  const sql = `
SELECT name, json_extract(settings_config, '$.env.ANTHROPIC_AUTH_TOKEN') AS k
FROM providers
WHERE settings_config LIKE '%anyrouter.top%'
  AND app_type = 'claude'
  AND json_extract(settings_config, '$.env.ANTHROPIC_AUTH_TOKEN') IS NOT NULL
ORDER BY CASE WHEN name LIKE '%copy%' THEN 1 ELSE 0 END, name;
`.trim();
  const raw = execFileSync("sqlite3", ["-readonly", "-json", db, sql], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const rows = raw ? JSON.parse(raw) : [];
  const keys = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.k && !seen.has(r.k)) {
      seen.add(r.k);
      keys.push(r.k);
    }
  }
  if (!keys.length) throw new Error("no ANTHROPIC_AUTH_TOKEN found for anyrouter claude providers");
  return keys;
}

function resolveModels(key) {
  // Prefer models from the same provider row that supplied the key path.
  // Fall back to a fixed probe list if DB parse fails.
  const defaults = [
    "claude-opus-4-8",
    "claude-opus-4-8[1M]",
    "claude-opus-5",
    "claude-opus-5[1M]",
    "claude-fable-5",
    "claude-fable-5[1M]",
  ];
  try {
    const db = process.env.CC_SWITCH_DB?.trim() || join(homedir(), ".cc-switch", "cc-switch.db");
    const sql = `
SELECT name, settings_config FROM providers
WHERE settings_config LIKE '%anyrouter.top%' AND app_type='claude'
ORDER BY CASE WHEN name LIKE '%copy%' THEN 0 ELSE 1 END LIMIT 1;
`.trim();
    const raw = execFileSync("sqlite3", ["-readonly", "-json", db, sql], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const row = raw ? JSON.parse(raw)[0] : null;
    if (!row) return defaults;
    const env = JSON.parse(row.settings_config)?.env ?? {};
    const ids = new Set();
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== "string") continue;
      if (/MODEL$/.test(k) && !/NAME$/.test(k) && v.trim()) ids.add(v.trim());
    }
    // Always include plain + [1M] variants of the primary model for A/B
    const primary = env.ANTHROPIC_MODEL?.trim();
    if (primary) {
      ids.add(primary);
      ids.add(primary.replace(/\[1[Mm]\]$/, ""));
      if (!/\[1[Mm]\]$/.test(primary)) ids.add(`${primary}[1M]`);
    }
    return ids.size ? [...ids] : defaults;
  } catch {
    return defaults;
  }
}

/** Matrix: what the proposed product fix would control. */
function buildCases(models) {
  const cases = [];
  for (const model of models) {
    const is1m = /\[1[Mm]\]$/.test(model);
    cases.push(
      {
        id: `${model}__plain`,
        model,
        label: "no beta extras",
        headers: { "anthropic-version": "2023-06-01" },
        expects: is1m ? "likely-1m-error" : "maybe-ok",
      },
      {
        id: `${model}__pi-default-beta`,
        model,
        label: "pi-switch default anthropic-beta (no context-1m)",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": FALLBACK_BETA,
          "User-Agent": "claude-cli/2.1.178 (external, cli)",
        },
        expects: is1m ? "likely-1m-error" : "maybe-ok",
      },
      {
        id: `${model}__with-context-1m`,
        model,
        label: "default beta + context-1m (proposed fix)",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": `${FALLBACK_BETA},${CONTEXT_1M}`,
          "User-Agent": "claude-cli/2.1.178 (external, cli)",
        },
        expects: is1m ? "should-unlock-1m" : "maybe-ok",
      },
      {
        id: `${model}__context-1m-only`,
        model,
        label: "context-1m only (minimal)",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": CONTEXT_1M,
        },
        expects: is1m ? "should-unlock-1m" : "maybe-ok",
      },
    );
  }
  return cases;
}

async function postMessage(key, model, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const body = {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
    stream: false,
  };
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    return {
      ok: res.ok,
      status: res.status,
      error: extractError(json),
      type: json?.type ?? json?.error?.type,
      // never store content that might echo secrets
      hasContent: Boolean(json?.content),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: msg, type: "network" };
  } finally {
    clearTimeout(timer);
  }
}

function extractError(json) {
  if (!json || typeof json !== "object") return undefined;
  if (typeof json.error === "string") return json.error.slice(0, 200);
  if (json.error && typeof json.error === "object") {
    const m = json.error.message ?? json.error.error;
    if (typeof m === "string") return m.slice(0, 200);
  }
  if (typeof json.message === "string") return json.message.slice(0, 200);
  if (json.raw) return String(json.raw).slice(0, 200);
  return undefined;
}

function classify(result) {
  const e = (result.error ?? "").toLowerCase();
  const raw = result.error ?? "";
  if (result.ok && result.hasContent) return "SUCCESS";
  if (result.ok) return "OK_EMPTY";
  if (result.status === 0) return "NETWORK";
  // Access denial first — error text often embeds model id like `claude-x[1M]`.
  if (
    raw.includes("无权") ||
    e.includes("permission") ||
    e.includes("no access") ||
    e.includes("not allowed") ||
    e.includes("does not have access") ||
    (result.status === 403 && !raw.includes("上下文"))
  ) {
    return "NO_MODEL_ACCESS";
  }
  // anyrouter / NewAPI 1M gate (Chinese). Do NOT match bare "1m" inside model ids.
  if (
    raw.includes("启用1m") ||
    raw.includes("启用 1m") ||
    raw.includes("1m 上下文") ||
    raw.includes("1m上下文") ||
    (raw.includes("上下文") && (raw.includes("全量") || raw.includes("启用")))
  ) {
    return "NEED_1M_CONTEXT";
  }
  if (e.includes("rate") || result.status === 429) return "RATE_LIMIT";
  if (result.status === 401) return "AUTH";
  if (result.status >= 500) return "UPSTREAM_5XX";
  return `HTTP_${result.status}`;
}

async function main() {
  const keys = resolveKeys();
  // Tight model set for reliability under flaky TLS
  const uniqueModels = [...new Set(resolveModels())].filter(Boolean).slice(0, 4);
  // Prefer one plain + one [1M] when available
  const preferred = [];
  const plain = uniqueModels.find((m) => !/\[1[Mm]\]$/.test(m));
  const oneM = uniqueModels.find((m) => /\[1[Mm]\]$/.test(m));
  if (plain) preferred.push(plain);
  if (oneM) preferred.push(oneM);
  if (!preferred.length) preferred.push(...uniqueModels.slice(0, 2));
  // Always probe a known pair if list is sparse
  for (const m of ["claude-opus-4-8", "claude-opus-4-8[1M]"]) {
    if (!preferred.includes(m)) preferred.push(m);
  }
  const models = preferred.slice(0, 3);
  const cases = buildCases(models);

  console.log(`base=${BASE}`);
  console.log(`keys=${keys.length} (values redacted)`);
  console.log(`models=${models.join(", ")}`);
  console.log(`cases_per_key=${cases.length}`);
  console.log("---");

  const results = [];
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    console.log(`\n## key#${ki + 1}`);
    for (const c of cases) {
      // One retry on pure network flake
      let r = await postMessage(key, c.model, c.headers);
      if (r.status === 0) {
        await new Promise((res) => setTimeout(res, 800));
        r = await postMessage(key, c.model, c.headers);
      }
      const kind = classify(r);
      const row = {
        keyIndex: ki + 1,
        id: c.id,
        model: c.model,
        label: c.label,
        expects: c.expects,
        status: r.status,
        kind,
        error: r.error,
        hasContent: r.hasContent,
      };
      results.push(row);
      const mark = kind === "SUCCESS" || kind === "OK_EMPTY" ? "✓" : "✗";
      console.log(`${mark} [${kind}] k${ki + 1}/${c.id}`);
      if (r.error) console.log(`    ${r.error}`);
    }
  }

  // Aggregate verdict signals across all keys
  const byKind = {};
  for (const r of results) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  const oneMRows = results.filter((r) => /\[1[Mm]\]$/.test(r.model));
  const plainRows = results.filter((r) => !/\[1[Mm]\]$/.test(r.model));

  const pairOnSameKey = (model, beforeSuffix, afterSuffix) => {
    for (const ki of new Set(results.map((r) => r.keyIndex))) {
      const before = results.find(
        (r) => r.keyIndex === ki && r.id === `${model}__${beforeSuffix}`,
      );
      const after = results.find(
        (r) => r.keyIndex === ki && r.id === `${model}__${afterSuffix}`,
      );
      if (before && after) return { before, after, keyIndex: ki };
    }
    return null;
  };

  const signals = {
    oneMNeedsContextFlag: oneMRows.some((r) => r.kind === "NEED_1M_CONTEXT"),
    defaultBetaStillNeeds1m: oneMRows.some(
      (r) => r.id.endsWith("__pi-default-beta") && r.kind === "NEED_1M_CONTEXT",
    ),
    context1mClearsNeedFlag: models
      .filter((m) => /\[1[Mm]\]$/.test(m))
      .some((m) => {
        const pair = pairOnSameKey(m, "pi-default-beta", "with-context-1m");
        return (
          pair &&
          pair.before.kind === "NEED_1M_CONTEXT" &&
          pair.after.kind !== "NEED_1M_CONTEXT" &&
          pair.after.kind !== "NETWORK"
        );
      }),
    context1mFullSuccess: oneMRows.some(
      (r) =>
        (r.id.endsWith("__with-context-1m") || r.id.endsWith("__context-1m-only")) &&
        (r.kind === "SUCCESS" || r.kind === "OK_EMPTY"),
    ),
    plainWorksWithout1m: plainRows.some(
      (r) =>
        r.id.endsWith("__pi-default-beta") &&
        (r.kind === "SUCCESS" || r.kind === "OK_EMPTY"),
    ),
    accessDeniedDominates:
      (byKind.NO_MODEL_ACCESS ?? 0) > results.filter((r) => r.kind !== "NETWORK").length / 2,
    networkDominates: (byKind.NETWORK ?? 0) > results.length / 2,
  };

  let verdict = "INVALIDATED";
  let reason = "";
  if (signals.context1mFullSuccess) {
    verdict = "VALIDATED";
    reason = "Adding context-1m beta unlocks [1M] models on anyrouter (got SUCCESS).";
  } else if (signals.context1mClearsNeedFlag) {
    verdict = "PARTIAL";
    reason =
      "context-1m clears NEED_1M_CONTEXT on the same key/model, but full chat success still blocked (auth/access/upstream). Product header merge still justified.";
  } else if (signals.oneMNeedsContextFlag && !signals.context1mClearsNeedFlag) {
    // Did we even get a comparable after-row?
    const hadAfter = oneMRows.some((r) => r.id.includes("context-1m") && r.kind !== "NETWORK");
    if (!hadAfter || signals.networkDominates) {
      verdict = "PARTIAL";
      reason =
        "Reproduced NEED_1M_CONTEXT, but network flakiness prevented a clean before/after on context-1m. Re-run when anyrouter is stable.";
    } else {
      verdict = "INVALIDATED";
      reason = "[1M] needs context flag observed, but adding context-1m did not clear it.";
    }
  } else if (signals.accessDeniedDominates) {
    verdict = "PARTIAL";
    reason =
      "Token cannot access probed models (无权访问). Header theory not fully testable with these keys.";
  } else if (signals.networkDominates) {
    verdict = "PARTIAL";
    reason = "Network/TLS to anyrouter.top dominated the run; inconclusive for product change.";
  } else if (!signals.oneMNeedsContextFlag) {
    verdict = "PARTIAL";
    reason =
      "Did not reproduce NEED_1M_CONTEXT with this token/model set. Cannot confirm header fix.";
  }

  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    models,
    keyCount: keys.length,
    byKind,
    signals,
    verdict,
    reason,
    results,
  };

  writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2), "utf8");
  console.log("---");
  console.log(`VERDICT: ${verdict}`);
  console.log(reason);
  console.log(`wrote ${RESULTS_PATH}`);
  console.log("byKind:", JSON.stringify(byKind));
  console.log("signals:", JSON.stringify(signals, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
