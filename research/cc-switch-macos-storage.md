# cc-switch macOS support and storage

Upstream inspected: `farion1231/cc-switch` at commit
[`a377d79303bc1e592d2783d559ca5bd6b8ba1417`](https://github.com/farion1231/cc-switch/tree/a377d79303bc1e592d2783d559ca5bd6b8ba1417).

## macOS support

- macOS is an officially supported platform alongside Windows and Linux.
  [README](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/README.md#L207)
- The minimum supported version is macOS 12 Monterey; the Tauri bundle also
  declares `minimumSystemVersion: 12.0`.
  [system requirements](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/README.md#L346-L350)
  [Tauri configuration](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/tauri.conf.json#L52-L54)
- Intel x64 and Apple Silicon arm64 are both supported. The release workflow
  builds a Universal Apple binary from the two Rust targets.
  [installation matrix](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/docs/user-manual/en/1-getting-started/1.2-installation.md#L7-L11)
  [release targets](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/.github/workflows/release.yml#L231-L246)
- Distribution options are a signed and notarized DMG, a ZIP containing the
  `.app`, and Homebrew Cask.
  [macOS installation](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/README.md#L356-L374)

## Data storage

cc-switch deliberately does not use macOS `~/Library/Application Support` for
its own provider database. Its cross-platform application directory is the
user home directory plus `.cc-switch`:

```text
~/.cc-switch/cc-switch.db       SQLite single source of truth
~/.cc-switch/settings.json      device-local UI settings
~/.cc-switch/backups/           rotating database backups (latest 10)
~/.cc-switch/skills/            managed skills
~/.cc-switch/skill-backups/     skill backups (latest 20)
```

The paths and storage roles are documented directly in the project.
[storage documentation](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/README_ZH.md#L299-L306)

The implementation resolves the platform home directory with
`dirs::home_dir()`, builds `~/.cc-switch`, and opens `cc-switch.db` beneath it.
An internal app-config-directory override can replace the default directory.
[home resolution](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/config.rs#L22-L34)
[app directory](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/config.rs#L183-L216)
[database path](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/database/mod.rs#L95-L106)

The special legacy `HOME` fallback in `config.rs` is Windows-only. It does not
change the macOS default path.

## Implication for pi-switch

Future macOS support can use the same default lookup as Windows:
`<resolved user home>/.cc-switch/cc-switch.db`, with `CC_SWITCH_DB` kept as an
explicit override. No macOS `Application Support` lookup is needed for this
database.
