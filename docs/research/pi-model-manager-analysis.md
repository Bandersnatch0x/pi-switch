# pi-model-manager 可吸收点分析

> 研究日期：2026-07-29  
> 目标仓库快照：[`Qihuanxishini/pi-model-manager@586238f`](https://github.com/Qihuanxishini/pi-model-manager/tree/586238fe7073d212137084fcefd3c4ea7fbd1ec8)（v0.1.0）  
> 本地对比快照：`pi-switch@6b8e796`

## 结论先行

`pi-model-manager` 最值得吸收的不是“再做一个 Provider 管理器”，而是以下四类做法：

1. **配置写入的工程防护**：稳定快照、写前冲突检测、唯一临时文件、Windows rename 重试和可恢复失败信息。
2. **可复用的请求头 Profile**：把身份请求头从每个 Provider 的散落配置提升为具名资产，并明确拒绝认证类敏感字段。
3. **分阶段事务与错误报告**：持久化、运行时刷新、模型启用/救援分别报告，避免把“部分成功”压成一个笼统失败。
4. **管理型 TUI 的信息组织**：Provider 总览、模型能力表和稳定光标表单适合补强 `pi-switch` 的“查看有效配置”体验。

不建议当前直接吸收两项：

- **完整 `models.json` CRUD** 会改变 `pi-switch` 的产品边界。当前项目明确是只读 cc-switch 数据并负责快速切换的桥接层，而不是第二个配置权威源。[本地定位](../../README.md#L9-L11)
- **内置本地代理** 技术上可行，但会引入网络服务生命周期、SSE 转发、代理认证、SSRF/密钥脱敏和额外依赖，应该由明确用户需求驱动，而不是顺手并入。

另外必须执行一条硬约束：目标项目是 **AGPL-3.0-only**，本项目是 **MIT**。可以研究行为和重新实现设计，但不应直接复制其代码。[目标许可](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/package.json#L50) · [本地许可](../../package.json#L6)

### 按行动类型排序

| 类型 | 建议项 |
| --- | --- |
| **立即吸收** | JSON 写入并发/Windows 加固；分阶段事务结果；只读的有效配置总览。 |
| **验证后吸收** | 具名请求头 Profile；请求 transform 管线与 OpenAI Fast mode；按 Provider HTTP(S) proxy。 |
| **不建议吸收** | 在现有 `pi-switch` 内加入完整 `models.json` CRUD；替换本地模型发现和 Claude Code 兼容实现；任何形式的目标源码直接复制或近似移植。 |

## 目标项目概览

`pi-model-manager` 是一个直接运行在 Pi TUI 内的 Provider/模型管理扩展，以 `~/.pi/agent/models.json` 作为模型配置的唯一权威源，并用独立 `state.json` 保存请求头 Profile、代理开关和 Fast mode 等扩展私有元数据。[README](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/README.en.md#L9-L11) · [配置文件说明](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/README.en.md#L141-L148)

它提供的主要能力包括：

- 在 `/model-manager` 内新增、编辑、删除 Provider 和模型。
- 支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI。
- 从上游发现模型 ID，失败后允许手动输入。
- 编辑上下文、最大输出、视觉输入、推理能力、Anthropic Thinking 和 OpenAI Responses Fast mode。
- 为每个 Provider 配置 HTTP(S) 代理。
- 使用推荐、禁用、Claude Code、Codex 或自定义请求头 Profile。
- 原子写入配置，并在保存后重新注册运行时 Provider。

以上能力集中列在其 [README 功能清单](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/README.en.md#L37-L48)。实际界面是密集、键盘优先的管理台，而不是切换器；可参考其 [总览截图](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/assets/pi-model-manager-preview.png)。

### 架构亮点

| 模块 | 做法 | 价值 |
| --- | --- | --- |
| 入口与生命周期 | factory 阶段只注册 catalog，`session_start` 激活完整 transport，`session_shutdown` 关闭代理；请求变换统一挂在 `before_provider_request`。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/index.ts#L19-L77) | 避免启动阶段过早创建长生命周期资源。 |
| 配置文档 | `models.json` 保存 Pi 原生模型定义，`state.json` 只保存插件私有元数据；同步时尽量保留 TUI 不认识的原生字段。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/models-json-sync.ts#L139-L165) | 降低扩展升级或编辑时丢字段的风险。 |
| 事务层 | `model-mutations.ts` 集中处理持久化、enabledModels 同步、运行时重注册和模型救援，TUI 只收集用户意图。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/model-mutations.ts#L1-L22) | 交互层与副作用边界清楚。 |
| 写入安全 | 写前比较文件签名，发现其他进程修改就拒绝覆盖；Windows 下对暂时性 rename 错误指数式重试并降级 copy 覆盖。[并发保护](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/models-json-manager.ts#L80-L149) · [Windows 写入](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/atomic-write.ts#L11-L100) | 对 Windows 配置文件锁和并发编辑有现实防护。 |
| 请求管线 | 请求变换是有序列表，每个 transform 有独立警告，并在单次请求内惰性共享一次状态读取。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/request-pipeline.ts#L14-L60) | 后续增加协议兼容逻辑时不必堆叠互相覆盖的 hooks。 |
| Provider 代理 | Provider 运行时 base URL 指向随机端口的 loopback route，再经 `http-proxy-agent` / `https-proxy-agent` 转发；过滤 hop-by-hop headers，并直接 pipe SSE/body。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/local-proxy-service.ts#L21-L85) | 在不修改 Pi 本体的前提下实现每 Provider 代理。 |
| 管理型 TUI | Dashboard、Provider 编辑器、模型编辑器、模型发现和请求头面板使用持久菜单与稳定 cursor。[Dashboard](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/tui/dashboard.ts#L320) | 适合反复编辑的工作流，不会每改一个字段就退出上下文。 |

## 与 pi-switch 的能力对比

| 维度 | pi-model-manager | pi-switch 当前能力 | 判断 |
| --- | --- | --- | --- |
| 产品定位 | Pi 原生 Provider/模型管理器 | cc-switch 到 Pi 的只读桥接与快速切换器。[README](../../README.md#L9-L11) | 两者互补，不应直接合并定位。 |
| 日常切换 | 保存配置但不主动切换当前会话模型。[README](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/README.en.md#L97-L99) | `/ps` 将 pin + recent 合并到最多 10 条的一屏热路径。[源码](../../src/ui/quick-pick.ts#L12-L46) | `pi-switch` 明显更强。 |
| Provider/模型 CRUD | 完整 TUI CRUD，并写入 `models.json`。 | 明确不改 cc-switch DB，仅注册和切换。[SPEC](../../SPEC.md#L29-L41) | 不建议在现有产品内补齐。 |
| 模型发现 | 每种协议构造一个主要 `/models` URL，10 秒超时，支持代理与手动兜底。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/tui/model-list-fetch.ts#L44-L91) | 移植 cc-switch 候选 URL 逻辑，按候选尝试并处理兼容后缀；picker 内支持刷新与手动输入。[源码](../../src/models-fetch.ts#L4-L16) · [交互](../../src/ui/three-level-pick.ts#L9-L18) | 不需要迁移对方的发现算法；本地实现更贴合上游。 |
| 模型参数 | 完整模型编辑，包括 input、reasoning、thinking、context、max tokens、Fast mode。 | 已有 Provider/模型两级覆盖、glob 匹配、reasoning、thinkingFormat、contextWindow、maxTokens。[README](../../README.md#L214-L214) · [类型](../../src/types.ts#L67-L73) | 只缺少少数请求期能力，如 `service_tier`。 |
| 请求身份 | 内置/自定义具名 Profile，可复用；拒绝认证类 headers。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/state-document.ts#L37-L40) | 默认指纹、全局规则和 per-provider headers 已有，但没有具名复用 Profile。[README](../../README.md#L305-L323) | 值得吸收 Profile 数据模型和 UI。 |
| 请求体兼容 | 统一管线处理 Claude metadata、OpenAI Responses instructions、Fast mode。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/request-pipeline.ts#L30-L60) | 已有更完整的 Claude Code request-shape 兼容 hook。[源码](../../extensions/claude-code-compat.ts#L18-L60) | 管线形式值得借鉴；Claude 实现无需替换。 |
| HTTP 代理 | 每 Provider 内置 loopback 代理。 | 明确不是本地 HTTP gateway/reverse proxy。[README](../../README.md#L53-L58) | 高成本可选项。 |
| 配置写入 | 唯一 tmp、Windows 重试、写前签名冲突检测。 | 已是 tmp + rename，但 tmp 名仅含 PID，且没有 Windows 重试或写前冲突检测。[源码](../../src/settings.ts#L58-L65) | 最直接、最值得补强的工程点。 |
| 诊断 | 启动/保存时给出局部错误，但没有独立 doctor。 | `/ps-doctor` 有 PASS/WARN/FAIL、修复建议、失效 pin/override 检查。[README](../../README.md#L34) | `pi-switch` 明显更强。 |
| 工程成熟度 | 仓库创建于 2026-07-26；当前快照 38 个 TS 文件、0 个测试文件、无 test script、0 个 GitHub Actions workflow、0 个 GitHub Release；Git 历史仅 3 个提交，核心 7516 行一次性进入初始提交。[仓库 API](https://api.github.com/repos/Qihuanxishini/pi-model-manager) · [Actions API](https://api.github.com/repos/Qihuanxishini/pi-model-manager/actions/workflows) · [Releases API](https://api.github.com/repos/Qihuanxishini/pi-model-manager/releases) · [初始提交](https://github.com/Qihuanxishini/pi-model-manager/commit/f1f033dd2bcea43b09e5560132b9f759a01c8d77) | 当前 20 个测试文件、`bun test`/typecheck/smoke、29 个提交和 4 个版本 tag。[package](../../package.json#L44-L56) · [tests](../../tests/) | 对方设计可参考，但不能因代码量大就视为已验证。 |
| 许可 | AGPL-3.0-only。[package](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/package.json#L50) | MIT。[package](../../package.json#L6) | 必须 clean-room 重写，不能复制实现。 |

## AGPL 与 MIT 的复用边界

以下是本项目应采用的工程政策，不构成法律意见：

**可以做：**

- 阅读 README、界面和源码，提炼问题、行为、约束、失败模式与验收标准。
- 基于这些公开事实，在本仓库现有模块、命名、接口和测试风格中独立设计实现。
- 用黑盒行为测试表达需求，例如“检测外部修改后拒绝覆盖”“Windows 文件锁短暂存在时重试”。
- 采用通用且不受该项目独占的技术思想，例如临时文件 + replace、optimistic concurrency、命名 Profile、请求变换流水线。

**不应做：**

- 复制目标文件、函数或大段代码后仅改名、翻译注释、调整格式或改成同步/异步版本。
- 按其函数边界、控制流、错误文案和常量逐行近似移植，再继续把本仓库整体标为 MIT。
- 将目标源码作为 vendored module、生成代码模板或补丁来源纳入发布包。

**建议流程：**先把要吸收的行为写成本仓库自己的短规格和测试，再由未复制源码的实现完成；评审时只对照行为是否满足，不对照代码是否相似。MIT 项目不能简单摄入 AGPL 实现后仍把摄入部分仅按 MIT 分发；对许可有疑问时应单独做法律审查。[AGPL 文件](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/LICENSE)

## 建议吸收项

### P0：加固本地 JSON 写入

**建议**：把目标项目的思路重新实现成 `pi-switch` 自己的通用 JSON 文件事务模块，并替换 `settings.json` 与 `pi-switch.json` 的现有写入路径。

应包含：

- 读取前后比较 `exists/mtime/ctime/size/inode`，获得稳定快照。
- read-modify-write 前保存签名，写入前再次比较；发生外部修改时拒绝覆盖并提示重试。
- 临时文件名包含 PID + 随机值，避免同进程并发写碰撞。
- 对 Windows `EACCES`、`EPERM`、`EBUSY`、`ENOTEMPTY` 做短退避重试。
- 如果保留 copy fallback，必须明确它不是原子替换，并为失败残留 tmp 提供可恢复路径。
- 增加外部修改冲突、rename 短暂失败、tmp 清理、原文件保持完整等测试。

**当前缺口**：现有 `safeWriteJson` 只有 `${path}.tmp-${pid}` + 一次 `renameSync`，且先读取整个 Pi `settings.json` 再覆盖，没有并发冲突保护。[源码](../../src/settings.ts#L58-L65)

**成本/风险**：低到中，约 1-2 个工程日。主要风险是 Windows fallback 语义和同步 `FsLike` 测试接口的调整。

### P1：具名请求头 Profile

**建议**：在 `pi-switch.json` 增加类似以下结构，而不是让多个 Provider 重复粘贴 headers：

```json
{
  "headerProfiles": {
    "relay-codex": {
      "base": "codex",
      "headers": {
        "x-client-channel": "stable"
      }
    }
  },
  "providerOverrides": {
    "<dbId>": {
      "headerProfile": "relay-codex"
    }
  }
}
```

配套行为：

- Profile 可显示被多少 Provider 引用，删除前提示影响范围。
- 复用现有 header allowlist，并额外拒绝 `authorization`、`api-key`、`x-api-key`、`cookie`、`set-cookie`、`proxy-authorization`。目标项目的敏感字段集合可作为行为参考。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/state-document.ts#L37-L40)
- `/ps-doctor` 显示 Profile 不存在、空 Profile、失效引用和最终合并结果。
- 仍由 `apiKey/authHeader` 负责认证，不允许 Profile 成为秘密存储。

**成本/风险**：中，约 2-4 个工程日。需要配置 schema 兼容、引用重命名/删除、UI 和测试。

### P1：分阶段事务结果

目标项目把“写模型文件”“写 metadata”“刷新 registry”“运行时重注册”“模型救援”分开报告。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/configuration-persistence.ts#L13-L34)

`pi-switch` 已有 `SwitchLifecycle` 和 `LocalState` 的模块边界，适合进一步把切换结果改为显式阶段：

```text
load provider snapshot
→ register provider
→ resolve and set model
→ persist selection
→ record recent
→ notify outcome
```

每一阶段返回 typed outcome，允许出现“模型已切换，但 selection 保存失败”这类真实状态，而不是把所有异常折叠为一次失败。`/ps-doctor` 可以据此给出恢复动作。

**成本/风险**：中，约 2-3 个工程日。风险在于切换成功/失败通知和现有测试断言会变化。

### P1：有效配置总览，而非 CRUD Dashboard

目标项目的 Dashboard 和模型能力表适合“管理”，但 `pi-switch` 应吸收的是信息密度，不是 CRUD 权限。建议新增 `/ps-info`，或扩展 `/ps-doctor` 的详情视图，显示：

- 当前 Provider：类型、名称、dbId、协议、脱敏 endpoint。
- 当前模型：ID、有效 reasoning/thinking/context/max tokens。
- 每个有效值来自 default、Provider override、glob override 还是 exact override。
- 最终 fingerprint/Profile 和将注入的非敏感 header 名称。
- 模型列表来源：DB、remote cache、手动输入。
- 最近一次成功切换和当前 pin 状态。

这能吸收对方 [管理台的信息组织](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/assets/pi-model-manager-preview.png)，同时保持 `pi-switch` 的只读边界。

**成本/风险**：低到中，约 1-2 个工程日。主要是避免输出 API key、认证 header 和私有 endpoint 查询参数。

### P2：请求变换管线与 OpenAI Fast mode

目标项目把请求期能力组织成有序 transform：Claude metadata、OpenAI Responses instructions 标准化、`service_tier=priority` 注入；状态在单请求内只加载一次，每个 transform 失败时保留原 payload 并给独立 warning。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/request-pipeline.ts#L14-L60)

建议在真正加入第二个请求体 transform 时，再把当前 Claude hook 重构为管线，而不是提前抽象。第一项新增能力可以是 OpenAI Responses 模型级 `fastMode`：

- 在 `modelOverrides` 中保存布尔值。
- 仅对当前 `openai-responses` 模型注入 `service_tier: "priority"`。
- 不覆盖用户 payload 已显式设置的值，除非产品契约明确要求。
- 管线每步失败都回退到上一步 payload，不阻断请求。

**成本/风险**：中，约 3-5 个工程日。需要验证 Pi hook 顺序、OpenAI Responses payload 形态和 relay 对 `service_tier` 的兼容性。

### P2：按 Provider 配置 HTTP(S) 代理

目标项目证明了一个可行路径：把启用代理的 Provider 注册到 loopback URL，由本地 server 按 route ID 转发，使用标准 proxy agent，并保留流式响应。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/local-proxy-service.ts#L194-L270)

但在 `pi-switch` 中应先验证真实需求，再决定实现。进入开发前至少需要：

- 明确只支持出站 HTTP(S) proxy，不扩展为 failover/gateway。
- 校验上游与代理 URL，限制危险协议，防止 route 注入和 SSRF 扩散。
- 代理凭据、URL query、认证 header 全链路脱敏。
- 覆盖 SSE、chunked、backpressure、取消请求、shutdown、代理失败和 Windows 端口生命周期测试。
- 决定是否愿意引入 `http-proxy-agent`、`https-proxy-agent`；目标项目确实新增了这两个运行时依赖。[package](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/package.json#L69-L72)

**成本/风险**：高，约 5-8 个工程日，且安全与支持成本会长期存在。

### P3：完整 Provider/模型管理保持独立

不建议让 `/ps-config` 同时承担 cc-switch 数据浏览、Pi `models.json` 编辑和本地 Provider 创建。这样会出现两个权威源、同步冲突和用户心智混乱。

如果未来确有“脱离 cc-switch 管理 Pi 原生 Provider”的需求，更合理的方案是：

1. 新建独立扩展，明确 `models.json` 是唯一权威源；或
2. 在 `pi-switch` 只提供一次性“导出当前 cc-switch Provider 为 Pi models.json 草稿”，不做双向同步。

**成本/风险**：很高，至少 2-4 周，并会改变产品定位、测试矩阵和支持边界。

## 不应直接迁移的部分

### 模型发现实现

目标实现对 OpenAI/Google 主要拼接单一 `/models`，Anthropic 根据 base URL path 选择 `/v1/models` 或 `/models`。[源码](https://github.com/Qihuanxishini/pi-model-manager/blob/586238fe7073d212137084fcefd3c4ea7fbd1ec8/tui/model-list-fetch.ts#L44-L91) `pi-switch` 已经移植 cc-switch 的候选 URL 与兼容 suffix 逻辑，并只在特定 HTTP 状态下尝试下一个候选。[源码](../../src/models-fetch.ts#L4-L16) 因此这里应保留本地实现，只借鉴其认证解析、错误脱敏和代理复用思路。

### Claude Code 兼容实现

目标项目只覆盖 metadata 注入和内置请求头；`pi-switch` 当前实现已经包含 device ID、system prefix、tool fingerprint、beta/header 等更完整的 relay 兼容路径。[源码](../../extensions/claude-code-compat.ts#L18-L60) 不应为了统一架构而退回较浅实现。

### 未验证代码的直接采纳

目标仓库创建于 2026-07-26，全部功能在一个 7516 行初始提交中进入，之后只有 README 链接修正和 v0.1.0 tag 发布提交：[仓库 API](https://api.github.com/repos/Qihuanxishini/pi-model-manager) · [初始提交](https://github.com/Qihuanxishini/pi-model-manager/commit/f1f033dd2bcea43b09e5560132b9f759a01c8d77) · [文档提交](https://github.com/Qihuanxishini/pi-model-manager/commit/b48dc9e11045b4aa304878cfe917dfe0050f9296) · [发布提交](https://github.com/Qihuanxishini/pi-model-manager/commit/586238fe7073d212137084fcefd3c4ea7fbd1ec8)。当前树没有测试文件或 test script，GitHub API 也显示没有 Actions workflow 和公开 GitHub Release（tag 不等于 Release）。[Actions API](https://api.github.com/repos/Qihuanxishini/pi-model-manager/actions/workflows) · [Releases API](https://api.github.com/repos/Qihuanxishini/pi-model-manager/releases) 它适合作为设计样本，不适合作为经过长期回归验证的上游依赖。

## 建议路线图

| 顺序 | 工作项 | 预期收益 | 前置条件 |
| --- | --- | --- | --- |
| 1 | JSON 写入并发/Windows 加固 | 直接降低配置损坏和丢更新风险 | 无 |
| 2 | `/ps-info` 或 doctor 详情页 | 提升可解释性，复用现有 override 解析 | 无 |
| 3 | 具名 header Profiles | 降低多个 relay 的重复配置 | 明确配置 schema |
| 4 | 请求 transform 管线 + Fast mode | 为 OpenAI Responses 等兼容能力建立扩展点 | 至少有第二个 transform 需求 |
| 5 | Provider HTTP(S) proxy spike | 验证真实网络需求与安全成本 | 用户案例、威胁模型、SSE 测试 |
| 6 | 原生 Provider 管理另立项目 | 避免污染 `pi-switch` 定位 | 明确放弃/绕开 cc-switch 的场景 |

总体建议是：**先吸收其写入安全、Profile 抽象和信息架构，保留 `pi-switch` 在快速切换、上游模型发现、诊断和 Claude relay 兼容方面的现有优势。**
