# pi-switch 设计脑暴

## 当前实现（相对脑暴的收敛）

> **权威契约以 [SPEC.md](./SPEC.md) 为准。** 下文保留早期脑暴痕迹；下列项已正式收敛：
>
> - UI：渐进三级选择（类型 → 名称 → 模型）+ `/` 搜索 + 可滚动列表；**不做**分页/跳页，**无** `pageSize`。
> - 命令：`/ps-config`（可选 `/ccs`）、`/ps-override`、`/ps-doctor`。
> - 入口：`extensions/{index,bootstrap,commands,runtime}.ts`；选择器：`src/ui/three-level-pick.ts`。
> - 本地 pin / recent 快捷；无 expose 配置中心。
> - 余量 / usage_script：**已取消**。


> 目标：在 `D:\code_space\pi-switch` 做完整 pi package，接 cc-switch DB，
> 融合 provider headers 伪装 + 协议自适应 + 三级选择/搜索。
>
> **状态：** grilling 完成，**[SPEC.md](./SPEC.md) 已锁定 v0.1.0**（余量功能已取消）。
> 本文仅保留脑暴过程；冲突以 SPEC 为准。

---

## 0. 现状结论

| 组件 | 现状 | 缺口 |
|------|------|------|
| `~/.pi/agent/extensions/cc-switch` | 读 claude+codex，`/cc-switch` 两级分页选择 | 无 tab；无余量脚本；无 headers；api 只看 wire_api |
| `pi-provider-headers` | 按 `models.json` 的 `api` 注入 UA/beta | **只扫 models.json**，动态 `registerProvider(ccs-*)` **吃不到** |
| cc-switch DB | `meta.apiFormat`、`meta.usage_script`、`usage_daily_rollups`、`limit_*_usd` | 本地 extension 几乎没用上 |
| pi 协议层 | `anthropic-messages` / `openai-responses` / `openai-completions` 已内置 path | **不需要自建完整 HTTP 路由代理**（除非要 failover 改写） |

**核心洞见：**

1. **协议适配 = 正确选 pi 的 `api` 字段**，不是重写 `/v1/*` 转发器。
2. **headers 伪装 = 注册时带上 `headers`**；现 headers 包与动态 ccs provider 脱节。
3. **余量 = 跑 `meta.usage_script` + 叠加 rollups/limit**，不是只显示 `$cost`。

---

## 1. 产品边界（pi-switch 做什么 / 不做什么）

### 做

- 从 `~/.cc-switch/cc-switch.db` 读 provider（类型动态）
- `/ps-config`（或 `/ccs`）交互：tab → 列表 → model
- 按 `meta.apiFormat` + settings 解析 `api` / `baseUrl` / `apiKey`
- 注册时注入 **伪装 headers**（规则可配置）
- 列表展示：**余量 / 今日花费 / 请求数 / api 形态 / 当前★**
- 启动恢复上次选择（`settings.piSwitchSelection`）
- 可选：按需拉 `/models`、手动 model id

### 不做（v1）

- 不重做 cc-switch 桌面端 CRUD
- 不默认起本地 proxy（15721）；failover 队列后续再议
- 不写 gemini/hermes 原生协议（可先 tab 隐藏或灰显）
- 不在 extension 内 `eval` 任意代码无沙箱（usage_script 要隔离）

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  pi-switch (pi package)                                 │
│                                                         │
│  db/          sqlite3 -json 读 providers + rollups      │
│  parse/       claude env / codex toml / meta.apiFormat  │
│  headers/     规则引擎（可复用 pi-provider-headers 思路）│
│  quota/       usage_script 执行 + 缓存 + 展示格式化     │
│  ui/          三级选择 + 搜索 + 行渲染（无分页）         │
│  register/    registerProvider + setModel + 持久化      │
│  cmd/         /pi-switch, /pi-switch refresh-quota      │
└────────────┬────────────────────────────┬───────────────┘
             │                            │
             ▼                            ▼
   ~/.cc-switch/cc-switch.db    ~/.pi/agent/settings.json
   (source of truth)            (piSwitchSelection)
