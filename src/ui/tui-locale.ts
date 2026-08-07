/**
 * TUI i18n layer for pi-switch.
 *
 * Detects the local language from the environment and exposes a bilingual
 * string table. Structural tokens (slash-command names, key glyphs such as
 * enter/esc/↑↓, and data identifiers like provider/model/pi-name) are kept
 * language-neutral on purpose — only UI chrome strings go through `t()`.
 */

export type Locale = "zh" | "en";

function env(name: string): string {
  return typeof process !== "undefined" && process.env
    ? (process.env[name] ?? "")
    : "";
}

/**
 * Resolve the active locale.
 * Precedence: PI_SWITCH_LOCALE override > LANG/LC_ALL/LANGUAGE > default "en".
 * Matches any `zh*` family (zh_CN, zh_TW, zh-Hans, …) as Chinese.
 */
export function detectLocale(): Locale {
  const forced = env("PI_SWITCH_LOCALE").trim().toLowerCase();
  if (forced.startsWith("zh")) return "zh";
  if (forced.startsWith("en")) return "en";

  const sys = (
    env("LC_ALL") ||
    env("LANG") ||
    env("LANGUAGE") ||
    ""
  ).toLowerCase();
  if (/(^|[._\s-])zh/.test(sys)) return "zh";
  return "en";
}

