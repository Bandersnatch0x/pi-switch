/**
 * Shared smoke harness for pi-switch subprocess tests.
 *
 * Generic primitives extracted from scripts/smoke-probe-repair.mjs so new
 * smoke scripts can drive the Pi CLI in RPC mode without duplicating the
 * JSON-RPC plumbing, temp-HOME env, or the faux OpenAI relay.
 *
 * Not a standalone script (underscore prefix); import from a smoke runner.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

export function sha256IfExists(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function smokeStatePaths(home, dbPath) {
  const agentDir = path.join(home, ".pi", "agent");
  return [
    path.join(agentDir, "settings.json"),
    path.join(agentDir, "pi-switch.json"),
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
  ];
}

export function captureFileStates(paths) {
  return new Map(paths.map((file) => [file, sha256IfExists(file)]));
}

export function assertFileStatesUnchanged(snapshot, label = "smoke state") {
  const changed = [];
  for (const [file, before] of snapshot) {
    if (sha256IfExists(file) !== before) changed.push(file);
  }
  assert(changed.length === 0, `${label} changed:\n  - ${changed.join("\n  - ")}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

export function formatError(error, indent = "") {
  const label = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const current =
    error instanceof Error && error.stack
      ? error.message && !error.stack.includes(error.message)
        ? `${label}\n${error.stack}`
        : error.stack
      : label;
  if (!(error instanceof AggregateError)) return `${indent}${current}`;
  const nested = [...error.errors]
    .map((item) => formatError(item, `${indent}  `))
    .join("\n");
  return `${indent}${current}\n${nested}`;
}

export function resolveExecutable(name, envName) {
  const explicit = process.env[envName];
  if (explicit && fs.existsSync(explicit)) return explicit;
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [name], { encoding: "utf8" });
  const lines = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length || result.status !== 0) {
    throw new Error(`${name} not found (set ${envName})`);
  }
  // On Windows, `where` may match .bat/.cmd/.dll entries; prefer a real .exe.
  const pick =
    process.platform === "win32"
      ? (lines.find((p) => /\.exe$/i.test(p)) ?? lines[0])
      : lines[0];
  return pick;
}

export function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Locate the local Pi CLI shipped under node_modules. */
export function locatePiCli(root) {
  const piCli = path.join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  assert(fs.existsSync(piCli), `local Pi CLI not found: ${piCli}`);
  return piCli;
}

/**
 * Build an isolated-HOME env for a Pi RPC subprocess. Mirrors the isolation
 * smoke-probe-repair uses so the real cc-switch DB / pi-switch.json are
 * never touched.
 */
export function buildTempEnv(
  tempHome,
  sqlite3,
  dbPath = path.join(tempHome, ".cc-switch", "cc-switch.db"),
) {
  const agentDir = path.join(tempHome, ".pi", "agent");
  const root = path.parse(tempHome).root;
  return {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    HOMEDRIVE: root.replace(/[\\/]$/, ""),
    HOMEPATH: tempHome.slice(root.length - 1),
    LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
    APPDATA: path.join(tempHome, "AppData", "Roaming"),
    PI_CODING_AGENT_DIR: agentDir,
    SQLITE3_PATH: sqlite3,
    CC_SWITCH_DB: dbPath,
  };
}

/**
 * Spawn a Pi RPC subprocess and expose send() + UI-request routing.
 *
 * handlers route extension_ui_request events back to the caller:
 *   select(event)  -> chosen option string, or undefined to cancel
 *   confirm(event) -> boolean
 *   input(event)   -> string, or undefined to cancel
 *   onNotify(message, type) -> void
 */
