# pi-switch 规格说明 (SPEC)

| 字段 | 值 |
|------|-----|
| 版本 | 0.1.0 |
| 状态 | **已锁定**（grilling 完成，剩余决策按最优解冻结） |
| 目录 | `D:\code_space\pi-switch` |
| 形态 | pi package（extension） |
| 上游数据 | `~/.cc-switch/cc-switch.db` **只读** |
| 一句话原则 | **全类型可见、已支持类型可切换** |
| 正式支持 | Windows 10/11 x64 |
| 理论兼容 | macOS（同路径 `~/.cc-switch/cc-switch.db`，未验收） |

> 冲突时以本文件为准，优先于 `DESIGN.md` 与任何旧草稿。

---

## 1. 目标与非目标

### 1.1 目标

1. 在 pi 内一键切换任意 **已支持且可解析** 的 cc-switch 供应商 + model。
2. **全量 app_type 可见**：DB 里出现什么类型就出什么 tab；未知类型 generic 尽力解析，失败仍列出并诊断。
3. 协议自适应：映射到 pi 的 `api`（不自建 HTTP 代理）。
4. 注册时注入客户端伪装 headers（白名单字段）。
5. UI：按 app_type **动态 tab** + 渐进三级选择 + 搜索（**不做**列表分页/跳页）。
6. 启动恢复上次选择（以 `dbId` 为权威身份）。

### 1.2 非目标（v0.1）

| 不做 | 原因 |
|------|------|
| 改写 / 管理 cc-switch DB | 桌面端职责；本扩展只读 |
| 完整本地 HTTP 网关 / failover | 复杂度高；协议靠 pi `api` 映射 |
| 替代 pi-provider-headers 对 `models.json` 的静态注入 | 静态 vs 动态 `ps-*` 分工 |
| 在无 baseUrl/apiKey 时假注册 | 列表可显示，切换时明确报错 |
| **余量展示 / usage_script 执行 / rollups 展示** | grilling 已取消整个功能点 |
| 旧 `extensions/cc-switch` 共存检测 | 发布后直接替换，不设计双扩展保护 |
| 捆绑 `sqlite3` 二进制 | 系统前置依赖 |
| 文件监听 DB 变化 | v0.1 简单：打开命令时重读 |
| 列表分页 / 跳页 UI | 三级选择 + 搜索已覆盖导航；废弃 `pageSize` |

### 1.3 成功标准

- [ ] 所有 `app_type` 均有 tab，且每条记录有明确状态（可切换 / 不可切换: 原因）。
- [ ] 六种已知类型（claude / codex / gemini / grokbuild / opencode / hermes）有专用 parser；有端点的至少可切换一条。
- [ ] 可解析记录可完成：选 model → `registerProvider` → `setModel` → 发消息。
- [ ] headers 仅注入白名单伪装字段（可 debug 日志验证）。
- [ ] 旧 `ccSwitchSelection` 可一次性迁移到 `piSwitchSelection`（名称唯一命中时）。
- [ ] 单元测试：parse + api-format + tabs/labels + headers 全绿。

---

## 2. 硬性原则

### 2.1 可见性契约（grilling Q1）

```
∀ app_type ∈ DISTINCT providers.app_type
  → UI 必须有对应 tab（count > 0）
  → 必须有 parser 尝试解析 settings_config + meta
  → 解析成功且协议受支持 → 可切换
  → 解析失败 / 协议未知 → 仍列出，标注「不可切换: 原因」，不静默丢弃
```

**发布验收：** 六种已知类型必须有专用解析器并通过切换验收；未知类型 generic 失败 **不阻止** 发布。

### 2.2 当前 DB 实测类型（用户机，会变）

| app_type | 约数 | settings 形态摘要 |
|----------|------|-------------------|
| `claude` | 46 | JSON：`env.ANTHROPIC_*` + 可选 model 字段 |
| `codex` | 33 | JSON：`auth.OPENAI_API_KEY` + TOML `config` |
| `gemini` | 3 | JSON：`env.GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY` |
| `grokbuild` | 9 | JSON：`config` 为 TOML |
| `opencode` | 12 | JSON：`npm` + `options` + `models`；或 agents 壳 |
| `hermes` | 2 | JSON：`base_url` + `api_key` + `api_mode` + `models[]` |

