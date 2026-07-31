# Gemini Tool Calling Compatibility Research & Thin Adapter Design

## Executive Summary

pi-switch currently has a full runtime compat layer for **Claude Code** (anthropic-messages) but
only config parsing for **Gemini** and **Codex**. The Gemini tool calling failure (empty `args: {}`)
stems from pi-ai's `google-shared.js` omitting `toolConfig` when no tool has `constrainedSampling`,
combined with third-party proxies not enforcing schema without explicit `toolConfig`.

## pi-ai Adapter Comparison

### 1. Gemini (`google-shared.js` + `google-generative-ai.js`)

**Tool serialization** (`convertTools`):
```
tools: [{
  functionDeclarations: tools.map(t => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters   // full JSON Schema (default)
    // OR (useParameters=true):
    parameters: sanitizeForOpenApi(t.parameters)  // OpenAPI 3.03
  }))
}]
```

**Tool choice** (`resolveGoogleFunctionCallingMode`):
- Checks `tools.some(t => resolveJsonSchemaStrictSampling(t, supportsStrictMode) === true)`
- If strict → `FunctionCallingConfigMode.VALIDATED` (Gemini 3+ only)
- If `toolChoice` is "none"/"any" → `mapToolChoice(toolChoice)`
- Otherwise → `undefined` (toolConfig omitted entirely!)

**Key problem**: When no tool has `constrainedSampling` and no explicit `toolChoice`,
`functionCallingMode` is `undefined`, so `toolConfig` is not sent. Third-party proxies
(like `elysia.h-e.top`) need explicit `toolConfig` to enforce parameter schemas.

**Tool call parsing** (`google-generative-ai.js:139`):
```js
arguments: part.functionCall.args ?? {}  // empty args default to {}
```
No validation of required parameters — empty `args` silently accepted.

**Model version gating** (`supportsGoogleStrictToolSampling`):
- Only Gemini 3+ supports `VALIDATED` mode
- `getGeminiMajorVersion(modelId)` parses version from model ID

### 2. OpenAI Completions (`openai-completions.js`)

**Tool serialization** (`convertTools`):
```
tools: [{ type: "function", function: { name, description, parameters: tool.parameters } }]
```
- `resolveGrammarConstrainedSampling` for grammar-based tools
- `resolveJsonSchemaStrictSampling` for strict JSON Schema mode

**Tool choice**: `params.tool_choice = options.toolChoice` (passed as-is)

**Strict mode**: `compat.supportsStrictMode` flag per provider

### 3. OpenAI/Codex Responses (`openai-responses-shared.js` + `openai-codex-responses.js`)

**Tool serialization** (`convertResponsesTools`):
```
tools: [{ type: "function", name, description, parameters: tool.parameters }]
// Grammar tools: { type: "custom", name, description, format: { type: "grammar", ... } }
```

**Tool choice**: `tool_choice: options.toolChoice ?? "auto"` (Codex defaults to "auto")

**Deferred tools**: `splitDeferredTools(context, supportsToolSearch)` splits tools into
immediate + deferred, with `tool_search_call` message type for on-demand loading.

**Codex-specific**: `strict: null`, `parallel_tool_calls: true`

### 4. Anthropic (`anthropic-messages.js`)

**Tool serialization** (`convertTools`):
```
tools: [{
  name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
  description: tool.description,
  input_schema: { type: "object", properties, required },
  strict: strict === true,
  eager_input_streaming: supportsEagerToolInputStreaming,
  defer_loading: deferLoading,
  cache_control: cacheControl  // on last tool
}]
```

**Tool choice**: `tool_choice: { type: options.toolChoice }`

**Strict mode**: `resolveJsonSchemaStrictSampling(tool, supportsStrictTools)`

**Tool call ID**: Normalized to Anthropic pattern (alphanumeric + underscore + hyphen, max 64 chars)

## pi-switch Existing Layers

### Claude Code (FULL compat layer)
- `src/compat/claude-code.ts` — pure logic (627 lines)
- `extensions/claude-code-compat.ts` — runtime hook installation (219 lines)
- `src/compat/claude-code-tools-data.ts` — bundled tool definitions for fingerprinting

