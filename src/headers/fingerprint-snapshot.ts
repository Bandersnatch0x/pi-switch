/**
 * W5 fingerprint snapshot baselines (packaged defaults/fingerprint-snapshot.json).
 * Pure load + parse; callers cache the result once per process if desired.
 */

/** Subset of defaults/fingerprint-snapshot.json used by doctor. */
export interface FingerprintSnapshot {
  snapshotVersion: number;
  baselines: { codex?: string; claudeCode?: string; gemini?: string };
}

export type FingerprintSnapshotIo = {
  readFileSync: (path: string, encoding: "utf8") => string;
};

/**
 * Load snapshot baselines. Undefined when the packaged file is missing
 * or malformed.
 */
export function loadFingerprintSnapshot(
  io: FingerprintSnapshotIo,
  snapshotPath: string,
): FingerprintSnapshot | undefined {
  try {
    const raw = JSON.parse(io.readFileSync(snapshotPath, "utf8")) as {
      snapshotVersion?: unknown;
      upstream?: {
        codex?: { version?: unknown };
        claudeCode?: { version?: unknown };
        gemini?: { version?: unknown };
      };
    };
    const v = raw.snapshotVersion;
    const up = raw.upstream;
    if (typeof v !== "number" || !up) return undefined;
    return {
      snapshotVersion: v,
      baselines: {
        codex: typeof up.codex?.version === "string" ? up.codex.version : undefined,
        claudeCode:
          typeof up.claudeCode?.version === "string"
            ? up.claudeCode.version
            : undefined,
        gemini:
          typeof up.gemini?.version === "string" ? up.gemini.version : undefined,
      },
    };
  } catch {
    return undefined;
  }
}
