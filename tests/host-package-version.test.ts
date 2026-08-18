import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
  findOwningPackageVersion,
  type HostPackageVersionDeps,
} from "../src/host-package-version.ts";

function locator(manifests: Map<string, string>): HostPackageVersionDeps {
  return {
    existsSync: (path) => manifests.has(path),
    readFileSync: (path) => {
      const value = manifests.get(path);
      if (value === undefined) throw new Error(`missing fixture: ${path}`);
      return value;
    },
    dirname,
    join,
    resolve,
  };
}

describe("host package version", () => {
  test("reads the package that owns the running CLI entry", () => {
    const root = resolve("fixtures", "pi-host");
    const manifests = new Map([
      [
        join(root, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          version: "0.84.2",
        }),
      ],
    ]);

    expect(
      findOwningPackageVersion(
        join(root, "dist", "cli.js"),
        "@earendil-works/pi-coding-agent",
        locator(manifests),
      ),
    ).toBe("0.84.2");
  });

  test("walks past malformed or unrelated wrapper manifests", () => {
    const root = resolve("fixtures", "wrapped-pi-host");
    const wrapper = join(root, "wrapper");
    const manifests = new Map([
      [join(wrapper, "dist", "package.json"), "{"],
      [join(wrapper, "package.json"), JSON.stringify({ name: "volta-wrapper", version: "1" })],
      [
        join(root, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          version: " 0.84.2 ",
        }),
      ],
    ]);

    expect(
      findOwningPackageVersion(
        join(wrapper, "dist", "cli.js"),
        "@earendil-works/pi-coding-agent",
        locator(manifests),
      ),
    ).toBe("0.84.2");
  });

  test("returns undefined when the entry is absent or no owner matches", () => {
    const deps = locator(new Map());
    expect(
      findOwningPackageVersion(undefined, "@earendil-works/pi-coding-agent", deps),
    ).toBeUndefined();
    expect(
      findOwningPackageVersion(
        resolve("fixtures", "unknown", "cli.js"),
        "@earendil-works/pi-coding-agent",
        deps,
      ),
    ).toBeUndefined();
  });
});
