# pi-switch

[![CI](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/Bandersnatch0x/pi-switch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-switch?style=flat-square)](https://www.npmjs.com/package/pi-switch)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[English](./README.md) | 中文

pi-switch 是一个面向 Pi 的扩展包，依托于 [cc-switch](https://github.com/farion1231/cc-switch) 构建。它以 cc-switch 作为 Provider 和模型配置的数据来源，并在 Pi 内提供快速切换 Provider 与模型的入口。

pi-switch 不替代 cc-switch，也不会修改 cc-switch 数据库。它只会以只读方式读取本机 cc-switch SQLite 数据库，然后把选中的 Provider 注册到 Pi，并把当前模型写入 Pi 的设置。

## 预览

以下为样例截图，用于展示交互形态；实际 Provider、模型和路径以你的本机 cc-switch 数据为准。

![类型选择](./docs/images/sample-provider-picker.svg)

![模型选择](./docs/images/sample-model-picker.svg)

![切换完成](./docs/images/sample-switch-success.svg)

## 功能特性

- 在 Pi 内通过 /pi-switch 或 /ccs 打开交互式切换器。
- 从本机 cc-switch SQLite 数据库只读加载 Provider 配置。
- 支持按类型、名称、模型的渐进式三级选择流程。
- 支持搜索、翻页、手动输入模型 ID、远程刷新模型列表。
- 自动解析并映射常见协议：Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、Google Generative AI。
- 支持 Header 规则合并，用于补齐 anthropic-version、anthropic-beta 等允许的请求头。
- 选中后注册 Pi Provider，并持久化最近一次选择，方便下次高亮与复用。

完整产品契约见 [SPEC.md](./SPEC.md)。

## 依托 cc-switch

cc-switch 是上游配置管理工具。pi-switch 依托 cc-switch 的本地数据模型，并把 cc-switch 视为 Provider 配置的事实来源。

pi-switch 的定位是 Pi 侧桥接工具：

- cc-switch 负责 Provider 的创建、编辑、删除和存储。
- pi-switch 从 ~/.cc-switch/cc-switch.db 只读读取 Provider。
- pi-switch 将 Provider 配置归一化为 Pi 可注册的 Provider。
- pi-switch 切换 Pi 当前模型，但不改变 cc-switch 的状态。

因此，推荐先在 cc-switch 中配置 Provider，再通过 pi-switch 在 Pi 内选择并启用。

## 架构

~~~text
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
└──────────┬───────────┘
           │ 选中的 Provider/模型
           ▼
┌──────────────────────┐
│          Pi          │
│ 注册 Provider + 设模型 │
└──────────────────────┘
~~~

主要模块：

~~~text
pi-switch/
├─ extensions/
│  └─ index.ts              # Pi 扩展入口，注册 /pi-switch 与 /ccs
├─ src/
│  ├─ db.ts                 # 只读读取 cc-switch SQLite 数据库
│  ├─ register.ts           # 构建并注册 Pi Provider
│  ├─ settings.ts           # Pi 设置读写与迁移
│  ├─ sqlite-path.ts        # sqlite3 路径解析
│  ├─ models-fetch.ts       # 远程模型列表发现与合并
│  ├─ headers/              # Header 规则与合并逻辑
│  ├─ parse/                # cc-switch Provider 配置解析
│  └─ ui/                   # 分页、标签、三级选择 UI
├─ defaults/
│  └─ headers.json          # 默认 Header 规则
├─ docs/
│  └─ images/               # README 样例截图
├─ tests/                   # Bun 测试
├─ SPEC.md                  # 产品规格
├─ DESIGN.md                # UI 与交互设计记录
└─ package.json
~~~

## 安装

推荐从 npm 安装：

~~~bash
pi install npm:pi-switch
~~~

也可以从 GitHub 安装：

~~~bash
pi install git:github.com/Bandersnatch0x/pi-switch
~~~

更新与启用扩展：

~~~bash
pi update npm:pi-switch
pi config
~~~

Pi 包通常会安装到 ~/.pi/agent/npm/；如果使用项目局部安装，则位于当前项目的 .pi/npm/。

## 使用方式

在 Pi 会话中输入：

~~~text
/pi-switch
~~~

或使用别名：

~~~text
/ccs
~~~

典型流程：

1. 选择 Provider 类型，例如 Claude Code、Codex、Gemini、OpenCode 等。
2. 选择具体 Provider。
3. 选择模型，或手动输入模型 ID。
4. pi-switch 注册 Provider，并切换 Pi 当前模型。

选择完成后，Pi 会使用所选 Provider 的 baseUrl、apiKey、协议类型和模型 ID 发起后续请求。

## 运行要求

- 已安装 Pi，并启用扩展包能力。
- 已安装并配置 cc-switch。
- 本机存在 cc-switch 数据库。
- 系统可执行 sqlite3。

默认数据库路径：

~~~text
~/.cc-switch/cc-switch.db
~~~

sqlite3 解析顺序：

~~~text
SQLITE3_PATH → ~/.pi/agent/pi-switch.json 中的 sqlitePath → PATH 中的 sqlite3
~~~

Windows 用户如果没有全局安装 sqlite3.exe，建议显式配置 SQLITE3_PATH。

## 配置

可选配置文件：

~~~text
~/.pi/agent/pi-switch.json
~~~

示例：

~~~json
{
  "dbPath": "C:/Users/you/.cc-switch/cc-switch.db",
  "sqlitePath": "C:/tools/sqlite3.exe",
  "preferredOrder": ["claude-code", "codex", "gemini", "opencode"],
  "debug": false
}
~~~

| 字段 | 说明 |
| --- | --- |
| dbPath | 覆盖 cc-switch 数据库路径 |
| sqlitePath | 覆盖 sqlite3 可执行文件路径 |
| preferredOrder | Provider 类型在 UI 中的优先排序 |
| debug | 输出调试信息 |

最近一次选择会写入 Pi 设置文件中的 piSwitchSelection，用于下次打开时高亮当前选择。

## Header 规则

默认 Header 规则位于：

~~~text
defaults/headers.json
~~~

用户可选覆盖文件：

~~~text
~/.pi/agent/provider-headers.json
~~~

pi-switch 只合并白名单内 Header，避免把任意敏感字段注入 Provider 配置。当前白名单包括：

- anthropic-version
- anthropic-beta

规则优先级按项目规范执行：用户规则优先于默认规则，选择时的显式覆盖优先级最高。

## 开发

安装依赖：

~~~bash
bun install
~~~

运行测试：

~~~bash
bun test
~~~

类型检查：

~~~bash
bun run typecheck
~~~

发布前检查：

~~~bash
bun run prepublishOnly
~~~

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

## 许可证

[MIT](./LICENSE)
