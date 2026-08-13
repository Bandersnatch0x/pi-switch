# 修复：Subagent 和 Resume 会话的模型选择问题

## 问题描述

### 问题 1：Subagent 启动时使用错误的模型

**现象**：
- 用户通过 `/ps` 选中了模型 A（保存在 ps-config）
- 父会话中手动切换到了模型 B
- 启动 subagent 时，subagent 使用了模型 B（父会话模型），而不是模型 A（ps-config 选择）

**期望行为**：
- Subagent 应该使用 ps-config 中选中的模型 A

### 问题 2：Resume 会话时忽略 ps-config 更新

**现象**：
- 会话 1 使用模型 A
- 用户通过 `/ps` 更新选择为模型 B
- Resume 会话 1 时，仍然使用模型 A（会话历史），而不是模型 B（ps-config 更新后的选择）

**期望行为**：
- Resume 时应该使用 ps-config 的最新选择（模型 B）

---

## 根本原因

### 代码分析

**`extensions/switch-lifecycle.ts:275-305`** 中的 `resolveSessionTarget()` 函数：

```typescript
// 旧逻辑（v0.3.3 及更早）
const sessionModel = sessionModelFromBranch(ctx.sessionManager?.getBranch?.());
if (sessionModel) {
  // 优先使用会话历史模型
  const sessionProvider = matchProvider(providers, { piName: sessionModel.provider });
  if (sessionProvider && isSwitchable(sessionProvider)) {
    return { provider: sessionProvider, modelId, source: "session" };
  }
}

// 只有当会话历史不可用时才回退到 ps-config
const current = rt.state.readSelection();
```

**问题**：
1. **会话历史优先**：resume/fork 时总是优先使用会话 branch 中的最后一个模型
2. **忽略 ps-config 更新**：如果会话历史存在，ps-config 的更新被忽略
3. **Subagent 继承父模型**：fork reason 时继承父会话的模型，而不是 ps-config 选择

### 为什么这是个问题

1. **ps-config 不是权威来源**：用户通过 `/ps` 做的选择被会话历史覆盖
2. **一致性差**：同一个 ps-config 选择，在不同会话历史下表现不同
3. **Subagent 行为不可预测**：subagent 使用什么模型取决于父会话历史，而不是 ps-config

---

## 解决方案

### 新增 `sessionModelStrategy` 配置

在 `~/.pi/agent/pi-switch.json` 中新增配置项：

```typescript
type SessionModelStrategy = "selection-first" | "session-first" | "selection-only";
```

### 三种策略

下文的“不可用”涵盖完整激活链路：Provider 注册失败、注册后无法在模型 registry 中找到目标，或 `setModel` 抛错/返回失败。候选在任一步失败时，策略才会尝试下一个候选。

#### 1. `selection-first`（默认，推荐）

**逻辑**：
```
1. 尝试 ps-config selection
2. 如果不可用 → 回退到 session branch
3. 两者都不可用 → 跳过切换
```

**适用场景**：
- ps-config 是权威来源
- Resume 时使用最新的 ps-config 选择
- Subagent 使用 ps-config 选择

#### 2. `session-first`（兼容模式）

**逻辑**：
```
1. 尝试 session branch
2. 如果不可用 → 回退到 ps-config selection
3. 两者都不可用 → 跳过切换
```

**适用场景**：
- 需要旧版行为（v0.3.3 及更早）
- Resume 时恢复会话最后使用的模型
- Subagent 继承父会话模型

#### 3. `selection-only`（严格模式）

**逻辑**：
```
1. 仅使用 ps-config selection
2. 完全忽略 session branch
3. ps-config 不可用 → 跳过切换（不回退）
```

**适用场景**：
- 强制使用 ps-config 选择
- 严格的模型管理需求

---

## 代码变更

### 1. 类型定义（`src/types.ts`）

```typescript
export type SessionModelStrategy =
  | "selection-first"  // 优先 ps-config，回退到会话
  | "session-first"    // 优先会话，回退到 ps-config
  | "selection-only";  // 仅 ps-config，不回退

export interface PiSwitchConfig {
  sessionModelStrategy?: SessionModelStrategy;
  // ... 其他配置
}
```

### 2. Session Target Resolution（`extensions/switch-lifecycle.ts`）

```typescript
function resolveSessionTarget(
  ctx: PiSwitchCtx,
  rt: Runtime,
  providers: CcProvider[],
): SessionTarget | undefined {
  const strategy = rt.config.sessionModelStrategy ?? "selection-first";
  
  const selectionSrc = rt.state.readSelection();
  const sessionModel = sessionModelFromBranch(ctx.sessionManager?.getBranch?.());
  
  // 根据策略决定优先级
  const sources = strategy === "selection-only"
    ? [{ kind: "selection" as const, data: selectionSrc }]
    : strategy === "session-first"
    ? [
        { kind: "session" as const, data: sessionModel },
        { kind: "selection" as const, data: selectionSrc },
      ]
    : [
        { kind: "selection" as const, data: selectionSrc },
        { kind: "session" as const, data: sessionModel },
      ];
  
  // 按优先级尝试
  for (const src of sources) {
    if (src.kind === "selection" && src.data) {
      const provider = matchProvider(providers, {
        dbId: src.data.dbId,
        appType: src.data.appType,
      });
      if (provider && isSwitchable(provider)) {
        return {
          provider,
          modelId: src.data.model,
          source: "selection",
        };
      }
    }
    
    if (src.kind === "session" && src.data) {
      const provider = matchProvider(providers, {
        piName: src.data.provider,
      });
      if (provider && isSwitchable(provider)) {
        return {
          provider,
          modelId: src.data.id,
          source: "session",
        };
      }
    }
  }
  
  return undefined;
}
```