export function createRpcClient({
  piCli,
  extension,
  env,
  label,
  handlers = {},
  timeoutMs = 180_000,
  cwd,
}) {
  const child = spawn(
    process.execPath,
    [
      piCli,
      "--mode",
      "rpc",
      "--no-session",
      "--approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--extension",
      extension,
    ],
    { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  );

  let stdoutBuffer = "";
  let stderr = "";
  let sequence = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const notifications = [];
  const statuses = [];
  const extensionErrors = [];
  const unexpected = [];
  const recordUnexpected = (entry) => {
    if (unexpected.length < 20) unexpected.push(entry);
    else if (unexpected.length === 20) unexpected.push({ kind: "more-unexpected-events" });
  };
  let terminalError;
  let closing = false;
  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const settlePending = (id, settle) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    settle(entry);
  };

  const rejectAll = (error) => {
    for (const id of [...pending.keys()]) {
      settlePending(id, ({ reject }) => reject(error));
    }
  };

  const failTransport = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    terminalError ??= normalized;
    rejectAll(terminalError);
  };

  const write = (value) => {
    if (terminalError) return Promise.reject(terminalError);
    if (child.stdin.destroyed || !child.stdin.writable) {
      const error = new Error(`Pi RPC stdin is closed (${label})`);
      failTransport(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
          if (error) {
            failTransport(error);
            reject(error);
            return;
          }
          resolve();
        });
      } catch (error) {
        failTransport(error);
        reject(error);
      }
    });
  };

  const send = (type, extra = {}) => {
    if (terminalError) return Promise.reject(terminalError);
    const id = `${label}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settlePending(id, ({ reject: rejectRequest }) => {
          rejectRequest(new Error(`RPC timeout waiting for ${type}`));
        });
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      void write({ id, type, ...extra }).catch((error) => {
        settlePending(id, ({ reject: rejectRequest }) => rejectRequest(error));
      });
    });
  };

  const respond = (event, payload) => {
    void write({ type: "extension_ui_response", id: event.id, ...payload }).catch((error) => {
      stderr += `\n[RPC write] ${String(error)}`;
    });
  };

  const onEvent = (event) => {
    if (event.type === "response" && event.id && pending.has(event.id)) {
      settlePending(event.id, ({ resolve }) => resolve(event));
      return;
    }
    if (event.type === "extension_ui_request") {
      if (event.method === "notify") {
        notifications.push({ message: event.message, type: event.notifyType });
        handlers.onNotify?.(event.message, event.notifyType);
        return;
      }
      if (event.method === "setStatus") {
        statuses.push({ key: event.key, text: event.text });
        handlers.onStatus?.(event.key, event.text);
        respond(event, {});
        return;
      }
      if (event.method === "select") {
        let value;
        try {
          value = handlers.select?.(event);
        } catch (err) {
          recordUnexpected({ kind: "select-threw", title: event.title, error: String(err) });
          respond(event, { cancelled: true });
          return;
        }
        if (value === undefined) {
          recordUnexpected({ kind: "select-unhandled", title: event.title, options: event.options });
          respond(event, { cancelled: true });
          return;
        }
        respond(event, { value });
        return;
      }
      if (event.method === "confirm") {
        let confirmed;
        try {
          confirmed = handlers.confirm?.(event);
        } catch (err) {
          recordUnexpected({ kind: "confirm-threw", title: event.title, error: String(err) });
          confirmed = false;
        }
        if (confirmed === undefined) {
          recordUnexpected({ kind: "confirm-unhandled", title: event.title, message: event.message });
          confirmed = false;
        }
        respond(event, { confirmed: confirmed ?? false });
        return;
      }
      if (event.method === "input") {
        let value;
        try {
          value = handlers.input?.(event);
        } catch (err) {
          recordUnexpected({ kind: "input-threw", prompt: event.prompt, error: String(err) });
        }
        if (value === undefined) {
          recordUnexpected({ kind: "input-unhandled", prompt: event.prompt });
        }
        respond(event, value === undefined ? { cancelled: true } : { value });
        return;
      }
      if (event.method === "editor") {
        recordUnexpected({ kind: "editor-unhandled", title: event.title, prompt: event.prompt });
        respond(event, { cancelled: true });
        return;
      }
      // Unknown UI methods are cancelled and recorded so the smoke fails.
      recordUnexpected({ kind: "unknown-method", method: event.method, title: event.title });
      respond(event, { cancelled: true });
      return;
    }
    if (event.type === "extension_error") {
      extensionErrors.push(event);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        stderr += `\n[RPC parse] ${line.slice(0, 500)}`;
        recordUnexpected({ kind: "invalid-rpc-json", line: line.slice(0, 200) });
        failTransport(
          new Error(`Pi RPC emitted invalid JSON (${label}): ${line.slice(0, 200)}`, {
            cause: error,
          }),
        );
        continue;
      }
      try {
        onEvent(event);
      } catch (error) {
        recordUnexpected({
          kind: "rpc-event-handler-threw",
          type: event?.type,
          error: String(error),
        });
        failTransport(
          new Error(`Pi RPC event handling failed (${label}): ${String(error)}`, {
            cause: error,
          }),
        );
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", (error) => {
    failTransport(new Error(`Pi RPC stdin error: ${String(error)}`));
  });
  child.once("exit", (code, signal) => {
    if (!closing) {
      failTransport(new Error(`Pi RPC exited early: code=${code} signal=${signal}`));
    }
  });

  child.on("error", (err) => {
    failTransport(new Error(`Pi RPC spawn error: ${String(err)}`));
  });
  child.once("close", (code, signal) => {
    closed = true;
    if (!closing && !terminalError) {
      failTransport(new Error(`Pi RPC closed early: code=${code} signal=${signal}`));
    }
    resolveClosed();
  });

  const close = () => {
    if (closed) return Promise.resolve();
    closing = true;
    failTransport(new Error(`Pi RPC client closed (${label})`));
    if (!child.killed && child.exitCode === null) child.kill();
    return closedPromise;
  };

  return {
    child,
    send,
    close,
    closed: closedPromise,
    notifications,
    statuses,
    extensionErrors,
    unexpected,
    stderr: () => stderr,
  };
}

export function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendJsonError(res, status, message, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": `smoke-relay-error-${status}`,
  });
  res.end(
    JSON.stringify({
      error: { message, type: "invalid_request_error", ...extra },
    }),
  );
}

export function readJsonRequest(req, res, onBody) {
  let source = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    source += chunk;
  });
  req.on("end", () => {
    let body;
    try {
      body = source ? JSON.parse(source) : {};
    } catch {
      sendJsonError(res, 400, "invalid JSON");
      return;
    }
    onBody(body);
  });
}

export function startHttpRelay(handler) {
  const requests = [];
  const server = http.createServer((req, res) => handler(req, res, requests));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("relay did not bind a TCP port"));
        return;
      }
      resolve({
        server,
        port: address.port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Minimal OpenAI Chat Completions SSE relay for the expected endpoint only. */
export function startOpenAiRelay() {
  return startHttpRelay((req, res, requests) => {
    if (req.method !== "POST") {
      sendJsonError(res, 405, `method not allowed: ${req.method ?? "unknown"}`);
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      sendJsonError(res, 404, `unexpected relay path: ${req.url ?? "unknown"}`);
      return;
    }
    readJsonRequest(req, res, (body) => {
      requests.push({ method: req.method, path: req.url, model: body.model });
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "close",
        "x-request-id": `smoke-relay-basic`,
      });
      const base = {
        id: "chatcmpl-smoke-relay",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
      };
      writeSse(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "smoke-ok" },
            finish_reason: null,
          },
        ],
      });
      writeSse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      writeSse(res, {
        ...base,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.end("data: [DONE]\n\n");
    });
  });
}

export function mkdtemp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-switch-${label}-smoke-`));
}
