#!/usr/bin/env bun
/**
 * Isolated end-to-end smoke for every /ps-repair whitelist recipe.
 *
 * Each scenario gets a temporary HOME, minimal cc-switch DB, local faux relay,
 * and real Pi RPC subprocess. Expected repair plans are confirmed, the
 * post-repair Session Model switch is declined, and only temporary config may
 * change. Real cc-switch data, credentials, and pi-switch.json stay untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assert,
  assertFileStatesUnchanged,
  buildTempEnv,
  captureFileStates,
  createRpcClient,
  formatError,
  locatePiCli,
  mkdtemp,
  readJsonRequest,
  resolveExecutable,
  sendJsonError,
  sha256IfExists,
  smokeStatePaths,
  sqlQuote,
  startHttpRelay,
  writeSse,
} from "./_smoke-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createMinimalDb(sqlite3, dbPath, scenario, relayOrigin) {
  const settings = scenario.settings(relayOrigin);
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
  ${sqlQuote(scenario.providerId)},
  ${sqlQuote(scenario.appType)},
  ${sqlQuote(scenario.providerName)},
  ${sqlQuote(JSON.stringify(settings))},
  NULL,
  ${sqlQuote(`isolated pi-switch ${scenario.recipeId} smoke`)},
  '{}',
  0,
  0
);
`;
  const result = spawnSync(sqlite3, [dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`failed to create ${scenario.recipeId} DB: ${result.stderr || result.stdout}`);
  }
}

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
  return {
    auth: { OPENAI_API_KEY: "repair-smoke-key" },
    config,
  };
}

function geminiSettings(baseUrl, modelId) {
  return {
    env: {
      GOOGLE_GEMINI_BASE_URL: baseUrl,
      GEMINI_API_KEY: "repair-smoke-key",
      GEMINI_MODEL: modelId,
    },
  };
}

function sendOpenAiStream(res, body, kind) {
  const id = `chatcmpl-repair-smoke-${kind}`;
  const base = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": `repair-smoke-${kind}`,
  });

  if (kind === "tool") {
    writeSse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_repair_smoke",
                type: "function",
                function: {
                  name: "probe_echo",
                  arguments: JSON.stringify({ msg: "probe_ok" }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    writeSse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "probe_ok" },
          finish_reason: null,
        },
      ],
    });
    writeSse(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }

  writeSse(res, {
    ...base,
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  res.end("data: [DONE]\n\n");
}

function sendGeminiStream(res, kind, args) {
  const parts =
    kind === "basic"
      ? [{ text: "probe_ok" }]
      : [
          {
            functionCall: {
              id: "call_repair_smoke",
              name: "probe_echo",
              args,
            },
          },
        ];
  const payload = {
    responseId: `gemini-repair-smoke-${kind}`,
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
    },
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-request-id": `gemini-repair-smoke-${kind}`,
  });
  res.end(`data: ${JSON.stringify(payload)}\n\n`);
}

function createReasoningRelayHandler(requests) {
  return (req, res) => {
    readJsonRequest(req, res, (body) => {
      const effort = body.reasoning_effort;
      const activeReasoning =
        typeof effort === "string" &&
        !["off", "none", "disabled"].includes(effort.toLowerCase());
      const kind = activeReasoning
        ? "reasoning"
        : Array.isArray(body.tools) && body.tools.length > 0
          ? "tool"
          : "basic";
      requests.push({ method: req.method, path: req.url, kind, reasoningEffort: effort });
      if (kind === "reasoning") {
        sendJsonError(res, 400, "reasoning parameter not supported", {
          param: "reasoning_effort",
          code: "unsupported_parameter",
        });
        return;
      }
      sendOpenAiStream(res, body, kind);
    });
  };
}

function createFingerprintRelayHandler(requests) {
  return (req, res) => {
    readJsonRequest(req, res, (body) => {
      const originator = String(req.headers.originator ?? "");
      const userAgent = String(req.headers["user-agent"] ?? "");
      const hasCodexFingerprint =
        originator.toLowerCase() === "codex_cli_rs" &&
        userAgent.toLowerCase().startsWith("codex_cli_rs/");
      if (!hasCodexFingerprint) {
        requests.push({ method: req.method, path: req.url, kind: "gate" });
        sendJsonError(res, 403, "codex_cli_rs required by client fingerprint gate", {
          code: "client_fingerprint_required",
        });
        return;
      }
      const kind = Array.isArray(body.tools) && body.tools.length > 0 ? "tool" : "basic";
      requests.push({
        method: req.method,
        path: req.url,
        kind,
        originator,
        userAgentPrefix: userAgent.slice(0, 24),
      });
      sendOpenAiStream(res, body, kind);
    });
  };
}

function geminiPayloadParts(body) {
  const config = body.config && typeof body.config === "object" ? body.config : body;
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const declaration = tools[0]?.functionDeclarations?.[0];
  const toolConfig = config.toolConfig;
  const mode = toolConfig?.functionCallingConfig?.mode;
  return { tools, declaration, mode };
}

function createGeminiRelayHandler(requests) {
  return (req, res) => {
    readJsonRequest(req, res, (body) => {
      const { tools, declaration, mode } = geminiPayloadParts(body);
      if (tools.length === 0) {
        requests.push({ method: req.method, path: req.url, kind: "basic" });
        sendGeminiStream(res, "basic", undefined);
        return;
      }
      const hasCompat =
        String(mode ?? "").toUpperCase() === "AUTO" &&
        declaration &&
        "parameters" in declaration &&
        !("parametersJsonSchema" in declaration);
      const kind = hasCompat ? "tool-compat" : "tool-empty";
      requests.push({
        method: req.method,
        path: req.url,
        kind,
        mode,
        schemaField: declaration
          ? "parameters" in declaration
            ? "parameters"
            : "parametersJsonSchema" in declaration
              ? "parametersJsonSchema"
              : "missing"
          : "missing",
      });
      sendGeminiStream(res, kind, hasCompat ? { msg: "probe_ok" } : {});
    });
  };
}

function startRelay(scenario) {
  let handler;
  return startHttpRelay((req, res, requests) => {
    if (process.env.SMOKE_DEBUG === "1") {
      console.error(`[repair-smoke] relay ${req.method ?? "unknown"} ${req.url ?? "unknown"}`);
    }
    if (req.method !== "POST") {
      requests.push({ method: req.method, path: req.url, kind: "unexpected-route" });
      sendJsonError(res, 405, `method not allowed: ${req.method ?? "unknown"}`);
      return;
    }
    const url = new URL(req.url ?? "/", "http://smoke.invalid");
    const expectedPath =
      scenario.appType === "gemini"
        ? url.pathname ===
            `/v1beta/models/${encodeURIComponent(scenario.modelId)}:streamGenerateContent` &&
          url.searchParams.get("alt") === "sse"
        : url.pathname === "/v1/chat/completions";
    if (!expectedPath) {
      requests.push({ method: req.method, path: req.url, kind: "unexpected-route" });
      sendJsonError(res, 404, `unexpected relay path: ${req.url ?? "unknown"}`);
      return;
    }
    handler ??= scenario.createHandler(requests);
    handler(req, res);
  });
}

function createScenarioHandlers(scenario, choices, confirmations) {
  return {
    select(event) {
      if (process.env.SMOKE_DEBUG === "1") {
        console.error(
          `[repair-smoke] select ${JSON.stringify(event.title)} options=${JSON.stringify(event.options)}`,
        );
      }
      const options = event.options ?? [];
      let value;
      if (["选择类型", "select type"].includes(event.title)) {
        value = options.find((option) =>
          new RegExp(`^${scenario.appType}\\b`, "i").test(option),
        );
      } else if (/^(选择名称|select name)/i.test(event.title ?? "")) {
        value = options.find((option) => option.trim() === scenario.providerName);
      } else if (/^(选择模型|select model)/i.test(event.title ?? "")) {
        value = options.find((option) => option.includes(scenario.modelId));
      }
      if (!value) {
        choices.push({ title: event.title, error: "expected option missing", options });
        return undefined;
      }
      choices.push({ title: event.title, value });
      return value;
    },
    confirm(event) {
      if (process.env.SMOKE_DEBUG === "1") {
        console.error(`[repair-smoke] confirm ${JSON.stringify(event.title)}`);
      }
      if (event.title === "确认执行修复？") {
        const confirmed = scenario.planFragments.every((fragment) =>
          event.message?.includes(fragment),
        );
        confirmations.push({ title: event.title, message: event.message, confirmed });
        return confirmed;
      }
      if (event.title === "切换到已修复目标？") {
        confirmations.push({ title: event.title, message: event.message, confirmed: false });
        return false;
      }
      confirmations.push({ title: event.title, message: event.message, confirmed: false });
      return false;
    },
  };
}

function countKinds(requests) {
  return requests.reduce((out, request) => {
    out[request.kind] = (out[request.kind] ?? 0) + 1;
    return out;
  }, {});
}

const scenarios = [
  {
    recipeId: "reasoning-false",
    appType: "codex",
    providerId: "repair-smoke-reasoning",
    providerName: "probe-repair-reasoning",
    modelId: "gpt-5.6-reasoning-smoke",
    settings: (origin) => codexSettings(origin, "gpt-5.6-reasoning-smoke"),
    initialOverride: {
      label: "Reasoning Repair Smoke",
      modelOverrides: {
        "gpt-5.6-reasoning-smoke": { reasoning: true, maxTokens: 8192 },
      },
    },
    createHandler: createReasoningRelayHandler,
    planFragments: ["reasoning-false", "gpt-5.6-reasoning-smoke", "reasoning=false"],
    assertWritten(written) {
      return (
        written.providerOverrides?.codex?.[this.providerId]?.modelOverrides?.[this.modelId]
          ?.reasoning === false
      );
    },
    assertCounts(counts) {
      assert(counts.reasoning === 1, `expected reasoning=1, got ${counts.reasoning ?? 0}`);
      assert(counts.basic === 3, `expected basic=3, got ${counts.basic ?? 0}`);
      assert(counts.tool === 2, `expected tool=2, got ${counts.tool ?? 0}`);
    },
  },
  {
    recipeId: "client-fingerprint",
    appType: "codex",
    providerId: "repair-smoke-fingerprint",
    providerName: "probe-repair-fingerprint",
    modelId: "gpt-5.6-fingerprint-smoke",
    settings: (origin) => codexSettings(origin, "gpt-5.6-fingerprint-smoke"),
    initialOverride: {
      label: "Fingerprint Repair Smoke",
      fingerprint: "none",
      modelOverrides: {
        "gpt-5.6-fingerprint-smoke": { reasoning: false, maxTokens: 8192 },
      },
    },
    createHandler: createFingerprintRelayHandler,
    planFragments: ["client-fingerprint", "fingerprint=\"codex\""],
    assertWritten(written) {
      return written.providerOverrides?.codex?.[this.providerId]?.fingerprint === "codex";
    },
    assertCounts(counts) {
      assert(counts.gate === 1, `expected gate=1, got ${counts.gate ?? 0}`);
      assert(counts.basic === 2, `expected basic=2, got ${counts.basic ?? 0}`);
      assert(counts.tool === 2, `expected tool=2, got ${counts.tool ?? 0}`);
    },
  },
  {
    recipeId: "gemini-tool-compat",
    appType: "gemini",
    providerId: "repair-smoke-gemini-tool",
    providerName: "probe-repair-gemini-tool",
    modelId: "gemini-2.5-pro-repair-smoke",
    settings: (origin) => geminiSettings(origin, "gemini-2.5-pro-repair-smoke"),
    initialOverride: {
      label: "Gemini Tool Repair Smoke",
      geminiToolCompat: false,
      modelOverrides: {
        "gemini-2.5-pro-repair-smoke": { reasoning: false, maxTokens: 8192 },
      },
    },
    createHandler: createGeminiRelayHandler,
    planFragments: ["gemini-tool-compat", "geminiToolCompat=true"],
    assertWritten(written) {
      return written.providerOverrides?.gemini?.[this.providerId]?.geminiToolCompat === true;
    },
    assertCounts(counts) {
      assert(counts.basic === 3, `expected basic=3, got ${counts.basic ?? 0}`);
      assert(counts["tool-empty"] === 1, `expected tool-empty=1, got ${counts["tool-empty"] ?? 0}`);
      assert(counts["tool-compat"] === 2, `expected tool-compat=2, got ${counts["tool-compat"] ?? 0}`);
    },
  },
];

async function runScenario({ scenario, sqlite3, piCli, extension, realState }) {
  const tempRoot = mkdtemp(scenario.recipeId);
  const tempHome = path.join(tempRoot, "home");
  const dbDir = path.join(tempHome, ".cc-switch");
  const agentDir = path.join(tempHome, ".pi", "agent");
  const dbPath = path.join(dbDir, "cc-switch.db");
  const tempConfig = path.join(agentDir, "pi-switch.json");
  const relay = await startRelay(scenario);
  let rpc;
  let success = false;
  let result;
  let failure;
  const choices = [];
  const confirmations = [];

  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const relayOrigin = `http://127.0.0.1:${relay.port}`;
    createMinimalDb(sqlite3, dbPath, scenario, relayOrigin);
    fs.writeFileSync(
      tempConfig,
      `${JSON.stringify(
        {
          providerOverrides: {
            [scenario.appType]: {
              [scenario.providerId]: scenario.initialOverride,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const tempConfigBefore = sha256IfExists(tempConfig);
    const env = buildTempEnv(tempHome, sqlite3, dbPath);
    rpc = createRpcClient({
      piCli,
      extension,
      env,
      cwd: ROOT,
      label: scenario.recipeId,
      handlers: createScenarioHandlers(scenario, choices, confirmations),
    });

    const commands = await rpc.send("get_commands");
    const commandNames = (commands.data?.commands ?? []).map((command) => command.name);
    assert(commandNames.includes("ps-repair"), "ps-repair command was not registered");

    const response = await rpc.send("prompt", { message: "/ps-repair" });
    assert(response.success === true, `ps-repair RPC failed: ${response.error ?? "unknown"}`);
    const entriesResponse = await rpc.send("get_entries");
    assert(entriesResponse.success === true, "failed to read RPC session entries");

    const written = JSON.parse(fs.readFileSync(tempConfig, "utf8"));
    const tempConfigAfter = sha256IfExists(tempConfig);
    const detailEntries = (entriesResponse.data?.entries ?? []).filter(
      (entry) => entry.customType === "ps-repair-case-detail",
    );
    const detail = detailEntries.at(-1)?.data;
    const counts = countKinds(relay.requests);
    const planConfirm = confirmations.find((item) => item.title === "确认执行修复？");
    const switchConfirm = confirmations.find(
      (item) => item.title === "切换到已修复目标？",
    );
    const diagnostics = JSON.stringify({
      choices,
      confirmations,
      unexpected: rpc.unexpected,
      notifications: rpc.notifications.slice(-5),
      requests: relay.requests,
      repair: detail?.repair,
    });

    assert(
      planConfirm?.confirmed === true,
      `${scenario.recipeId}: expected plan was not confirmed: ${diagnostics}`,
    );
    assert(switchConfirm?.confirmed === false, `${scenario.recipeId}: session switch was not declined`);
    assert(scenario.assertWritten(written), `${scenario.recipeId}: expected config patch missing`);
    assert(tempConfigBefore !== tempConfigAfter, `${scenario.recipeId}: temp config hash unchanged`);
    scenario.assertCounts(counts);
    assert(detail?.repair?.status === "committed", `${scenario.recipeId}: Repair Case not committed`);
    assert(detail?.repair?.persisted === true, `${scenario.recipeId}: persisted flag not true`);
    assert(rpc.extensionErrors.length === 0, `${scenario.recipeId}: extension_error emitted`);
    assert(
      rpc.unexpected.length === 0,
      `${scenario.recipeId}: unexpected UI request: ${JSON.stringify(rpc.unexpected)}`,
    );
    assert(
      choices.every((choice) => !choice.error),
      `${scenario.recipeId}: expected picker option missing`,
    );

    success = true;
    result = {
      recipeId: scenario.recipeId,
      target: `${scenario.appType}/${scenario.providerName}/${scenario.modelId}`,
      counts,
      repair: detail.repair,
      notifications: rpc.notifications,
      requestDetails: relay.requests,
    };
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
      assertFileStatesUnchanged(realState, `${scenario.recipeId}: real state`);
    } catch (error) {
      errors.push(error);
    }
    if (success && errors.length === 0 && process.env.KEEP_SMOKE_TEMP !== "1") {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (!success || errors.length > 0 || process.env.KEEP_SMOKE_TEMP === "1") {
      console.error(`${scenario.recipeId} smoke temp retained: ${tempRoot}`);
    }
    if (errors.length === 1) failure = errors[0];
    if (errors.length > 1) {
      failure = new AggregateError(errors, `${scenario.recipeId} smoke failed`);
    }
  }
  if (failure) throw failure;
  return result;
}

async function main() {
  const realHome = os.homedir();
  const configuredDb = process.env.CC_SWITCH_DB?.trim();
  const realDb = configuredDb
    ? path.resolve(configuredDb)
    : path.join(realHome, ".cc-switch", "cc-switch.db");
  const realState = captureFileStates(smokeStatePaths(realHome, realDb));
  const sqlite3 = resolveExecutable("sqlite3", "SQLITE3_PATH");
  const piCli = locatePiCli(ROOT);
  const extension = path.join(ROOT, "extensions", "index.ts");
  const requested = process.argv.find((arg) => arg.startsWith("--recipe="))?.slice(9);
  const selected = requested ? scenarios.filter((scenario) => scenario.recipeId === requested) : scenarios;
  assert(selected.length > 0, `unknown recipe: ${requested}`);

  console.log("== pi-switch isolated repair smoke ==");
  const results = [];
  for (const scenario of selected) {
    const result = await runScenario({
      scenario,
      sqlite3,
      piCli,
      extension,
      realState,
    });
    results.push(result);
    console.log(
      `[PASS] ${result.recipeId} · ${result.target} · requests=${JSON.stringify(result.counts)}`,
    );
  }
  assertFileStatesUnchanged(realState, "real state after smoke suite");
  console.log(`summary: ${results.length}/${selected.length} recipes committed in isolated temp state`);
  console.log("candidate verification: 2 consecutive passes per recipe");
  console.log("session switches: declined");
  console.log("real settings/config/DB state: unchanged");
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
