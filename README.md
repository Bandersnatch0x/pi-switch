# pi-switch

[![CI](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-switch?style=flat-square)](https://www.npmjs.com/package/pi-switch)

**Pi package** that lets you switch any [cc-switch](https://github.com/farion1231/cc-switch) provider + model from inside [Pi](https://github.com/badlogic/pi-mono).

| | |
|---|---|
| Type | Pi extension (`pi-package`) |
| Command | `/pi-switch` (alias `/ccs`) |
| Data source | `~/.cc-switch/cc-switch.db` (**read-only**) |
| Platform | Windows 10/11 x64 (macOS theoretically compatible) |

Full product contract: **[SPEC.md](./SPEC.md)** (locked v0.1).

---

## Install

### From npm (recommended)

```bash
pi install npm:pi-switch
```

### From git

```bash
pi install git:github.com/Bandersnatch0x/pi-switch
```

### Update / configure

```bash
pi update npm:pi-switch
pi config   # enable/disable the extension
```

Packages land under `~/.pi/agent/npm/` (global) or `.pi/npm/` (project-local with `-l`).

> **Security:** Pi packages run with full system access. Review source before installing third-party packages.

---

## Requirements

| Dependency | Notes |
|------------|--------|
| [Pi](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`) | Host |
| [cc-switch](https://github.com/farion1231/cc-switch) desktop app | Owns the provider DB |
| System `sqlite3` CLI | On `PATH`, or set `SQLITE3_PATH` / config |

```powershell
# optional overrides
$env:SQLITE3_PATH = "D:\platform-tools\sqlite3.exe"
$env:CC_SWITCH_DB = "$env:USERPROFILE\.cc-switch\cc-switch.db"
```

If you previously used the local `~/.pi/agent/extensions/cc-switch` extension, **remove it** after installing `pi-switch` (this package replaces it).

---

## Usage

```text
/pi-switch
```

Optional alias (default on): `/ccs`

1. Pick `app_type` tab (dynamic from DB)
2. Pick provider (search / pagination)
3. Pick model from config list, enter manually, or **获取远端模型**

### Features

- Dynamic tabs for every `app_type` in cc-switch
- Protocol mapping → Pi `api` (Anthropic / OpenAI responses & chat / Gemini)
- Allowlisted client fingerprint headers on `registerProvider`
- Stable identity via `dbId`; registration name `ps-<appType>-<dbId>`
- Re-reads DB each time you open the command (snapshot during the picker)

---

## Configuration

`~/.pi/agent/pi-switch.json`:

```jsonc
{
  "pageSize": 12,
  "tabs": ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes"],
  "aliasCcs": true,
  "sqlitePath": null,
  "providerOverrides": {
    "<dbId>": {
      "label": "sbai",
      "headers": {
        "User-Agent": "codex_cli_rs/0.144.0 (Windows 10.0; x64) Terminal"
      }
    }
  },
  "debug": false
}
```

**Header allowlist only:** `User-Agent`, `originator`, `anthropic-version`, `anthropic-beta`.  
Auth headers are never taken from rules or overrides.

Shared header rules may also live in `~/.pi/agent/provider-headers.json` (same file as `pi-provider-headers`).

Selection is stored in `~/.pi/agent/settings.json` as `piSwitchSelection` (`dbId` is the identity). Legacy `ccSwitchSelection` migrates once when the name uniquely matches.

---

## Package layout

This is a standard **Pi package** (`keywords` includes `pi-package`):

```json
{
  "name": "pi-switch",
  "keywords": ["pi-package", "pi", "pi-coding-agent"],
  "pi": {
    "extensions": ["./extensions/index.ts"]
  }
}
```

| Path | Role |
|------|------|
| `extensions/index.ts` | Extension entry (commands, session restore) |
| `src/` | Pure logic (parse, db, headers, UI helpers) |
| `defaults/headers.json` | Default fingerprint rules |
| `SPEC.md` | Locked product specification |

---

## Develop

```bash
bun install   # optional; tests use bun built-ins
bun test
```

---

## Release

CI runs on every push/PR. Publishing to npm happens when a version tag is pushed **and** tests pass:

```bash
# bump version in package.json, then:
git tag v0.1.0
git push origin v0.1.0
```

Requires repository secret **`NPM_TOKEN`** (Automation token with publish rights).

---

## Out of scope (v0.1)

- Quota / `usage_script` / rollups UI  
- Bundled sqlite binary  
- Writing back to the cc-switch DB  
- Dual-install coexistence with the old local `cc-switch` extension  

---

## License

MIT © Bandersnatch0x
