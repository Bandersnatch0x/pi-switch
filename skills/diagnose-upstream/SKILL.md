---
name: diagnose-upstream
description: 诊断 pi-switch 切换 Provider 后连接上游出现的报错（400/401/403/429/5xx、reasoning 参数、模型拉取失败、UA 指纹拒绝），并给出可执行的修复方案。
---

# 诊断上游连接报错

当用户通过 pi-switch（`/ps-config` / `/ccs`）切换 Provider/Model 后，向上游发请求时报错，用本 skill 定位根因并给出修复。

> **优先**：先跑 `/ps-doctor` 拿结构化 PASS/WARN/FAIL 报告（环境、DB、指纹、modelMeta、pin）。本 skill 提供 doctor 之外的深度排查知识。

## 使用前先收集

1. **完整报错**：HTTP 状态码 + 响应体（`Error: <code> {...}`）。
2. **当前选择**：`~/.pi/agent/settings.json` 里的 `piSwitchSelection`（dbId / model / appType）。
3. **崩溃日志**（如有）：`~/.pi/agent/pi-crash.log`。
4. **thinking 级别**：`settings.json` 的 `defaultThinkingLevel`。

## 报错分类速查表

| 状态码 / 症状 | 最可能根因 | 跳转 |
|---|---|---|
| `400 ... Unsupported parameter(s): reasoning` | 模型不支持 thinking，但被注册为 `reasoning: true` | [§400](#400-reasoning-参数不支持) |
| `400 ... model not found / invalid model` | model id 与上游不符 | [§400-model](#400-model-id-错误) |
| `401` / `403` | apiKey 无效、认证头类型不对（Bearer vs x-api-key） | [§401](#401403-认证失败) |
| `429 rate_limit_exceeded` | 上游限流 | [§429](#429-限流) |
| `502 Bad gateway` / `503 No available accounts` | 上游/中转侧故障，非本地问题 | [§5xx](#5xx-上游网关故障) |
| `Connection error` / 切换后立刻断连 | UA 指纹被中转拒绝 | [§ua](#connection-error--ua-指纹) |
| `400 ... 1m 上下文已经全量可用，请启用 1m 上下文` | anyrouter 等中转要求 `context-1m` beta | [§1m](#400-1m-上下文门闸) |
| `503 {"error":{"message":"Service Unavailable"...}}`（anyrouter） | 中转校验 Claude Code 客户端指纹（metadata.user_id + Agent SDK system 前缀） | [§503-cc](#503-anyrouter-claude-code-指纹) |
| 模型列表拉取失败（`f` 刷新） | 候选 URL 算错 / 端点不开放 | [§fetch](#模型列表拉取失败) |

---

## 400 reasoning 参数不支持

**报错**：`400 {"error":{"message":"...Unsupported parameter(s): reasoning..."}}`

**根因**：Pi SDK 用 `model.reasoning` 判断模型是否支持 thinking。pi-switch 默认对 `anthropic-messages` / `openai-responses` 协议注册 `reasoning: true`。若 `settings.json` 里 `defaultThinkingLevel` 非 `off`，SDK 就会向上游发 reasoning/thinking 参数。当 Provider 是**中转把 claude/codex 协议接到不支持 thinking 的模型**（如 GLM、部分 Qwen/DeepSeek 兼容端点）时，上游拒绝该参数 → 400。

**修复（推荐，精准到单个 Provider）**：编辑 `~/.pi/agent/pi-switch.json`，只给报错的 Provider 关掉 reasoning：

```json
{
  "providerOverrides": {
    "<dbId>": {
      "modelMeta": { "reasoning": false }
    }
  }
}
```

`<dbId>` 取自 `settings.json` 的 `piSwitchSelection.dbId`。改完 `/reload` 或重启 pi。

**修复（兜底，全局）**：`settings.json` 里 `"defaultThinkingLevel": "off"`。缺点：会关掉所有 Provider 的 thinking（含真支持的 Claude/Grok），仅在多个 Provider 都不支持时才这么做。

---

## 400 1M 上下文门闸

**报错**：`400 {"error":"1m 上下文已经全量可用，请启用 1m 上下文后重试","type":"error"}`

**根因**：中转（典型：**anyrouter.top**）要求请求带 Anthropic 官方 beta
`context-1m-2025-08-07`（完整字符串；日期是 beta 版本号，不是“今天”）。
Claude Code 会自动加；Pi 默认 beta 不含此项。模型 id **不必**带 `[1M]` 也会触发。

**pi-switch 行为**：注册时若 `baseUrl` 主机为 `anyrouter.top`（或子域）且协议为 `anthropic-messages`，自动把该 flag **合并**进 `anthropic-beta`，并把默认 `contextWindow` 设为 `1000000`（用户 `providerOverrides.modelMeta` 仍可覆盖）。

**手工兜底**（非 anyrouter 主机但同样要求 1M 时）：

```json
{
  "providerOverrides": {
    "<dbId>": {
      "headers": {
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07"
      },
      "modelMeta": { "contextWindow": 1000000 }
    }
  }
}
```

改完重新 `/ps-config` 切换或重启 pi 使注册生效。

---

## 503 anyrouter Claude Code 指纹

**报错**：`503 {"error":{"message":"Service Unavailable","type":"error"},"type":"error"}`  
（同一把 key 在 Claude Code 里正常，Pi 里连 anyrouter 必现。）

**根因**：anyrouter 等中转按 **Claude Code 请求形状** 做渠道门闸，不只是 UA/beta：

1. body `metadata.user_id` = JSON 字符串，内含 `device_id`（与 `~/.claude.json` 的 `userID` 一致，64 hex）
2. system 首块前缀为  
   `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
3. 仍需 `anthropic-beta` 含 `context-1m-2025-08-07`

缺任一项常返回糊成 **503 Service Unavailable**（不是 401）。

**pi-switch 行为**（`claudeCodeCompat`，默认 `mode: "auto"`）：

- 当前 Provider 的 `baseUrl` 为 `anyrouter.top`（或配置的 hosts）时自动：
  1. 注入 `metadata.user_id`（`device_id` 优先读 `~/.claude.json` `userID`；**`session_id` 必须非空 UUID**，空字符串会 503）
  2. system 前 prepend Agent SDK 前缀
  3. **tools[] 补齐 ≥10 个 Claude Code 工具 schema**（`Bash`/`Read`/`Glob`…；Pi 原工具保留）
  4. header 补 `x-app` / `anthropic-dangerous-direct-browser-access` / 完整 CC beta 集
  5. **Pi `thinking: {type:"enabled", budget_tokens}` → `adaptive` + `output_config.effort`**（enabled 预算模式在 anyrouter 上 503）
- 改完 **重启 pi**（hooks 在 extension 启动时注册）
- 运行痕迹：`~/.pi/agent/pi-switch-compat.log`（hook 是否触发）

配置示例（`~/.pi/agent/pi-switch.json`）：

```json
{
  "claudeCodeCompat": {
    "mode": "auto",
    "hosts": ["anyrouter.top"],
    "deviceIdSource": "claude-json",
    "systemPrefix": "agent-sdk",
    "injectToolFingerprint": true
  }
}
```

- `mode: "always"`：所有 anthropic-messages 请求都伪装  
- `mode: "never"`：关闭  
- `providerOverrides.<dbId>.claudeCodeCompat: true|false`：单 Provider 强制开/关  

**注意**：stub 工具仅用于过门闸，Pi 不会执行它们；若模型误调 stub，会报工具不存在——正常对话应仍用 Pi 自己的工具名。若仍 503：看 `pi-switch-compat.log` 是否有 `apply:true`，确认 `userID` 存在，并降低 `retry.maxRetries` 避免打满限流（anyrouter 限流也返回 Service Unavailable）。

---

## 400 model id 错误

**报错**：`400 ... model not found` / `invalid model` / `no such model`。

**根因**：注册用的 model id 与上游实际接受的不一致（大小写、后缀 `[1M]`、厂商前缀 `anthropic/`）。

**修复**：
1. 在 `/ps-config` 里进入「模型」列，按 `f` 刷新拉取上游真实模型列表，选一个存在的。
2. 或按 `m` 手动输入上游文档里的准确 model id。
3. pi-switch **只 trim、不改写** model id（SPEC §5.10），所以以上游要求的原样为准。

---

## 401/403 认证失败

**根因**（两类）：
- **apiKey 失效/错误**：cc-switch 数据库里的 key 过期或复制错。
- **认证头类型不对**：Anthropic 系区分 `Authorization: Bearer`（对应 `ANTHROPIC_AUTH_TOKEN`）与 `x-api-key`（对应 `ANTHROPIC_API_KEY`），两者只发其一。pi-switch 的 `authHeader` 字段控制这个：`authHeader=true` → Bearer；`false` → 协议默认头（Anthropic=x-api-key，Google=x-goog-api-key）。

**修复**：
1. 先确认 key 本身有效（在 cc-switch 里核对，或用 curl 直连上游验证）。
2. 若 key 有效仍 401，多半是认证头类型不符：在 cc-switch 里确认该 Provider 用的是 `ANTHROPIC_AUTH_TOKEN` 还是 `ANTHROPIC_API_KEY`，两者对应不同的认证头。修正后重新在 pi-switch 切换。
3. **不要**在 `providerOverrides.headers` 里手写 `Authorization` / `x-api-key`——白名单会拒绝这些字段（安全设计），认证由 `authHeader` + apiKey 决定。

---

## 429 限流

**报错**：`429 {"error":{"message":"...rate-per-minute limit exceeded...","type":"rate_limit_exceeded"}}`。

**根因**：上游（或中转账户池）触发速率限制，非本地问题。

**修复**：等待后重试（响应体常带 `retry_after`）；或在 `/ps-config` 切到另一个 Provider/账户分流。这不是 pi-switch 的 bug。

---

## 5xx 上游网关故障

**报错**：
- `502 Bad gateway ... origin_bad_gateway`（Cloudflare：源站过载/配置错）
- `503 No available accounts: no available accounts supporting model:...`（中转账户池无可用账户 / 渠道定价限制）

**根因**：**上游或中转侧的故障，与 pi-switch 无关**。503 的 `channel pricing restriction` 表示该中转对这个模型有定价/权限限制，你的账户不能用。

**修复**：
1. 502/503 通常可重试（`retryable: true` + `retry_after`）——先等 60s 重试。
2. 503 `pricing restriction` 无法靠重试解决：换一个支持该模型的 Provider，或换模型。
3. 持续 5xx：该中转当前不可用，在 `/ps-config` 切换到其他 Provider。

---

## Connection error / UA 指纹

**症状**：切换后请求立刻 `Connection error` 或被中转拒绝，但 key、model 都正确。

**根因**：部分中转对 `User-Agent` 做指纹校验，要求匹配真实 codex/claude CLI 的 UA 形状。若 UA 不符（如裸 `Windows` 缺版本/架构，或版本号与 `anthropic-beta` flags 时间线矛盾），会被拒。

**修复**：pi-switch 已内置 UA 探测（读本机 `codex --version` / `claude --version`）+ 正确的 osInfo 形状。确认：
1. 已重启 pi（探测在启动时执行并缓存）。
2. 开 `pi-switch.json` 的 `"debug": true`，重启后日志会打印 `codexVersion=... (source=local/fallback)`——`fallback` 表示没探测到本机 CLI，版本号可能过时。
3. 若需为某中转定制 UA，在 `providerOverrides.<dbId>.headers` 里覆盖 `User-Agent`（白名单允许）。
4. 某些严格上游需要 `anthropic-beta` / `originator`（默认已移除，避免误伤）——按需在 `providerOverrides.<dbId>.headers` 加回。

---

## 模型列表拉取失败

**症状**：在「模型」列按 `f` 刷新，提示拉取失败或列表为空。

**根因**（两类）：
- **候选 URL 算错**：baseUrl 挂在兼容子路径（`/claude`、`/claudecode`、`/step_plan`、`/api/anthropic` 等），需剥离后缀再拼 `/v1/models`。pi-switch 已内置 9 个兼容后缀（按最长前缀优先）。
- **端点不开放**：该上游根本不提供 `/v1/models`（很多 Anthropic 直连、OAuth 端点不支持）。

**修复**：
1. 若上游不开放 models 端点：直接用 `m` 手动输入 model id，不依赖拉取。
2. 若 baseUrl 特殊：在 cc-switch 的 Provider meta 里设 `modelsUrl` 精确覆写拉取地址。
3. 拉取失败**不影响切换**——手动输入或选 configModels 里已有的即可。

---

## 排查流程建议

1. 读报错状态码 → 查速查表定位分类。
2. 区分**本地可修**（400 reasoning、401 认证头、UA）与**上游故障**（429/5xx）——后者别改本地配置，换 Provider 或等待。
3. 本地修复优先用 `pi-switch.json` 的 `providerOverrides.<dbId>`，精准到单个 Provider，不动全局。
4. 改完 `/reload` 或重启 pi 验证。
