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
- Load provider configuration from the local cc-switch SQLite database in read-only mode.
- Use a progressive three-level picker: provider type → provider name → model.
- Search (`/`), manually enter model IDs, refresh remote lists, and pin favorites with `p` (scrollable list — **no** pagination).
- Remember last-N successful switches locally (no expose / multi-tool config center).
- Parse and map common API protocols: Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, and Google Generative AI.
- Inject CLI-like fingerprints by default (Codex UA + `originator`, Claude Code `claude-cli/... (external, cli)` + `anthropic-version`/`anthropic-beta`, GeminiCLI UA + `x-goog-api-client`).
- Override model parameters via presets or a native dialog (`/ps-override` or picker key `o`) — e.g. **中转兼容** sets `reasoning=false` when a relay rejects thinking.
- Run structured health checks with `/ps-doctor` (PASS/WARN/FAIL + fix hints).
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

To edit model parameter overrides (for example disable `reasoning` for a Claude-protocol → GLM relay):

```text
/ps-override
```

In the provider picker, after the **Name** column is revealed, press **`o`** to open the same override dialog for the focused provider. The footer shows `o override`.

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

Each row reads one of three states: **override** (set in this scope), **inherit** (a lower layer set it), **default** (protocol tier). Count fields offer common presets (`200k`, `256k`, `500k`, `1M`) plus custom input (k/M suffix). Saving writes `providerOverrides` keyed by the cc-switch **dbId**; model-scope edits go under `modelOverrides[modelId]` (default scope is the preselected model when opened from the picker's `o` key; the § submenu switches to provider-scope or another model/glob). If that provider is currently active, pi-switch re-registers it immediately.

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
| `codex` | `codex_cli_rs/<ver> (...)` + `originator` |
| `gemini` | `GeminiCLI/<ver>` + `x-goog-api-client` |
| `none` | Skip default/api-matched rule injection; only explicit `headers` (if any) remain |

Explicit `headers` always win over the preset on conflicts.

Supported `modelMeta` fields:

| Field | Description |
| --- | --- |
| `reasoning` | Whether Pi may send reasoning/thinking parameters |
| `thinkingFormat` | One of: `openai` / `openrouter` / `together` / `deepseek` / `zai` / `qwen` / `chat-template` / `qwen-chat-template` / `string-thinking` / `ant-ling` |
| `contextWindow` | Context window size |
| `maxTokens` | Max output tokens |

After save, if the provider is currently active, pi-switch re-registers it so the override applies immediately.

The latest selection is stored as `piSwitchSelection` in Pi settings, so it can be highlighted the next time the switcher opens.

> Note: remote model list fetching currently returns model **IDs only**. Per-model parameters are not imported from `/models`; use protocol defaults plus `providerOverrides.modelMeta` / `modelOverrides` instead.

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
