#!/usr/bin/env bun
/**
 * Real end-to-end check for the models.json provider mirror (ADR 0006).
 *
 * What it proves, with a real Pi process and a real pi-subagents detached
 * runner (no stubs):
 *
 *   1. A `/ps-config` switch writes the mirrored provider into the temp HOME's
 *      `models.json` (+ ownership sidecar).
 *   2. A **detached** (`--bg`) subagent whose model is that cc-switch provider
 *      actually starts and completes: the child's own ModelRuntime resolves the
 *      provider out of `models.json`, the request reaches the faux relay (whose
 *      base URL only exists in the mirrored entry), and pi-subagents records the
 *      resolved `provider/model` in the run status.
 *   3. Negative control: removing that entry from `models.json` makes the very
 *      same run fail without ever reaching the relay (the silent-death
 *      signature: workflow run stuck `running`, no child step). So `models.json`
 *      — not the parent process registry — is what makes the child work.
 *   4. Recovery: switching again rebuilds the mirror and the same run succeeds.
 *
 * Ambient extensions are disabled for children (`subagents.defaultExtensions: []`)
 * so resolution cannot fall back to loading pi-switch inside the child.
 *
 * Isolation: temporary HOME + temporary cc-switch DB + local faux relay. The
 * real HOME's settings/config/models.json/sidecar are snapshotted and verified
 * unchanged (the live cc-switch DB is excluded: the CC Switch desktop app writes
 * it concurrently, and pi-switch only ever reads it).
 *
 * Requirements: `pi`, `sqlite3`, `node`, and pi-subagents installed under
 * `~/.pi/agent/npm/node_modules/pi-subagents` (the runner is spawned through
 * Node: Bun 1.3.11 panics in pi-subagents' detached runner).
 *
 * Usage: bun run smoke:subagent-mirror [--keep]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assert,
  assertFileStatesUnchanged,
  buildTempEnv,
  captureFileStates,
  createRpcClient,
  locatePiCli,
  mkdtemp,
  resolveExecutable,
  smokeStatePaths,
  sqlQuote,
  startOpenAiRelay,
} from "./_smoke-harness.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Inner extension module: the package's index.js wrapper breaks Pi's loader. */
const PI_SUBAGENTS_EXTENSION = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "pi-subagents",
  "src",
  "extension",
  "index.js",
);

const SCENARIO = {
  appType: "codex",
  providerId: "e2e-mirror-provider",
  providerName: "e2e-mirror-relay",
  modelId: "gpt-5",
};

const task = "Reply with exactly PROBE-OK. Do not use any tools.";

function codexSettings(baseUrl, modelId) {
  return {
    auth: { OPENAI_API_KEY: "e2e-mirror-key" },
    config: [
      'model_provider = "local"',
      `model = "${modelId}"`,
      "",
      "[model_providers.local]",
      'name = "local"',
      'wire_api = "chat"',
      "requires_openai_auth = true",
      `base_url = "${baseUrl}/v1"`,
      "",
    ].join("\n"),
  };
}

function createMinimalDb(sqlite3, dbPath, relayOrigin) {
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
  ${sqlQuote(JSON.stringify(codexSettings(relayOrigin, SCENARIO.modelId)))},
  NULL,
  ${sqlQuote("isolated pi-switch mirror e2e")},
  '{}',
  0,
  0
);
`;
  const result = spawnSync(sqlite3, [dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to create e2e DB: ${result.stderr || result.stdout}`);
  }
}

function pickOption(options, needle) {
  return options.find((option) => typeof option === "string" && option.includes(needle));
}
function pickOptionStarts(options, prefix) {
  return options.find((option) => typeof option === "string" && option.startsWith(prefix));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Async run dirs pi-subagents creates under the OS temp dir (not under HOME). */
function asyncRunRoots() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith("pi-subagents-"))
    .map((entry) => path.join(os.tmpdir(), entry, "async-subagent-runs"))
    .filter((dir) => fs.existsSync(dir));
}

function readRunStatus(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Wait for the run directory of the dispatch that started at/after `since`.
 * `status.json.startedAt` is the runner's own clock, so this identifies the run
 * without racing on file mtimes (pi-subagents rewrites old run artifacts during
 * later reconciliation).
 */
async function waitForRunDir(since, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let best;
    for (const root of asyncRunRoots()) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        const status = readRunStatus(dir);
        if (!status || typeof status.startedAt !== "number") continue;
        if (status.startedAt < since) continue;
        if (!best || status.startedAt > best.startedAt) {
          best = { dir, id: entry, status, startedAt: status.startedAt };
        }
      }
    }
    if (best) return best;
    await sleep(300);
  }
  throw new Error(`no async run started within ${timeoutMs}ms`);
}

/**
 * Wait for a terminal run status. `acceptChildless` covers the silent-death
 * signature: the workflow run stays "running" forever because its child died
 * before starting (exactly what an unresolvable provider produces).
 */
async function waitForTerminal(runDir, { timeoutMs = 120_000, acceptChildless = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readRunStatus(runDir);
    if (status) {
      if (status.state === "complete" || status.state === "failed") return status;
      if (acceptChildless && (status.steps ?? []).length === 0) return status;
    }
    await sleep(500);
  }
  return readRunStatus(runDir);
}

