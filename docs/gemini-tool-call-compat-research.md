# Gemini 工具调用兼容性研究报告

> 调查对象：pi 0.82.1 + elysiver/gemini-3.5-flash (elysia.h-e.top) 出现 `read({})` 空参数调用
> 日期：2026-07-30
> 方法：本地 dist 源码对照 + 上游 GitHub 源码 (earendil-works/pi, google-gemini/gemini-cli, googleapis/js-genai)

## 1. 三层架构对照

### 1.1 Pi (earendil-works/pi 0.82.1)

**工具声明 → 请求序列化**
- `packages/ai/src/api/google-shared.ts` `convertTools()`：
  - 默认发送 `parametersJsonSchema`（完整 JSON Schema），支持 anyOf/oneOf/const
  - 仅当 `useParameters=true`（Cloud Code Assist / Claude 模型）时才用旧式 `parameters`（OpenAPI 3.0.3）
- `resolveGoogleFunctionCallingMode()`：
  - 仅当某个工具声明了 `constrainedSampling: {type: "json_schema"}` 且模型支持 strict mode (Gemini 3+) 时，才发送 `toolConfig.functionCallingConfig.mode = VALIDATED`
  - 内置工具 (`read`, `bash`, `edit` 等) **没有**设置 `constrainedSampling`，所以 pi 通常不发送任何 `toolConfig`，模型处于默认 AUTO 模式，无参数强制约束

**参数校验 → 错误回送**
- `packages/agent/src/agent-loop.ts`：
  - `prepareToolCall()` → `validateToolArguments()` (来自 `@earendil-works/pi-ai`)
  - 校验失败时抛出 `Validation failed for tool "read": - path: must have required properties path`
  - 该错误变为 `toolResult { isError: true }`，通过 `functionResponse.error` 回送 Gemini
  - 循环继续——模型获得下一轮
- `packages/ai/src/utils/validation.ts`：基于 TypeBox 的校验 + 类型强制转换，能捕获缺失必填字段

**缺失机制**
- 没有 `MALFORMED_FUNCTION_CALL` finish reason 的专门处理——所有工具调用都被当作"有参数但可能非法"处理
- 没有循环检测——模型可以反复调用 `read({})` 而不会收到"你在重复"的反馈
- 没有 SDK 兼容层——直接使用 `@google/genai` 的 `generateContentStream`

### 1.2 Gemini CLI (google-gemini/gemini-cli 0.53.0)

**SDK 兼容层**
- `packages/core/src/core/geminiChat.ts`：**复制并维护**了一份 `@google/genai` 的 `chats.ts`，注释明确说明是为了绕过 SDK 的已知 bug（function responses 不被当作有效响应）
- 这证明即使是 Google 自己的 CLI 团队也认为 `@google/genai` 的 function-call 链路需要专门兼容

**流式校验 + 重试**
- `InvalidStreamError` 类型：`NO_FINISH_REASON`、`NO_RESPONSE_TEXT`、`MALFORMED_FUNCTION_CALL`、`UNEXPECTED_TOOL_CALL`
- 当模型产生 malformed function call 时，CLI 抛出 `InvalidStreamError` 并通过 `retryWithBackoff` **重试整个 turn**
- `packages/core/src/core/client.ts`：使用 `retryWithBackoff` 包裹 API 调用，有显式重试计数和退避

**工具校验 → 错误回送**
- `packages/core/src/tools/tools.ts` `validateBuildAndExecute()`：
  - `silentBuild()` 校验参数，失败时返回 `{llmContent: "Error: Invalid parameters provided. Reason: ...", error: {type: INVALID_TOOL_PARAMS}}`
  - 与 pi 相同的模式：错误回送 → 模型下一轮
- `packages/core/src/tools/tool-error.ts`：
  - 显式 `ToolErrorType` 枚举，`INVALID_TOOL_PARAMS = 'invalid_tool_params'`
  - `isFatalToolError()` 对 `INVALID_TOOL_PARAMS` 返回 false——明确标注为"可恢复，LLM 可自我纠正"

**循环检测**
- `LoopDetectionService`：当模型反复调用相同工具时，注入反馈文本 "Potential loop detected... Avoid repeating the same tool calls"

**工具声明**
- `read-file.ts`：参数名为 `file_path`（非 `path`），使用 `resolveDefensiveToolPath` + `resolveToRealPath`
- 使用标准 `FunctionDeclaration`，不依赖 `parametersJsonSchema`

### 1.3 @google/genai (js-genai 1.52.0)

- SDK 直接从流式 chunk 提供 `functionCall.args`
- Gemini CLI 的 fork 注释确认 SDK 在 function response 处理上有已知 bug

## 2. 根因分析

### 2.1 为什么会出现 `read({})`

**已验证的复现路径**（本机实测）：
1. 直接 SDK + 单个工具 + `toolConfig: {mode: ANY}` → 正确返回 `read({path: "src/ui/tabs.ts"})`
2. 直接 SDK + 7 个工具 + `toolConfig: {mode: ANY}` → 正确返回 `read({path: "src/ui/tabs.ts"})`
3. 直接 SDK + 7 个工具 + 无 `toolConfig`（模拟 pi 默认） → 返回 `read({})` ← **复现**
4. 直接 SDK + 7 个工具 + `toolConfig: {mode: VALIDATED}` → 也返回过 `read({})` ← 代理不可靠
5. 真实 pi CLI + 全扩展 → 模型选择 `ls`、`bash git status`、`bash bun test`，完全偏离，最终超时

