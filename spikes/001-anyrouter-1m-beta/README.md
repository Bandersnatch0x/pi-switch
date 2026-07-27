# 001: anyrouter-1m-beta

## Question

Given a Claude-protocol provider pointed at `https://anyrouter.top`, when requests use pi-switch’s default `anthropic-beta` (no `context-1m`), does anyrouter reject with the 1M-context gate — and does adding `context-1m-2025-08-07` clear that gate?

Also: is Pi-local `contextWindow` override enough by itself? (It is **not** sent on the wire.)

## Why this spike

- pi-switch already supports `modelMeta.contextWindow` overrides.
- Pi / pi-switch do **not** auto-add `context-1m-2025-08-07` from `contextWindow`.
- Community maps  
  `1m 上下文已经全量可用，请启用1m 上下文后重试`  
  to missing `context-1m` beta.
- Prove the header actually changes anyrouter’s response class **before** product code.

## Given / When / Then

| # | Focus | Validates | Risk |
|---|-------|-----------|------|
| 001a | Reproduce NEED_1M | Given default pi betas, when POST `/v1/messages`, then error class is NEED_1M_CONTEXT | High |
| 001b | Fix with beta | Given same request + `context-1m-2025-08-07`, when POST, then **not** NEED_1M_CONTEXT | High |
| 001c | Full success | Given context-1m, when POST, then HTTP 2xx with content | High |

## Approach

Throwaway `probe.mjs` + focused PowerShell A/B:

1. Load both claude anyrouter keys from `~/.cc-switch/cc-switch.db` (values never logged).
2. Matrix: plain / pi-default-beta / default+context-1m / context-1m-only.
3. Classify: SUCCESS · NEED_1M_CONTEXT · NO_MODEL_ACCESS · UPSTREAM_5XX · NETWORK · …
4. Write `results.json`.

```bash
bun spikes/001-anyrouter-1m-beta/probe.mjs
```

## Results (2026-07-27, live anyrouter.top)

### Matrix (`probe.mjs`, 2 keys × 3 models × 4 header profiles)

| Kind | Count | Notes |
|------|------:|-------|
| NO_MODEL_ACCESS | 12 | `该令牌无权访问模型 …` — plan/token ACL |
| NETWORK | 5 | TLS/socket flake to anyrouter.top |
| **NEED_1M_CONTEXT** | **4** | Exact gate message reproduced |
| UPSTREAM_5XX | 3 | `Service Unavailable` after adding context-1m |

### Reproduced NEED_1M_CONTEXT (exact text)

```text
1m 上下文已经全量可用，请启用 1m 上下文后重试
```

Observed on:

| Key | Model | Header profile |
|-----|-------|----------------|
| k1 (`anyrouter`) | `claude-opus-4-8` (**no** `[1M]` suffix) | plain + pi-default-beta |
| k2 (`anyrouter copy`) | `claude-opus-5` (**no** `[1M]` suffix) | plain + pi-default-beta |

**Surprise:** the gate is **not** limited to model ids with `[1M]`. For these tokens, anyrouter enforces 1M enablement even on plain model names.

### Before / after on same key+model (k1 + `claude-opus-4-8`)

| Profile | Result |
|---------|--------|
| pi-default-beta (no context-1m) | **NEED_1M_CONTEXT** (400-class message) |
| default + `context-1m-2025-08-07` | **UPSTREAM_5XX** `Service Unavailable` |
| `context-1m-2025-08-07` only | **UPSTREAM_5XX** `Service Unavailable` |

Focused PowerShell re-check (same pair): with context-1m → **503** (×3); default-beta attempt timed out (flake).

### What we did **not** get

- No HTTP 2xx SUCCESS on any profile with these two keys today.
- `contextWindow` cannot be A/B’d against the gateway (not on the wire). Local override remains orthogonal.

## Verdict: **PARTIAL**

### What worked

- **001a VALIDATED:** pi-switch default betas reproduce anyrouter’s 1M gate (`NEED_1M_CONTEXT`).
- **001b PARTIAL/directional:** adding `context-1m-2025-08-07` **clears the NEED_1M_CONTEXT class** on the same key+model (→ 503 instead of the 1M gate). Header is recognized by the gateway.
- Classifier fixed mid-spike: bare `1m` inside model ids must not count as NEED_1M (error text embeds `claude-x[1M]`).

### What didn't

- **001c INVALIDATED for now:** no full chat SUCCESS. Blockers:
  1. Token ACL: `该令牌无权访问模型 …` on many model ids.
  2. After clearing the 1M gate: `503 Service Unavailable` (upstream/channel, not local).
  3. Intermittent TLS/socket failures to `anyrouter.top`.

### Surprises

1. **1M gate applies without `[1M]` in the model id** for these accounts — product logic that only keys off `/\[1[Mm]\]$/` is incomplete for anyrouter.
2. Clearing the gate surfaces 503, not necessarily success — “enable 1M” and “channel healthy / token allowed” are separate layers.
3. Network flakiness is high enough that automated matrices need retries + focused A/B.

### Recommendation for the real build

| Decision | Rationale |
|----------|-----------|
| **Do not merge auto-inject as “fully validated” yet** | Missing end-to-end SUCCESS; user asked for spike pass before formal change. |
| **PARTIAL is enough to keep the design direction** | Wire-level evidence: default beta → NEED_1M; +context-1m → not NEED_1M. |
| **Re-run to promote to VALIDATED** when: token can access a working model **and** upstream returns 2xx with context-1m. Command: `bun spikes/001-anyrouter-1m-beta/probe.mjs` |
| **If implementing later, prefer broader triggers than only `[1M]`** | e.g. `contextWindow >= 1_000_000` **or** model id `/\[1[Mm]\]$/` **or** explicit fingerprint/preset `anyrouter` / `context-1m` — merge flag into existing `anthropic-beta`, don’t replace it. |
| **Shipable today without code** | Manual `providerOverrides[dbId].headers["anthropic-beta"]` including `context-1m-2025-08-07` + optional `modelMeta.contextWindow: 1000000` (local only). |
| **Keep `contextWindow` override as-is** | Correct local meta; not a substitute for the beta header. |

### Stop line for product code

```text
Spike 001 verdict = PARTIAL
→ formal code change: HOLD
→ next: re-probe when anyrouter key has model access + non-503 channel
→ promote to VALIDATED only on SUCCESS with context-1m on a previously NEED_1M pair
```

## Artifacts

- `probe.mjs` — throwaway matrix runner
- `results.json` — last full matrix (kinds + signals)
- This README — verdict
