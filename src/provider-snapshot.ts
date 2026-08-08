/**
 * CC Switch providers table snapshot with last-good retention.
 *
 * Owns sqlite3 path discovery state and the last successful provider list so
 * transient DB failures do not blank the picker / switch UI.
 */

import type { CcProvider } from "./types.ts";
import {
  defaultDbPath,
  readProviders,
  type DbCapabilities,
  type DbReaderDeps,
} from "./db.ts";

export type ProviderSnapshotIo = {
  home: string;
  execFileSync: DbReaderDeps["execFileSync"];
  existsSync: (path: string) => boolean;
};

export type ProviderSnapshotResult = {
  providers: CcProvider[];
  error?: string;
  capabilities?: DbCapabilities;
};

export class ProviderSnapshot {
  lastGoodProviders: CcProvider[] = [];
  sqlite3Path = "sqlite3";
  sqlite3Tried: string[] = [];
  lastSchemaCapabilities: DbCapabilities | undefined;

  constructor(private readonly io: ProviderSnapshotIo) {}

  refresh(): ProviderSnapshotResult {
    const result = readProviders({
      execFileSync: this.io.execFileSync,
      existsSync: this.io.existsSync,
      sqlite3Path: this.sqlite3Path,
      dbPath: defaultDbPath(this.io.home),
    });
    this.lastSchemaCapabilities = result.capabilities;
    if (result.ok) {
      this.lastGoodProviders = result.providers;
      return { providers: result.providers, capabilities: result.capabilities };
    }
    if (this.lastGoodProviders.length) {
      return {
        providers: this.lastGoodProviders,
        error: result.error ?? "read failed; using last good snapshot",
        capabilities: result.capabilities,
      };
    }
    return {
      providers: [],
      error: result.error ?? "failed to read database",
      capabilities: result.capabilities,
    };
  }
}
