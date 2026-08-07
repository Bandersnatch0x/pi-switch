#!/usr/bin/env bun
/**
 * TUI smoke: drives pi-switch's interactive slash commands through the Pi RPC
 * subprocess surface (the same harness pattern as smoke-probe-repair.mjs) and
 * asserts on state outcomes — not visual rendering.
 *
 * Flows: /ps-override (modelMeta write), /ps-config (3-level switch),
 *        /ps-info (effective config), /ps-doctor (diagnostics),
 *        /ps (quick switch).
 *
 * Fully isolated: temporary HOME, minimal cc-switch DB, faux OpenAI relay.
 * Real cc-switch data, credentials, and pi-switch.json stay untouched.
 *
 * Usage: bun run smoke:tui [--flow=override|switch|info|doctor|quickswitch]
 * Debug: KEEP_SMOKE_TEMP=1 retains the temp HOME.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assert,
  assertFileStatesUnchanged,
  resolveExecutable,
  sqlQuote,
  locatePiCli,
  buildTempEnv,
  captureFileStates,
  createRpcClient,
  formatError,
  mkdtemp,
  smokeStatePaths,
  startOpenAiRelay,
} from "./_smoke-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCENARIO = {
  appType: "codex",
  providerId: "tui-smoke-provider",
  providerName: "tui-smoke-relay",
  modelId: "gpt-5",
};

/** Codex provider settings pointing at the faux relay (same shape as smoke-probe-repair). */
function codexSettings(baseUrl, modelId) {
  const config = [
    'model_provider = "local"',
    `model = "${modelId}"`,
    "",
    "[model_providers.local]",
    'name = "local"',
    'wire_api = "chat"',
    "requires_openai_auth = true",
    `base_url = "${baseUrl}/v1"`,
    "",
  ].join("\n");
  return { auth: { OPENAI_API_KEY: "tui-smoke-key" }, config };
}

