/** Locate the package that owns a concrete runtime entry file. */

export interface HostPackageVersionDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  dirname(path: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
}

export function findOwningPackageVersion(
  entryPath: string | undefined,
  packageName: string,
  deps: HostPackageVersionDeps,
): string | undefined {
  if (!entryPath?.trim() || !packageName.trim()) return undefined;

  let directory = deps.dirname(deps.resolve(entryPath));
  while (true) {
    const manifestPath = deps.join(directory, "package.json");
    if (deps.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(deps.readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === packageName && typeof manifest.version === "string") {
          const version = manifest.version.trim();
          if (version) return version;
        }
      } catch {
        // A malformed unrelated ancestor must not hide a valid owning package.
      }
    }

    const parent = deps.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