const zh = {
  doctor: "诊断",
  checks: "项检查",
  pass: "通过",
  warn: "警告",
  fail: "失败",
  skip: "跳过",
  stop: "停止",
  fix: "修复：",
  cursor: "光标",
  pinned: "已固定",
  overridden: "有覆写",
  blocked: "不可切换",
  active: "当前生效",
  nav: "移动",
  column: "切换列",
  search: "搜索",
  manual: "手动",
  refresh: "刷新",
  override: "覆写",
  pin: "固定",
  enterNextName: "下一级名称",
  enterNextModel: "下一级模型",
  select: "选择",
  escExit: "退出",
  escBack: "返回",
  filter: "过滤",
  confirm: "确认",
  cancelSearch: "取消搜索",
  modelId: "模型 id",
  switch: "切换",
  cancel: "取消",
  pinNeedModel: "请先进入模型列再固定",
  nameNotSwitchable: "当前名称不可切换",
  pinNeedSelectedModel: "请选中具体模型再固定",
  pinNoPersist: "未配置 pin 持久化",
  pinOn: "已固定",
  pinOff: "已取消固定",
  pinFail: "固定失败",
  overrideNeedName: "请先进入名称列再设置参数覆写",
  colType: "类型",
  colName: "名称",
  colModel: "模型",
  searching: "搜索",
  inputModelId: "输入 模型 id",
  selectModel: "选择模型",
  refreshModel: "刷新模型",
  manualInput: "手动输入",
  page: "翻页",
  unpin: "取消固定",
  empty: "空",
  noMatches: "无匹配",
  noModels: "无模型",
  notSwitchable: "不可切换",
  remoteFetchUnavailable: "未配置远端拉取",
  refreshingModels: "刷新模型...",
  modelsRefreshed: "已刷新 {n} 个模型",
  modelListEmpty: "模型列表为空",
  fetchFailed: "拉取失败",
  modelIdRequired: "model id 不能为空",
  noAvailableModels: "无可用模型，可手动输入或刷新模型",
  selectType: "选择类型",
  selectName: "选择名称",
  quickSwitchTitle: "快速切换",
  quickEmpty: "无 pin / recent",
  quickEmptyHint: "没有可用的 pin / recent；先用 /ps-config 完成一次切换",
  overrideProviderTitle: "参数覆写 · 选择 Provider",
  noProviders: "无 Provider",
  noSwitchableProviders: "没有可切换的 Provider",
  scopeAllModels: "全部模型",
  scopeModel: "模型 {id}",
  overrideSaveFailed: "参数覆写保存失败：{error}",
  overrideCleared: "已清除 modelMeta 覆写",
  overrideSaved: "已保存：{summary}",
  overrideClearFailed: "清除覆写失败：{error}",
  overrideClearedAll: "已清除全部覆写 · {provider}",
  overrideReapplyFailed: "已保存覆写，但重新应用失败：{error}",
  notSwitchableReason: "不可切换：{reason}",
  overrideBadge: "覆写",
  modelOverrideBadge: "{n}模型覆写",
  combinedOverrideBadge: "覆写+{n}模型",
  effectiveConfigEmpty: "没有可显示的当前或已保存 pi-switch 配置",
  effectiveConfigMaxUnresolved: "无法构建有效配置：{provider} · {model} maxTokens=unresolved；请写 exact-model maxTokens override",
  effectiveConfigBuildFailed: "无法构建有效配置：{reason}",
  noCcProviders: "未找到 cc-switch provider（检查 ~/.cc-switch/cc-switch.db 或 CC_SWITCH_DB）",
  stageProviderRegistration: "Provider 注册",
  stageModelSwitch: "模型切换",
  activationFailed: "切换失败（{stage}）：{error}",
  activationPartial: "已切换，但部分阶段未完成：\n- {warnings}",
  activationSuccess: "已切换到 {provider} · {model}（{meta}）",
  oldProviderCleanupFailed: "旧 Provider 清理失败",
  oldProviderCleanupSkipped: "旧 Provider 清理跳过",
  selectionSaveFailed: "selection 保存失败",
  recentSaveFailed: "recent 保存失败",
  cmdConfigDescription: "从 cc-switch 选择 Provider 与 Model 并切换（pin/recent 本地快捷）",
  cmdQuickDescription: "快速切换：pin + recent 一屏直达",
  cmdAliasDescription: "ps-config 别名",
  cmdOverrideDescription: "设置 modelMeta 参数覆写（可按模型细粒度；预设：中转兼容 / 完整推理）",
  cmdDoctorDescription: "诊断 pi-switch 环境（sqlite3 / DB / 指纹 / modelMeta / pin）",
  cmdProbeDescription: "兼容性探针（只读）：对当前/指定 Target 跑 basic/reasoning/tool 契约，输出结构化证据",
  cmdRepairDescription: "证据驱动修复（交互）：重新 Probe → 白名单 Recipe → 确认 → 内存候选验证 → CAS 提交，不切换 Session Model",
  cmdInfoDescription: "显示当前生效的 Provider、Model、参数与非敏感 Header 名称",

  // --- /ps-doctor report strings ---
  docTitleSqlite3: "sqlite3 可执行文件",
  docTitleIdentity: "身份迁移",
  docTitleCcDb: "cc-switch 数据库",
  docTitleSchema: "CC Switch 数据契约",
  docTitleReadProviders: "读取 providers",
  docTitleProvidersSnap: "providers 快照",
  docTitleProvidersStale: "providers 读取警告",
  docTitleSelection: "已保存选择",
  docTitleHeaders: "Header 规则",
  docTitleFingerprint: "客户端伪装指纹",
  docTitleModelMeta: "当前 modelMeta 策略",
  docTitleModelOverrides: "按模型覆写",
  docTitlePins: "常用 pin",
  docTitleRecent: "最近切换",
  docTitleRouting: "CC Switch 路由服务",
  docTitleCapabilities: "模型能力元数据",
  docTitleWireCompat: "Provider 请求线兼容",
  docTitleSdk: "Pi 运行版本",

  docSqlite3NotFound: "未找到 sqlite3。tried: ",
  docSkipped: "已跳过",
  docDbMissing: "不存在: ",
  docSchemaProbeFail: "schema 探测失败（按核心列尽力读取）",
  docDbEmpty: "数据库为空",
  docNoSelection: "尚无 piSwitchSelection",
  docSelNotInDb: " 在当前 DB 中不存在",
  docSelNotSwitchable: " 不可切换: ",
  docHeadersLoaded: " 条规则（defaults + provider-headers.json）",
  docFingerprintOutOfSnap: "本机版本超出快照契约",
  docNoPins: "无 pin（在 /ps-config 选中模型后按 p 添加）",
  docRecentKept: "保留 {n} 条 last-N",
  docRecentNone: "尚无 recent 记录",
  docProvidersSnapOk: "共 {n} 条（可切换 {s}，不可切换 {b}）",
  docSdkBelow: "Pi {ver} < 最低 {min}（peer range ≥{min}，本进程越界加载）",
  docSdkOk: "Pi {ver} ≥ 最低 {min}",
  docSdkUndetected: "未探测到（安装期 peer range ≥{min} 已拦截窗口外版本）",

  docSrcModelIdTag: "模型 id 标签",
  docSrcHostAdapt: "宿主适配",
  docStale: "(过期)",
  docCapUnresolved: "（不可注册）",
  docCapReasoningUnknown: "（不写回配置）",
  docCapLastGood: "（保留 last-good）",
  docCapMiss: "无此条目（已确认 @{at}）",
  docCapCold: "未查询（下次注册后台刷新）",
  docCapRefreshFail: "上次后台刷新失败 @{t}",

  docUser: "用户",
  docBuiltIn: "内置",
  docBuiltInDisabled: "已关闭",

  docTierRoutedNote: "；routed 后备仅应用级启用（客户端指向 CC Switch 代理时）",
  docTierNothingSwitchableFix: "该 app type 无静态凭据条目；managed-auth 条目可见不可切换（SPEC §11），或用 CC Switch 路由（应用级）",
  docIdentityFix: "stale：dbId 已不在 DB；ambiguous：同 id 跨 app type，未猜测；迁移前备份为 settings.json/pi-switch.json .bak-<ts>",

  docFixSqlite3: "安装 sqlite3 并加入 PATH，或设置 SQLITE3_PATH / pi-switch.json.sqlitePath",
  docFixDb: "先用 cc-switch 创建 Provider，或设置 CC_SWITCH_DB 指向正确路径",
  docFixProviders: "检查 sqlite3 与 DB 路径；确认 providers 表可查询",
  docFixProvidersEmpty: "在 cc-switch 中添加至少一个 Provider",
  docFixSelectionNone: "运行 /ps-config 选择一次 Provider/Model",
  docFixSelectionMissing: "运行 /ps-config 重新选择；旧选择会在成功后覆盖",
  docFixSelectionNotSwitchable: "在 cc-switch 补全 baseUrl/apiKey，或换一个可切换 Provider",
  docFixSchemaFail: "检查 sqlite3 可执行文件与 DB 只读权限；身份配对将按 dbId 尽力匹配",
  docFixHeaders: "检查包内 defaults/headers.json 是否随安装发布",
  docFixFingerprintFallback: "未探测到本机 CLI（{list}），使用兜底版本；可安装 CLI 或在 pi-switch.json.vars 显式指定",
  docFixFingerprintSnapshot: "本机版本超出快照契约（{list}）；升级 pi-switch 得新快照，或 pi-switch.json.vars 显式钉版本",
  docFixModelMeta: "若中转报 400 reasoning/thinking，用 /ps-override 选「中转兼容」或设 defaultModelMeta.reasoning=false",
  docFixModelOverrides: "模型 id 可能已改名或只在远端存在；用 /ps-override 重新设置或清除该层",
  docFixPins: "在 /ps-config 用 p 重新 pin，或编辑 pi-switch.json.pins",
  docFixRouting: "在 CC Switch 应用内检查代理/切换状态（设置 → 代理）；仅 routed 应用需要它",
  docFixCapabilitiesFail: "在 providerOverrides 为 model \"{id}\" 写 exact-model maxTokens（modelOverrides.<id>.maxTokens）",
  docFixCapabilitiesWarn: "冲突：可显式 override 钉值；过期：清缓存重拉（pi-switch-cache.json 或 config.capabilitiesRefresh）；reasoning unknown 可钉 exact-model reasoning",
  docFixWireCompat: "显式 providerOverrides.<provider>.compat 覆盖了官方 adapter 事实；确认中转是否真的不支持该 wire 能力，或删除该覆写",
  docFixSchemaNew: "SCHEMA_VERSION 过新：升级 pi-switch 获取新列契约",
  docFixSchemaOld: "SCHEMA_VERSION 过旧：升级 CC Switch 到窗口内版本（≥3.14.0）",
  docFixSchemaUnknown: "探测到未知列（{cols}）：升级 pi-switch",
  docFixSdk: "升级 Pi（pi 自更新或 npm i -g @earendil-works/pi-coding-agent）",

  docModelOverridesOk: "{n} 条",
  docModelOverridesStale: "{n} 条（{m} 条不在 DB 模型列表: {list}）",
  docPinsOk: "{n} 条 pin",
  docPinsBroken: "（{n} 条 dbId 失效）",
  docRoutingReach: "可达 {url}",
  docRoutingUnreach: "不可达 {url}（Direct 路径不受影响）",
} as const;

