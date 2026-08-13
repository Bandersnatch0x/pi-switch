# Session Model Strategy 配置

## 概述

`sessionModelStrategy` 控制 Pi 在 resume/fork/reload 时如何选择模型：使用 ps-config 保存的选择，还是会话历史中的模型。

## 配置项

在 `~/.pi/agent/pi-switch.json` 中设置：

```json
{
  "sessionModelStrategy": "selection-first"
}
```

## 三种策略

本文中的“不可用”涵盖完整激活链路：Provider 注册失败、注册后无法在模型 registry 中找到目标，或 `setModel` 抛错/返回失败。候选在任一步失败时，策略才会尝试下一个候选。

### 1. `selection-first`（默认，推荐）

**行为**：优先使用 ps-config 选择，回退到会话历史

**适用场景**：
- 希望 ps-config 是权威来源
- Subagent 应该使用 ps-config 选中的模型
- Resume 会话时应该恢复到 ps-config 选择

**示例**：
```
ps-config: xkool/gpt-5
会话历史: zhipu-glm-en/glm-5.2

→ Resume: 使用 xkool/gpt-5
→ Fork (subagent): 使用 xkool/gpt-5
```

**回退逻辑**：
- 如果 ps-config 选择的 provider 不可用 → 尝试会话历史模型
- 两者都不可用 → 跳过自动切换

---

### 2. `session-first`（兼容模式）

**行为**：优先使用会话历史，回退到 ps-config 选择

**适用场景**：
- 需要旧版行为（v0.3.3 及更早）
- 希望 resume 时恢复会话最后使用的模型
- Subagent 继承父会话模型

**示例**：
```
ps-config: xkool/gpt-5
会话历史: zhipu-glm-en/glm-5.2

→ Resume: 使用 zhipu-glm-en/glm-5.2
→ Fork (subagent): 使用 zhipu-glm-en/glm-5.2
```

**回退逻辑**：
- 如果会话历史模型的 provider 不可用 → 尝试 ps-config 选择
- 两者都不可用 → 跳过自动切换

---

### 3. `selection-only`（严格模式）

**行为**：**仅**使用 ps-config 选择，完全忽略会话历史

**适用场景**：
- 希望强制使用 ps-config 选择
- 不希望会话历史影响模型选择
- 严格的模型管理需求

**示例**：
```
ps-config: xkool/gpt-5
会话历史: zhipu-glm-en/glm-5.2

→ Resume: 使用 xkool/gpt-5（忽略会话历史）
→ Fork (subagent): 使用 xkool/gpt-5（忽略父会话）
```

**回退逻辑**：
- 如果 ps-config 选择不可用 → 跳过自动切换（不回退到会话历史）

---

## 触发时机

该策略在以下 `session_start` reason 时生效：

1. **`startup`**: 启动新会话
2. **`resume`**: 恢复已保存的会话
3. **`fork`**: 启动 subagent（Agent 工具调用）
4. **`reload`**: 重新加载会话

## 典型使用场景

### 场景 1：ps-config 是权威来源（推荐）

```json
{
  "sessionModelStrategy": "selection-first"
}
```

**效果**：
- `/ps` 选中模型 A
- 会话中手动切换到模型 B
- Resume 会话 → 恢复到模型 A（ps-config 选择）
- 启动 subagent → 使用模型 A

---

### 场景 2：保留旧版行为

```json
{
  "sessionModelStrategy": "session-first"
}
```

**效果**：
- `/ps` 选中模型 A
- 会话中手动切换到模型 B
- Resume 会话 → 继续使用模型 B（会话历史）
- 启动 subagent → 继承父会话模型 B

---

### 场景 3：严格控制模型选择

```json
{
  "sessionModelStrategy": "selection-only"
}
```

**效果**：
- `/ps` 选中模型 A
- 会话中手动切换到模型 B
- Resume 会话 → 强制使用模型 A（忽略会话历史）
- 启动 subagent → 强制使用模型 A（忽略父会话）

---

## 与其他功能的交互

### 与 `pins` 的关系
- `pins` 是快捷方式，不影响 session model resolution
- Pin 切换成功后，模型会被写入 ps-config selection

### 与 `recent` 的关系
- `recent` 是历史记录，不影响 session model resolution
- Recent 切换成功后，模型会被写入 ps-config selection

### 与手动切换的关系
- 手动切换（`/ps` 或 Pi 自带切换）会更新 ps-config selection
- Pi 原生切换通过 `model_select` 事件同步；`set`/`cycle` 会写入 selection，`restore` 不会覆盖 selection
- 下次 resume 时，策略决定是否使用新的 selection

---

## 版本历史

- **v0.3.4+**: 引入 `sessionModelStrategy` 配置
  - 默认值：`selection-first`（新行为）
  - 兼容模式：`session-first`（旧行为）
  
- **v0.3.3 及更早**: 固定使用 `session-first` 逻辑

---

## 故障排查

### 问题：Resume 时使用了错误的模型

**诊断**：
1. 检查 `~/.pi/agent/pi-switch.json` 中的 `sessionModelStrategy`
2. 检查 `~/.pi/agent/settings.json` 中的 `piSwitchSelection`
3. 确认 provider 在当前数据库中可用

**解决方案**：
- 如果希望使用 ps-config 选择：设置 `"sessionModelStrategy": "selection-first"`
- 如果希望保留会话历史：设置 `"sessionModelStrategy": "session-first"`

---

### 问题：Subagent 使用了父会话的模型，而不是 ps-config 选择

**原因**：`sessionModelStrategy` 设置为 `session-first`

**解决方案**：
```json
{
  "sessionModelStrategy": "selection-first"
}
```

重启 Pi 后生效。

---

## 配置示例

### 完整配置示例

```json
{
  "sessionModelStrategy": "selection-first",
  "tabs": ["claude", "codex", "gemini"],
  "providerOverrides": {
    "xkool-id": {
      "modelMeta": {
        "maxTokens": 32000
      }
    }
  },
  "pins": [
    {
      "dbId": "xkool-id",
      "model": "gpt-5",
      "label": "GPT-5"
    }
  ],
  "recentLimit": 8
}
```

---

## 更多信息

- [完整修复文档](./fix-subagent-model-selection.md)
- [Issue 讨论](https://github.com/Bandersnatch0x/pi-switch/issues)
