/**
 * layered-config.ts — the three-layer raw config: project file over global
 * file over the built-in defaults, with the session layer kept by the caller.
 *
 * Every change routes through `mutate` or `clear`, so persistence and target
 * resolution happen the same way for each slice of the file, and the project
 * layer is only ever created by a write.
 */

import type { SubagentsConfig } from "../models/model-precedence.js";
import {
  createConfigIO,
  mergeDefaults,
  mergeLayers,
  type ConfigIO,
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

export class LayeredConfig {
  private io: ConfigIO;
  private globalRaw: RawConfig;
  private projectLayer: ProjectLayer;

  constructor(io: ConfigIO = fileConfigIO) {
    this.io = io;
    const loaded = io.load();
    this.globalRaw = loaded.global;
    this.projectLayer = projectLayerFrom(loaded);
  }

  /** Project file over global file over the built-in defaults. */
  get effective(): SubagentsConfig {
    return mergeDefaults(mergeLayers(this.globalRaw, this.project));
  }

  get global(): RawConfig {
    return this.globalRaw;
  }

  /** Null when no project layer exists. */
  get project(): RawConfig | null {
    return this.projectLayer.kind === "present" ? this.projectLayer.raw : null;
  }

  /** A write creates an absent project file; only an untrusted or malformed one is refused. */
  get isProjectWritable(): boolean {
    return this.projectLayer.kind !== "refused";
  }

  /** A global file the loader could not parse is never written over. */
  get isGlobalWritable(): boolean {
    return this.io.isGlobalWritable();
  }

  /** Does not reload; session_start follows with reload(). */
  setProjectDir(projectDir: string | undefined): void {
    this.io = createConfigIO(projectDir);
  }

  /** Re-reads both files. */
  reload(): void {
    const loaded = this.io.load();
    this.globalRaw = loaded.global;
    this.projectLayer = projectLayerFrom(loaded);
  }

  /**
   * Applies `update` to one raw layer and persists it. A write creates an
   * absent project layer; when the project target is unavailable the change is
   * refused with a warning. False means nothing was written.
   */
  mutate(
    target: "global" | "project",
    update: (raw: RawConfig) => void,
  ): boolean {
    if (target === "global" && !this.globalWritableOrWarn()) return false;
    const layer =
      target === "global" ? this.global : this.projectLayerToWrite();
    if (layer === null) return false;
    update(layer);
    if (target === "global") this.io.saveGlobal(layer);
    else this.io.saveProject(layer);
    return true;
  }

  /**
   * Applies `update` to the raw layer(s) a target names, and `clearSession` to
   * the caller's session layer. Only layers that exist change: a clear never
   * creates a project file.
   */
  clear(
    target: ConfigTarget | "all",
    update: (raw: RawConfig) => void,
    clearSession: () => void,
  ): void {
    if (target === "session" || target === "all") clearSession();
    if (target === "global" || target === "all") {
      if (this.globalWritableOrWarn()) {
        update(this.globalRaw);
        this.io.saveGlobal(this.globalRaw);
      }
    }
    const project = this.project;
    if (project && (target === "project" || target === "all")) {
      update(project);
      this.io.saveProject(project);
    }
  }

  /** True when a global write may replace the file on disk. */
  private globalWritableOrWarn(): boolean {
    if (this.isGlobalWritable) return true;
    console.warn(
      "[subagents] Refusing to write global config (malformed); change not saved",
    );
    return false;
  }

  /** The project layer a write may touch, creating the file when it is absent. */
  private projectLayerToWrite(): RawConfig | null {
    const project = this.projectLayer;
    if (project.kind === "present") return project.raw;
    if (project.kind === "refused") {
      console.warn(
        `[subagents] Project config target unavailable (${project.status}); change ignored`,
      );
      return null;
    }
    const raw: RawConfig = {};
    this.projectLayer = { kind: "present", raw };
    return raw;
  }
}
