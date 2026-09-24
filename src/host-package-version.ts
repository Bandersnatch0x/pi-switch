/** Locate the package that owns a concrete runtime entry file. */

export interface HostPackageVersionDeps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  dirname(path: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
}

/** Read a package.json at `directory` when it belongs to `packageName`. */
function owningManifest(
  directory: string,
  packageName: string,
  deps: HostPackageVersionDeps,
): { name: string; version?: string } | undefined {
  const manifestPath = deps.join(directory, "package.json");
  if (!deps.existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(deps.readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name !== packageName) return undefined;
    return {
      name: packageName,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  } catch {
    // A malformed unrelated ancestor must not hide a valid owning package.
    return undefined;
  }
}

/** Walk from `entryPath` upwards looking for the directory owning `packageName`. */
export function findOwningPackageDir(
  entryPath: string | undefined,
  packageName: string,
  deps: HostPackageVersionDeps,
): string | undefined {
  if (!entryPath?.trim() || !packageName.trim()) return undefined;

  let directory = deps.dirname(deps.resolve(entryPath));
  while (true) {
    if (owningManifest(directory, packageName, deps)) return directory;
    const parent = deps.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function findOwningPackageVersion(
  entryPath: string | undefined,
  packageName: string,
  deps: HostPackageVersionDeps,
): string | undefined {
  if (!entryPath?.trim() || !packageName.trim()) return undefined;

  let directory = deps.dirname(deps.resolve(entryPath));
  while (true) {
    const manifest = owningManifest(directory, packageName, deps);
    if (manifest?.version?.trim()) return manifest.version.trim();

    const parent = deps.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