async function main() {
  const keep = process.argv.includes("--keep");
  const realHome = os.homedir();
  const configuredDb = process.env.CC_SWITCH_DB?.trim();
  const realDb = configuredDb ? path.resolve(configuredDb) : path.join(realHome, ".cc-switch", "cc-switch.db");
  // The CC Switch desktop app writes its own DB while it runs, so the real DB is
  // excluded from the unchanged-state check (pi-switch only ever reads it).
  const realState = captureFileStates(
    smokeStatePaths(realHome, realDb).filter((file) => file !== realDb && !file.startsWith(realDb)),
  );

  assert(
    fs.existsSync(PI_SUBAGENTS_EXTENSION),
    `pi-subagents not installed at ${PI_SUBAGENTS_EXTENSION}`,
  );

  const sqlite3 = resolveExecutable("sqlite3", "SQLITE3_PATH");
  const piCli = locatePiCli(ROOT);
  const nodeExec = resolveExecutable("node", "PI_NODE_PATH");
  const extension = path.join(ROOT, "extensions", "index.ts");

  const tempRoot = mkdtemp("mirror-e2e");
  const tempHome = path.join(tempRoot, "home");
  const agentDir = path.join(tempHome, ".pi", "agent");
  const dbDir = path.join(tempHome, ".cc-switch");
  const dbPath = path.join(dbDir, "cc-switch.db");
  const modelsPath = path.join(agentDir, "models.json");
  const sidecarPath = path.join(agentDir, "pi-switch-persisted-providers.json");

  const relay = await startOpenAiRelay();
  const relayOrigin = `http://127.0.0.1:${relay.port}`;

  let rpc;
  let failure;
  const log = (message) => console.log(message);

  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    createMinimalDb(sqlite3, dbPath, relayOrigin);

    // maxTokens authority so registration is not skipped (#63), and no ambient
    // extensions in children so only models.json can supply the provider.
    fs.writeFileSync(
      path.join(agentDir, "pi-switch.json"),
      `${JSON.stringify(
        {
          providerOverrides: {
            [SCENARIO.appType]: {
              [SCENARIO.providerId]: {
                modelMeta: { maxTokens: 8192, contextWindow: 128000, reasoning: false },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    // Children get NO ambient extensions (`defaultExtensions: []`), so only
    // `models.json` can supply the provider — exactly what the mirror is for.
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ subagents: { defaultExtensions: [] } }, null, 2)}\n`,
    );

    const env = { ...buildTempEnv(tempHome, sqlite3, dbPath), PI_SWITCH_LOCALE: "en" };
    let switchStep = 0;
    rpc = createRpcClient({
      piCli,
      extension,
      extraExtensions: [PI_SUBAGENTS_EXTENSION],
      piExecPath: nodeExec,
      env,
      label: "mirror-e2e",
      timeoutMs: 180_000,
      handlers: {
        select(event) {
          const options = event.options ?? [];
          const model = pickOption(options, SCENARIO.modelId);
          if (model) return model;
          const provider = pickOption(options, SCENARIO.providerName);
          if (provider) return provider;
          const appType = pickOptionStarts(options, SCENARIO.appType);
          if (appType) return appType;
          if (switchStep === 0) {
            switchStep = 1;
            return options[0];
          }
          return undefined;
        },
        confirm() {
          return false;
        },
        input() {
          return undefined;
        },
      },
    });

    const commands = (await rpc.send("get_commands")).data?.commands ?? [];
    const names = commands.map((command) => command.name);
    for (const required of ["ps-config", "run"]) {
      assert(names.includes(required), `command /${required} not registered (have: ${names.join(", ")})`);
    }

    // ---- 1. switch → mirror -------------------------------------------------
    log("[1] /ps-config → mirror");
    await rpc.send("prompt", { message: "/ps-config" });
    assert(fs.existsSync(modelsPath), "models.json was not written by the switch");
    const mirrored = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    const entry = mirrored.providers?.[SCENARIO.providerName];
    assert(entry, `mirrored provider missing (got ${JSON.stringify(Object.keys(mirrored.providers ?? {}))})`);
    assert(
      entry.baseUrl === `${relayOrigin}/v1`,
      `mirrored baseUrl wrong: ${entry.baseUrl}`,
    );
    assert(entry.models?.[0]?.id === SCENARIO.modelId, `mirrored model missing: ${JSON.stringify(entry.models)}`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    assert(sidecar.owned?.[SCENARIO.providerName], "ownership record missing for the mirrored provider");
    log(`    mirror ok: ${SCENARIO.providerName} → ${entry.baseUrl} (model ${entry.models[0].id})`);

    const runModel = `${SCENARIO.providerName}/${SCENARIO.modelId}`;

    /**
     * Dispatch one detached subagent and follow the exact run it created.
     * `waitForRunDir` identifies it by the runner's own `startedAt`, then the
     * result is read by that run id (pi-subagents rewrites older result files
     * during reconciliation, so mtime ordering is not trustworthy).
     */
    const dispatchRun = async () => {
      const since = Date.now();
      const before = relay.requests.length;
      const resp = await rpc.send("prompt", {
        message: `/run delegate[model=${runModel}] ${task} --bg`,
      });
      assert(resp.success === true, `RPC prompt failed: ${resp.error ?? "unknown"}`);
      const run = await waitForRunDir(since);
      return { run, relayBefore: before };
    };

    // ---- 2. detached child resolves the mirrored provider -------------------
    log("[2] detached subagent on the mirrored provider");
    const positiveRun = await dispatchRun();
    const positive = await waitForTerminal(positiveRun.run.dir);
    const positiveRelayDelta = relay.requests.length - positiveRun.relayBefore;
    const positiveText = JSON.stringify(positive);
    const positiveChild = positive.results?.[0] ?? positive.workflow?.value?.results?.[0];
    log(
      `    run ${positiveRun.run.id} · state=${positive.state} · child model=${positiveChild?.model ?? "?"} · relay hits=${positiveRelayDelta}`,
    );
    assert(positive.state === "complete", `positive run did not complete: ${positiveText.slice(0, 400)}`);
    assert(
      positiveChild?.model === runModel,
      `child did not record the mirrored provider model (got ${positiveChild?.model ?? "none"})`,
    );
    assert(positiveRelayDelta > 0, "positive run never reached the relay (provider was not resolved)");
    assert(
      positiveText.includes("smoke-ok"),
      `child output did not come from the relay: ${positiveText.slice(0, 400)}`,
    );
    log("    child output: smoke-ok (relay text echoed through the mirrored provider)");

    // ---- 3. negative control: no mirror ⇒ no resolution ---------------------
    log("[3] negative control: mirror entry removed");
    fs.writeFileSync(modelsPath, `${JSON.stringify({ providers: {} }, null, 2)}\n`);
    const negativeRun = await dispatchRun();
    const negative = await waitForTerminal(negativeRun.run.dir, {
      timeoutMs: 45_000,
      acceptChildless: true,
    });
    const negativeRelayDelta = relay.requests.length - negativeRun.relayBefore;
    const negativeText = JSON.stringify(negative);
    const negativeChild = negative?.results?.[0] ?? negative?.workflow?.value?.results?.[0];
    log(
      `    run ${negativeRun.run.id} · state=${negative?.state ?? "unknown"} · steps=${(negative?.steps ?? []).length} · child model=${negativeChild?.model ?? "none"} · relay hits=${negativeRelayDelta}`,
    );
    assert(negativeRelayDelta === 0, "negative control still reached the relay");
    assert(
      negative?.state !== "complete",
      `negative control completed without a mirror entry: ${negativeText.slice(0, 300)}`,
    );
    assert(!negativeText.includes("smoke-ok"), "negative control produced relay output");
    assert(
      !negativeChild?.model,
      `negative control resolved a model anyway: ${negativeChild?.model}`,
    );

    // ---- 4. recovery: the same run works again once the mirror is back ------
    log("[4] recovery: switch again, mirror restored");
    switchStep = 0;
    await rpc.send("prompt", { message: "/ps-config" });
    const restored = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    assert(restored.providers?.[SCENARIO.providerName], "mirror was not restored by the second switch");
    const recoveredRun = await dispatchRun();
    const recovered = await waitForTerminal(recoveredRun.run.dir);
    const recoveredRelayDelta = relay.requests.length - recoveredRun.relayBefore;
    log(
      `    run ${recoveredRun.run.id} · state=${recovered.state} · relay hits=${recoveredRelayDelta}`,
    );
    assert(recovered.state === "complete", `recovery run failed: ${JSON.stringify(recovered).slice(0, 300)}`);
    assert(recoveredRelayDelta > 0, "recovery run never reached the relay");

    assertFileStatesUnchanged(realState, "real state during mirror e2e");
    log("");
    log("PASS: detached subagent resolved the cc-switch provider from models.json");
    log("      and failed without it (negative control) — real HOME untouched");
  } catch (error) {
    failure = error;
  } finally {
    try {
      await rpc?.close();
    } catch {
      // best effort
    }
    try {
      await relay.close();
    } catch {
      // best effort
    }
    if (keep || failure) {
      console.log(`e2e temp retained: ${tempRoot}`);
    } else {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        console.log(`e2e temp retained (locked): ${tempRoot}`);
      }
    }
  }

  if (failure) {
    if (rpc) {
      try {
        const tail = rpc.stderr().split(/\r?\n/).slice(-30).join("\n");
        if (tail.trim()) console.error(`--- pi stderr (tail) ---\n${tail}`);
        if (rpc.extensionErrors.length) {
          console.error(`--- extension errors ---\n${JSON.stringify(rpc.extensionErrors.slice(-4), null, 2)}`);
        }
        const notes = rpc.notifications.slice(-6).map((note) => note.message ?? JSON.stringify(note));
        if (notes.length) console.error(`--- last notifications ---\n${notes.join("\n---\n")}`);
      } catch {
        // diagnostics only
      }
    }
    console.error("mirror e2e failed:", failure.message ?? failure);
    process.exit(1);
  }
}

await main();
