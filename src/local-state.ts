import type {
  CcProvider,
  ModelMetaOverride,
  PinEntry,
  PiSwitchConfig,
  PiSwitchSelection,
  RecentEntry,
} from "./types.ts";
import {
  clearAllModelMetaOverrides,
  migrateLegacySelection,
  readPiSwitchConfig,
  readSelection,
  writeModelMetaOverride,
  writeSelection,
  type ModelMetaScope,
} from "./settings.ts";
import type { FsLike } from "./json-file.ts";
import { piSettingsPath, piSwitchConfigPath } from "./paths.ts";
import { recordRecentAndWrite, togglePinAndWrite } from "./pins-recent.ts";

export type StateWriteResult = { ok: boolean; error?: string };

export interface LocalState {
  readConfig(): PiSwitchConfig;
  readSelection(): PiSwitchSelection | undefined;
  readOrMigrateSelection(providers: CcProvider[]): PiSwitchSelection | undefined;
  saveSelection(selection: PiSwitchSelection): StateWriteResult;
  saveProviderModelMeta(
    provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
    modelMeta: ModelMetaOverride | null,
  ): StateWriteResult;
  /** Write one scope (provider or a single model id). */
  saveModelMetaOverride(
    provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
    scope: ModelMetaScope,
    modelMeta: ModelMetaOverride | null,
  ): StateWriteResult;
  /** Drop provider modelMeta plus every per-model override. */
  clearModelMetaOverrides(
    provider: Pick<CcProvider, "id" | "displayName"> & { appType?: string },
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
      writeModelMetaOverride({ fs, configPath, pid }, provider, { kind: "provider" }, modelMeta),
    saveModelMetaOverride: (provider, scope, modelMeta) =>
      writeModelMetaOverride({ fs, configPath, pid }, provider, scope, modelMeta),
    clearModelMetaOverrides: (provider) =>
      clearAllModelMetaOverrides({ fs, configPath, pid }, provider),
    togglePin: (entry) => togglePinAndWrite({ fs, configPath, pid }, entry),
    recordRecent: (entry) => recordRecentAndWrite({ fs, configPath, pid }, entry),
  };
}
