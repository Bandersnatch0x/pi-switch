# pi-switch

[![CI](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-ccs?style=flat-square)](https://www.npmjs.com/package/pi-ccs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

English | [中文](./README-zh.md)

pi-switch is a Pi extension package built on top of [cc-switch](https://github.com/farion1231/cc-switch). It uses cc-switch as the source of provider and model configuration, then exposes a fast provider/model switcher directly inside Pi.

pi-switch does not replace cc-switch and does not modify the cc-switch database. It reads the local cc-switch SQLite database in read-only mode, registers the selected provider in Pi, and stores the active model in Pi settings.

## Preview

The screenshots below are sample illustrations of the interaction flow. Actual providers, models, and paths depend on your local cc-switch data.

![Provider type picker](https://cdn.jsdelivr.net/npm/pi-ccs@latest/docs/images/sample-provider-picker.svg)

![Model picker](https://cdn.jsdelivr.net/npm/pi-ccs@latest/docs/images/sample-model-picker.svg)

![Switch success](https://cdn.jsdelivr.net/npm/pi-ccs@latest/docs/images/sample-switch-success.svg)

## Features

- Open the interactive switcher in Pi with `/ps-config` (optional alias: `/ccs`).
- `/ps` quick switch: pins + recents on one screen, one Enter for the daily hot path.
- Load provider configuration from the local cc-switch SQLite database in read-only mode.
- Use a progressive three-level picker: provider type → provider name → model.
- Search (`/`), manually enter model IDs, refresh remote lists, pin favorites with `p`, and page through long lists with `PgUp`/`PgDn`.
- Remember last-N successful switches locally (no expose / multi-tool config center).
- Parse and map common API protocols: Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, and Google Generative AI.
- Inject CLI-like fingerprints by default (Codex UA + `originator` + `X-Codex-Window-ID`, Claude Code `claude-cli/... (external, cli)` + `anthropic-version`/`anthropic-beta`, GeminiCLI UA + `x-goog-api-client`).
- Override model parameters via presets or a native dialog (`/ps-override` or picker key `o`) — e.g. **中转兼容** sets `reasoning=false` when a relay rejects thinking.
- Run structured health checks with `/ps-doctor` (PASS/WARN/FAIL + fix hints).
- Run a read-only compatibility probe with `/ps-probe` (basic / reasoning / tool contracts, structured evidence, JSON in headless/CI).
- Repair evidence-driven with `/ps-repair` (interactive only): re-probe → whitelist Recipe → confirm → in-memory candidate verify → CAS commit, without switching the Session Model.
- Persist the latest selection so the next switcher session can highlight and reuse it.
- Ship a `diagnose-upstream` skill as supplemental knowledge for upstream / relay troubleshooting.

See [SPEC.md](./SPEC.md) for the full product contract.

## Built on cc-switch

cc-switch is the upstream configuration manager. pi-switch depends on the local cc-switch data model and treats cc-switch as the source of truth for providers.

pi-switch is intentionally scoped as a Pi-side bridge:

- cc-switch owns provider creation, editing, deletion, and storage.
- pi-switch reads cc-switch providers from `~/.cc-switch/cc-switch.db`.
- pi-switch normalizes provider settings into Pi-compatible provider registrations.
- pi-switch switches the active Pi model without changing cc-switch state.

This means you should configure providers in cc-switch first, then use pi-switch to select and activate them inside Pi.

### What this project is (and is not)

| This project (Bandersnatch0x/pi-switch) | Not this project |
|---|---|
| **cc-switch → Pi bridge** | Local HTTP gateway / reverse proxy |
| Read-only consumer of `cc-switch.db` | All-in-One provider CRUD manager |
| In-process Pi extension (`/ps-config`) | Standalone daemon with WebUI |
| Local pin / recent shortcuts only | Multi-tool expose / config center |

If you need a local gateway that terminates requests and manages providers itself, look at projects such as [@cokefenta/pi-switch](https://www.npmjs.com/package/@cokefenta/pi-switch) / [CallmeLins/pi-switch](https://github.com/CallmeLins/pi-switch). This repo intentionally stays a thin Pi-side bridge on top of cc-switch.

## Architecture

```text
┌──────────────────────┐
│      cc-switch       │
│ provider management  │
└──────────┬───────────┘
           │ read-only SQLite
           ▼
┌──────────────────────┐
│      pi-switch       │
│ DB read + normalize  │
└──────────┬───────────┘
           │ parsed providers
           ▼
┌──────────────────────┐
│   interactive picker │
│ type → name → model  │
│   (+ override dialog)│
└──────────┬───────────┘
           │ selected provider/model
           ▼
┌──────────────────────┐
│          Pi          │
│ register + setModel  │
└──────────────────────┘
```

Main modules:

```text
pi-switch/
├─ extensions/
│  └─ index.ts                 # Pi entry: /ps-config, /ps-doctor, /ps-override
├─ src/
│  ├─ db.ts                    # Read the cc-switch SQLite database
│  ├─ register.ts              # Build and register Pi providers
│  ├─ settings.ts              # Pi settings, selection, pins/recent, overrides
│  ├─ model-meta.ts            # modelMeta presets + resolution
│  ├─ doctor.ts                # /ps-doctor pure checks
│  ├─ sqlite-path.ts           # sqlite3 executable resolution
│  ├─ models-fetch.ts          # Remote model discovery and merging
│  ├─ headers/                 # Header rule loading, merge, and vars
│  ├─ parse/                   # cc-switch provider config parsers
│  └─ ui/
│     ├─ three-level-pick.ts   # Progressive type → name → model picker
│     ├─ model-meta-dialog.ts  # Non-interactive dialog (fallback / tests)
│     ├─ model-meta-form.ts    # TUI SettingsList form for modelMeta overrides
│     ├─ labels.ts             # Display labels and status text
│     └─ tabs.ts               # Tab helpers
├─ skills/
│  └─ diagnose-upstream/       # Upstream / relay diagnostics skill
├─ defaults/
│  └─ headers.json             # Default header rules
├─ docs/
│  └─ images/                  # README sample screenshots
├─ tests/                      # Bun tests
├─ SPEC.md                     # Product contract (maintainers)
└─ package.json
```

## Installation

### From npm (recommended)

```bash
pi install npm:pi-ccs
```

After the package is published publicly on npm with the `pi-package` keyword, it can also appear in the [Pi package catalog](https://pi.dev/packages). There is no separate submission form — catalog discovery is based on public npm metadata (`keywords` includes `pi-package`, plus a valid `package.json` `pi` manifest).

Direct catalog page after listing:

```text
https://pi.dev/packages/pi-ccs
```

### From GitHub

```bash
pi install git:github.com/Bandersnatch0x/pi-switch
```

Git installs work even before npm / catalog listing.

### Update and enable

```bash
pi update npm:pi-ccs
pi config
```

Pi packages usually land under `~/.pi/agent/npm/`. With project-local installation, they are placed under `.pi/npm/` in the current project.

## Usage

In a Pi session, run:

```text
/ps-config
```

Aliases:

```text
/ccs
```

Quick switch for the hot path (pins + recents, one screen):

```text
/ps
```

To edit model parameter overrides (for example disable `reasoning` for a Claude-protocol → GLM relay):

```text
/ps-override
```

In the provider picker, after the **Name** column is revealed, press **`o`** to open the same override dialog for the focused provider. The footer shows `o override`.

### Compatibility probe & repair

Switching a provider/model means “the model is listed” ≠ “requests actually work”. Verify and repair out-of-band:

```text
/ps-probe
```

Read-only probe against the current/selected Target. Sends isolated synthetic requests (**never your conversation history**):

- `basic` — plain-text contract
- `reasoning` — controlled thinking contract (only when the target claims reasoning support)
- `tool` — side-effect-free `probe_echo` tool contract

Outputs structured evidence grouped into wide failure categories (auth / model / protocol / streaming / tool / client-gate); ambiguous evidence yields `unknown` (no guessing). Hard budget: max 9 requests, 15s each, ≤32 output tokens; 401/429/5xx stop immediately. headless/CI emits JSON.

```text
/ps-repair
```

Evidence-driven repair, **interactive only** (headless is rejected — a persistent config change needs consent). Re-probes fresh each run → matches a whitelist Repair Recipe → one plan-level confirmation (target, recipe order, each patch, affected models) → candidate verified on an in-memory probe target first (the same contract must pass **twice consecutively** before commit) → CAS commit of one recipe. **Session Model stays unchanged**; an explicit “switch to repaired target” is offered on success.

First-version whitelist recipes:

1. Upstream rejects `reasoning`/`thinking` → exact-model `reasoning=false`.
2. Client fingerprint gate, signature uniquely mapped to Claude Code / Codex / Gemini → provider-level `fingerprint` (+ optional `claudeCodeCompat`); non-unique → `unknown`.
3. Gemini tool empty-args / schema evidence → enable per-provider `geminiToolCompat` (report-only when already enabled and still failing).

Every write re-checks the config version (CAS); a concurrent external edit aborts the repair and preserves external content. Each probe/repair is recorded as a Repair Case (redacted summary in context, detailed redacted evidence out of context).

Typical flow:

1. Choose a provider type, such as Claude Code, Codex, Gemini, or OpenCode.
2. Choose a specific provider.
3. Choose a model, or manually enter a model ID.
4. pi-switch registers the provider and switches the current Pi model.

After selection, Pi uses the selected provider baseUrl, apiKey, protocol type, and model ID for subsequent requests.

### Override dialog

In a terminal (TUI) Pi runs a single-screen **SettingsList** overlay form (Pi's own settings-list primitive): one row per field, `Enter`/`Space` cycles enum values, count/预设/作用域 rows open a `SelectList` submenu, custom counts accept a `200k` / `1M` input. In non-interactive modes (RPC / headless / tests) it falls back to the chained `select` / `input` / `confirm` popup in `model-meta-dialog.ts`. Both paths return the same result shape.

```text
Parameter override · elysiver-claude · model glm-4.6 ✱
  scope              model glm-g4           ▸   § submenu switch layer
  preset             select…               ▸   § relay-safe / full-reasoning
  reasoning          inherit true             ∘ inline: § true / false / inherit
  contextWindow      override 200k           ▸   § 200k 256k 500k 1M / custom
  maxTokens          default 64k             ▸   § 4k 8k 16k 32k 64k 128k / custom
  thinkingFormat     override deepseek     ∘   inline-cycle enum
  — clear this layer                  ▸
  — clear all for provider           ▸
  save                                   ✱ save (Title shows ✱ when dirty)
  cancel
Enter/Space switch or open submenu · Esc back · s save
```

Each row reads one of four states: **override** (set in this scope), **inherit** (a lower user-config layer), **built-in** (built-in compat profile), **default** (protocol tier). Count fields offer common presets (`200k`, `256k`, `500k`, `1M`) plus custom input (k/M suffix). Saving writes `providerOverrides` keyed by the cc-switch **dbId**; model-scope edits go under `modelOverrides[modelId]` (default scope is the preselected model when opened from the picker's `o` key; the § submenu switches to provider-scope or another model/glob). If that provider is currently active, pi-switch re-registers it immediately.

## Requirements

- Pi is installed and extension packages are enabled.
- cc-switch is installed and configured.
- The local cc-switch database exists.
- sqlite3 is available on the system.

Default database path:

```text
~/.cc-switch/cc-switch.db
```

sqlite3 resolution order:

```text
SQLITE3_PATH → ~/.pi/agent/pi-switch.json sqlitePath → sqlite3 from PATH
```

Windows users should explicitly configure `SQLITE3_PATH` if `sqlite3.exe` is not globally available.

## Configuration

Optional configuration file:

```text
~/.pi/agent/pi-switch.json
```

Example:

```json
{
  "sqlitePath": "C:/tools/sqlite3.exe",
  "tabs": ["claude", "codex", "gemini", "opencode"],
  "vars": {
    "codexVersion": "0.144.5",
    "claudeCodeVersion": "2.1.190"
  },
  "debug": false
}
```

| Field | Description |
| --- | --- |
| `sqlitePath` | Overrides the sqlite3 executable path (`null` disables lookup) |
| `tabs` | Preferred provider-type order in the picker |
| `vars` | Optional overrides for UA template versions (otherwise auto-detected) |
| `providerOverrides` | Per-provider `label`, `fingerprint`, `headers`, `modelMeta`, and per-model `modelOverrides` (keyed by **dbId**) |
| `aliasCcs` | Register `/ccs` alias (default `true`) |
| `debug` | Enables debug output |

Database path is **not** in this file — use env `CC_SWITCH_DB` or the default `~/.cc-switch/cc-switch.db`.

### Parameter overrides (`providerOverrides`)

Some gateways reject Anthropic-style fields. A common case is Claude-protocol → GLM relays returning:

```text
Unsupported parameter(s): `reasoning`
```

Use the popup dialog (`/ps-override` or picker key `o`) to set `modelMeta.reasoning` to `false`, and optionally set a short `label`. The dialog is scope-aware: edit **全部模型** (provider level) or pick one model id. Values are persisted under the provider's cc-switch **dbId** in `~/.pi/agent/pi-switch.json`:

```json
{
  "providerOverrides": {
    "dooongai-1775180253543": {
      "label": "elysiver-claude",
      "modelMeta": {
        "reasoning": false
      },
      "modelOverrides": {
        "glm-4.6": { "reasoning": false, "maxTokens": 8192 },
        "gpt-5*":  { "reasoning": true }
      }
    }
  }
}
```

Layering (later wins per field, unset fields never clobber a lower layer):

```text
defaultModelMeta  ⊕  providerOverrides[dbId].modelMeta  ⊕  providerOverrides[dbId].modelOverrides[modelId]
```

`modelOverrides` keys may be exact ids or globs (`gpt-5*` / `*sonnet*`). Match order: exact → case-insensitive → most specific glob.

Optional `fingerprint` field forces a CLI disguise preset regardless of protocol:

| Value | Effect |
| --- | --- |
| `claude-code` | `claude-cli/<ver> (external, cli)` + anthropic version/beta |
| `codex` | `codex_cli_rs/<ver> (...)` + `originator` + per-process `X-Codex-Window-ID` |
| `gemini` | `GeminiCLI/<ver>` + `x-goog-api-client` |
| `none` | Skip default/api-matched rule injection; only explicit `headers` (if any) remain |

Explicit `headers` always win over the preset on conflicts.

Supported `modelMeta` fields (stored flat in `pi-switch.json`; registration reshapes into Pi's modern layout):

| Field | Description |
| --- | --- |
| `reasoning` | Whether Pi may send reasoning/thinking parameters |
| `thinkingFormat` | One of: `openai` / `openrouter` / `together` / `deepseek` / `zai` / `qwen` / `chat-template` / `qwen-chat-template` / `string-thinking` / `ant-ling` → registered as `compat.thinkingFormat` |
| `contextWindow` | Context window size (drives Pi compact: `contextTokens > contextWindow - reserveTokens`) |
| `maxTokens` | Max output tokens |
| `thinkingLevelMap` | Optional map of Pi levels (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`) → provider effort strings, or `null` for unsupported → registered top-level |
| `supportsDeveloperRole` | OpenAI-compatible upstream accepts `role: "developer"`; set `true` to preserve it, otherwise pi-switch conservatively rewrites it to `system` |
| `requiresReasoningContentOnAssistantMessages` | OpenAI-compat: require empty `reasoning_content` on assistant turns → registered under `compat` |
| `useBuiltInCompat` | pi-switch only (not sent to Pi): `false` disables the whole built-in compat profile; unset/`true` keeps the default (apply when id matches) |

The UI edits the common scalar fields (`reasoning` / `thinkingFormat` / `contextWindow` / `maxTokens`) plus the **内置compat** toggle. Object fields such as `thinkingLevelMap` are config-only (edit `pi-switch.json` or call the write APIs). Each form row shows **override / inherit / built-in / default** (built-in = matched profile and not opted out).

Advanced fields such as `supportsDeveloperRole` (exact-model tuple / flat meta) are config-only (edit `pi-switch.json` or call the write APIs).

### Built-in compat profiles

models.dev covers capability scalars (`contextWindow` / `maxTokens` / `reasoning`) only. Some models also need compat fields such as `thinkingFormat` to register correctly. pi-switch ships a **small** in-code profile table for known families:

| Model id match | Built-in fields |
| --- | --- |
| `deepseek*` | `thinkingFormat=deepseek`, `requiresReasoningContentOnAssistantMessages=true`, DeepSeek-style `thinkingLevelMap` |
| `qwen*` | `thinkingFormat=qwen` |

Precedence: **user override > built-in profile**. Profiles never set `contextWindow` / `maxTokens` / `reasoning` (those still flow models.dev → protocol default).

**Disable the whole profile**: in `/ps-override` set **内置compat → 关闭**, or write:

```json
{
  "modelOverrides": {
    "deepseek-v4-flash": { "useBuiltInCompat": false }
  }
}
```

Provider-scope `modelMeta.useBuiltInCompat: false` turns it off for all matching models under that provider; a model-scope `true` re-enables one id. `/ps-doctor` and the post-switch notify share the same effective meta; doctor sources look like `用户: …；内置: deepseek*` (omitted when disabled).
### DeepSeek V4 Flash example

Compact is executed by Pi itself; pi-switch does not compress sessions. Per-switch registration means the same model id can use different `contextWindow` / compat under different providers.

Thinking compat for `deepseek*` is **already supplied by the built-in profile**. To raise the window / enable reasoning when models.dev misses, override only the capability fields:

```json
{
  "providerOverrides": {
    "<dbId>": {
      "modelOverrides": {
        "deepseek-v4-flash": {
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 384000
        }
      }
    }
  }
}
```

At register time this becomes Pi model config with top-level `thinkingLevelMap` and nested `compat` (no top-level `thinkingFormat`). The `[1M]` model-id tag only sets `contextWindow=1000000`; it does **not** replace the DeepSeek thinking map (that comes from the built-in profile or a user override).

After save, if the provider is currently active, pi-switch re-registers it so the override applies immediately.

The latest selection is stored as `piSwitchSelection` in Pi settings, so it can be highlighted the next time the switcher opens.

> Note: remote model list fetching currently returns model **IDs only**. Per-model parameters are not imported from `/models`; use protocol defaults plus built-in compat profiles plus `providerOverrides.modelMeta` / `modelOverrides` instead.

## Header Rules

Default header rules are stored at:

```text
defaults/headers.json
```

Optional user override file:

```text
~/.pi/agent/provider-headers.json
```

pi-switch only merges allowlisted headers to avoid injecting arbitrary sensitive fields into provider configuration. Allowlist:

| Header | Default rules inject? | Notes |
| --- | --- | --- |
| `User-Agent` | yes | Version/os auto-detected; overridable per provider / fingerprint |
| `anthropic-version` | yes (claude) | Protocol-required for Anthropic Messages |
| `anthropic-beta` | yes (claude) | Claude Code beta flags (template via `vars.anthropicBeta`) |
| `originator` | yes (codex) | Codex CLI private header (template via `vars.codexOriginator`) |
| `X-Codex-Window-ID` | yes (codex) | Per-process UUID required by official-client relay gates |
| `x-goog-api-client` | yes (gemini) | Gemini CLI client id (`gemini-cli/<ver>`) |

`Authorization` / `x-api-key` / `Host` / etc. are **never** injectable via rules or overrides.

Rule precedence: `defaults/headers.json` < `~/.pi/agent/provider-headers.json` < `providerOverrides[dbId].headers`.


## Branch protection

Branch and release-tag protection is documented in [.github/branch-protection.md](./.github/branch-protection.md).

## Development

Install dependencies:

```bash
bun install
```

Run tests:

```bash
bun test
```

Typecheck:

```bash
bun run typecheck
```

Pre-publish check:

```bash
bun run prepublishOnly
```

Run the isolated TUI smoke (requires `pi` and `sqlite3` on `PATH`):

```bash
bun run smoke:tui
```

This drives the interactive slash commands through a Pi RPC subprocess under a temporary HOME with a faux OpenAI relay, asserting on state outcomes rather than visual rendering. Real `settings.json`, `pi-switch.json`, the cc-switch DB, and its SQLite sidecars are snapshotted and verified unchanged even when a flow fails. It covers the five main flows:

- `/ps-override` — provider-scope `modelMeta` write round-trip.
- `/ps-config` — 3-level pick, provider registration, and selection persistence.
- `/ps-info` — effective-config summary.
- `/ps-doctor` — diagnostics (offline models.dev/routing items degrade to `warn`, not fail).
- `/ps` — quick switch off a pinned/recent entry.

Use `--flow=<name>` to run one flow, or `KEEP_SMOKE_TEMP=1` to retain the temp HOME for inspection.

Run the isolated end-to-end `/ps-repair` smoke (requires `pi` and `sqlite3` on `PATH`):

```bash
bun run smoke:probe-repair
```

This starts a local faux OpenAI relay and a Pi RPC subprocess under a temporary HOME. It runs **3 repair scenarios** against the same faux target:

1. **`reasoning-false`** — The faux target passes basic/tool requests but rejects reasoning, matching `reasoning-false`. Writes `modelOverrides[model].reasoning=false`.
2. **`client-fingerprint`** — Sets `fingerprint="codex"`; the relay validates real `originator: codex_cli_rs` headers and `User-Agent`.
3. **`gemini-tool-compat`** — Sets `geminiToolCompat=true`; the relay validates Gemini-style payload (`toolConfig.functionCallingConfig.mode=AUTO`, `parameters` instead of `parametersJsonSchema`).

Each scenario: verifies the candidate twice, declines the post-repair Session Model switch, asserts real Pi settings/config and cc-switch DB state remain unchanged, and deletes temporary state after success. Use `--recipe=<id>` to run a single scenario, or `--keep` / `KEEP_SMOKE_TEMP=1` to retain temp files.

### Release and GitHub auto-publish

Publishing is modeled after a release-gate flow (similar to vibe-designing-playbook):

1. Local dry-run gates (`tree` / `version` / `test` / `pack` / `tag`)
2. Create `vX.Y.Z` tag after gates pass
3. Push the tag; GitHub Actions publishes to npm

One-time setup on GitHub:

1. Create an npm **Automation** access token with publish permission
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**
3. Name: `NPM_TOKEN`, value: the token

Release steps:

```bash
# 1) bump version in package.json (keep semver)
# 2) commit all release changes
bun run release              # dry-run gates (no tag)
bun run release:apply        # create tag vX.Y.Z after gates pass
git push origin main
git push origin v0.1.0       # triggers Actions publish
```

Manual re-publish is also available from **Actions → CI → Run workflow** with `publish=true` (the matching `vX.Y.Z` tag must already point at that commit).

The workflow:

- runs tests + pack dry-run on push/PR
- publishes only on `v*` tags (or manual dispatch)
- verifies tag version == `package.json` version
- skips if that version already exists on npm
- uses `npm publish --access public --provenance`

## Supported Configuration Sources

pi-switch parses provider configuration from the cc-switch providers table and normalizes it into Pi-registerable providers where possible.

- Claude / Claude Code config parsing
- Codex config parsing
- Gemini config parsing
- Grok Build config parsing
- OpenCode config parsing
- Hermes config parsing
- Generic / OpenAI-compatible config parsing

If a provider protocol cannot be mapped to a Pi-supported API type, it is shown as non-switchable in the UI instead of being force-registered.

## Out of Scope

- Does not edit the cc-switch database.
- Does not add, delete, reorder, or migrate providers.
- Does not include an API key manager.
- Does not track quota or cost.
- Does not replace cc-switch; it only acts as a switcher entry inside Pi.
- Does not import per-model metadata from remote `/models` responses (IDs only).

## License

[MIT](./LICENSE)
