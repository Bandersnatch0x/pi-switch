import type {
  CcProvider,
  PinEntry,
  PiSwitchConfig,
  PiSwitchSelection,
  RecentEntry,
} from "./types.ts";
import type { ModelMetaOverride } from "./settings.ts";
import {
  migrateLegacySelection,
  piSettingsPath,
  piSwitchConfigPath,
  pushRecentEntry,
  readPiSwitchConfig,
  readSelection,
  togglePinEntry,
  writePins,
  writeProviderModelMeta,
  writeRecent,
  writeSelection,
  type FsLike,
} from "./settings.ts";

export type StateWriteResult = { ok: boolean; error?: string };

export interface LocalState {
  readConfig(): PiSwitchConfig;
  readSelection(): PiSwitchSelection | undefined;
  readOrMigrateSelection(providers: CcProvider[]): PiSwitchSelection | undefined;
  saveSelection(selection: PiSwitchSelection): StateWriteResult;
  saveProviderModelMeta(
    provider: Pick<CcProvider, "id" | "displayName">,
    modelMeta: ModelMetaOverride | null,
  ): StateWriteResult;
  togglePin(
    pins: PinEntry[] | undefined,
    entry: PinEntry,
  ): StateWriteResult & { pins: PinEntry[]; pinned: boolean };
  recordRecent(
    recent: RecentEntry[] | undefined,
    entry: Omit<RecentEntry, "at"> & { at?: number },
    limit?: number,
  ): StateWriteResult & { recent: RecentEntry[] };
}

export function createLocalState(options: {
  fs: FsLike;
  home: string;
  pid?: number;
}): LocalState {
  const { fs, home } = options;
  const pid = options.pid ?? process.pid;
  const settingsPath = piSettingsPath(home);
  const configPath = piSwitchConfigPath(home);

  return {
    readConfig: () => readPiSwitchConfig(fs, configPath),
    readSelection: () => readSelection(fs, settingsPath),
    readOrMigrateSelection: (providers) =>
      readSelection(fs, settingsPath) ??
      migrateLegacySelection(fs, settingsPath, providers, pid),
    saveSelection: (selection) =>
      writeSelection(fs, settingsPath, selection, pid),
    saveProviderModelMeta: (provider, modelMeta) =>
      writeProviderModelMeta(fs, configPath, provider, modelMeta, pid),
    togglePin: (pins, entry) => {
      const next = togglePinEntry(pins, entry);
      return { ...writePins(fs, configPath, next.pins, pid), ...next };
    },
    recordRecent: (recent, entry, limit) => {
      const next = pushRecentEntry(recent, entry, limit);
      return { ...writeRecent(fs, configPath, next, pid), recent: next };
    },
  };
}
