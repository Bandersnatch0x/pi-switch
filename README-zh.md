# pi-switch

[![CI](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-ccs?style=flat-square)](https://www.npmjs.com/package/pi-ccs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) | 中文

pi-switch 是一个面向 Pi 的扩展包，依托于 [cc-switch](https://github.com/farion1231/cc-switch) 构建。它以 cc-switch 作为 Provider 和模型配置的数据来源，并在 Pi 内提供快速切换 Provider 与模型的入口。

pi-switch 不替代 cc-switch，也不会修改 cc-switch 数据库。它只会以只读方式读取本机 cc-switch SQLite 数据库，然后把选中的 Provider 注册到 Pi，并把当前模型写入 Pi 的设置。

## 预览

以下为样例截图，用于展示交互形态；实际 Provider、模型和路径以你的本机 cc-switch 数据为准。

![类型选择](https://cdn.jsdelivr.net/npm/pi-ccs@latest/docs/images/sample-provider-picker.svg)

![模型选择](https://cdn.jsdelivr.net/npm/pi-ccs@latest/docs/images/sample-model-picker.svg)

![切换完成](https://cdn.jsdelivr.net/npm/pi-ccs@latest/docs/images/sample-switch-success.svg)

## 功能特性

- 在 Pi 内通过 `/ps-config`（可选别名 `/ccs`）打开交互式切换器。
- 从本机 cc-switch SQLite 数据库只读加载 Provider 配置。
- 支持按类型 → 名称 → 模型的渐进式三级选择流程。
- 支持搜索（`/`）、手动输入模型 ID、远程刷新，以及快捷键 `p` 本地 pin 常用模型（可滚动列表，**不做**分页/跳页）。
- 本地记录 last-N 最近切换（不做 expose 配置中心）。
- 自动解析并映射常见协议：Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、Google Generative AI。
- 默认注入类官方 CLI 指纹（Codex UA+`originator`、Claude Code `claude-cli/... (external, cli)` + `anthropic-version`/`anthropic-beta`、GeminiCLI UA + `x-goog-api-client`）。
- 通过预设或原生弹窗覆写模型参数（`/ps-override` 或快捷键 `o`），例如 **中转兼容** 关闭被拒的 `reasoning`。
- `/ps-doctor` 结构化体检（PASS/WARN/FAIL + 修复建议）。
- 选中后注册 Pi Provider，并持久化最近一次选择，方便下次高亮与复用。
- 附带 `diagnose-upstream` skill 作为补充知识，便于排查上游 / 中转问题。

完整产品契约见 [SPEC.md](./SPEC.md)。

## 依托 cc-switch

cc-switch 是上游配置管理工具。pi-switch 依托 cc-switch 的本地数据模型，并把 cc-switch 视为 Provider 配置的事实来源。

pi-switch 的定位是 Pi 侧桥接工具：

- cc-switch 负责 Provider 的创建、编辑、删除和存储。
- pi-switch 从 `~/.cc-switch/cc-switch.db` 只读读取 Provider。
- pi-switch 将 Provider 配置归一化为 Pi 可注册的 Provider。
- pi-switch 切换 Pi 当前模型，但不改变 cc-switch 的状态。

因此，推荐先在 cc-switch 中配置 Provider，再通过 pi-switch 在 Pi 内选择并启用。

### 本项目是什么 / 不是什么

| 本项目（Bandersnatch0x/pi-switch） | 不是本项目 |
|---|---|
| **cc-switch → Pi 桥** | 本地 HTTP 网关 / 反向代理 |
| 只读消费 `cc-switch.db` | All-in-One Provider CRUD 管理器 |
| 进程内 Pi 扩展（`/ps-config`） | 带 WebUI 的独立守护进程 |
| 仅本地 pin / recent 快捷 | 多工具 expose 配置中心 |

若你需要「本地起网关、自己管 Provider」的方案，可参考 [@cokefenta/pi-switch](https://www.npmjs.com/package/@cokefenta/pi-switch) / [CallmeLins/pi-switch](https://github.com/CallmeLins/pi-switch)。本仓库刻意保持为 cc-switch 之上的 Pi 侧薄桥。

## 架构

```text
┌──────────────────────┐
│      cc-switch       │
│ Provider 配置管理     │
└──────────┬───────────┘
           │ 只读 SQLite
           ▼
┌──────────────────────┐
│      pi-switch       │
│ 读取 DB + 配置归一化  │
└──────────┬───────────┘
           │ 解析后的 Provider
           ▼
┌──────────────────────┐
│     交互式选择器      │
│ 类型 → 名称 → 模型    │
│   （+ 参数覆写弹窗）   │
└──────────┬───────────┘
           │ 选中的 Provider/模型
           ▼
┌──────────────────────┐
│          Pi          │
│ 注册 Provider + 设模型 │
└──────────────────────┘
```

主要模块：

```text
pi-switch/
├─ extensions/
│  └─ index.ts                 # Pi 入口：/ps-config、/ps-doctor、/ps-override
├─ src/
│  ├─ db.ts                    # 只读读取 cc-switch SQLite 数据库
│  ├─ register.ts              # 构建并注册 Pi Provider
│  ├─ settings.ts              # Pi 设置、最近选择、providerOverrides
│  ├─ sqlite-path.ts           # sqlite3 路径解析
│  ├─ models-fetch.ts          # 远程模型列表发现与合并
│  ├─ headers/                 # Header 规则、合并与变量
│  ├─ parse/                   # cc-switch Provider 配置解析
│  └─ ui/
│     ├─ three-level-pick.ts   # 类型 → 名称 → 模型三级选择器
│     ├─ model-meta-dialog.ts  # modelMeta 参数覆写弹窗
│     ├─ labels.ts             # 显示名与状态文案
│     └─ tabs.ts               # 标签辅助
├─ skills/
│  └─ diagnose-upstream/       # 上游 / 中转诊断 skill
├─ defaults/
│  └─ headers.json             # 默认 Header 规则
├─ docs/
│  └─ images/                  # README 样例截图
├─ tests/                      # Bun 测试
├─ SPEC.md                     # 产品规格
├─ DESIGN.md                   # UI 与交互设计记录
└─ package.json
```

## 安装

### 从 npm 安装（推荐）

```bash
pi install npm:pi-ccs
```

当包以公开方式发布到 npm，且 `keywords` 包含 `pi-package`、`package.json` 中有合法的 `pi` 清单时，它也可能出现在 [Pi 包目录](https://pi.dev/packages)。目录没有单独的提交表单，主要依赖公开 npm 元数据自动发现。

上架后的详情页形态：

```text
https://pi.dev/packages/pi-ccs
```

### 从 GitHub 安装

```bash
pi install git:github.com/Bandersnatch0x/pi-switch
```

即使尚未上架 npm / 目录，也可以用 Git 安装。

### 更新与启用

```bash
pi update npm:pi-ccs
pi config
```

Pi 包通常会安装到 `~/.pi/agent/npm/`；如果使用项目局部安装，则位于当前项目的 `.pi/npm/`。

## 使用方式

在 Pi 会话中输入：

```text
/ps-config
```

别名：

```text
/ccs
```

如需修改模型参数覆写（例如关闭 `reasoning`，修复 Claude 协议 → GLM 中转报错）：

```text
/ps-override
```

在三列选择器中，进入 **名称** 列后按 **`o`**，可对当前 Provider 打开同样的参数覆写弹窗；页脚会显示 `o override`。

典型流程：

1. 选择 Provider 类型，例如 Claude Code、Codex、Gemini、OpenCode 等。
2. 选择具体 Provider。
3. 选择模型，或手动输入模型 ID。
4. pi-switch 注册 Provider，并切换 Pi 当前模型。

选择完成后，Pi 会使用所选 Provider 的 baseUrl、apiKey、协议类型和模型 ID 发起后续请求。

### 参数覆写弹窗

弹窗走 Pi 原生交互（`select` / `input` / `confirm`），不再挤在 TUI 窄窗里改：

```text
参数覆写 · elysiver-claude
- reasoning · 默认 / true / false
- contextWindow · 数字或默认
- maxTokens · 数字或默认
- thinkingFormat · 字符串或默认
- 清除全部覆写
- 保存
- 取消
```

保存后写入 `providerOverrides`，键是 cc-switch 的 **dbId**。若该 Provider 当前已激活，会立即重新注册生效。

## 运行要求

- 已安装 Pi，并启用扩展包能力。
- 已安装并配置 cc-switch。
- 本机存在 cc-switch 数据库。
- 系统可执行 sqlite3。

默认数据库路径：

```text
~/.cc-switch/cc-switch.db
```

sqlite3 解析顺序：

```text
SQLITE3_PATH → ~/.pi/agent/pi-switch.json 中的 sqlitePath → PATH 中的 sqlite3
```

Windows 用户如果没有全局安装 `sqlite3.exe`，建议显式配置 `SQLITE3_PATH`。

## 配置

可选配置文件：

```text
~/.pi/agent/pi-switch.json
```

示例：

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

| 字段 | 说明 |
| --- | --- |
| `sqlitePath` | 覆盖 sqlite3 可执行文件路径（`null` 禁用查找） |
| `tabs` | 选择器中 Provider 类型优先顺序 |
| `vars` | 可选覆盖 UA 模板版本号（缺省则自动探测） |
| `providerOverrides` | 按 Provider 的 `label` / `fingerprint` / `headers` / `modelMeta` 覆写（以 **dbId** 为键） |
| `aliasCcs` | 是否注册 `/ccs` 别名（默认 `true`） |
| `debug` | 输出调试信息 |

数据库路径**不在**此文件配置——用环境变量 `CC_SWITCH_DB` 或默认 `~/.cc-switch/cc-switch.db`。

### 参数覆写（`providerOverrides`）

部分中转网关不接受 Anthropic 风格字段。常见报错：

```text
Unsupported parameter(s): `reasoning`
```

请用弹窗（`/ps-override` 或选择器快捷键 `o`）把 `modelMeta.reasoning` 设为 `false`，也可同时设置简短 `label`。配置会按 cc-switch 的 **dbId** 写入 `~/.pi/agent/pi-switch.json`：

```json
{
  "providerOverrides": {
    "dooongai-1775180253543": {
      "label": "elysiver-claude",
      "modelMeta": {
        "reasoning": false
      }
    }
  }
}
```

可选 `fingerprint` 字段可强制某套 CLI 指纹（与协议默认无关）：

| 值 | 效果 |
| --- | --- |
| `claude-code` | `claude-cli/<ver> (external, cli)` + anthropic version/beta |
| `codex` | `codex_cli_rs/<ver> (...)` + `originator` |
| `gemini` | `GeminiCLI/<ver>` + `x-goog-api-client` |
| `none` | 跳过默认/按 api 匹配的规则注入；仅保留显式 `headers`（可为空） |

显式 `headers` 与预设冲突时，以 `headers` 为准。

支持的 `modelMeta` 字段：

| 字段 | 说明 |
| --- | --- |
| `reasoning` | 是否允许 Pi 发送 reasoning/thinking 参数 |
| `thinkingFormat` | 仅允许：`openai` / `openrouter` / `together` / `deepseek` / `zai` / `qwen` / `chat-template` / `qwen-chat-template` / `string-thinking` / `ant-ling` |
| `contextWindow` | 上下文窗口 |
| `maxTokens` | 最大输出 token |

保存后，若该 Provider 当前已激活，pi-switch 会立即重新注册，使覆写马上生效。

最近一次选择会写入 Pi 设置文件中的 `piSwitchSelection`，用于下次打开时高亮当前选择。

> 说明：当前远程模型列表只保留模型 **ID**，不会从 `/models` 导入各模型参数；参数来自协议默认值 + 可选的 `providerOverrides.modelMeta`。

## Header 规则

默认 Header 规则位于：

```text
defaults/headers.json
```

用户可选覆盖文件：

```text
~/.pi/agent/provider-headers.json
```

pi-switch 只合并白名单内 Header，避免把任意敏感字段注入 Provider 配置。白名单：

| Header | 默认规则是否注入 | 说明 |
| --- | --- | --- |
| `User-Agent` | 是 | 版本/系统自动探测；可按 provider / fingerprint 覆盖 |
| `anthropic-version` | 是（claude） | Anthropic Messages 协议必需 |
| `anthropic-beta` | 是（claude） | Claude Code beta flags（`vars.anthropicBeta`） |
| `originator` | 是（codex） | Codex CLI 私有头（`vars.codexOriginator`） |
| `x-goog-api-client` | 是（gemini） | Gemini CLI 客户端标识（`gemini-cli/<ver>`） |

`Authorization` / `x-api-key` / `Host` 等**永远不能**通过规则或 override 注入。

优先级：`defaults/headers.json` < `~/.pi/agent/provider-headers.json` < `providerOverrides[dbId].headers`。

## 开发

安装依赖：

```bash
bun install
```

运行测试：

```bash
bun test
```

类型检查：

```bash
bun run typecheck
```

发布前检查：

```bash
bun run prepublishOnly
```

### 发布与 GitHub 自动发包

发布流程参考 vibe-designing-playbook 的 release gate：

1. 本地 dry-run 门禁（`tree` / `version` / `test` / `pack` / `tag`）
2. 门禁通过后创建 `vX.Y.Z` 标签
3. 推送标签；GitHub Actions 自动发布到 npm

GitHub 一次性配置：

1. 在 npm 创建带 publish 权限的 **Automation** token
2. 仓库 → **Settings → Secrets and variables → Actions → New repository secret**
3. 名称：`NPM_TOKEN`，值：token

发布步骤：

```bash
# 1) 修改 package.json 版本（保持 semver）
# 2) 提交全部发布改动
bun run release              # dry-run 门禁（不打 tag）
bun run release:apply        # 门禁通过后创建 vX.Y.Z
git push origin main
git push origin v0.1.0       # 触发 Actions 发包
```

也可在 **Actions → CI → Run workflow** 勾选 `publish=true` 手动重发（该 commit 上必须已有对应 `vX.Y.Z` tag）。

工作流行为：

- push/PR 跑测试 + pack dry-run
- 仅在 `v*` 标签（或手动 dispatch）时发包
- 校验 tag 版本 == `package.json` 版本
- 若 npm 上已有该版本则跳过
- 使用 `npm publish --access public --provenance`

## 支持的配置来源

pi-switch 会解析 cc-switch providers 表中的 Provider 配置，并尽量归一化为 Pi 可注册的 Provider。

- Claude / Claude Code 配置解析
- Codex 配置解析
- Gemini 配置解析
- Grok Build 配置解析
- OpenCode 配置解析
- Hermes 配置解析
- Generic / OpenAI 兼容配置解析

如果某个 Provider 的协议无法映射到 Pi 支持的 API 类型，会在 UI 中显示为不可切换，而不是强行注册。

## 非目标

- 不编辑 cc-switch 数据库。
- 不提供 Provider 新增、删除、排序或迁移能力。
- 不内置 API Key 管理器。
- 不做额度统计或费用统计。
- 不替代 cc-switch 本身，只作为 Pi 内部的切换入口。
- 不从远程 `/models` 响应导入 per-model 元数据（仅 ID）。

## 许可证

[MIT](./LICENSE)