> 未来新 app_type → tab 自动出现；无专用 parser 走 **generic**。

---

## 3. 架构

```
                    ┌──────────────────────┐
                    │  /ps-config  command       │
                    └──────────┬───────────┘
                               ▼
┌────────────┐   rows    ┌─────────────┐   CcProvider[]   ┌──────────┐
│  db.ts     │──────────►│  parse/*    │─────────────────►│  ui/*    │
│  sqlite3   │           │  per type   │                  │  tabs    │
└────────────┘           └──────┬──────┘                  │  page    │
                                │                         └────┬─────┘
                     api+headers│                              │ pick
                                ▼                              ▼
                         ┌─────────────┐               ┌─────────────┐
                         │ headers/*   │               │ register.ts │
                         │ + overrides │──────────────►│ setModel    │
                         └─────────────┘               │ settings    │
                                                       └─────────────┘
```

### 3.1 包结构

```
pi-switch/
  package.json
  README.md
  SPEC.md
  DESIGN.md
  research/
  scripts/
    smoke.mjs             # doctor + 可选 models probe
  extensions/
    index.ts              # 唯一 extension 入口（薄壳）
    bootstrap.ts          # 启动恢复
    commands.ts           # /ps-config · /ps-override · /ps-doctor
    runtime.ts            # 运行时依赖装配
  src/
    types.ts
    pi-context.ts         # Pi ExtensionAPI 窄类型
    db.ts
    sqlite-path.ts
    models-fetch.ts       # 对齐 cc-switch model_fetch 候选逻辑
    doctor.ts             # /ps-doctor 结构化体检
    model-meta.ts         # register-time modelMeta 清洗
    provider-override.ts
    parse/
      index.ts
      claude.ts
      codex.ts
      gemini.ts
      grokbuild.ts
      opencode.ts
      hermes.ts
      generic.ts
      api-format.ts
      common.ts
    headers/
      rules.ts
      merge.ts
      fingerprints.ts     # Claude / Codex / Gemini UA 预设
      vars.ts             # CLI 版本变量展开
    ui/
      tabs.ts
      labels.ts
      three-level-pick.ts # 类型 → 名称 → 模型（搜索；无分页）
      model-meta-dialog.ts
    register.ts
    settings.ts
  defaults/
    headers.json
  skills/
  tests/
```

### 3.2 依赖

| 依赖 | 用途 |
|------|------|
| `@earendil-works/pi-coding-agent` | peer：ExtensionAPI |
| `@earendil-works/pi-tui` | peer：三级选择器自定义 TUI（`0.81.1`） |
| 系统 `sqlite3` CLI | 读 DB（**不用 bun:sqlite**） |
| 无强制 runtime dep | headers / 解析自实现 |

查找 `sqlite3` 顺序（grilling Q16）：`SQLITE3_PATH` → `pi-switch.json.sqlitePath` → `PATH` 中的 `sqlite3`。

---

## 4. 数据模型

### 4.1 DB 行（只读）

```sql
SELECT id, app_type, name, settings_config, is_current,
       website_url, notes, meta, provider_type, sort_index
FROM providers
ORDER BY app_type, sort_index, name;
```

> 不读取 `usage_daily_rollups` / `limit_*`（余量功能已取消）。

### 4.2 内部统一类型 `CcProvider`

```ts
type PiApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "google-generative-ai";

interface CcProvider {
  /** DB id，权威身份 */
  id: string;
  /** pi 注册名：优先 displayName slug；空名时回退 ps-<slug(appType)>-<完整 dbId> */
  piName: string;
  /** UI 名（用户可读） */
  displayName: string;
  appType: string;
  api: PiApi | null;       // null = 协议不受支持，不可切换
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  configModels: string[];  // 仅 trim，不做其他清洗
  apiFormat?: string;      // meta.apiFormat 原文
  meta: Record<string, unknown>;
  isCurrentInCc: boolean;
  parseError?: string;     // 有则不可切换
  websiteUrl?: string;
  notes?: string;
  modelsUrl?: string;      // meta.modelsUrl 可选覆写
  isFullUrl?: boolean;     // meta.isFullUrl
}
```

### 4.3 持久化 `piSwitchSelection`

路径：`~/.pi/agent/settings.json`

```json
{
  "piSwitchSelection": {
    "dbId": "448d0e64-...",
    "model": "grok-4.5",
    "tab": "codex",
    "appType": "codex",
    "provider": "elysiver-claude"
  }
}
```