```

与 `pi-provider-headers` 关系：**组合，不互斥**。

- headers 包继续服务 **静态** `models.json` provider
- pi-switch 在 **动态** `ccs-*` 注册时自己合并 headers（同一规则文件可共享）

---

## 3. 能力结合：三条路线

### 路线 A — 协议映射优先（推荐 v1）

| meta.apiFormat / 线索 | pi `api` | 实际 path（pi SDK 管） |
|----------------------|----------|------------------------|
| `anthropic` | `anthropic-messages` | `/v1/messages` |
| `openai_responses` / wire `responses` | `openai-responses` | `/v1/responses` |
| `openai_chat` / wire `chat*` | `openai-completions` | `/v1/chat/completions` |

**解析优先级：**

```
meta.apiFormat
  > codex wire_api / claude 是否 anthropic base
  > 默认：claude→anthropic-messages，codex→openai-responses
```

你 DB 现状（抽样）：

- claude：34 anthropic / 9 openai_chat / 2 openai_responses
- codex：14 openai_chat / 14 openai_responses

现 extension **只看 wire_api**，会把部分 openai_chat 的 claude 中转判错 → 这是必修点。

**优点：** 实现小、稳、与 pi 模型层一致  
**缺点：** 无 body 改写、无跨协议转换（chat↔responses）

### 路线 B — 内嵌轻量路由/适配器（v2 可选）

复制 cc-switch proxy 的「按目标协议改 path/body」子集：

- 仅当源协议与 pi 内置不一致时启用（例：上游只要 chat，但想用 responses 客户端）
- 本地 `127.0.0.1:随机端口` 或进程内 fetch wrapper

**优点：** 兼容怪供应商  
**缺点：** 状态、TLS、流式、调试成本高；和桌面 proxy 双开冲突

**建议：** v1 不做；只在 A 失败 case 列表积累后再上。

### 路线 C — headers 深度结合（与 A 并行，v1 必做）

`pi-provider-headers` 能力：

- 按 `api` 规则注入 `User-Agent` / `originator` / `anthropic-beta` …
- 变量：`{codexVersion}` `{claudeCodeVersion}` `{osInfo}`
- 配置：`~/.pi/agent/provider-headers.json`

pi-switch 注册时：

```ts
headers = merge(
  rulesFor(api),           // 同 headers 包规则
  meta.extraHeaders?,      // 若以后 DB 有
  providerOverride?        // pi-switch 本地 overrides.json
)
pi.registerProvider(piName, { baseUrl, apiKey, authHeader, api, headers, models })
```

**共享配置策略（推荐）：**

1. 读 `~/.pi/agent/provider-headers.json`（有则用）
2. 否则用 package 内 `default-headers.json`（抄 headers 包默认规则）
3. 可选 `~/.pi/agent/pi-switch.json` 做 per-provider 覆盖：

```jsonc
{
  "headerOverrides": {
    "ccs-sbai": { "User-Agent": "codex_cli_rs/0.144.0  (Windows 10.0; x64) Terminal" },
    "ccs-100xlabs": { "anthropic-beta": "context-1m-2025-08-07" }
  },
  "tabs": ["claude", "codex"],   // 强制顺序；省略则 DB 动态
  // pageSize removed — scrollable three-level list + search
}
```

**不要** 让 pi-switch 去改 models.json 再指望 headers 包扫到——时序与「只注册当前 provider」冲突。

---

## 4. 余量（quota）设计

### 数据源分层

| 优先级 | 源 | 含义 |
|--------|----|------|
| 1 | `meta.usage_script`（enabled） | 上游真实余额/额度（cc-switch 同源） |
| 2 | `usage_daily_rollups` | 本地观测花费/次数（今日/近 N 日） |
| 3 | `limit_daily_usd` / `limit_monthly_usd` | 用户自设 cap（你库目前几乎全 null） |

### usage_script 执行

cc-switch 形态（已验证）：

```js
({
  request: { url: "{{baseUrl}}/v1/usage", method: "GET",
             headers: { Authorization: "Bearer {{apiKey}}" } },
  extractor: function(response) {
    return { isValid, remaining, unit, used, total, planName };
  }
})
```

模板变量：`baseUrl` `apiKey`；部分脚本用 `accessToken` `userId`（需从 settings_config 挖或 meta）。

**安全：**

- **禁止** `new Function` 裸 eval 全脚本
- 推荐：
  - 模板替换 `{{var}}` 后 `fetch`
  - extractor 用 **受限 VM**（`node:vm` + timeout + 无 require）或预置 extractor 预设 + 少量自定义 JSONPath
- 缓存：`autoQueryInterval`（秒，默认 30）按 provider 节流
- 列表默认 **用缓存**；进入 tab 时后台 refresh 当前页；`/pi-switch quota` 强制刷新

### 行展示草案

```
★ 100xlabs          anthropic   $12.40 left   today $0.32/14req  ●
  sbai              responses   —             today $1.02/9req
  muyuan            chat        ¥失效          today $0
