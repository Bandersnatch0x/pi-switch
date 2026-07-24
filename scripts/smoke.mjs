#!/usr/bin/env bun
/**
 * Local smoke: doctor + DB snapshot + optional models list probe.
 * Does NOT call chat completions or mutate selection.
 *
 * Exit non-zero when doctor reports any fail checks.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultDbPath, readProviders } from "../src/db.ts";
import { resolveSqlitePath } from "../src/sqlite-path.ts";
import { isSwitchable } from "../src/parse/index.ts";
import {
  piSettingsPath,
  piSwitchConfigPath,
  readPiSwitchConfig,
  readSelection,
  resolveProviderOverride,
} from "../src/settings.ts";
import { parseHeaderRulesFile, combineRules } from "../src/headers/rules.ts";
import { buildHeaderVars } from "../src/headers/vars.ts";
import { fetchRemoteModels } from "../src/models-fetch.ts";
import { formatDoctorReport, runDoctor } from "../src/doctor.ts";
import {
  resolveOverrideHeaders,
  isFingerprintPreset,
} from "../src/headers/fingerprints.ts";

const home = os.homedir();
const fsLike = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
};

function loadHeaderRules() {
  const defaultsPath = new URL("../defaults/headers.json", import.meta.url);
  let defaults = [];
  try {
    const p =
      defaultsPath.pathname.startsWith("/") && process.platform === "win32"
        ? decodeURIComponent(defaultsPath.pathname.slice(1))
        : decodeURIComponent(defaultsPath.pathname);
    if (fs.existsSync(p)) {
      defaults = parseHeaderRulesFile(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  } catch {
    // package defaults optional
  }

  let shared = [];
  try {
    const pathShared = path.join(home, ".pi", "agent", "provider-headers.json");
    if (fs.existsSync(pathShared)) {
      shared = parseHeaderRulesFile(JSON.parse(fs.readFileSync(pathShared, "utf8")));
    }
  } catch {
    // ignore
  }
  return combineRules(defaults, shared);
}

async function main() {
  console.log("== pi-switch smoke ==");
  console.log("home:", home);

  const config = readPiSwitchConfig(fsLike, piSwitchConfigPath(home));
  const resolved = resolveSqlitePath({
    configPath: config.sqlitePath,
    exists: fs.existsSync,
  });
  const sqlite3Path = resolved.path ?? "";
  const sqlite3Tried = resolved.tried ?? [];
  console.log(
    "sqlite3:",
    sqlite3Path || "(missing)",
    "tried:",
    sqlite3Tried.join(" | ") || "(none)",
  );

  const dbPath = defaultDbPath(home);
  console.log("db:", dbPath, fs.existsSync(dbPath) ? "(exists)" : "(missing)");

  const providersResult = readProviders({
    execFileSync,
    existsSync: fs.existsSync,
    sqlite3Path,
    dbPath,
  });
  const providers = providersResult.ok ? providersResult.providers : [];
  const providersError = providersResult.ok ? undefined : providersResult.error;
  const switchable = providers.filter(isSwitchable);
  console.log(
    "providers:",
    providers.length,
    "switchable:",
    switchable.length,
    providersError ? `error: ${providersError}` : "",
  );

  const headerRules = loadHeaderRules();
  const vars = buildHeaderVars(
    {
      execFileSync,
      existsSync: fs.existsSync,
      readFileSync: fs.readFileSync,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      homedir: home,
    },
    config.vars,
  );
  const varsSummary = {
    codexVersion: vars.codexVersion,
    codexVersionSource: vars.codexVersionSource,
    claudeCodeVersion: vars.claudeCodeVersion,
    claudeCodeVersionSource: vars.claudeCodeVersionSource,
    geminiVersion: vars.geminiVersion,
    geminiVersionSource: vars.geminiVersionSource,
    anthropicBeta: vars.anthropicBeta,
    codexOriginator: vars.codexOriginator,
  };

  const sel = readSelection(fsLike, piSettingsPath(home));
  console.log(
    "selection:",
    sel
      ? `${sel.provider ?? "?"} model=${sel.model} dbId=${sel.dbId}`
      : "(none)",
  );

  const report = runDoctor({
    home,
    dbPath,
    dbExists: fs.existsSync(dbPath),
    sqlite3Path: sqlite3Path || null,
    sqlite3Tried,
    providers,
    providersError,
    selection: sel ?? undefined,
    config,
    headerRuleCount: headerRules.length,
    varsSummary,
    pins: config.pins,
    recent: config.recent,
  });

  console.log("");
  console.log(formatDoctorReport(report));
  console.log(
    `summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
  );

  // Optional upstream models probe (no setModel, no selection write)
  const probeTarget =
    (sel && switchable.find((p) => p.id === sel.dbId)) || switchable[0];
  if (probeTarget) {
    const ov = resolveProviderOverride(config.providerOverrides, probeTarget);
    const fingerprint =
      typeof ov?.fingerprint === "string" && isFingerprintPreset(ov.fingerprint)
        ? ov.fingerprint
        : undefined;
    const resolvedHeaders = resolveOverrideHeaders({
      fingerprint,
      headers: ov?.headers,
    });
    const ua = resolvedHeaders.headers?.["User-Agent"];
    console.log("");
    console.log(
      `upstream models probe: ${probeTarget.appType}/${probeTarget.displayName} (${probeTarget.baseUrl})`,
    );
    try {
      const r = await fetchRemoteModels({
        baseUrl: probeTarget.baseUrl,
        apiKey: probeTarget.apiKey,
        modelsUrl: probeTarget.modelsUrl,
        isFullUrl: probeTarget.isFullUrl,
        userAgent: ua,
      });
      if (r.error) {
        console.log("models probe: FAIL", r.error);
      } else {
        console.log(
          `models probe: OK count=${r.models.length} sample=${r.models.slice(0, 5).join(", ")}`,
        );
      }
    } catch (e) {
      console.log(
        "models probe: FAIL",
        e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    console.log("");
    console.log("upstream models probe: skipped (no switchable provider)");
  }

  if (report.summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exitCode = 1;
});
