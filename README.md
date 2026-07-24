# pi-switch

Pi coding-agent extension: switch **any** cc-switch provider + model from the
local `~/.cc-switch/cc-switch.db` database.

- Dynamic tabs for every `app_type` in the DB  
- Protocol mapping to Pi `api` (Anthropic / OpenAI responses & chat / Gemini)  
- Client fingerprint headers (allowlisted) on `registerProvider`  
- Stable identity via `dbId`; registration name `ps-<appType>-<dbId>`

Full product contract: **[SPEC.md](./SPEC.md)** (locked).

## Requirements

| Dependency | Notes |
|------------|--------|
| [Pi](https://github.com/badlogic/pi-mono) / `@earendil-works/pi-coding-agent` | Host |
| [cc-switch](https://github.com/farion1231/cc-switch) desktop app | Owns the provider DB |
| System `sqlite3` CLI | On `PATH`, or set `SQLITE3_PATH` / `pi-switch.json.sqlitePath` |

**Supported:** Windows 10/11 x64  
**Theoretical:** macOS / Linux (same `~/.cc-switch/cc-switch.db` path; not CI-verified)

## Install

```bash
# clone / copy this package somewhere stable, then link into Pi extensions
# example: clone next to your agent config
```

Point Pi at this package (exact install path depends on your Pi setup). The
package declares:

```json
"pi": { "extensions": ["./extensions/index.ts"] }
```

Ensure `sqlite3` works:

```powershell
sqlite3 -version
```

Optional override:

```powershell
$env:SQLITE3_PATH = "D:\platform-tools\sqlite3.exe"
$env:CC_SWITCH_DB = "C:\Users\you\.cc-switch\cc-switch.db"
```

## Usage

```
/pi-switch
```

Optional alias (default on): `/ccs`

Flow:

1. Pick `app_type` tab  
2. Pick provider (search / pagination)  
3. Pick model from config list, **or** manually enter, **or** “获取远端模型”

## Config

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

Allowed header override names only:

- `User-Agent`
- `originator`
- `anthropic-version`
- `anthropic-beta`

Auth headers are never taken from rules/overrides.

Shared rules may also live in `~/.pi/agent/provider-headers.json` (same file as
`pi-provider-headers`).

## Selection persistence

Stored in `~/.pi/agent/settings.json` as `piSwitchSelection`:

- **`dbId`** is the only identity used to restore  
- If the id is missing from the DB, Pi does **not** auto-switch and the old
  selection is kept  

Legacy `ccSwitchSelection` is migrated once when the name uniquely matches.

## Develop

```bash
bun test
```

## Out of scope (v0.1)

- Quota / `usage_script` / rollups UI  
- Bundled sqlite binary  
- Writing back to cc-switch DB  
- Dual-install coexistence with the old `extensions/cc-switch` package — remove
  the old one when you switch

## License

MIT
