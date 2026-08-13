# v0.3.4 (未发布)

## 新增功能

### Session Model Strategy 配置

新增 `sessionModelStrategy` 配置项，控制 resume/fork/reload 时的模型选择逻辑。

**配置项**：
- `selection-first`（默认）：优先使用 ps-config 选择，回退到会话历史
- `session-first`（兼容）：优先使用会话历史，回退到 ps-config 选择
- `selection-only`（严格）：仅使用 ps-config 选择，忽略会话历史

**修复的问题**：
1. ✅ Subagent 启动时使用错误的模型（继承父会话而非 ps-config 选择）
2. ✅ Resume 会话时忽略 ps-config 更新的选择

**配置示例**：
```json
{
  "sessionModelStrategy": "selection-first"
}
```

**向后兼容**：
- 默认策略改为 `selection-first`（新行为）
- 需要旧行为的用户可设置 `"sessionModelStrategy": "session-first"`

**文档**：
- [配置指南](./session-model-strategy.md)
- [完整修复文档](./fix-subagent-model-selection.md)

---

## 内部改进

### 测试覆盖
- 新增 3 个测试场景覆盖所有策略
- 新增 2 个测试验证 fork (subagent) 行为
- 全部 899 个测试通过

### 代码变更
- `src/types.ts`: 新增 `sessionModelStrategy` 配置类型
- `extensions/switch-lifecycle.ts`: 重构 `resolveSessionTarget()` 支持三种策略
- `tests/switch-lifecycle.test.ts`: 新增 5 个测试用例

---

## 升级指南

### 从 v0.3.3 升级

**如果你希望保留旧行为**（resume 时使用会话历史模型）：
```json
{
  "sessionModelStrategy": "session-first"
}
```

**如果你希望使用新行为**（推荐，resume 时使用 ps-config 选择）：
```json
{
  "sessionModelStrategy": "selection-first"
}
```
或者不配置（默认就是 `selection-first`）。

### 迁移检查清单

- [ ] 阅读 [session-model-strategy.md](./session-model-strategy.md)
- [ ] 确定期望的策略行为
- [ ] 更新 `~/.pi/agent/pi-switch.json` 配置
- [ ] 重启 Pi 使配置生效
- [ ] 测试 resume 和 subagent 行为

---

## 技术细节

### 策略优先级表

| 策略 | ps-config 可用 | 会话历史可用 | 使用哪个 |
|------|---------------|-------------|---------|
| selection-first | ✅ | ✅ | ps-config |
| selection-first | ✅ | ❌ | ps-config |
| selection-first | ❌ | ✅ | 会话历史（回退） |
| selection-first | ❌ | ❌ | 跳过切换 |
| session-first | ✅ | ✅ | 会话历史 |
| session-first | ✅ | ❌ | ps-config（回退） |
| session-first | ❌ | ✅ | 会话历史 |
| session-first | ❌ | ❌ | 跳过切换 |
| selection-only | ✅ | ✅ | ps-config（忽略会话） |
| selection-only | ✅ | ❌ | ps-config |
| selection-only | ❌ | ✅ | 跳过切换（不回退） |
| selection-only | ❌ | ❌ | 跳过切换 |

### 触发时机

策略在以下 `session_start` reason 时生效：
- `startup`：新会话
- `resume`：恢复会话
- `fork`：Subagent 启动
- `reload`：重新加载

### 会话模型来源

会话历史模型从以下来源解析：
1. `model_change` 事件（最后一个）
2. `assistant` 消息（最后一个）

解析顺序：后者优先（最新的记录）

---

## 已知限制

1. **配置更新需要重启**：修改 `sessionModelStrategy` 后需重启 Pi
2. **不影响手动切换**：手动切换（`/ps` 或 Pi 自带 `/model`、模型循环）总是更新 ps-config selection；Pi 的 `model_select` 事件中 `restore` 来源不会覆盖 selection
3. **Provider 必须可用**：无论哪种策略，如果目标 provider 不在数据库中，都会跳过或回退

---

## 反馈

如果遇到问题或有建议，请：
1. 检查 [故障排查指南](./session-model-strategy.md#故障排查)
2. 提交 Issue 附带：
   - `~/.pi/agent/pi-switch.json` 配置（脱敏）
   - 期望行为 vs 实际行为
   - Pi 版本和 pi-switch 版本