Handles:
1. Tool fingerprint injection (CC tool names as stubs)
2. System prefix injection (Agent SDK prefix)
3. Metadata injection (user_id with device_id, session_id)
4. Thinking transformation (budget → adaptive)
5. Header beta flags

Hook integration: `pi.on("before_provider_request", ...)` + `pi.on("before_provider_headers", ...)`

### Gemini (config parsing only)
- `src/parse/gemini.ts` — parses config from cc-switch DB
- Normalizes baseUrl (adds `/v1beta` if missing)
- Sets auth header (Bearer for non-Google hosts)
- **NO runtime compat layer**

### Codex (config parsing only)
- `src/parse/codex.ts` — parses config from TOML
- Extracts base_url, model from TOML
- **NO runtime compat layer**

## pi ExtensionAPI Hook System

```typescript
interface ExtensionAPI {
  on(event: "before_provider_request",
     handler: (event: { type, payload: unknown }) => unknown): void;
  // Return value replaces payload

  on(event: "before_provider_headers",
     handler: (event: { type, headers: ProviderHeaders }) => void): void;
  // Mutate headers in place

  on(event: "after_provider_response",
     handler: (event: { type, status: number, headers: Record<string, string> }) => void): void;
  // Response received but body not available

  on(event: "tool_call",
     handler: (event: ToolCallEvent) => { block?: boolean; reason?: string }): void;
  // Fires when tool is called; can block or modify input
}
```

Key constraints:
- `after_provider_response` gives status + headers only, NOT response body
- `tool_call` event fires when a tool is invoked; `event.input` can be mutated in place
- `before_provider_request` return value replaces the entire payload

## Thin Adapter Design

### Architecture

```
extensions/index.ts
  ├─ installClaudeCodeCompat(pi, rt)    ← existing
  ├─ installGeminiToolCompat(pi, rt)    ← NEW
  └─ installCodexCompat(pi, rt)         ← future (if needed)

src/compat/
  ├─ claude-code.ts                     ← existing (627 lines)
  ├─ gemini-tool-compat.ts              ← NEW (pure logic)
  └─ codex-compat.ts                    ← future
```

### Gemini Tool Compat — `src/compat/gemini-tool-compat.ts`

Pure functions, no IO. Three responsibilities:

#### 1. Inject `toolConfig` when missing

```typescript
export function applyGeminiToolCompatToPayload(
  payload: unknown,
  opts: {
    forceToolConfigMode?: "AUTO" | "VALIDATED" | "ANY" | "NONE";
    modelId?: string;
  }
): unknown
```

Logic:
- Detect Gemini payload by checking for `contents` + `tools` + `functionDeclarations`
- If `tools` present but `toolConfig` missing → inject `toolConfig: { functionCallingConfig: { mode: "AUTO" } }`
- If model is Gemini 3+ and `forceToolConfigMode` is "VALIDATED" → use VALIDATED
- If `toolConfig` already present → respect existing config unless overridden

#### 2. Upgrade tool schemas for strict mode (optional)

For Gemini 3+ models, optionally add `constrainedSampling` metadata to known
tool schemas so pi-ai's `resolveGoogleFunctionCallingMode` naturally selects VALIDATED.

This is a config-level fix vs. a runtime fix — if we can patch the tool definitions
before they reach pi-ai, the existing code path handles it natively.

#### 3. Detect and handle empty tool call args (response side)

```typescript
export function hasEmptyToolCallArgs(payload: unknown): {
  hasEmpty: boolean;
  toolNames: string[];
  missingParams: string[];
}
```

This checks if any `functionCall` in the response has `args: {}` or missing
required parameters. Since `after_provider_response` doesn't give us the body,
this needs an alternative approach:

**Option A: `tool_call` hook** (preferred)
- Hook `tool_call` event
- When `event.input` is empty/missing for a tool with required params
- Return `{ block: true, reason: "Missing required parameters. Please regenerate the tool call with all required fields." }`
- Pi will see the blocked tool call and regenerate

