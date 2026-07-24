#!/usr/bin/env node
/**
 * Release gate for pi-switch (inspired by vibe-designing-playbook scripts/release.py).
 *
 * Dry-run by default. Pass --apply to create git tag vX.Y.Z after gates pass.
 * Pushing the tag triggers GitHub Actions npm publish.
 *
 * Usage:
 *   bun scripts/release.mjs
 *   bun scripts/release.mjs --apply
 *   bun scripts/release.mjs --checks tree,version,test,pack,tag
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
const CHECK_ORDER = ["tree", "version", "test", "pack", "tag"];
const failures = [];

function ok(msg) {
  console.log(`  ok    ${msg}`);
}
function fail(msg) {
  console.log(`  FAIL  ${msg}`);
  failures.push(msg);
}
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...opts,
  });
}
function git(...args) {
  const r = run("git", ["-C", ROOT, ...args]);
  return r.status === 0 ? (r.stdout || "").trim() : "";
}
function packageJson() {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
}
function packageVersion() {
  const version = packageJson().version;
  return typeof version === "string" ? version : "";
}
function packageName() {
  const name = packageJson().name;
  return typeof name === "string" ? name : "pi-ccs";
}

function checkTree() {
  console.log("== 1. working tree clean ==");
  const status = git("status", "--porcelain", "--untracked-files=all");
  const dirty = status.split(/\r?\n/).filter(Boolean);
  if (!dirty.length) {
    ok("working tree clean");
    return;
  }
  fail(`working tree has uncommitted changes: ${dirty.length} file(s)`);
  for (const line of dirty.slice(0, 12)) console.log(`        ${line}`);
}

function checkVersion() {
  console.log("== 2. version consistency ==");
  const version = packageVersion();
  if (!SEMVER.test(version)) {
    fail(`package.json version not semver: ${JSON.stringify(version)}`);
    return;
  }
  ok(`package.json version: ${version}`);

  const pkg = packageJson();
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
    fail('package.json keywords must include "pi-package" (for pi.dev/packages discovery)');
  } else {
    ok("keywords include pi-package");
  }
  if (!pkg.pi || !Array.isArray(pkg.pi.extensions) || !pkg.pi.extensions.length) {
    fail("package.json.pi.extensions is required for Pi package install");
  } else {
    ok(`pi.extensions: ${pkg.pi.extensions.join(", ")}`);
  }
  if (!pkg.publishConfig || pkg.publishConfig.access !== "public") {
    fail('publishConfig.access must be "public"');
  } else {
    ok("publishConfig.access=public");
  }

  for (const rel of ["README.md", "README-zh.md", "LICENSE"]) {
    if (!existsSync(resolve(ROOT, rel))) fail(`missing ${rel}`);
    else ok(`${rel} present`);
  }
}

function checkTest() {
  console.log("== 3. bun test ==");
  const r = run("bun", ["test"], { stdio: ["ignore", "pipe", "pipe"] });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  if (r.status === 0 && /0 fail/.test(out)) {
    const m = out.match(/(\d+) pass/);
    ok(m ? `bun test passed (${m[1]} pass)` : "bun test passed");
    return;
  }
  fail(`bun test failed (exit ${r.status})`);
  console.log(out.split(/\r?\n/).slice(-20).join("\n"));
}

function checkPack() {
  console.log("== 4. npm pack dry-run ==");
  const r = run("npm", ["pack", "--dry-run", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    fail(`npm pack --dry-run failed (exit ${r.status})`);
    console.log((r.stderr || r.stdout || "").split(/\r?\n/).slice(-15).join("\n"));
    return;
  }
  try {
    const j = JSON.parse(r.stdout || "[]");
    const files = (j[0]?.files || []).map((f) => String(f.path).replace(/\\/g, "/"));
    const hasExt = files.some((f) => f.endsWith("extensions/index.ts"));
    const hasReadme = files.includes("README.md");
    if (!hasExt || !hasReadme) {
      fail(`pack missing required files (ext=${hasExt}, readme=${hasReadme})`);
    } else {
      ok(`npm pack dry-run ok (${files.length} files)`);
    }
  } catch {
    ok("npm pack --dry-run exited 0");
  }
}

function checkTag(apply) {
  console.log("== 5. tag ==");
  const version = packageVersion();
  if (!SEMVER.test(version)) {
    fail(`cannot check tag: invalid version ${JSON.stringify(version)}`);
    return "";
  }
  const tag = `v${version}`;
  const tagCommit = git("rev-list", "-n", "1", tag);
  const head = git("rev-parse", "HEAD");
  if (tagCommit) {
    if (tagCommit === head) ok(`tag ${tag} already points at HEAD`);
    else fail(`tag ${tag} points at ${tagCommit.slice(0, 12)}, not HEAD ${head.slice(0, 12)}`);
    return tag;
  }
  if (!apply) {
    ok(`tag ${tag} not present (dry-run; pass --apply to create)`);
    return tag;
  }
  if (failures.length) {
    fail(`refusing to create tag ${tag}: ${failures.length} earlier gate failure(s)`);
    return tag;
  }
  const r = run("git", ["-C", ROOT, "tag", tag]);
  if (r.status === 0) ok(`created tag ${tag}`);
  else fail(`git tag ${tag} failed: ${(r.stderr || "").trim()}`);
  return tag;
}

function parseChecks(value) {
  const requested = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((n) => !CHECK_ORDER.includes(n));
  if (unknown.length) {
    throw new Error(`unknown check(s): ${unknown.join(",")}; choose from ${CHECK_ORDER.join(",")}`);
  }
  if (!requested.length) throw new Error("at least one check is required");
  const set = new Set(requested);
  return CHECK_ORDER.filter((n) => set.has(n));
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  let checks = CHECK_ORDER;
  const idx = args.indexOf("--checks");
  if (idx >= 0) checks = parseChecks(args[idx + 1] || "");

  const handlers = {
    tree: checkTree,
    version: checkVersion,
    test: checkTest,
    pack: checkPack,
  };

  let tag = `v${packageVersion()}`;
  for (const name of checks) {
    if (name === "tag") tag = checkTag(apply) || tag;
    else handlers[name]();
  }

  const name = packageName();
  console.log("");
  console.log("== manual (irreversible / human) ==");
  console.log("  - Ensure GitHub secret NPM_TOKEN is set (npm Automation token with publish)");
  console.log("  - git push origin main");
  console.log(`  - git push origin ${tag}   # triggers GitHub Actions npm publish`);
  console.log(`  - Optional: gh release create ${tag} --generate-notes`);
  console.log(`  - Verify: npm view ${name} version`);
  console.log(`  - Catalog: https://pi.dev/packages/${name}`);

  console.log("");
  if (failures.length) {
    console.log(`RELEASE GATE FAILED: ${failures.length} issue(s)`);
    process.exit(1);
  }
  console.log(apply ? "RELEASE GATE PASSED" : "RELEASE GATE PASSED (dry-run; --apply to tag)");
}

main();
