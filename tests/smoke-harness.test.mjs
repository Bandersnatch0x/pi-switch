import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import {
  assertFileStatesUnchanged,
  buildTempEnv,
  captureFileStates,
  createRpcClient,
  readJsonRequest,
  sha256IfExists,
  smokeStatePaths,
  startOpenAiRelay,
} from "../scripts/_smoke-harness.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-harness-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("smoke harness isolation", () => {
  test("temporary DB overrides an inherited CC_SWITCH_DB", () => {
    const home = tempDir();
    const previous = process.env.CC_SWITCH_DB;
    process.env.CC_SWITCH_DB = path.join(home, "real.db");

    try {
      const env = buildTempEnv(home, "sqlite3");
      expect(env.CC_SWITCH_DB).toBe(path.join(home, ".cc-switch", "cc-switch.db"));
    } finally {
      if (previous === undefined) delete process.env.CC_SWITCH_DB;
      else process.env.CC_SWITCH_DB = previous;
    }
  });

  test("hashes files, returns null only when missing, and surfaces read errors", () => {
    const root = tempDir();
    const file = path.join(root, "config.json");
    const missing = path.join(root, "missing.json");
    fs.writeFileSync(file, "{}\n", "utf8");

    const expected = crypto.createHash("sha256").update("{}\n").digest("hex");
    expect(sha256IfExists(file)).toBe(expected);
    expect(sha256IfExists(missing)).toBeNull();
    expect(() => sha256IfExists(root)).toThrow();
  });

  test("tracks settings, config, DB, and SQLite sidecars", () => {
    const home = tempDir();
    const db = path.join(home, ".cc-switch", "cc-switch.db");
    const paths = smokeStatePaths(home, db);

    expect(paths).toEqual([
      path.join(home, ".pi", "agent", "settings.json"),
      path.join(home, ".pi", "agent", "pi-switch.json"),
      db,
      `${db}-wal`,
      `${db}-shm`,
    ]);

    fs.mkdirSync(path.dirname(paths[0]), { recursive: true });
    fs.writeFileSync(paths[0], "{}\n", "utf8");
    const before = captureFileStates(paths);
    assertFileStatesUnchanged(before, "real state");

    fs.writeFileSync(paths[0], '{"changed":true}\n', "utf8");
    expect(() => assertFileStatesUnchanged(before, "real state")).toThrow(
      /settings\.json/,
    );
  });
});

describe("smoke harness RPC transport", () => {
  test("rejects invalid JSON emitted by the RPC child", async () => {
    const root = tempDir();
    const childScript = path.join(root, "invalid-json.mjs");
    fs.writeFileSync(
      childScript,
      'process.stdout.write("not-json\\n"); setInterval(() => {}, 1_000);\n',
      "utf8",
    );

    const rpc = createRpcClient({
      piCli: childScript,
      extension: "unused.ts",
      env: process.env,
      label: "invalid-json-child",
      handlers: {},
      timeoutMs: 5_000,
    });
    await expect(rpc.send("get_commands")).rejects.toThrow(/invalid JSON/i);
    expect(rpc.unexpected[0]?.kind).toBe("invalid-rpc-json");
    await rpc.close();
  });

  test("rejects when an RPC event handler throws", async () => {
    const root = tempDir();
    const childScript = path.join(root, "handler-error.mjs");
    fs.writeFileSync(
      childScript,
      'process.stdout.write(JSON.stringify({ type: "extension_ui_request", method: "notify", message: "boom" }) + "\\n"); setInterval(() => {}, 1_000);\n',
      "utf8",
    );

    const rpc = createRpcClient({
      piCli: childScript,
      extension: "unused.ts",
      env: process.env,
      label: "handler-error-child",
      handlers: {
        onNotify() {
          throw new Error("notify handler failed");
        },
      },
      timeoutMs: 5_000,
    });
    await expect(rpc.send("get_commands")).rejects.toThrow(/event handling failed/i);
    expect(rpc.unexpected[0]?.kind).toBe("rpc-event-handler-threw");
    await rpc.close();
  });

  test("rejects immediately after the child has exited", async () => {
    const root = tempDir();
    const childScript = path.join(root, "exit-immediately.mjs");
    fs.writeFileSync(childScript, "process.exit(0);\n", "utf8");

    const rpc = createRpcClient({
      piCli: childScript,
      extension: "unused.ts",
      env: process.env,
      label: "exited-child",
      handlers: {},
      timeoutMs: 5_000,
    });
    await once(rpc.child, "close");

    const startedAt = Date.now();
    await expect(rpc.send("get_commands")).rejects.toThrow(/exited|closed/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
    await rpc.close();
  });
});

describe("smoke harness relay", () => {
  test("does not misreport relay handler failures as invalid JSON", () => {
    const req = new EventEmitter();
    req.setEncoding = () => {};
    const res = {
      writeHead() {
        throw new Error("unexpected invalid JSON response");
      },
    };
    readJsonRequest(req, res, () => {
      throw new Error("relay handler failed");
    });
    req.emit("data", "{}");

    expect(() => req.emit("end")).toThrow("relay handler failed");
  });

  test("rejects unexpected methods and paths", async () => {
    const relay = await startOpenAiRelay();
    const origin = `http://127.0.0.1:${relay.port}`;
    try {
      expect((await fetch(`${origin}/v1/chat/completions`)).status).toBe(405);
      expect(
        (
          await fetch(`${origin}/wrong`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(404);
      expect(relay.requests).toHaveLength(0);
    } finally {
      await relay.close();
    }
  });
});