**Option B: Pre-response injection** (if available)
- Some providers support response schema validation
- Inject `responseSchema` or `responseMimeType: "application/json"` to enforce structured output

### Gemini Tool Compat — `extensions/gemini-tool-compat.ts`

Runtime hook installation, mirrors `claude-code-compat.ts`:

```typescript
export function installGeminiToolCompat(pi: ExtensionAPI, rt: Runtime): void {
  // Request: inject toolConfig
  pi.on("before_provider_request", (event) => {
    const target = resolveGeminiCompatTarget(rt);
    if (!target.apply) return event.payload;
    return applyGeminiToolCompatToPayload(event.payload, target.opts);
  });

  // Tool call: detect empty args, block + request regeneration
  pi.on("tool_call", (event) => {
    const target = resolveGeminiCompatTarget(rt);
    if (!target.apply) return;
    if (hasMissingRequiredParams(event)) {
      return { block: true, reason: "..." };
    }
  });
}
```

### Config Schema Extension

```json
{
  "geminiToolCompat": {
    "mode": "auto" | "always" | "never",
    "hosts": ["elysia.h-e.top", ...],
    "forceToolConfigMode": "AUTO" | "VALIDATED",
    "blockEmptyToolCalls": true,
    "convertSchema": true
  },
  "providerOverrides": {
    "<dbId>": {
      "geminiToolCompat": true
    }
  }
}
```

Mode semantics (same philosophy as Claude Code compat — `auto` targets the known-problem scope only):
- `auto` (default): non-official Gemini endpoints (proxies) only; official `*.googleapis.com` and the default endpoint are untouched. If `hosts` is non-empty, require a hostname match (exact or parent domain, `hostMatches` semantics)
- `always`: every Gemini API provider (ignore `hosts`)
- `never`: off unless per-provider `geminiToolCompat: true`
- No resolved provider → do not apply (avoids `tool_call` blocking on non-Gemini sessions)
- Injected `toolConfig` mode defaults to `AUTO`; `VALIDATED` only via explicit `forceToolConfigMode` (repro #4 in gemini-tool-call-compat-research.md: VALIDATED unreliable through proxies)

### Codex Compat Assessment

Currently no runtime compat needed for Codex. The `openai-codex-responses` adapter:
- Always sends `tool_choice: "auto"` and `parallel_tool_calls: true`
- Uses `strict: null` (lets the API decide)
- Has deferred tools support via `splitDeferredTools`

Potential future issues:
- Some Codex proxies may not support `tool_search_call` message type
- `parallel_tool_calls` may not be supported by all proxies
- These can be handled with a similar thin adapter if they arise

### Claude Code Compat Assessment

Already fully handled. The existing layer covers:
- Tool fingerprinting (stub tools for relay gates)
- System prefix (Agent SDK / CLI)
- Metadata (user_id, session_id)
- Thinking transformation (budget → adaptive)
- Header beta flags

No changes needed.

## Implementation Priority

1. **`src/compat/gemini-tool-compat.ts`** — pure logic (toolConfig injection, empty-args detection)
2. **`extensions/gemini-tool-compat.ts`** — hook installation
3. **`extensions/index.ts`** — wire `installGeminiToolCompat`
4. **`src/types.ts`** — add `GeminiToolCompatConfig` type
5. **Tests** — `tests/gemini-tool-compat.test.ts` (mirror `claude-code-compat.test.ts` structure)
6. **Config** — add `geminiToolCompat` to pi-switch.json schema

## Risk Assessment

- **Low risk**: Injecting `toolConfig: AUTO` is a no-op for official Gemini API (it's the default)
- **Medium risk**: `VALIDATED` mode may reject some tool schemas that don't comply with Gemini's strict requirements
- **Medium risk**: `tool_call` blocking for empty args changes behavior — the model will see a "blocked" result and need to regenerate. This adds latency but prevents silent failures.
- **Low risk**: Default `auto` applies to all Gemini API providers (empty `hosts`); use `hosts` or per-provider force to narrow