| 字段 | 角色 |
|------|------|
| `dbId` | **唯一权威身份**；恢复时只按它精确匹配 |
| `provider` / `piName` | 当前注册名，可随实现再生，不用于身份匹配 |
| `model` | 上次 model id（原样，仅 trim 后写入） |
| `tab` / `appType` | UI 记忆 |

**迁移：** 若无 `piSwitchSelection` 且存在 `ccSwitchSelection`：按旧 `provider` 名称反查；**必须唯一命中** 才写入新 key；否则丢弃并 debug 日志。

---

## 5. 解析规范

### 5.1 协议映射 `resolveApi()`（grilling Q8）

优先级（高→低）：

1. `meta.apiFormat`（若 **显式声明且无法识别** → `api=null`，`parseError=unsupported apiFormat: …`，**禁止静默回退**）
2. 类型特有字段（`api_mode` / `wire_api` / `api_backend` / `npm`）
3. app_type 默认（仅当未声明协议时）

| 源值 | pi `api` |
|------|----------|
| `anthropic` / `anthropic_messages` / `anthropic-messages` | `anthropic-messages` |
| `openai_responses` / `responses` / `openai-responses` | `openai-responses` |
| `openai_chat` / `chat` / `chat/completions` / `openai-completions` | `openai-completions` |
| `google` / `gemini` / `google-generative-ai` | `google-generative-ai` |
| opencode `npm=@ai-sdk/anthropic` | `anthropic-messages` |
| opencode `npm=@ai-sdk/openai-compatible`（及未知 openai 系） | `openai-completions` |

### 5.2–5.8 各类型字段（与草稿一致，关键变更如下）

| 类型 | 关键字段来源 | 默认 api |
|------|--------------|----------|
| `claude` | `env.ANTHROPIC_BASE_URL`；key=`AUTH_TOKEN\|\|API_KEY`；`authHeader`=仅有 AUTH 无 API_KEY | anthropic-messages |
| `codex` | `auth.OPENAI_API_KEY`；TOML `model_provider`→`base_url`；`wire_api` | openai-responses |
| `gemini` | `GOOGLE_GEMINI_BASE_URL`；`GEMINI_API_KEY\|\|GOOGLE_API_KEY` | google-generative-ai |
| `grokbuild` | TOML `base_url` / `api_key` / `api_backend` | responses 或 meta |
| `opencode` | `options.baseURL` / `apiKey` / `models` keys；agents-only 壳 → parseError | 按 npm |
| `hermes` | `base_url` / `api_key` / `models[].id` / `api_mode` | openai-completions |
| `generic` | env.*BASE_URL / options / base_url / TOML 探测 | 尽力；失败仍列出 |

### 5.9 命名（grilling Q18）

```
piName = slug(displayName)                // 优先：人类可读，出现在 Pi 状态栏
       | "ps-" + slug(appType) + "-" + id // 回退：displayName 为空/无法 slug
// 例：elysiver-claude
// 例（回退）：ps-codex-448d0e64-aaaa-bbbb-cccc-ddddeeeeffff
```

- `slug(...)`：小写，非 `[a-z0-9]` 替换为 `-`。
- 持久身份仍是 `dbId`；`piName` 可随 displayName 再生，不用于身份匹配。
- 同名冲突时：首个保留 base，后续追加短 dbId 后缀。
- `displayName` = 用户可读名称（通常即 DB `name`）。

### 5.10 Model ID（grilling Q19，最优解）

- **仅** trim 首尾空白。
- 不转小写、不 slug、不删括号、不剥 `[1M]` 等后缀。
- 列表合并去重：完全相同字符串。
- `configModels` 优先于远端同名字（同字符串只保留一条，config 侧优先）。
- 空字符串视为无效。

### 5.11 Base URL（grilling Q9）

- 注册时保留配置完整路径。
- 仅规范化：trim + 去末尾 `/`。
- **不**删除 `/v1`，不猜测自定义前缀。
- 模型列表请求使用 §8.4 的 cc-switch 候选逻辑，**不改写**注册 baseUrl。

---

## 6. Headers 规范

### 6.1 规则源（优先级高→低）

