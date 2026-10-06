/**
 * store.ts — real ConfigStore over in-memory ConfigIO (real ADR-0008 precedence).
 * `writes` records each mutation's layer, asserting e.g. "session is not saved".
 */
import {
  ConfigStore,
  type ConfigIO,
  type RawConfig,
} from "../../src/config/config-store.js";
import type { LoadedConfig } from "../../src/config/config-io.js";
import { setStore } from "./shell-mock.js";

export interface MemoryStoreOptions {
  global?: RawConfig;
  project?: RawConfig | null;
  projectStatus?: LoadedConfig["projectStatus"];
}

interface PersistedWrite {
  layer: "global" | "project";
  config: RawConfig;
}

export interface MemoryStore {
  store: ConfigStore;
  writes: PersistedWrite[];
  install(): ConfigStore;
  /** Last written layer, or null when nothing was persisted. */
  lastLayer(): PersistedWrite["layer"] | null;
}

export function createMemoryStore(
  options: MemoryStoreOptions = {},
): MemoryStore {
  const writes: PersistedWrite[] = [];
  let globalConfig: RawConfig = options.global ?? {};
  let projectConfig: RawConfig | null = options.project ?? null;

  const io: ConfigIO = {
    load: () => ({
      global: globalConfig,
      project: projectConfig,
      projectStatus: options.projectStatus ?? "untrusted",
    }),
    isGlobalWritable: () => true,
    saveGlobal: (config) => {
      writes.push({ layer: "global", config });
      globalConfig = config;
    },
    saveProject: (config) => {
      writes.push({ layer: "project", config });
      projectConfig = config;
    },
  };

  const store = new ConfigStore(io);
  return {
    store,
    writes,
    install: () => {
      setStore(store);
      return store;
    },
    lastLayer: () => writes[writes.length - 1]?.layer ?? null,
  };
}
