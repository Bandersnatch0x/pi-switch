/**
 * /ps-doctor — structured health checks (inspired by CallmeLins doctor UX).
 * Pure functions: no node imports; caller injects IO results.
 */

import type { CcProvider, PinEntry, PiSwitchConfig, PiSwitchSelection, RecentEntry } from "./types.ts";
import { compareSemver, PI_MIN_VERSION } from "./settings.ts";
import { isSwitchable } from "./parse/index.ts";
import {
  CC_SWITCH_SCHEMA_LATEST,
  CC_SWITCH_SCHEMA_MIN,
  KNOWN_PROVIDERS_COLUMNS,
  type DbCapabilities,
} from "./db.ts";
import type { ResolvedCapabilities, CapabilitySource } from "./capabilities/resolve.ts";
import type { IdentityMigrationSummary } from "./migration.ts";
import { summarizeTiers } from "./tier.ts";
import {
  countModelOverrides,
  resolveModelMetaLayers,
  summarizeModelMeta,
} from "./model-meta.ts";
import { resolveProviderOverride } from "./provider-override.ts";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorInput {
  home: string;
  dbPath: string;
  dbExists: boolean;
  sqlite3Path: string | null;
  sqlite3Tried?: string[];
  providers: CcProvider[];
  providersError?: string;
  selection?: PiSwitchSelection;
  config: PiSwitchConfig;
  headerRuleCount: number;
  varsSummary?: {
    codexVersion: string;
    codexVersionSource: string;
    claudeCodeVersion: string;
    claudeCodeVersionSource: string;
    geminiVersion: string;
    geminiVersionSource: string;
    anthropicBeta: string;
    codexOriginator: string;
  };
  pins?: PinEntry[];
  recent?: RecentEntry[];
  /** Detected Pi runtime version (W6 SDK). Undefined when not detectable. */
  piVersion?: string;
  /** Minimum supported Pi version (W6). Defaults to PI_MIN_VERSION. */
  piMinVersion?: string;
  /** Fingerprint snapshot baselines (W5). Undefined when not packaged. */
  fingerprintSnapshot?: {
    snapshotVersion: number;
    baselines: { codex?: string; claudeCode?: string; gemini?: string };
  };
  /** Routing probe result (W3). Undefined when probing disabled. */
  routingProbe?: { url: string; reachable: boolean };
  /** Resolved capability facts for the current model (W4). */
  capabilities?: { modelId: string; resolved: ResolvedCapabilities };
  /**
   * models.dev cache state for the selected model (issue #39).
   * miss/cold are informational only and never upgrade the check to warn.
   */
  modelsDevCache?: { state: "hit" | "miss" | "cold"; observedAt?: string };
  /** Last session-only background refresh failure (issue #39). */
  refreshFailure?: { at: number; message: string };
  /** Identity migration outcome (issue #16); present only on this run. */
  migrationSummary?: IdentityMigrationSummary;
  /** Probed CC Switch schema capabilities (W1). Undefined when not available. */
  schemaCapabilities?: DbCapabilities;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number };
  lines: string[];
}

