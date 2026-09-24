# v0.3.6

> **停止维护前的最后一个例外。** 本仓库处于停止维护状态;本节是经维护者明确授权、在一个有界例外范围内合入并发布:只把 Provider 注册镜像进 `models.json`、并新增 Subagent 模型层 UI,不引入第二配置权威的最后一次变更。此后不再有计划中的新功能、修复或支持。

## New Features

- **Subagent 模型层 UI**：picker 快捷键 `s`（名称列起）或 `/ps-subagents` 直接写 `settings.json` 的 `subagents.defaultModel` / `subagents.agentOverrides.<agent>.model`。
  - 目标列表 = 一行“全部 Subagent 默认” + 扫盘发现的所有 agent 定义（项目 `.pi/agents` → `~/.pi/agent/agents` → 已安装 `pi-subagents` 包的 `agents/`，同名先命中者胜出）。
  - 每行显示当前模型来自哪一层：`override` / `frontmatter` / `default` / `inherit session model`。
  - 取值列表：用当前聚焦的 provider/model（仅从 picker `s` 进入时）、清除（回退下一层）、选 cc-switch Provider/Model（只读选择器）、手输 model id。
- **Provider 镜像**：新增 `pi-switch.json` 的 `persistProviders`（默认 `true`）。每次成功注册都把该 Provider 镜像进 Pi 的跨进程 provider 文件，使从未加载本扩展的进程（pi-subagents 的 detached subagent runner）也能解析 cc-switch Provider。

## Behavior

- 镜像只动 `models.json` 的 `providers.<name>`，其余键与外部 Provider 原样保留。
- 归属记录写在 `~/.pi/agent/pi-switch-persisted-providers.json`（`piName → 内容摘要`）；只有摘要匹配的条目会被改写或剪枝，外部内容只上报 conflict。
- 切换 Provider 会剪掉上一个条目；探针 / 修复目标（`commit: "runtime-only"`）永不镜像。
- `models.json` 非法 JSON 或根非对象时只告警，不重建文件。
- 两个路径都跟随 `PI_CODING_AGENT_DIR`（以及 `~`）。
- provider `apiKey` 会明文出现在 `models.json`，与 Pi / cc-switch 的既有做法一致；设 `persistProviders: false` 可完全关闭。

## Architecture

- 新增 `src/persistent-providers.ts`（纯规划器 + 原子同步）、`src/subagent-models.ts`（agent 发现 / frontmatter 解析 / 四层来源判定 / settings 写入）、`src/ui/subagent-model-pick.ts`（两段式选择流程）。
- `registerProvider` 结果带上已构建 config，供镜像复用；镜像接线集中在 `Runtime.providerMirror` + `switch-lifecycle` 的同步点。
- 新增 `findOwningPackageDir`，与既有 `findOwningPackageVersion` 共用 manifest 探测。

## Validation

- `bun test`：1060 pass / 0 fail（新增 `tests/persistent-providers.test.ts` 19 条、`tests/subagent-models.test.ts` 31 条）。
- `bun run typecheck`：无错误。
- `bun run smoke:tui`：6/6 通过（新增 `subagents` flow；`switch` flow 增加 `models.json` 条目与归属记录断言；快照范围扩到 `models.json` 与 sidecar，证明真实 HOME 未被改写）。
- `bun run smoke:probe-repair`：3/3 配方通过。
- `bun run smoke:subagent-mirror`（新）：真实 Pi + 真实 pi-subagents detached runner —— 镜像存在时子代理解析出 `provider/model`、请求打到 relay、输出正确；删除镜像后同一条命令静默失败且不碰 relay；重建镜像后恢复。