1. `~/.pi/agent/pi-switch.json` → `providerOverrides[dbId].headers`（及可选 `fingerprint` 预设展开；`fingerprint: "none"` 跳过默认规则注入）
2. `~/.pi/agent/provider-headers.json` → 按 `api` 匹配 rules（与 pi-provider-headers **同文件**）
3. 包内 `defaults/headers.json`

### 6.2 白名单（grilling Q10–Q11）

v0.1 **仅允许**以下名称（大小写不敏感）：

- `User-Agent`
- `x-goog-api-client`
- `originator`
- `anthropic-version`
- `anthropic-beta`

**永远不得**由规则覆盖：`Authorization`、`Proxy-Authorization`、`x-api-key`、`api-key`、`x-goog-api-key`、`Host`、`Content-Length` 及任何未在白名单中的字段。

其他字段：忽略，`debug` 模式下警告日志。

### 6.3 注入时机

**仅**在 `registerProvider` 时写入 `headers`。不修改 `models.json`。

---

## 7. 余量（Quota）— 已取消

v0.1 **不包含**：

- `quota/*` 模块
- `usage_script` 执行
- `QuotaSnapshot` / rollups / limit 展示
- `/pi-switch quota` 命令
- 相关配置与测试

---

## 8. UI / UX 规范

### 8.1 命令

| 命令 | 行为 |
|------|------|
| `/ps-config` | 主流程：重读 DB → 快照 → tab → provider → model（pin/recent） |
| `/ccs` | 可选 alias（`pi-switch.json.aliasCcs`，默认 true） |
| `/ps-override` | 为 Provider 设置 modelMeta 覆写（预设：中转兼容 / 完整推理） |
| `/ps-doctor` | 结构化体检：PASS/WARN/FAIL + 修复建议 |

### 8.2 渐进三级选择（类型 → 名称 → 模型）

自定义 TUI（`ctx.ui.custom`），**逐级展开**：

1. **初始化只显示「类型」**
2. `enter` / `→` 进入后显示「名称」
3. 再 `enter` / `→` 进入后显示「模型」
4. 在模型列 `enter` 确认切换

| 列 | 内容 |
|----|------|
| **类型** | `app_type` + count |
| **名称** | 显示名 · host；当前 `model.provider` **黄色高亮** |
| **模型** | `configModels` + 远端缓存 + `✎ 手动输入` / `↻ 刷新模型` |

快捷键：`↑↓` 导航 · `enter` 下一级/确认 · `←→` 列切换 · `/` 搜索 · `m` 手动 · `f` 刷新 · `p` pin · `o` 参数覆写（名称列） · `esc` 取消。

改类型（在类型列 ↑↓）会收起名称/模型列，需重新 enter 展开。

### 8.4 Model 列表（grilling Q7 + research）

1. **立即**显示 `configModels`（仅 trim 去重）。
2. 始终提供 `✎ 手动输入`。
3. **不**自动请求远端。仅当用户选择 **`↻ 刷新模型`** 时，按 cc-switch 逻辑请求（见 `research/cc-switch-model-discovery.md`）：
   - 支持 `modelsUrl` 覆写、`isFullUrl` 推导
   - `/vN` 规则与兼容后缀剥离候选
   - Bearer + 可选 User-Agent；超时 15s
   - **仅** HTTP 404/405 尝试下一候选
4. 成功后与 configModels 合并（config 优先），**仅当前会话缓存**。
5. 失败：notify 警告，不影响手动输入或切换。

### 8.5 状态栏

- 启动：`pi-switch: N providers`
- 恢复成功：`{model} @ {appType}/{name}`
- 恢复失败（dbId 失效）：`⚠ 已保存的 Provider 不可用`

### 8.6 注册与切换提交顺序（grilling Q5）

1. 保留旧 Provider 与当前模型。
2. 注册候选 Provider（含 headers + 至少所选 model）。
3. 调用 `setModel` — **成功即运行时切换成功**。
4. 成功后注销其他已跟踪的旧 Provider 注册名（防列表膨胀；兼容旧 `ps-*` 与可读名）。
5. 持久化新选择；持久化失败 → 保持已切换模型，明确提示「已切换，本次选择未保存」。
6. `setModel` 失败 → notify error，不写 selection，不注销旧注册。

---

## 9. 启动与生命周期（grilling Q2–Q4, Q15）