type Key = keyof typeof zh;

const en: Record<Key, string> = {
  doctor: "doctor",
  checks: "checks",
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skip: "SKIP",
  stop: "STOP",
  fix: "fix:",
  cursor: "cursor",
  pinned: "pinned",
  overridden: "overridden",
  blocked: "blocked",
  active: "active",
  nav: "nav",
  column: "column",
  search: "search",
  manual: "manual",
  refresh: "refresh",
  override: "override",
  pin: "pin",
  enterNextName: "next name",
  enterNextModel: "next model",
  select: "select",
  escExit: "exit",
  escBack: "back",
  filter: "filter",
  confirm: "confirm",
  cancelSearch: "cancel search",
  modelId: "model id",
  switch: "switch",
  cancel: "cancel",
  pinNeedModel: "enter the model column before pinning",
  nameNotSwitchable: "current name is not switchable",
  pinNeedSelectedModel: "select a concrete model before pinning",
  pinNoPersist: "pin persistence not configured",
  pinOn: "pinned",
  pinOff: "pin removed",
  pinFail: "pin failed",
  overrideNeedName: "enter the name column before override",
  colType: "Type",
  colName: "Name",
  colModel: "Model",
  searching: "search",
  inputModelId: "enter model id",
  selectModel: "select model",
  refreshModel: "refresh model",
  manualInput: "manual input",
  page: "page",
  unpin: "unpin",
  empty: "empty",
  noMatches: "no matches",
  noModels: "no models",
  notSwitchable: "not switchable",
  remoteFetchUnavailable: "remote model fetch is not configured",
  refreshingModels: "refreshing models...",
  modelsRefreshed: "refreshed {n} models",
  modelListEmpty: "model list is empty",
  fetchFailed: "fetch failed",
  modelIdRequired: "model id is required",
  noAvailableModels: "no available models; enter one manually or refresh",
  selectType: "select type",
  selectName: "select name",
  quickSwitchTitle: "quick switch",
  quickEmpty: "no pins or recent entries",
  quickEmptyHint: "no pins or recent entries; run /ps-config once first",
  overrideProviderTitle: "parameter override · select Provider",
  noProviders: "no Providers",
  noSwitchableProviders: "no switchable Providers",
  scopeAllModels: "all models",
  scopeModel: "model {id}",
  overrideSaveFailed: "failed to save parameter override: {error}",
  overrideCleared: "modelMeta override cleared",
  overrideSaved: "saved: {summary}",
  overrideClearFailed: "failed to clear overrides: {error}",
  overrideClearedAll: "all overrides cleared · {provider}",
  overrideReapplyFailed: "override saved, but reapplying it failed: {error}",
  notSwitchableReason: "not switchable: {reason}",
  overrideBadge: "override",
  modelOverrideBadge: "{n} model overrides",
  combinedOverrideBadge: "override + {n} models",
  effectiveConfigEmpty: "no active or saved pi-switch config to display",
  effectiveConfigMaxUnresolved: "cannot build effective config: {provider} · {model} maxTokens=unresolved; set an exact-model maxTokens override",
  effectiveConfigBuildFailed: "cannot build effective config: {reason}",
  noCcProviders: "no cc-switch providers found (check ~/.cc-switch/cc-switch.db or CC_SWITCH_DB)",
  stageProviderRegistration: "Provider registration",
  stageModelSwitch: "model switch",
  activationFailed: "switch failed ({stage}): {error}",
  activationPartial: "switched, but some stages did not complete:\n- {warnings}",
  activationSuccess: "switched to {provider} · {model} ({meta})",
  oldProviderCleanupFailed: "old Provider cleanup failed",
  oldProviderCleanupSkipped: "old Provider cleanup skipped",
  selectionSaveFailed: "selection save failed",
  recentSaveFailed: "recent save failed",
  cmdConfigDescription: "select a Provider and Model from cc-switch and switch (local pin/recent shortcuts)",
  cmdQuickDescription: "quick switch from pins and recent entries",
  cmdAliasDescription: "alias for ps-config",
  cmdOverrideDescription: "set modelMeta parameter overrides by Provider or Model, with relay-compatible and full-reasoning presets",
  cmdDoctorDescription: "diagnose the pi-switch environment (sqlite3, DB, fingerprint, modelMeta, pins)",
  cmdProbeDescription: "run read-only basic, reasoning, and tool compatibility probes against the current or selected target",
  cmdRepairDescription: "re-probe, propose a whitelisted repair, confirm it, validate in memory, and commit with CAS without switching the Session Model",
  cmdInfoDescription: "show the active Provider, Model, parameters, and non-sensitive Header names",

  // --- /ps-doctor report strings ---
  docTitleSqlite3: "sqlite3 executable",
  docTitleIdentity: "identity migration",
  docTitleCcDb: "cc-switch database",
  docTitleSchema: "CC Switch data contract",
  docTitleReadProviders: "reading providers",
  docTitleProvidersSnap: "providers snapshot",
  docTitleProvidersStale: "providers read warning",
  docTitleSelection: "saved selection",
  docTitleHeaders: "Header rules",
  docTitleFingerprint: "client fingerprint",
  docTitleModelMeta: "current modelMeta policy",
  docTitleModelOverrides: "per-model overrides",
  docTitlePins: "saved pins",
  docTitleRecent: "recent switches",
  docTitleRouting: "CC Switch routing service",
  docTitleCapabilities: "model capability metadata",
  docTitleWireCompat: "Provider wire compatibility",
  docTitleSdk: "Pi runtime version",

  docSqlite3NotFound: "sqlite3 not found. tried: ",
  docSkipped: "skipped",
  docDbMissing: "missing: ",
  docSchemaProbeFail: "schema probe failed (best-effort read by core columns)",
  docDbEmpty: "database is empty",
  docNoSelection: "no piSwitchSelection yet",
  docSelNotInDb: " not in current DB",
  docSelNotSwitchable: " not switchable: ",
  docHeadersLoaded: " rules (defaults + provider-headers.json)",
  docFingerprintOutOfSnap: "local version outside snapshot contract",
  docNoPins: "no pins (select a model in /ps-config then press p to add)",
  docRecentKept: "kept {n} last-N",
  docRecentNone: "no recent records",
  docProvidersSnapOk: "total {n} (switchable {s}, not switchable {b})",
  docSdkBelow: "Pi {ver} < minimum {min} (peer range ≥{min}, out-of-window load)",
  docSdkOk: "Pi {ver} ≥ minimum {min}",
  docSdkUndetected: "not detected (install-time peer range ≥{min} blocks out-of-window versions)",

  docSrcModelIdTag: "model-id tag",
  docSrcHostAdapt: "host adaptation",
  docStale: "(stale)",
  docCapUnresolved: "(not registrable)",
  docCapReasoningUnknown: "(not written back to config)",
  docCapLastGood: "(keep last-good)",
  docCapMiss: "no such entry (confirmed @{at})",
  docCapCold: "not queried (refreshed in background on next register)",
  docCapRefreshFail: "last background refresh failed @{t}",

  docUser: "user",
  docBuiltIn: "built-in",
  docBuiltInDisabled: "disabled",

  docTierRoutedNote: "; routed fallback is app-level only (when client points at the CC Switch proxy)",
  docTierNothingSwitchableFix: "this app type has no static credential entry; managed-auth entries are visible but not switchable (SPEC §11), or use CC Switch routing (app-level)",
  docIdentityFix: "stale: dbId no longer in DB; ambiguous: same id across app types, not guessed; back up to settings.json/pi-switch.json .bak-<ts> before migrating",

  docFixSqlite3: "install sqlite3 and add it to PATH, or set SQLITE3_PATH / pi-switch.json.sqlitePath",
  docFixDb: "create a Provider in cc-switch first, or point CC_SWITCH_DB to the correct path",
  docFixProviders: "check sqlite3 and DB path; ensure the providers table is queryable",
  docFixProvidersEmpty: "add at least one Provider in cc-switch",
  docFixSelectionNone: "run /ps-config to pick a Provider/Model",
  docFixSelectionMissing: "run /ps-config to re-select; the old selection is overwritten on success",
  docFixSelectionNotSwitchable: "fill in baseUrl/apiKey in cc-switch, or pick a switchable Provider",
  docFixSchemaFail: "check the sqlite3 executable and DB read-only permission; identity pairing matches best-effort by dbId",
  docFixHeaders: "check that defaults/headers.json shipped with the package",
  docFixFingerprintFallback: "no local CLI detected ({list}); using fallback versions—install the CLI or set pi-switch.json.vars explicitly",
  docFixFingerprintSnapshot: "local version outside snapshot contract ({list}); upgrade pi-switch for a new snapshot, or pin explicitly via pi-switch.json.vars",
  docFixModelMeta: "if a relay returns 400 on reasoning/thinking, use /ps-override 'relay-compat' or set defaultModelMeta.reasoning=false",
  docFixModelOverrides: "model id may have been renamed or exist only remotely; re-set via /ps-override or clear that layer",
  docFixPins: "re-pin with p in /ps-config, or edit pi-switch.json.pins",
  docFixRouting: "check the proxy/switch state inside the CC Switch app (Settings → Proxy); only routed apps need it",
  docFixCapabilitiesFail: 'write exact-model maxTokens for model "{id}" in providerOverrides (modelOverrides.<id>.maxTokens)',
  docFixCapabilitiesWarn: "conflict: pin explicitly via override; stale: clear cache and re-pull (pi-switch-cache.json or config.capabilitiesRefresh); reasoning unknown can be pinned to exact-model reasoning",
  docFixWireCompat: "explicit providerOverrides.<provider>.compat overrides official adapter facts; confirm the relay truly lacks that wire capability, or remove the override",
  docFixSchemaNew: "SCHEMA_VERSION too new: upgrade pi-switch for the new column contract",
  docFixSchemaOld: "SCHEMA_VERSION too old: upgrade CC Switch to an in-window version (≥3.14.0)",
  docFixSchemaUnknown: "unknown columns detected ({cols}): upgrade pi-switch",
  docFixSdk: "upgrade Pi (pi self-update or npm i -g @earendil-works/pi-coding-agent)",

  docModelOverridesOk: "{n} entries",
  docModelOverridesStale: "{n} entries ({m} not in DB model list: {list})",
  docPinsOk: "{n} pins",
  docPinsBroken: " ({n} dbId stale)",
  docRoutingReach: "reachable {url}",
  docRoutingUnreach: "unreachable {url} (Direct path unaffected)",
};

export const STRINGS: Record<Locale, Record<Key, string>> = { zh, en };

let current: Locale = detectLocale();

/** Override the active locale at runtime (used by tests and future config). */
export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** Translate a chrome string key for the active locale. */
export function t(key: Key): string {
  return STRINGS[current][key];
}

/**
 * Translate a chrome string key and fill `{name}` placeholders from `params`.
 * Unmatched placeholders are left intact so a missing param is visible rather
 * than silently dropped.
 */
export function tf(
  key: Key,
  params: Record<string, string | number> = {},
): string {
  return STRINGS[current][key].replace(
    /\{(\w+)\}/g,
    (_, name: string) => (name in params ? String(params[name]) : `{${name}}`),
  );
}

/** Build a translator bound to a specific locale (deterministic, test-friendly). */
export function makeT(locale: Locale = current): (key: Key) => string {
  return (key: Key) => STRINGS[locale][key];
}