function countBy(checks: DoctorCheck[]): DoctorReport["summary"] {
  return {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
}

export function runDoctor(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. sqlite3
  if (input.sqlite3Path) {
    checks.push({
      id: "sqlite3",
      title: "sqlite3 可执行文件",
      status: "pass",
      detail: input.sqlite3Path,
    });
  } else {
    checks.push({
      id: "sqlite3",
      title: "sqlite3 可执行文件",
      status: "fail",
      detail: `未找到 sqlite3。tried: ${(input.sqlite3Tried ?? []).join(", ") || "(none)"}`,
      fix: "安装 sqlite3 并加入 PATH，或设置 SQLITE3_PATH / pi-switch.json.sqlitePath",
    });
  }

  // 1.5 identity migration outcome (issue #16)
  if (input.migrationSummary) {
    const m = input.migrationSummary;
    checks.push({
      id: "identity-migration",
      title: "身份迁移",
      status: m.ambiguous || m.stale ? "warn" : "pass",
      detail: m.skipped
        ? `已跳过（${m.skipped}）`
        : `migrated=${m.migrated} stale=${m.stale} ambiguous=${m.ambiguous}`,
      fix:
        m.ambiguous || m.stale
          ? "stale：dbId 已不在 DB；ambiguous：同 id 跨 app type，未猜测；迁移前备份为 settings.json/pi-switch.json .bak-<ts>"
          : undefined,
    });
  }

  // 1.6 app-type support tiers (W2): direct / visible-only / routed summary
  if (input.providers.length) {
    for (const row of summarizeTiers(input.providers)) {
      const reasons = Object.entries(row.reasonDistribution)
        .map(([k, n]) => `${k}=${n}`)
        .join(", ");
      const nothingSwitchable = row.total > 0 && row.direct === 0;
      checks.push({
        id: `tier-${row.appType}`,
        title: `app type ${row.appType}`,
        status: nothingSwitchable ? "warn" : "pass",
        detail:
          `direct=${row.direct} visible=${row.visible} routed=${row.routed}` +
          (reasons ? `（${reasons}）` : "") +
          (row.routed
            ? "；routed 后备仅应用级启用（客户端指向 CC Switch 代理时）"
            : ""),
        fix: nothingSwitchable
          ? "该 app type 无静态凭据条目；managed-auth 条目可见不可切换（SPEC §11），或用 CC Switch 路由（应用级）"
          : undefined,
      });
    }
  }

  // 2. DB file
  if (input.dbExists) {
    checks.push({
      id: "db-file",
      title: "cc-switch 数据库",
      status: "pass",
      detail: input.dbPath,
    });
  } else {
    checks.push({
      id: "db-file",
      title: "cc-switch 数据库",
      status: "fail",
      detail: `不存在: ${input.dbPath}`,
      fix: "先用 cc-switch 创建 Provider，或设置 CC_SWITCH_DB 指向正确路径",
    });
  }

  // 2.5 schema capabilities (W1): probed column set / composite key / version
  if (input.schemaCapabilities) {
    const cap = input.schemaCapabilities;
    const unknown = cap.columns.filter((c) => !KNOWN_PROVIDERS_COLUMNS.has(c));
    const facts =
      `columns=${cap.columns.length} category=${cap.hasCategory} ` +
      `provider_type=${cap.hasProviderType} compositeId=${cap.compositeId}` +
      (cap.userVersion !== undefined ? ` userVersion=${cap.userVersion}` : " userVersion=?");
    let status: DoctorStatus = "pass";
    let fix: string | undefined;
    if (cap.userVersion !== undefined && cap.userVersion > CC_SWITCH_SCHEMA_LATEST) {
      status = "warn";
      fix = "SCHEMA_VERSION 过新：升级 pi-switch 获取新列契约";
    } else if (cap.userVersion !== undefined && cap.userVersion < CC_SWITCH_SCHEMA_MIN) {
      status = "warn";
      fix = "SCHEMA_VERSION 过旧：升级 CC Switch 到窗口内版本（≥3.14.0）";
    } else if (unknown.length) {
      status = "warn";
      fix = `探测到未知列（${unknown.join(", ")}）：升级 pi-switch`;
    }
    checks.push({
      id: "schema",
      title: "CC Switch 数据契约",
      status,
      detail: `${input.providers.length} providers · ${facts}`,
      fix,
    });
  } else if (input.dbExists) {
    checks.push({
      id: "schema",
      title: "CC Switch 数据契约",
      status: "warn",
      detail: "schema 探测失败（按核心列尽力读取）",
      fix: "检查 sqlite3 可执行文件与 DB 只读权限；身份配对将按 dbId 尽力匹配",
    });
  }

  // 3. providers snapshot
  if (input.providersError && !input.providers.length) {
    checks.push({
      id: "providers",
      title: "读取 providers",
      status: "fail",
      detail: input.providersError,
      fix: "检查 sqlite3 与 DB 路径；确认 providers 表可查询",
    });
  } else {
    const switchable = input.providers.filter(isSwitchable).length;
    const blocked = input.providers.length - switchable;
    checks.push({
      id: "providers",
      title: "providers 快照",
      status: input.providers.length ? "pass" : "warn",
      detail: input.providers.length
        ? `共 ${input.providers.length} 条（可切换 ${switchable}，不可切换 ${blocked}）`
        : "数据库为空",
      fix: input.providers.length ? undefined : "在 cc-switch 中添加至少一个 Provider",
    });
    if (input.providersError) {
      checks.push({
        id: "providers-stale",
        title: "providers 读取警告",
        status: "warn",
        detail: input.providersError,
      });
    }
  }

  // 4. selection
  const sel = input.selection;
  if (!sel) {
    checks.push({
      id: "selection",
      title: "已保存选择",
      status: "warn",
      detail: "尚无 piSwitchSelection",
      fix: "运行 /ps-config 选择一次 Provider/Model",
    });
  } else {
    const match = input.providers.find(
      (p) => p.id === sel.dbId && (!sel.appType || p.appType === sel.appType),
    );
    if (!match) {
      checks.push({
        id: "selection",
        title: "已保存选择",
        status: "fail",
        detail: `dbId=${sel.dbId}${sel.appType ? ` appType=${sel.appType}` : ""} model=${sel.model} 在当前 DB 中不存在`,
        fix: "运行 /ps-config 重新选择；旧选择会在成功后覆盖",
      });
    } else if (!isSwitchable(match)) {
      checks.push({
        id: "selection",
        title: "已保存选择",
        status: "fail",
        detail: `${match.appType}/${match.displayName} 不可切换: ${match.parseError ?? "unknown"}`,
        fix: "在 cc-switch 补全 baseUrl/apiKey，或换一个可切换 Provider",
      });
    } else {
      checks.push({
        id: "selection",
        title: "已保存选择",
        status: "pass",
        detail: `${match.appType}/${match.displayName} · ${sel.model}`,
      });
    }
  }

  // 5. headers
  checks.push({
    id: "headers",
    title: "Header 规则",
    status: input.headerRuleCount > 0 ? "pass" : "warn",
    detail: `已加载 ${input.headerRuleCount} 条规则（defaults + provider-headers.json）`,
    fix: input.headerRuleCount ? undefined : "检查包内 defaults/headers.json 是否随安装发布",
  });

  // 6. fingerprint vars (W5: fallback + out-of-snapshot detection)
  if (input.varsSummary) {
    const v = input.varsSummary;
    const snap = input.fingerprintSnapshot;
    const fallbacks = [
      v.codexVersionSource === "fallback" ? "codex" : null,
      v.claudeCodeVersionSource === "fallback" ? "claude" : null,
      v.geminiVersionSource === "fallback" ? "gemini" : null,
    ].filter(Boolean);
    // Locally probed CLI versions that drift from the fixture-verified
    // snapshot baseline are outside the fingerprint contract (W5).
    // config-pinned versions are the documented resolution, so they do not warn.
    const outOfSnapshot: string[] = [];
    const baseline = (cli: "codex" | "claudeCode" | "gemini", ver: string) => {
      const base = snap?.baselines[cli];
      if (base && ver !== base) outOfSnapshot.push(`${cli}:${ver}(local)≠${base}`);
    };
    if (snap) {
      if (v.codexVersionSource === "local") baseline("codex", v.codexVersion);
      if (v.claudeCodeVersionSource === "local") baseline("claudeCode", v.claudeCodeVersion);
      if (v.geminiVersionSource === "local") baseline("gemini", v.geminiVersion);
    }
    const status: DoctorStatus = fallbacks.length || outOfSnapshot.length ? "warn" : "pass";
    const fixes: string[] = [];
    if (fallbacks.length) {
      fixes.push(
        `未探测到本机 CLI（${fallbacks.join(", ")}），使用兜底版本；可安装 CLI 或在 pi-switch.json.vars 显式指定`,
      );
    }
    if (outOfSnapshot.length) {
      fixes.push(
        `本机版本超出快照契约（${outOfSnapshot.join("; ")}）；升级 pi-switch 得新快照，或 pi-switch.json.vars 显式钉版本`,
      );
    }
    checks.push({
      id: "fingerprint",
      title: "客户端伪装指纹",
      status,
      detail:
        `codex=${v.codexVersion}(${v.codexVersionSource}) · ` +
        `claude=${v.claudeCodeVersion}(${v.claudeCodeVersionSource}) · ` +
        `gemini=${v.geminiVersion}(${v.geminiVersionSource}) · ` +
        `originator=${v.codexOriginator} · beta=${v.anthropicBeta}` +
        (snap ? ` · snapshot=v${snap.snapshotVersion}` : ""),
      fix: fixes.length ? fixes.join("；") : undefined,
    });
  }

  // 7. effective modelMeta for current selection (layer-aware)
  if (sel) {
    const match = input.providers.find(
      (p) => p.id === sel.dbId && (!sel.appType || p.appType === sel.appType),
    );
    if (match) {
      const layers = resolveModelMetaLayers(input.config, match, sel.model);
      const sources: string[] = [];
      if (layers.base) sources.push("defaultModelMeta");
      if (layers.provider) sources.push("provider");
      if (layers.model) sources.push(`model[${layers.modelKey}]`);
      const detail =
        summarizeModelMeta(layers.effective) +
        (sources.length ? `（来源: ${sources.join(" → ")}）` : "");
      checks.push({
        id: "model-meta",
        title: "当前 modelMeta 策略",
        status: "pass",
        detail,
        fix:
          layers.effective?.reasoning === false
            ? undefined
            : "若中转报 400 reasoning/thinking，用 /ps-override 选「中转兼容」或设 defaultModelMeta.reasoning=false",
      });
    }
  }

  // 7b. per-model overrides: count + stale keys
  const modelOverrideCount = countModelOverrides(input.config.providerOverrides);
  if (modelOverrideCount) {
    const stale: string[] = [];
    for (const provider of input.providers) {
      const entry = resolveProviderOverride(input.config.providerOverrides, provider);
      for (const key of Object.keys(entry?.modelOverrides ?? {})) {
        if (key.includes("*")) continue;
        if (!provider.configModels.includes(key)) {
          stale.push(`${provider.displayName}/${key}`);
        }
      }
    }
    checks.push({
      id: "model-overrides",
      title: "按模型覆写",
      status: stale.length ? "warn" : "pass",
      detail:
        `${modelOverrideCount} 条` +
        (stale.length ? `（${stale.length} 条不在 DB 模型列表: ${stale.slice(0, 3).join(", ")}）` : ""),
      fix: stale.length
        ? "模型 id 可能已改名或只在远端存在；用 /ps-override 重新设置或清除该层"
        : undefined,
    });
  }

  // 8. pins
  const pins = input.pins ?? input.config.pins ?? [];
  if (pins.length) {
    const broken = pins.filter((p) => !input.providers.some((x) => x.id === p.dbId));
    checks.push({
      id: "pins",
      title: "常用 pin",
      status: broken.length ? "warn" : "pass",
      detail: `${pins.length} 条 pin` + (broken.length ? `（${broken.length} 条 dbId 失效）` : ""),
      fix: broken.length ? "在 /ps-config 用 p 重新 pin，或编辑 pi-switch.json.pins" : undefined,
    });
  } else {
    checks.push({
      id: "pins",
      title: "常用 pin",
      status: "pass",
      detail: "无 pin（在 /ps-config 选中模型后按 p 添加）",
    });
  }

  // 9. recent
  const recent = input.recent ?? input.config.recent ?? [];
  checks.push({
    id: "recent",
    title: "最近切换",
    status: "pass",
    detail: recent.length ? `保留 ${recent.length} 条 last-N` : "尚无 recent 记录",
  });

  // 10. routing (W3): CC Switch Local Routing proxy reachability
  if (input.routingProbe) {
    checks.push({
      id: "routing",
      title: "CC Switch 路由服务",
      status: input.routingProbe.reachable ? "pass" : "warn",
      detail: input.routingProbe.reachable
        ? `可达 ${input.routingProbe.url}`
        : `不可达 ${input.routingProbe.url}（Direct 路径不受影响）`,
      fix: input.routingProbe.reachable
        ? undefined
        : "在 CC Switch 应用内检查代理/切换状态（设置 → 代理）；仅 routed 应用需要它",
    });
  }

  // 11. capabilities (W4): provenance, conflicts, staleness for current model
  if (input.capabilities) {
    const cap = input.capabilities.resolved;
    const fieldLine = (label: string, e: { value: number | boolean; source: CapabilitySource; fetchedAt?: string; stale?: boolean }) => {
      const src =
        e.source === "models-dev"
          ? `models.dev@${e.fetchedAt ?? "?"}${e.stale ? "(过期)" : ""}`
          : e.source === "model-id-tag"
            ? "模型 id 标签"
            : e.source === "host-adaptation"
              ? "宿主适配"
              : e.source;
      return `${label}=${e.value}(${src})`;
    };
    const warnRows: string[] = [];
    for (const c of cap.conflicts) {
      warnRows.push(`${c.field}=${c.effective}(${c.effectiveSource}) vs ${c.overridden}(${c.overriddenSource})`);
    }
    for (const e of [cap.contextWindow, cap.maxTokens, cap.reasoning, cap.vision]) {
      if (e.source === "models-dev" && e.stale) {
        warnRows.push(`models.dev@${e.fetchedAt ?? "?"} 过期（保留 last-good）`);
      }
    }
    // Issue #39: cache-state lines are informational; miss/cold never upgrade warn.
    const infoRows: string[] = [];
    if (input.modelsDevCache?.state === "miss") {
      const at = input.modelsDevCache.observedAt ?? "?";
      infoRows.push(`models.dev: 无此条目（已确认 @${at}）`);
    } else if (input.modelsDevCache?.state === "cold") {
      infoRows.push("未查询（下次注册后台刷新）");
    }
    if (input.refreshFailure) {
      const t = new Date(input.refreshFailure.at).toISOString();
      infoRows.push(`上次后台刷新失败 @${t}`);
    }
    const detail =
      `${input.capabilities.modelId}: ` +
      [
        fieldLine("context", cap.contextWindow),
        fieldLine("maxOutput", cap.maxTokens),
        fieldLine("reasoning", cap.reasoning),
        fieldLine("vision", cap.vision),
      ].join(" · ") +
      (warnRows.length ? `；${warnRows.join("；")}` : "") +
      (infoRows.length ? `；${infoRows.join("；")}` : "");
    checks.push({
      id: "capabilities",
      title: "模型能力元数据",
      status: warnRows.length ? "warn" : "pass",
      detail,
      fix: warnRows.length
        ? "冲突：可显式 override 钉值；过期：清缓存重拉（pi-switch-cache.json 或 config.capabilitiesRefresh）"
        : undefined,
    });
  }

  // 12. SDK (W6): Pi runtime version within compat window
  const min = input.piMinVersion ?? PI_MIN_VERSION;
  if (input.piVersion) {
    const below = compareSemver(input.piVersion, min) < 0;
    checks.push({
      id: "sdk",
      title: "Pi 运行版本",
      status: below ? "fail" : "pass",
      detail: below
        ? `Pi ${input.piVersion} < 最低 ${min}（peer range ≥${min}，本进程越界加载）`
        : `Pi ${input.piVersion} ≥ 最低 ${min}`,
      fix: below ? "升级 Pi（pi 自更新或 npm i -g @earendil-works/pi-coding-agent）" : undefined,
    });
  } else {
    checks.push({
      id: "sdk",
      title: "Pi 运行版本",
      status: "pass",
      detail: `未探测到（安装期 peer range ≥${min} 已拦截窗口外版本）`,
    });
  }

  const summary = countBy(checks);
  const icon = (s: DoctorStatus) => (s === "pass" ? "PASS" : s === "warn" ? "WARN" : "FAIL");
  const lines: string[] = [
    `pi-switch doctor · pass=${summary.pass} warn=${summary.warn} fail=${summary.fail}`,
    "",
  ];
  for (const c of checks) {
    lines.push(`[${icon(c.status)}] ${c.title}`);
    lines.push(`  ${c.detail}`);
    if (c.fix) lines.push(`  fix: ${c.fix}`);
  }
  return { checks, summary, lines };
}

/** Render report as a single notify-friendly string. */
export function formatDoctorReport(report: DoctorReport): string {
  return report.lines.join("\n");
}