```

格式化：

- remaining 有值：`$12.40` / `12.4U`（看 unit）
- isValid=false：`失效`
- 无 script：`—`，仍显示 today cost/req
- 超 limit_*：`⚠ cap`

---

## 5. UI：三级选择 + 搜索（对齐 cc-switch 心智；已收敛）

### 约束

pi `ctx.ui.select` = **单层字符串列表**，无原生 tab 控件。  
模拟 tab：

```
── tab 行（每页固定置顶）──
[● claude 46]  [ codex 32]  [ grokbuild 9] …
── 工具行 ──
🔍 搜索…    ↻ 刷新余量    ✎ 手动 model（进 provider 后）
── 列表 ──
★ 100xlabs · sub.100xlabs.space · anthropic · $12.4 · 14req ●
  …
── 导航 ──
↑↓ 导航   / 搜索   （无分页/跳页）
```

### Tab 动态规则

```sql
SELECT app_type, COUNT(*) n, SUM(is_current) cur
FROM providers GROUP BY app_type
```

- 默认只启用 **pi 能注册的类型**：v1 = `claude` + `codex`  
  （二者 settings 已会解析；`meta.apiFormat` 覆盖协议）
- `gemini` / `grokbuild` / `opencode`：tab 可显示但选中提示「v1 未支持」或后续加 parser
- tab 顺序：配置 `tabs` > 有 is_current 的优先 > 名称字典序
- 记忆：上次 tab 写入 `piSwitchSelection.tab`

### 列表导航（相对现 extension；**已废弃分页**）

| 点 | 现 cc-switch ext | pi-switch |
|----|------------------|-----------|
| page size | 固定 10 | 可配 8–15，宽终端可 15 |
| 跳页 | 无 | **不做**（搜索 + 滚动） |
| 搜索 | 无 | 名称/host 子串过滤（`/`） |
| 排序 | 用量 desc + last | tab 内：★last → 有余量 → 用量 → 名 |
| 翻页选项污染 | prev/next 混在列表 | 固定底栏，选项前缀 `·` 区分 |
| 余量加载 | 无 | 当前页并发 ≤ 4 拉取，status 条显示进度 |

### 两级流程

1. **类型/名称列**（动态 app_type + 名称列表）  
2. **模型列**（configModels ∪ 按需远端 + 手动输入 + 刷新；可滚动，无分页）

选中后：`registerProvider`（带 headers）→ `setModel` → 写 settings → status `● model @ provider`。

---

## 6. 模块拆分（目录草案）

```
D:\code_space\pi-switch\
  package.json                 # pi package manifest
  README.md
  DESIGN.md                    # 本文
  extensions/
    index.ts                   # 入口：命令、session_start
  src/
    db.ts                      # sqlite3 CLI 查询
    types.ts
    parse/
      claude.ts
      codex.ts
      api-format.ts            # apiFormat → pi api
    headers/
      rules.ts                 # 读 provider-headers.json + 默认
      merge.ts
    quota/
      script-runner.ts         # 模板 + fetch + vm extractor
      cache.ts
      format.ts
    ui/
      tabs.ts
      three-level-pick.ts
      labels.ts
      model-meta-dialog.ts
    register.ts
    settings.ts
  defaults/
    headers.json
  tests/
    api-format.test.ts
    tabs-labels.test.ts
    three-level.test.ts
    labels.test.ts
    parse-*.test.ts