```
extension load
  → resolve sqlite3 path + 验证
  → read DB（只读 + busy_timeout=3000）→ parse all → 内存快照
  → if piSwitchSelection.dbId 命中可切换 provider → register that one
  → if dbId 未命中 → 不 setModel、不清除 selection、会话内警告一次
session_start(startup)
  → applyModel(selection) if still valid
  → setStatus
/ps-config
  → 重新读 DB + 解析（刷新快照）
  → Picker 交互期间使用固定快照（不中途重读）
  → interactive UI
```

| 条件 | 行为 |
|------|------|
| DB 缺失 / 首次读取失败 | notify；命令提示安装/配置 `CC_SWITCH_DB` |
| 刷新时 busy/超时/临时失败 | 沿用**最后一次有效快照**；notify 警告 |
| 保存的 dbId 不存在 | 不自动回退；不 setModel；保留 selection；会话警告一次 |
| `CC_SWITCH_DB` | 覆盖默认路径 |
| 默认路径 | `{homedir}/.cc-switch/cc-switch.db`（Windows/macOS/Linux 相同约定） |

**SQLite：** 始终 `-readonly`；启动连接设置 `busy_timeout=3000`（CLI：`.timeout 3000` 或 pragma）。

---

## 10. 配置文件

### 10.1 `~/.pi/agent/pi-switch.json`

```jsonc
{
  "tabs": ["claude", "codex", "gemini", "grokbuild", "opencode", "hermes"],
  "aliasCcs": true,
  "sqlitePath": null,
  "vars": {
    "codexVersion": "0.144.0",
    "claudeCodeVersion": "1.0.0"
  },
  "defaultModelMeta": { "reasoning": false },
  "providerOverrides": {
    "448d0e64-...": {
      "label": "sbai",
      "fingerprint": "codex",
      "headers": {
        "User-Agent": "codex_cli_rs/0.144.0 (Windows 10.0; x64) Terminal"
      },
      "modelMeta": { "reasoning": false }
    }
  },
  "pins": [{ "dbId": "448d0e64-...", "model": "gpt-5" }],
  "recent": [],
  "recentLimit": 8,
  "debug": false
}
```

- `providerOverrides` 以 **dbId** 为键；`label` 仅人读，不参与匹配。
- `tabs` 只影响排序；DB 多出的类型仍显示在末尾。
- **无 `pageSize`**：三级选择器用可滚动列表 + `/` 搜索，**不**做分页/跳页（旧配置中的 `pageSize` 忽略）。
- `pins` / `recent` / `recentLimit`：仅本地快捷，不引入 expose 配置中心。
- `vars` / `defaultModelMeta` / per-provider `fingerprint` · `modelMeta`：注册时指纹与上游拒收字段策略。

### 10.2 共享 `~/.pi/agent/provider-headers.json`

与 `pi-provider-headers` 共用；pi-switch 只读 rules，不写。

---

## 11. 错误与边界

| 情况 | 行为 |
|------|------|
| sqlite3 找不到 | 启动 notify；命令内给出 `SQLITE3_PATH` / 配置 / PATH 诊断 |
| 某行 JSON 坏 | 该行 parseError，其余继续 |
| setModel 失败 | notify error，不写 selection |
| 上游 401/403 | 切换仍成功；发消息时由 pi 报错 |
| 未知 apiFormat | 可见，不可切换 |
| opencode agents-only | 可见，不可切换 |
| 远端 /models 失败 | 保留 configModels / 手动输入 |

---

## 12. 安全

- DB / settings 含密钥：**永不** log 完整 key（debug 最多末 4 位）
- 不向第三方上传供应商列表
- 不执行 usage_script（功能已取消）
- README 标明依赖本机 cc-switch + 系统 sqlite3

---

## 13. 测试要求

| 套件 | 内容 |
|------|------|
| unit: api-format | 全部 apiFormat / wire / npm 映射；未知显式格式禁止回退 |
| unit: parse-* | 各 app_type fixture（脱敏） |
| unit: tabs / labels / three-level | 空 tab、搜索过滤、列宽/快捷键 |
| unit: headers | 白名单过滤、大小写合并、认证字段拒绝 |
| unit: models-fetch candidates | 候选 URL 构建与 404/405 回退策略（可 mock） |
| unit: piName / model trim | 稳定 id；仅 trim |
| integration（可选） | 真实 DB 只读统计可切换比例 |

