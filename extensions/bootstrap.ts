/**
 * Initial register of saved selection + session_start apply.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSwitchable } from "../src/parse/index.ts";
import {
  migrateLegacySelection,
  piSettingsPath,
  readSelection,
} from "../src/settings.ts";
import { registerProvider } from "../src/register.ts";
import {
  asRegisterApi,
  findRegisteredModel,
} from "../src/pi-context.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Register last-known provider at extension load (before session_start),
 * then wire session_start to setModel on startup.
 */
export function bootstrap(pi: ExtensionAPI, rt: Runtime): void {
  const { providers } = rt.refreshSnapshot();

  const settingsPath = piSettingsPath(rt.home);
  const sel =
    readSelection(rt.fsLike(), settingsPath) ??
    migrateLegacySelection(rt.fsLike(), settingsPath, providers, process.pid);

  if (sel) {
    const match = providers.find((p) => p.id === sel.dbId);
    if (match && isSwitchable(match)) {
      if (
        registerProvider(asRegisterApi(pi), match, [sel.model], {
          rules: rt.headerRules,
          ...rt.headerOverrideOpts(match),
          vars: rt.headerVars(),
          debug: rt.config.debug,
          onReject: rt.rejectSink(),
          modelMeta: rt.modelMetaFor(match),
        })
      ) {
        rt.registeredPsNames = [match.piName];
      }
    } else if (!rt.warnedMissingDbId) {
      rt.warnedMissingDbId = true;
      console.warn(
        `[pi-switch] saved dbId not available; keeping selection, not auto-switching (${sel.dbId})`,
      );
    }
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (rt.lastGoodProviders.length) {
      ctx.ui?.setStatus?.(
        "pi-switch",
        `pi-switch: ${rt.lastGoodProviders.length} providers`,
      );
    }
    const current = readSelection(rt.fsLike(), settingsPath);
    if (!current) return;
    const match = rt.lastGoodProviders.find((p) => p.id === current.dbId);
    if (!match || !isSwitchable(match)) {
      if (!rt.warnedMissingDbId) {
        rt.warnedMissingDbId = true;
        ctx.ui?.setStatus?.("pi-switch", "⚠ 已保存的 Provider 不可用");
        ctx.ui?.notify?.(
          "pi-switch: 已保存的 Provider 在当前数据库中不可用，未自动切换",
          "warning",
        );
      }
      return;
    }
    registerProvider(asRegisterApi(pi), match, [current.model], {
      rules: rt.headerRules,
      ...rt.headerOverrideOpts(match),
      vars: rt.headerVars(),
      debug: rt.config.debug,
      onReject: rt.rejectSink(),
      modelMeta: rt.modelMetaFor(match),
    });
    rt.registeredPsNames = [match.piName];
    const model = findRegisteredModel(ctx, match.piName, current.model);
    if (model) {
      const ok = await pi.setModel(model as never);
      if (ok) {
        ctx.ui?.setStatus?.(
          "pi-switch",
          `${current.model} @ ${match.appType}/${match.displayName}`,
        );
      }
    }
  });
}
