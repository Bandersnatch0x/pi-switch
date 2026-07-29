# UI/UX 重构与美化实施计划 (UI/UX Refactor Plan)

## 1. 目标与背景 (Objective)
本项目 (`pi-switch` / `pi-ccs`) 负责在 CLI 环境中提供供应商（Provider）与模型（Model）的快捷切换与参数覆写。其 TUI 界面主要通过 `@earendil-works/pi-tui`（支持 ANSI 颜色、主题及极简组件库）和三层级控制逻辑构建。

本次重构旨在从**视觉层次、视觉标识（Icons/Badges）、空间间距与对比度、动画与过渡提示、键盘操作指引**五个维度进行系统性推进。

---

## 2. 核心重构与 UX 改造要点 (Key Enhancement Modules)

### 2.1 品牌与图标增强 (Icons & Visual Badges)
- **应用类型/Provider 独有 Icon 标识**：
  - 为 `claude` / `codex` / `gemini` / `opencode` / `grok` / `hermes` 等不同 `appType` 引入精致的 Unicode / Nerd-Font Icon（如 `⚡` / `🤖` / `✦` / `⚙️` / `💻` / `◈`）。
  - 在 Provider 状态、固定（Pinned）、最近（Recent）列表中引入醒目的 Tag 徽章（如 `[PINNED]` 带有微亮黄高亮，`[ACTIVE]` 带有亮绿小圆点 `●`）。

### 2.2 视觉排版与三栏边框美化 (Layout & Border Refinements)
- **三栏级联选择器 (`three-level-pick.ts`)**：
  - 增加立体 Box-drawing 边界与柔和阴影分隔，优化栏目 Header 标题（`◈ 类型 ◈` / `◈ 名称 ◈` / `◈ 模型 ◈`）的字体样式与背景点缀。
  - 强化**当前选中项 (Focused Item)** 的背景与高亮行样式（使用 Theme 的 `accent` + 加粗 / 反白样式），提高眼睛焦点捕捉效率。
  - 动态光标 `vsep` 实线 `│` 与虚线 `┆` 的焦点响应。

### 2.3 交互指引与底部 Action-Bar (Interactive Footers & Hints)
- **快捷键指引**：
  - 优化底部提示信息显示，按按键类别突出关键功能按键：`[Tab] 切换列 · [↑/↓] 移动 · [Enter] 确认切换 · [Esc] 返回/退出`。
  - 在实时搜索（Search/Filter）状态下，搜索框引入高亮匹配关键字与 `🔍` 图标状态指示。

### 2.4 参数覆写表单 (`model-meta-form.ts` & `model-meta-dialog.ts`)
- **对话框与表单的美化**：
  - 设置清晰的圆角/双线外框（Box Border）与居中 Header Banner。
  - 强化已修改项（Dirty fields）的标记与保存/放弃更改提示。

---

## 3. 详细执行路线图 (Execution Phases)

### Phase 1: `src/ui/labels.ts` & `src/ui/tabs.ts`
- [x] 规范图标与状态标签样式 (`getAppTypeIcon`, `formatAppTypeBadge`)。
- [x] 增加 ANSI 高亮与调色盘层级工具 (`cyanHighlight`, `dimText`, `ANSI_CYAN`)。

### Phase 2: `src/ui/three-level-pick.ts`
- [x] 重构三栏布局的 Header / Column Body / Footer 渲染逻辑。
- [x] 动态焦点线 (`vsep`) 在激活列时高亮为实线 `│`。
- [x] 格式化 Keybinding Legend 底部指示器。

### Phase 3: `src/ui/model-meta-form.ts` & `model-meta-dialog.ts`
- [x] 表单已具备 `✱` dirty 标记、`覆写/继承/默认` 状态行、accent 选中高亮、border + hint footer（既有实现，无需再改）
- [x] dirty 提示：`formTitle` / `fieldStateText` / `fieldRow` 三处均已标 ✱；`confirmDiscard` 在退出/切作用域时拦截

### Phase 4: 全套回归测试
- [x] `bun run typecheck` 0 错误（修复 `labels.ts` 重复定义）
- [x] `bun test` 285 项全 Pass，0 Failure
- [x] `bun run smoke` pass=10 warn=0 fail=0
