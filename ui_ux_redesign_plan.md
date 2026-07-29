# UI/UX 美化与 TUI 改造方案 (UI/UX Redesign Plan)

## 1. 目标与背景 (Objective & Background)
本项目 (`pi-switch` / `pi-ccs`) 负责在 CLI 环境中提供供应商（Provider）与模型（Model）的快捷切换与参数覆写。其 TUI 界面主要通过 `@earendil-works/pi-tui`（支持 ANSI 颜色、主题及极简组件库）和三层级控制逻辑构建。

本次 TUI 美化改造旨在从**视觉层次、视觉标识（Icons/Badges）、空间间距与对比度、动画与过渡提示、键盘操作指引**五个维度进行全面精细化重构。

---

## 2. 核心美化与 UX 改造点 (Key Enhancements)

### 2.1 品牌与图标增强 (Icons & Visual Badges)
- **应用类型/Provider 独有 Icon 标识**：
  - 为 `claude` / `codex` / `gemini` / `opencode` / `grok` / `hermes` 等不同 `appType` 引入精致的 Unicode / Nerd-Font Icon（如 `⚡` / `🤖` / `✦` / `⚙️` / `💻` / `◈`）。
  - 在 Provider 状态、固定（Pinned）、最近（Recent）列表中引入醒目的 Tag 徽章（如 `[PINNED]` 带有微亮黄高亮，`[ACTIVE]` 带有亮绿小圆点 `●`）。

### 2.2 视觉排版与三栏边框美化 (Layout & Border Refinements)
- **三栏级联选择器 (`three-level-pick.ts`)**：
  - 增加立体 Box-drawing 边界与柔和阴影分隔，优化栏目 Header 标题（`◈ 类型 ◈` / `◈ 名称 ◈` / `◈ 模型 ◈`）的字体样式与背景点缀。
  - 强化**当前选中项 (Focused Item)** 的背景与高亮行样式（使用 Theme 的 `accent` + 加粗 / 反白样式），提高眼睛焦点捕捉效率。
  - 增加动态光标 `vsep` 实线 `│` 与虚线 `┆` 的焦点响应。

### 2.3 交互指引与底部 Action-Bar (Interactive Footers & Hints)
- **快捷键指引**：
  - 优化底部提示信息显示，清晰地按按键类别突出关键功能按键：`[Tab] 切换列 · [↑/↓] 移动 · [Enter] 确认切换 · [Esc] 返回/退出`。
  - 在实时搜索（Search/Filter）状态下，搜索框引入高亮匹配关键字与 `🔍` 图标状态指示。

### 2.4 参数覆写表单 (`model-meta-form.ts` & `model-meta-dialog.ts`)
- **对话框与表单的美化**：
  - 设置清晰的圆角/双线外框（Box Border）与居中 Header Banner。
  - 强化已修改项（Dirty fields）的标记与保存/放弃更改提示。

---

## 3. 受影响文件与架构 (Affected Components)

1. `src/ui/labels.ts`:
   - 包含 Provider 与 AppType 的图标/Badge 格式化函数 (`getAppTypeIcon`, `formatAppTypeBadge`, ANSI 高亮辅助)。
2. `src/ui/tabs.ts`:
   - 升级 Tab 页签格式（增加图标与徽章，优化激活态提示）。
3. `src/ui/quick-pick.ts`:
   - 美化 `/ps` 快速切换列表中的 Pinned/Recent 视觉排版。
4. `src/ui/three-level-pick.ts`:
   - 重构三栏渲染引擎的颜色应用、边框绘制、Header/Footer 视觉流与焦点样式。
5. `src/ui/model-meta-form.ts` & `model-meta-dialog.ts`:
   - 升级表单框体、按键提示与输入反馈的 UI 体验。

---

## 4. 验证与测试计划 (Verification & Testing)

- **自动化单元测试**：
  - 运行 `bun test`，确保 283+ 项测试全部 Pass，不破坏核心文本对齐与选择逻辑。
- **冒烟与环境实测**：
  - 运行 `bun run smoke`，验证端到端数据库连接、Provider 快照解析与远程 Upstream 探针。