**根因链**：
1. pi 默认不发送 `toolConfig`（因为没有工具声明 `constrainedSampling`）→ 模型处于 AUTO 模式，无参数强制
2. `elysia.h-e.top` 代理对 `parametersJsonSchema` 的兼容不稳定——可能不识别该字段，导致模型看不到 schema 约束
3. 网络层面 `fetch failed`、524 超时、流中断进一步干扰参数传递
4. pi 没有循环检测——模型反复 `read({})` 不会收到反馈，陷入循环

### 2.2 为什么 `ctx_execute_file` 不受影响

`ctx_execute_file` 的 schema 允许空参数（`path`、`code`、`language` 都不是必填的，有默认值或从上下文推断），所以即使代理丢掉 schema，模型仍然能正确调用。

## 3. 对照表

| 关注点 | Pi 0.82.1 | Gemini CLI 0.53.0 |
|--------|-----------|-------------------|
| Schema 字段 | `parametersJsonSchema`（默认） | `parameters`（标准 FunctionDeclaration） |
| toolConfig | 通常不发送（AUTO） | 依赖模型默认 |
| 缺参数处理 | 校验 → error toolResult → 下一轮 | 校验 → `INVALID_TOOL_PARAMS` → 下一轮 |
| Malformed function call | 不专门处理 | `InvalidStreamError` → 重试整个 turn |
| 循环检测 | 无 | `LoopDetectionService` 注入反馈 |
| SDK 兼容 | 直接使用 SDK | Fork `chats.ts` 绕过 SDK bug |

## 4. 修复方向建议

### 4.1 Google 适配层兼容策略（pi-ai 侧）

**方案 A：代理兼容降级**
- 检测 baseUrl 是否为非官方 Google 端点
- 对非官方端点，从 `parametersJsonSchema` 降级为 `parameters`（OpenAPI 3.0.3）
- 可配置开关 `compatibilityMode: "auto" | "strict" | "legacy"`

**方案 B：强制 VALIDATED 模式**
- 对 Gemini 3+ 模型，即使工具没有声明 `constrainedSampling`，也发送 `toolConfig.functionCallingConfig.mode = VALIDATED`
- 风险：部分代理对 VALIDATED 支持不完整（实测 elysia.h-e.top 曾返回空参数）

### 4.2 缺少必填参数时重新生成工具调用（pi-agent 侧）

**方案 C：malformed function call 专项重试**（参考 Gemini CLI）
- 在 `agent-loop.ts` 中检测 `MALFORMED_FUNCTION_CALL` 和 `UNEXPECTED_TOOL_CALL` finish reason
- 对这些情况，不执行工具，而是以"你的上一次工具调用缺少必填参数 X，请重新调用并提供该参数"为内容重试
- 与现有的 `failToolCallsFromTruncatedMessage`（处理 `length` stop reason）平行

**方案 D：循环检测**（参考 Gemini CLI）
- 在 agent loop 中加入轻量循环检测
- 当同一工具以相同（或空）参数被连续调用 N 次时，注入反馈："你在重复调用 read 但缺少 path 参数。请提供 path 参数或改用其他方式。"

### 4.3 验证测试

需要添加的回归测试（在 `packages/ai/test/` 或 `packages/coding-agent/test/`）：
1. `read({})` → 确认错误信息包含 "path" 且 isError=true
2. Gemini 3+ 模型 → 确认 `toolConfig` 是否发送 VALIDATED
3. `MALFORMED_FUNCTION_CALL` finish reason → 确认是否重试而非静默继续
4. 代理 baseUrl 非 googleapis.com → 确认 schema 字段选择

## 5. 源码引用

### Pi 本地 (0.82.1 dist)
- `@earendil-works/pi-ai/dist/api/google-shared.js:256-270` — `convertTools()` 使用 `parametersJsonSchema`
- `@earendil--works/pi-ai/dist/api/google-shared.js:289-298` — `resolveGoogleFunctionCallingMode()`
- `@earendil-works/pi-ai/dist/api/constrained-sampling.js:50-62` — `resolveJsonSchemaStrictSampling()` 需要工具声明 `constrainedSampling`
- `@earendil--works/pi-ai/dist/utils/validation.js:241-268` — `validateToolArguments()` 校验+错误格式化
- `@earendil-works/pi-agent-core/dist/agent-loop.js:121-123` — `length` stop reason 截断处理（可参考的模式）
- `@earendil-works/pi-coding-agent/dist/core/tools/read.js:16-20` — read schema 无 `constrainedSampling`

### Gemini CLI 上游 (main)
- `packages/core/src/core/geminiChat.ts` — fork 注释 + `InvalidStreamError` + `MALFORMED_FUNCTION_CALL` 重试
- `packages/core/src/core/client.ts` — `retryWithBackoff` + `LoopDetectionService`
- `packages/core/src/tools/tools.ts` — `validateBuildAndExecute()` + `INVALID_TOOL_PARAMS`
- `packages/core/src/tools/tool-error.ts` — `ToolErrorType` enum + `isFatalToolError()`
- `packages/core/src/tools/read-file.ts` — `file_path` 参数 + `resolveDefensiveToolPath`

### @google/genai (1.52.0)
- `node_modules/@google/genai/dist/node/index.mjs` — SDK stream parsing

## 6. 结论

用户的思路方向正确。问题不是"pi 无法加载 Gemini 工具"，而是 pi 的 Google 适配层在代理环境下缺少兼容策略，且 agent loop 缺少对 malformed/空参数工具调用的专项重试和循环检测。Gemini CLI 的实现提供了直接参考：SDK fork + InvalidStreamError 重试 + 循环检测 + 类型化错误系统。
