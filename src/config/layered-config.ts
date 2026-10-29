/**
 * layered-config.ts — the three-layer raw config: project file over global
 * file over the built-in defaults, with the session layer kept by the caller.
 *
 * Every change routes through `mutate` or `clear`, so persistence and target
 * resolution happen the same way for each slice of the file, and the project
 * layer is only ever created by a write.
 *
 * Construction reads nothing. The session's project directory is chosen only
 * after the store exists, so the first load waits for `reload()` (see
 * events.ts); until then the layers are the built-in defaults and no write is
 * allowed, since an unread file is not one a write may replace.
 */

import type { SubagentsConfig } from "../models/model-precedence.js";
import {
  createConfigIO,
  mergeDefaults,
  mergeLayers,
  type ConfigIO,
  type ConfigPaths,
  type ConfigTarget,
  type LoadedConfig,
  type RawConfig,
} from "./config-io.js";

const fileConfigIO: ConfigIO = createConfigIO();

/**
 * The project layer: a loaded file, no file yet (a write may create one), or a
 * file that may not be used. Holding a project layer and refusing to use it are
 * the same fact, so they are one variant.
 */
type ProjectLayer =
  | { kind: "present"; raw: RawConfig }
  | { kind: "creatable" }
  | { kind: "refused"; status: "untrusted" | "malformed" };

function projectLayerFrom(loaded: LoadedConfig): ProjectLayer {
  if (loaded.project) return { kind: "present", raw: loaded.project };
  if (
    loaded.projectStatus === "untrusted" ||
    loaded.projectStatus === "malformed"
  ) {
    return { kind: "refused", status: loaded.projectStatus };
  }
  return { kind: "creatable" };
}

/** The layers as the last load left them. */
interface FileLayers {
  globalRaw: RawConfig;
  projectLayer: ProjectLayer;
}

function projectRawOf(layer: ProjectLayer): RawConfig | null {
  return layer.kind === "present" ? layer.raw : null;
}

/** A write before the first load would replace a file nothing has read. */
const UNLOADED_WRITE_WARNING =
  "[subagents] Refusing to write config before the first load; change not saved";

export class LayeredConfig {
  private io: ConfigIO;
  /** Null until the first load: no file has been read, so only defaults exist. */
  private files: FileLayers | null = null;

  constructor(io: ConfigIO = fileConfigIO) {
    this.io = io;
  }

  /** The files the current layers came from, for warnings formatted after load. */
  get paths(): ConfigPaths {
    return this.io.paths();
  }

  /**
   * Project file over global file over the built-in defaults — the defaults
   * alone until the first load.
   */
  get effective(): SubagentsConfig {
    const files = this.files;
    return files === null
      ? mergeDefaults({})
      : mergeDefaults(
          mergeLayers(files.globalRaw, projectRawOf(files.projectLayer)),
        );
  }

  /** Empty until the first load. */
  get global(): RawConfig {
    return this.files?.globalRaw ?? {};
  }

  /** Null when no project layer exists, and before the first load. */
  get project(): RawConfig | null {
    const files = this.files;
    return files === null ? null : projectRawOf(files.projectLayer);
  }

  /**
   * A write creates an absent project file; only an untrusted or malformed one
   * is refused, and before the first load nothing is writable.
   */
  get isProjectWritable(): boolean {
    const files = this.files;
    return files !== null && files.projectLayer.kind !== "refused";
  }

  /**
   * A global file the loader could not parse is never written over, and until
   * the first load the file has not been read at all.
   */
  get isGlobalWritable(): boolean {
    return this.files !== null && this.io.isGlobalWritable();
  }

  /** Does not reload; session_start follows with reload(). */
  setProjectDir(projectDir: string | undefined): void {
    this.io = createConfigIO(projectDir);
  }

  /** The first load, and every later re-read of both files. */
  reload(): void {
    const loaded = this.io.load();
    this.files = {
      globalRaw: loaded.global,
      projectLayer: projectLayerFrom(loaded),
    };
  }

  /**
   * Applies `update` to one raw layer and persists it. A write creates an
   * absent project layer; when the project target is unavailable, or nothing
   * has been loaded yet, the change is refused with a warning. False means
   * nothing was written.
   */
  mutate(
    target: "global" | "project",
    update: (raw: RawConfig) => void,
  ): boolean {
    const files = this.loadedOrWarn();
    if (files === null) return false;
    if (target === "global") {
      if (!this.globalWritableOrWarn()) return false;
      update(files.globalRaw);
      this.io.saveGlobal(files.globalRaw);
      return true;
    }
    const layer = projectLayerToWrite(files);
    if (layer === null) return false;
    update(layer);
    this.io.saveProject(layer);
    return true;
  }

  /**
   * Applies `update` to the raw layer(s) a target names, and `clearSession` to
   * the caller's session layer. Only layers that exist change: a clear never
   * creates a project file, and before the first load it writes no file at
   * all.
   */
  clear(
    target: ConfigTarget | "all",
    update: (raw: RawConfig) => void,
    clearSession: () => void,
  ): void {
    if (target === "session" || target === "all") clearSession();
    // The session layer is the only one a clear can reach with no file read.
    if (target === "session") return;
    const files = this.loadedOrWarn();
    if (files === null) return;
    if (target === "global" || target === "all") {
      if (this.globalWritableOrWarn()) {
        update(files.globalRaw);
        this.io.saveGlobal(files.globalRaw);
      }
    }
    const project = projectRawOf(files.projectLayer);
    if (project && (target === "project" || target === "all")) {
      update(project);
      this.io.saveProject(project);
    }
  }

  /** The layers a write may touch, or null after warning when nothing has loaded. */
  private loadedOrWarn(): FileLayers | null {
    if (this.files !== null) return this.files;
    console.warn(UNLOADED_WRITE_WARNING);
    return null;
  }

  /** True when a global write may replace the file on disk. */
  private globalWritableOrWarn(): boolean {
    if (this.isGlobalWritable) return true;
    console.warn(
      "[subagents] Refusing to write global config (malformed); change not saved",
    );
    return false;
  }
}

/** The project layer a write may touch, creating the file when it is absent. */
function projectLayerToWrite(files: FileLayers): RawConfig | null {
  const layer = files.projectLayer;
  if (layer.kind === "present") return layer.raw;
  if (layer.kind === "refused") {
    console.warn(
      `[subagents] Project config target unavailable (${layer.status}); change ignored`,
    );
    return null;
  }
  const raw: RawConfig = {};
  files.projectLayer = { kind: "present", raw };
  return raw;
}