最低：`parse` + `api-format` + `tabs/labels` + `headers` 在 `bun test` 全绿。

---

## 14. 里程碑

| 里程碑 | 交付 | 验收 |
|--------|------|------|
| **M0** | package 可 install；读全表；tab 动态；claude+codex 可切换 | `/ps-config` 切真实供应商 |
| **M1** | gemini / grokbuild / opencode / hermes + generic | 每类型有端点者可切换 |
| **M2** | headers 注入 + providerOverrides(dbId) | debug 见 UA；认证字段不覆盖 |
| **M3** | 模型按需拉取（cc-switch 逻辑）+ 三级选择搜索/pin/recent + 迁移 | 手动获取远端模型可用 |
| **M4** | README + Windows 验收清单 | 发布就绪 |

（原 M3 余量里程碑已删除。）

---

## 15. 与旧扩展关系

| 项 | 策略 |
|----|------|
| `~/.pi/agent/extensions/cc-switch` | 发布后由用户删除；**不**做运行时检测/共存 |
| `ccSwitchSelection` | 只读迁移一次（唯一名称命中） |
| `pi-provider-headers` | 保留；静态 models.json 继续由它处理 |

---

## 16. 验收清单（发布 0.1）

- [ ] 动态 tab = DB 全部 app_type
- [ ] 六种已知类型均有 parser；未知走 generic
- [ ] 显式未知 apiFormat → 不可切换，不静默回退
- [ ] headers 白名单注入；认证字段不可覆盖
- [ ] 打开 `/ps-config` 重读 DB；picker 内固定快照
- [ ] 恢复以 dbId 为准；失效安全失败
- [ ] 三级选择 + `/` 搜索可用（无分页/跳页）
- [ ] 只注册当前 provider；切换提交顺序符合 §8.6
- [ ] 模型列表默认 config；远端按需
- [ ] 密钥不进日志
- [ ] 单元测试覆盖映射、tabs/labels、headers
- [ ] 无 quota / usage_script 代码路径

---

## 17. 决策冻结

| # | 决策 | 来源 |
|---|------|------|
| 1 | 全类型可见、已支持类型可切换；未知 generic 失败不挡发布 | grilling Q1 |
| 2 | 每次打开 `/ps-config` 重读 DB；picker 固定快照；无文件监听 | grilling Q2 |
| 3 | `dbId` 是持久身份；`piName` 可再生 | grilling Q3 |
| 4 | dbId 失效：不自动回退、不 setModel、保留 selection、会话警告一次 | grilling Q4 |
| 5 | setModel 成功=运行时成功；随后清理旧注册名并持久化；持久化失败只告警 | grilling Q5 |
| 6 | **取消**全部余量展示与查询 | grilling 用户指令 |
| 7 | Model 列表先 configModels；用户点击才拉远端 | grilling Q7 |
| 8 | 显式未知协议禁止切换；缺省才用类型默认 | grilling Q8 |
| 9 | baseUrl 不改写；模型发现对齐 cc-switch | grilling Q9 + research |
| 10 | Header 不覆盖认证字段 | grilling Q10 |
| 11 | 白名单仅 4 字段：UA / originator / anthropic-version / anthropic-beta | grilling Q11 |
| 12 | 不设计旧扩展共存/冲突保护 | grilling Q12 |
| 13 | v0.1 正式支持 Windows x64 | grilling Q13 |
| 14 | macOS 同路径理论兼容，未验收；保留 `CC_SWITCH_DB` | grilling Q14 |
| 15 | SQLite 只读 + busy_timeout 3s + 最后有效快照 | grilling Q15 |
| 16 | 不捆绑 sqlite3；`SQLITE3_PATH` → 配置 → PATH | grilling Q16 |
| 17 | per-provider 配置键 = dbId（`providerOverrides`） | grilling Q17 |
| 18 | `piName` 优先 `slug(displayName)`，回退 `ps-<slug(appType)>-<dbId>` | 状态栏可读名 |
| 19 | Model ID 仅 trim，不做其他清洗 | grilling Q19 最优解 |
| 20 | 可选 `/ccs` alias 默认开启 | 最优解 |
| 21 | 不显示 rollups / 本地花费 | 随余量取消 |

---

*文档结束。实现以本 SPEC 为准；与 DESIGN.md 冲突时以 SPEC 为准。*