```

`package.json` 要点：

```json
{
  "name": "pi-switch",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

---

## 7. 与现有扩展迁移

| 项 | 策略 |
|----|------|
| `~/.pi/agent/extensions/cc-switch` | pi-switch 稳定后 **移除/改名禁用**，避免双 `/cc-switch` |
| `settings.ccSwitchSelection` | 启动时若无 `piSwitchSelection` 则迁移读旧 key |
| `pi-provider-headers` | **保留**；文档写明静态 vs 动态分工 |
| 命令名 | `/ps-config` 主命令；可选 alias `/ccs`（可关） |

---

## 8. 风险与决策点

| # | 议题 | 建议 |
|---|------|------|
| 1 | 协议：映射 vs 自建路由 | **v1 映射**；路由 backlog |
| 2 | headers：依赖 npm 包 vs 内嵌 | **内嵌规则 + 共享配置文件**（不 import 运行时扩展） |
| 3 | usage_script 安全 | vm + timeout；失败降级 `—` |
| 4 | 全量 tab vs 仅 claude/codex | v1 仅可切换的类型；其它可配置 `experimentalTabs` |
| 5 | 是否注册全部 provider | **否**，仅 last + 当前选中（现策略对，避免 70+ 污染） |
| 6 | 余量是否列表全刷 | **否**，当前页 + 缓存；进入时 background |
| 7 | grokbuild | 与 codex 类似 openai 系，parser 可复用 → v1.1 |

---

## 9. 推荐实施切片（里程碑）

### M0 — 骨架（0.5d）

- package 可 `pi install D:\code_space\pi-switch`
- 读 DB、列 claude/codex、旧逻辑可切换

### M1 — 协议 + headers（1d）

- `apiFormat` 映射
- 注册带 headers（默认 codex/claude 伪装）
- 共享 `provider-headers.json`

### M2 — UI 三级选择 + 搜索（1d）

- 动态类型列、搜索、pin/recent
- 行：host / api / today usage / ★●

### M3 — 余量（1–1.5d）

- usage_script 安全执行 + 缓存
- 行展示 remaining
- `/pi-switch quota`

### M4 — 抛光

- 迁移旧 selection
- 测试、README、禁用旧 extension 说明
- （可选）grokbuild tab

---

## 10. 待你拍板（实现前）

1. **命令名**：`/pi-switch` 还是继承 `/cc-switch`？
2. **v1 tab 范围**：仅 claude+codex，还是凡 DB 有的都显示？
3. **usage_script**：完整兼容 cc-switch JS，还是先支持「预设模板 + 少数 JSONPath」？
4. **headers 配置**：只共用 `provider-headers.json`，还是再加 `pi-switch.json` overrides？
5. **是否保留** 与桌面 cc-switch 的 is_current 双向同步？（现 pi 扩展 **不同步** 回写 DB；建议继续只读）

---

## 11. 一句话决策

> **pi-switch = 只读 cc-switch DB 的 pi 侧桥 + 正确协议映射 + 注册时 headers 伪装 + 三级选择/搜索 UI（无分页、无余量）。**  
> **不做** 完整本地 API 网关；**协议** 靠 pi `api`；**headers** 复制 headers 包规则并挂到动态 provider；**余量** 跑 `meta.usage_script` + rollups。