function createMinimalDb(sqlite3, dbPath, relayOrigin) {
  const settings = codexSettings(relayOrigin, SCENARIO.modelId);
  const sql = `
PRAGMA user_version = 16;
CREATE TABLE providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  website_url TEXT,
  notes TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  sort_index INTEGER NOT NULL DEFAULT 0,
  is_current INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, app_type)
);
INSERT INTO providers (
  id, app_type, name, settings_config, website_url, notes, meta, sort_index, is_current
) VALUES (
  ${sqlQuote(SCENARIO.providerId)},
  ${sqlQuote(SCENARIO.appType)},
  ${sqlQuote(SCENARIO.providerName)},
  ${sqlQuote(JSON.stringify(settings))},
  NULL,
  ${sqlQuote("isolated pi-switch tui smoke")},
  '{}',
  0,
  0
);
`;
  const result = spawnSync(sqlite3, [dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to create tui-smoke DB: ${result.stderr || result.stdout}`);
  }
}

function pickOption(options, needle) {
  return options.find((o) => typeof o === "string" && o.includes(needle));
}
function pickOptionStarts(options, prefix) {
  return options.find((o) => typeof o === "string" && o.startsWith(prefix));
}

/**
 * Best-effort recursive removal that tolerates transient Windows file-lock
 * errors (EBUSY/EPERM/ENOTEMPTY) left by a just-killed child process still
 * holding handles on the temp dir. Retries a few times before giving up so a
 * smoke run doesn't leak its HOME on Win; a stubborn dir is left for the user
 * (mirrors the KEEP_SMOKE_TEMP "retained" path) instead of throwing.
 */
async function removeSmokeTemp(target, { retries = 5, delayMs = 200 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = err?.code;
      const transient = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  const realHome = os.homedir();
  const configuredDb = process.env.CC_SWITCH_DB?.trim();
  const realDb = configuredDb
    ? path.resolve(configuredDb)
    : path.join(realHome, ".cc-switch", "cc-switch.db");
  const realState = captureFileStates(smokeStatePaths(realHome, realDb));
  const smokeLocale = process.env.PI_SWITCH_LOCALE?.trim().toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
  const isChinese = smokeLocale === "zh";
  const sqlite3 = resolveExecutable("sqlite3", "SQLITE3_PATH");
  const piCli = locatePiCli(ROOT);
  const extension = path.join(ROOT, "extensions", "index.ts");

  const requested = process.argv.find((arg) => arg.startsWith("--flow="))?.slice(7);
  const allFlows = ["override", "switch", "info", "doctor", "quickswitch"];
  const selected = requested ? [requested] : allFlows;
  assert(
    selected.every((f) => allFlows.includes(f)),
    `unknown flow; choose from ${allFlows.join(", ")}`,
  );

  const tempRoot = mkdtemp("tui");
  const tempHome = path.join(tempRoot, "home");
  const dbDir = path.join(tempHome, ".cc-switch");
  const agentDir = path.join(tempHome, ".pi", "agent");
  const dbPath = path.join(dbDir, "cc-switch.db");
  const tempConfig = path.join(agentDir, "pi-switch.json");
  const tempSettings = path.join(agentDir, "settings.json");
  const relay = await startOpenAiRelay();
  const relayOrigin = `http://127.0.0.1:${relay.port}`;
  let rpc;
  let success = false;
  let failure;
  const results = [];

  // Flow-routing state, mutated by the handler closures below.
  let currentFlow = "";
  let overrideStep = 0;
  const handlerLog = [];

  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    createMinimalDb(sqlite3, dbPath, relayOrigin);
    // Seed a pin (so /ps has an entry) and a provider modelMeta with maxTokens
    // so the model resolves as switchable offline (no models.dev reachable in
    // the temp HOME). Without a trusted maxTokens, register.ts skips the model
    // and /ps-config activation fails with "cannot register provider".
    fs.writeFileSync(
      tempConfig,
      `${JSON.stringify({
        pins: [{ dbId: SCENARIO.providerId, model: SCENARIO.modelId, label: `${SCENARIO.providerName} · ${SCENARIO.modelId}` }],
        providerOverrides: {
          [SCENARIO.appType]: {
            [SCENARIO.providerId]: {
              label: SCENARIO.providerName,
              modelMeta: { maxTokens: 8192, contextWindow: 128000, reasoning: false },
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      tempSettings,
      `${JSON.stringify({
        piSwitchSelection: {
          dbId: SCENARIO.providerId,
          model: SCENARIO.modelId,
          tab: SCENARIO.appType,
          appType: SCENARIO.appType,
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const env = { ...buildTempEnv(tempHome, sqlite3, dbPath), PI_SWITCH_LOCALE: smokeLocale };
    rpc = createRpcClient({
      piCli,
      extension,
      env,
      label: "tui-smoke",
      timeoutMs: Number.parseInt(process.env.SMOKE_RPC_TIMEOUT_MS ?? "", 10) || 180_000,
      handlers: {
        select(event) {
          const title = event.title ?? "";
          const options = event.options ?? [];
          if (currentFlow === "override") {
            const provider = pickOption(options, SCENARIO.providerName);
            if (provider) return provider;
            if (title === "reasoning") return pickOptionStarts(options, "true");
            if (overrideStep === 0) {
              const reasoning = pickOptionStarts(options, "reasoning ·");
              if (reasoning) {
                overrideStep += 1;
                return reasoning;
              }
            }
            if (overrideStep === 1) {
              const save =
                pickOptionStarts(options, "保存") ?? pickOptionStarts(options, "save");
              if (save) {
                overrideStep += 1;
                return save;
              }
            }
            if (handlerLog.length < 20) {
              handlerLog.push(`override: unhandled select "${title}"`);
            }
            return undefined;
          }
          if (currentFlow === "switch") {
            const model = pickOption(options, SCENARIO.modelId);
            if (model) return model;
            const provider = pickOption(options, SCENARIO.providerName);
            if (provider) return provider;
            const appType = pickOptionStarts(options, SCENARIO.appType);
            if (appType) return appType;
            if (handlerLog.length < 20) handlerLog.push(`switch: unhandled select "${title}"`);
            return undefined;
          }
          if (currentFlow === "quickswitch") {
            const entry = pickOption(options, SCENARIO.modelId) ?? options[0];
            if (entry) return entry;
            if (handlerLog.length < 20) {
              handlerLog.push(`quickswitch: unhandled select "${title}"`);
            }
            return undefined;
          }
          // info / doctor emit no interactive selects.
          if (handlerLog.length < 20) {
            handlerLog.push(`${currentFlow}: unexpected select "${title}"`);
          }
          return undefined;
        },
        confirm(event) {
          if (handlerLog.length < 20) {
            handlerLog.push(`${currentFlow}: unexpected confirm "${event.title ?? ""}"`);
          }
          return false;
        },
        input(event) {
          if (handlerLog.length < 20) {
            handlerLog.push(`${currentFlow}: unexpected input "${event.prompt ?? ""}"`);
          }
          return undefined;
        },
      },
    });

    // Verify the commands are registered before driving them.
    const commands = await rpc.send("get_commands");
    const registeredCommands = commands.data?.commands ?? [];
    const names = registeredCommands.map((c) => c.name);
    for (const required of ["ps-config", "ps", "ps-override", "ps-doctor", "ps-info"]) {
      assert(names.includes(required), `command /${required} not registered`);
      if (!isChinese) {
        const description = registeredCommands.find((command) => command.name === required)?.description ?? "";
        assert(
          !/[\u3400-\u9fff]/.test(description),
          `command /${required} has Chinese text in English locale: ${description}`,
        );
      }
    }

    const runFlow = async (name, command, assertFn) => {
      currentFlow = name;
      overrideStep = 0;
      const notifyStart = rpc.notifications.length;
      const errStart = rpc.extensionErrors.length;
      const resp = await rpc.send("prompt", { message: command });
      assert(resp.success === true, `${name}: RPC prompt failed: ${resp.error ?? "unknown"}`);
      const flowNotifies = rpc.notifications.slice(notifyStart);
      const flowErrors = rpc.extensionErrors.slice(errStart);
      await assertFn({ flowNotifies, flowErrors, resp });
      if (!isChinese) {
        const joined = flowNotifies.map((item) => item.message).join("\n");
        assert(
          !/[\u3400-\u9fff]/.test(joined),
          `${name}: Chinese notification in English locale: ${joined}`,
        );
      }
      console.log(`[PASS] ${name}`);
    };

    console.log("== pi-switch isolated tui smoke ==");
    if (selected.includes("override")) {
      await runFlow("override", "/ps-override", ({ flowErrors }) => {
        const written = JSON.parse(fs.readFileSync(tempConfig, "utf8"));
        const meta =
          written.providerOverrides?.[SCENARIO.appType]?.[SCENARIO.providerId]?.modelMeta ??
          written.providerOverrides?.[SCENARIO.providerId]?.modelMeta;
        assert(
          meta?.reasoning === true,
          `override: modelMeta.reasoning not written (got ${JSON.stringify(meta)})`,
        );
        assert(flowErrors.length === 0, `override: extension_error emitted (${flowErrors.length})`);
      });
      results.push("override");
    }

    if (selected.includes("switch")) {
      await runFlow("switch", "/ps-config", ({ flowNotifies, flowErrors }) => {
        const joined = flowNotifies.map((n) => n.message).join("\n");
        assert(
          !joined.includes(isChinese ? "切换失败" : "switch failed"),
          `switch: activation failed: ${joined}`,
        );
        assert(
          joined.includes(isChinese ? "已切换" : "switched"),
          `switch: did not activate (notify: ${joined})`,
        );
        // Plan: assert selection persisted to settings.json (not just the notify).
        const sel = JSON.parse(fs.readFileSync(tempSettings, "utf8"));
        const selection = sel.piSwitchSelection ?? sel.ccSwitchSelection;
        assert(
          selection?.model === SCENARIO.modelId && selection?.dbId === SCENARIO.providerId,
          `switch: selection not persisted (got ${JSON.stringify(selection)})`,
        );
        assert(flowErrors.length === 0, `switch: extension_error emitted (${flowErrors.length})`);
      });
      results.push("switch");
    }

    if (selected.includes("info")) {
      await runFlow("info", "/ps-info", ({ flowNotifies, flowErrors }) => {
        const joined = flowNotifies.map((n) => n.message).join("\n");
        // Content check: /ps-info renders "pi-switch effective config" (src/effective-config.ts).
        assert(joined.includes("pi-switch effective config"), "info: no effective-config report emitted");
        assert(flowErrors.length === 0, `info: extension_error emitted (${flowErrors.length})`);
      });
      results.push("info");
    }

    if (selected.includes("doctor")) {
      await runFlow("doctor", "/ps-doctor", ({ flowNotifies, flowErrors }) => {
        const joined = flowNotifies.map((n) => n.message).join("\n");
        // Content check: /ps-doctor renders "pi-switch doctor · pass=.." (src/doctor.ts).
        assert(joined.includes("pi-switch doctor"), "doctor: no diagnosis report emitted");
        assert(flowErrors.length === 0, `doctor: extension_error emitted (${flowErrors.length})`);
      });
      results.push("doctor");
    }

    if (selected.includes("quickswitch")) {
      await runFlow("quickswitch", "/ps", ({ flowNotifies, flowErrors }) => {
        const joined = flowNotifies.map((n) => n.message).join("\n");
        assert(
          !joined.includes(isChinese ? "切换失败" : "switch failed"),
          `quickswitch: activation failed: ${joined}`,
        );
        assert(
          joined.includes(isChinese ? "已切换" : "switched"),
          `quickswitch: did not activate (notify: ${joined})`,
        );
        // Plan: assert selection persisted to settings.json (not just the notify).
        const sel = JSON.parse(fs.readFileSync(tempSettings, "utf8"));
        const selection = sel.piSwitchSelection ?? sel.ccSwitchSelection;
        assert(
          selection?.model === SCENARIO.modelId && selection?.dbId === SCENARIO.providerId,
          `quickswitch: selection not persisted (got ${JSON.stringify(selection)})`,
        );
        assert(flowErrors.length === 0, `quickswitch: extension_error emitted (${flowErrors.length})`);
      });
      results.push("quickswitch");
    }

    // Any interactive step the harness couldn't route is a real gap — fail loudly
    // instead of letting a silently-cancelled flow still print [PASS].
    assert(
      handlerLog.length === 0,
      `unhandled interactive step(s) during smoke:\n  - ${handlerLog.join("\n  - ")}`,
    );
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    const errors = failure ? [failure] : [];
    try {
      await rpc?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await relay.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      assertFileStatesUnchanged(realState, "real state during TUI smoke");
    } catch (error) {
      errors.push(error);
    }
    if (handlerLog.length > 0) {
      errors.push(
        new Error(`unhandled interactive step(s):\n  - ${handlerLog.join("\n  - ")}`),
      );
    }
    if (rpc?.unexpected.length) {
      errors.push(new Error(`unexpected RPC UI request(s): ${JSON.stringify(rpc.unexpected)}`));
    }
    const rpcStderr = rpc?.stderr().trim();
    if (rpcStderr && errors.length > 0) {
      errors.push(new Error(`Pi RPC stderr:\n${rpcStderr}`));
    }
    if (success && errors.length === 0 && process.env.KEEP_SMOKE_TEMP !== "1") {
      try {
        await removeSmokeTemp(tempRoot);
      } catch (err) {
        console.error(
          `tui smoke temp NOT removed (cleanup failed after retries): ${tempRoot}\n  ${err?.code ?? err}`,
        );
        errors.push(err);
      }
    } else {
      console.error(`tui smoke temp retained: ${tempRoot}`);
    }
    if (errors.length === 1) failure = errors[0];
    if (errors.length > 1) failure = new AggregateError(errors, "TUI smoke failed");
  }
  if (failure) throw failure;
  console.log(
    `summary: ${results.length}/${selected.length} flows passed · real settings/config/DB unchanged`,
  );
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
