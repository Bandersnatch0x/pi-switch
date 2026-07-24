# cc-switch model discovery behavior

Upstream inspected: `farion1231/cc-switch` at commit
[`a377d79303bc1e592d2783d559ca5bd6b8ba1417`](https://github.com/farion1231/cc-switch/tree/a377d79303bc1e592d2783d559ca5bd6b8ba1417).

## Findings

- The command accepts `baseUrl`, `apiKey`, optional `isFullUrl`, optional
  `modelsUrl`, and optional custom User-Agent, then delegates to the shared model
  fetch service. An invalid custom User-Agent is ignored rather than failing the
  request. [command source](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/commands/model_fetch.rs#L7-L30)
- A non-empty `modelsUrl` override is authoritative and becomes the only
  candidate. Otherwise the service trims surrounding whitespace and trailing
  `/` from `baseUrl`. [candidate builder](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L129-L156)
- When `isFullUrl` is true, cc-switch derives one `/v1/models` URL from the full
  request URL: it cuts before an embedded `/v1/`, or removes the final path
  segment. Failure to derive a root is an error. [full-URL handling](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L158-L170)
- For a normal base URL ending in `/vN`, the first candidate is `{base}/models`.
  If `N` is not `1`, `{base}/v1/models` is also retained as a fallback. Other
  base URLs start with `{base}/v1/models`. [version handling](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L173-L184)
- Known Anthropic-compatible suffixes such as `/api/coding`, `/anthropic`, and
  `/coding` add candidates after stripping that suffix: `{root}/v1/models` and
  `{root}/models`. Candidates are de-duplicated while preserving first-seen
  order. [compatibility fallback](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L36-L49)
  [candidate construction](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L186-L196)
- Fetching requires a non-empty API key, sends `Authorization: Bearer <key>`,
  optionally sends the configured User-Agent, and uses a 15-second timeout.
  [request construction](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L54-L84)
- Only HTTP 404 and 405 advance to the next candidate. A transport error, JSON
  parse error, or any other non-success status fails immediately. A successful
  response reads `data[]` and sorts models by ID. Error bodies are truncated.
  [response and fallback behavior](https://github.com/farion1231/cc-switch/blob/a377d79303bc1e592d2783d559ca5bd6b8ba1417/src-tauri/src/services/model_fetch.rs#L86-L126)

## Implication for pi-switch

To satisfy “follow cc-switch logic,” pi-switch should port this candidate builder
and fallback policy, including `modelsUrl`, `isFullUrl`, compatibility suffixes,
Bearer authentication, custom User-Agent, 15-second timeout, and 404/405-only
candidate fallback. Provider registration should continue using the configured
base URL; this logic is specific to the user-triggered model-list request.
