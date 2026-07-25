import type {
  CcProvider,
  ModelMetaOverride,
  PinEntry,
  PiSwitchConfig,
  PiSwitchSelection,
  RecentEntry,
} from "./types.ts";
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
    entry: PinEntry,
  ): StateWriteResult & { pins: PinEntry[]; pinned: boolean };
  recordRecent(
    entry: Omit<RecentEntry, "at"> & { at?: number },
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
    togglePin: (entry) => {
      const current = readPiSwitchConfig(fs, configPath);
      const next = togglePinEntry(current.pins, entry);
      return { ...writePins(fs, configPath, next.pins, pid), ...next };
    },
    recordRecent: (entry) => {
      const current = readPiSwitchConfig(fs, configPath);
      const next = pushRecentEntry(
        current.recent,
        entry,
        current.recentLimit,
      );
      return { ...writeRecent(fs, configPath, next, pid), recent: next };
    },
  };
}