### 3. 测试覆盖（`tests/switch-lifecycle.test.ts`）

新增 5 个测试用例：

1. **`resume with selection-first (default) prefers ps-config selection`**
   - 验证默认策略下 resume 使用 ps-config 选择

2. **`resume with session-first (legacy) prefers session model`**
   - 验证兼容模式下 resume 使用会话历史

3. **`resume with selection-only ignores session model`**
   - 验证严格模式下完全忽略会话历史

4. **`fork (subagent) with selection-first uses ps-config selection`**
   - 验证默认策略下 subagent 使用 ps-config 选择

5. **`fork (subagent) with session-first uses session model`**
   - 验证兼容模式下 subagent 继承父会话模型

---

## 测试结果

### 单元测试

```bash
bun test switch-lifecycle.test.ts
# ✅ 23 pass, 0 fail
```

### 完整测试套件

```bash
bun test
# ✅ 899 pass, 0 fail；session lifecycle 定向测试覆盖激活级回退与原生同步
```

### TypeScript 类型检查

```bash
npm run typecheck
# ✅ No errors
```

---

## 向后兼容性

### 默认行为变更

- **v0.3.3 及更早**：固定使用 `session-first` 逻辑
- **v0.3.4+**：默认使用 `selection-first` 逻辑

### 迁移路径

**如果需要保留旧行为**，在 `~/.pi/agent/pi-switch.json` 中添加：

```json
{
  "sessionModelStrategy": "session-first"
}
```

**如果接受新行为**（推荐），无需配置（默认即可）。

---

## 验证步骤

### 1. 验证 Subagent 使用 ps-config 选择

**前置条件**：
- ps-config 选中 provider A / model M1
- 当前会话使用 provider B / model M2

**操作**：
1. 启动 subagent（Agent 工具调用）

**预期结果**：
- Subagent 使用 provider A / model M1（ps-config 选择）

### 2. 验证 Resume 使用 ps-config 选择

**前置条件**：
- 会话 1 使用 provider A / model M1
- 保存并退出会话 1
- 通过 `/ps` 更新选择为 provider B / model M2

**操作**：
1. Resume 会话 1

**预期结果**：
- 会话恢复后使用 provider B / model M2（ps-config 最新选择）

### 3. 验证兼容模式

**配置**：
```json
{
  "sessionModelStrategy": "session-first"
}
```

**操作**：
- 重复上述两个验证步骤

**预期结果**：
- Subagent 使用 provider B / model M2（父会话模型）
- Resume 使用 provider A / model M1（会话历史）

---

## 性能影响

### 无显著性能影响

- 策略判断是简单的字符串比较和条件分支
- 没有新增磁盘 I/O 或网络请求
- Session target resolution 仍然是 O(1) 操作

### 内存开销

- 新增配置字段：~8 bytes（字符串指针）
- 无运行时状态累积

---

## 已知限制

1. **配置更新需要重启 Pi**
   - `sessionModelStrategy` 在 Pi 启动时读取
   - 修改后需重启 Pi 才能生效

2. **不影响手动切换**
   - 用户手动切换（`/ps` 或 Pi 自带切换）总是更新 ps-config selection
   - Pi 原生切换通过 `model_select` 事件同步；`restore` 来源不会覆盖 selection
   - 策略不干预手动切换行为

3. **Provider 可用性检查**
   - 如果目标 provider 不在当前数据库中，会跳过或回退
   - 这是设计行为，防止尝试注册不存在的 provider

---

## 故障排查

### 问题：Resume 时仍然使用旧模型

**诊断步骤**：
1. 检查 `~/.pi/agent/pi-switch.json` 中的 `sessionModelStrategy`
2. 检查 `~/.pi/agent/settings.json` 中的 `piSwitchSelection`
3. 确认目标 provider 在当前数据库中可用

**常见原因**：
- `sessionModelStrategy` 设置为 `session-first`
- 目标 provider 不在数据库中（被移除或从未启用）

**解决方案**：
```json
{
  "sessionModelStrategy": "selection-first"
}
```

### 问题：Subagent 使用了错误的模型

**诊断步骤**：
1. 检查父会话使用的模型
2. 检查 ps-config 选择的模型
3. 检查 `sessionModelStrategy` 配置

**常见原因**：
- `sessionModelStrategy` 设置为 `session-first`（继承父会话）
- ps-config 选择的 provider 不可用（回退到会话历史）

**解决方案**：
```json
{
  "sessionModelStrategy": "selection-first"
}
```

### 问题：配置修改后没有生效

**原因**：Pi 在启动时读取配置，修改后需要重启。

**解决方案**：重启 Pi。

---

## 相关文档

- [Session Model Strategy 配置指南](./session-model-strategy.md)
- [CHANGELOG v0.3.4](./CHANGELOG-v0.3.4.md)
- [Pi Switch 用户文档](../README.md)

---

## 贡献者

- 问题报告：用户反馈
- 设计与实现：Kiro (Claude Fable 5)
- 测试：自动化测试套件
- 文档：本文档及配置指南

---

## 版本历史

- **2026-08-12**: 初始版本，修复 subagent 和 resume 模型选择问题
- **v0.3.4**: 首次发布，包含 `sessionModelStrategy` 配置
