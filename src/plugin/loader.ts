/**
 * loader.ts — discover, import and run the installed pi-cowboy plugins.
 *
 * `createPluginLoader()` binds a loader to one session's registries. Each
 * discovered package's entry module is imported and its default export called
 * once with the plugin api, in discovery order (name order), so a plugin
 * registers its harnesses and multiplexers into that session's registry. A
 * plugin that fails to import or throws during its factory is skipped with a
 * warning — one broken plugin costs its own registrations, never the session.
 *
 * Loading happens once per loader, and only once: a second call returns the
 * live load, because re-registering would only repeat the work. Disposing the
 * load runs the plugin disposers and undoes the registrations it made, so a
 * later load into the same registries starts from the built-ins.
 *
 * The registries belong to the session, not to this module, so a replacement
 * session's loader writes to its own maps and a dying load's teardown cannot
 * reach them.
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessRegistry } from "../agents/harness/harness-registry.js";
import type { MultiplexerRegistry } from "../agents/multiplexer-registry.js";
import { errorMessage } from "../utils.js";
import type { CowboyPluginApi, CowboyPluginFactory } from "./contract.js";
import { discoverPluginPackages, type DiscoveredPlugin } from "./discovery.js";

/** Where a loader reports a skipped plugin; a UI sink in production. */
export type PluginNoticeSink = (message: string, kind: "warning") => void;

/** The live plugin load: how to undo everything the plugins registered. */
export interface LoadedPlugins {
  /** The plugin package names that loaded, in load order. */
  readonly loaded: readonly string[];
  /** Run every disposer in reverse load order; never throws. */
  dispose(): Promise<void>;
}

/** The registries one loader registers into. */
export interface PluginRegistries {
  readonly harnesses: HarnessRegistry;
  readonly multiplexers: MultiplexerRegistry;
}

/** One session's plugin loading. */
export interface PluginLoader {
  /**
   * Discover and load every installed plugin, once per loader. Returns the load
   * so the caller can report what loaded and dispose it at unload.
   */
  load(
    pi: ExtensionAPI,
    cwd: string,
    notify: PluginNoticeSink,
  ): Promise<LoadedPlugins>;
}

/**
 * A loader for the session whose registries these are.
 *
 * The in-flight promise is memoized, so two overlapping callers (pi's reload and
 * a session replacement can produce them) await one discovery and import every
 * plugin once — not twice.
 */
export function createPluginLoader(registries: PluginRegistries): PluginLoader {
  /** This loader's live load: loaded, and not being torn down. */
  let current: LoadedPlugins | null = null;

  /** The in-flight load, so two overlapping callers await one discovery and import. */
  let pending: Promise<LoadedPlugins> | null = null;

  /**
   * The teardown in flight, if any. A later load waits for it before registering
   * anything: the teardown undoes the previous load's registrations, and
   * registering first would have those undos treat the new load's ids as their
   * own.
   */
  let disposing: Promise<void> | null = null;

  async function startLoad(
    pi: ExtensionAPI,
    cwd: string,
    notify: PluginNoticeSink,
  ): Promise<LoadedPlugins> {
    const teardown = disposing;
    if (teardown !== null) {
      await teardown;
      if (disposing === teardown) disposing = null;
    }

    const disposers: Array<() => void | Promise<void>> = [];
    /** Every registration this load made, newest last, undone at teardown. */
    const undos: Array<() => void> = [];
    const loaded: string[] = [];
    // Discovery failing costs every plugin, so it is reported rather than reading
    // as "no plugins installed" — the two are different answers.
    let discovered: readonly DiscoveredPlugin[];
    try {
      discovered = await discoverPluginPackages(cwd);
    } catch (error) {
      notify(
        `[cowboy] installed plugins could not be discovered and were skipped: ${errorMessage(error)}`,
        "warning",
      );
      discovered = [];
    }
    for (const plugin of discovered) {
      // A plugin's own registrations are rolled back on their own if its factory
      // throws, leaving the plugins loaded before it untouched.
      const mark = undos.length;
      try {
        const dispose = await loadOne(plugin, pi, cwd, registries, (undo) =>
          undos.push(undo),
        );
        if (dispose !== undefined) disposers.push(dispose);
        loaded.push(plugin.name);
      } catch (error) {
        for (const undo of undos.splice(mark).reverse()) undo();
        notify(
          `[cowboy] plugin "${plugin.name}" (${plugin.source}) could not load and was skipped: ${errorMessage(error)}`,
          "warning",
        );
      }
    }

    /**
     * This load's teardown, memoized so its body runs exactly once: a second call,
     * or a stale handle disposed after a later load, awaits the same pass instead
     * of running a disposer twice or undoing registrations twice.
     */
    let ownTeardown: Promise<void> | undefined;
    const self: LoadedPlugins = {
      loaded,
      dispose: () => {
        ownTeardown ??= (async () => {
          // Stop being the live load the moment teardown begins: a later load
          // must start fresh rather than adopt a dying handle.
          if (current === self) current = null;
          // Reverse load order — a later plugin may depend on an earlier one — and
          // strictly sequential, because the whole pass is one memoized promise: a
          // second or concurrent call awaits this one rather than popping the next
          // disposer out from under it.
          for (
            let next = disposers.pop();
            next !== undefined;
            next = disposers.pop()
          ) {
            try {
              await next();
            } catch (error) {
              notify(
                `[cowboy] a plugin disposer failed: ${errorMessage(error)}`,
                "warning",
              );
            }
          }
          // The registrations go with the load, so the registries answer with the
          // built-ins alone — the only ids a plugin never owns.
          for (let undo = undos.pop(); undo !== undefined; undo = undos.pop()) {
            undo();
          }
        })();
        // Published for a load that starts while this teardown is still running.
        disposing = ownTeardown;
        return ownTeardown;
      },
    };
    current = self;
    pending = null;
    return self;
  }

  return {
    load(pi, cwd, notify) {
      if (current !== null) return Promise.resolve(current);
      pending ??= startLoad(pi, cwd, notify);
      return pending;
    },
  };
}

/**
 * A cache-busting query so a rebuilt plugin is re-imported by a `/reload`
 * instead of served from the module cache. The file's own mtime is the version:
 * a fresh build changes it, an untouched one does not.
 */
function cacheBust(entry: string): string {
  try {
    return `?v=${fs.statSync(entry).mtimeMs}`;
  } catch {
    return "";
  }
}

/** The api one plugin's factory is handed; registrations go straight to the registries. */
function pluginApi(
  pi: ExtensionAPI,
  cwd: string,
  registries: PluginRegistries,
  onRegistered: (undo: () => void) => void,
): CowboyPluginApi {
  return {
    pi,
    cwd,
    registerHarness: (harness) => {
      const accepted = registries.harnesses.register(harness);
      if (accepted) {
        onRegistered(() => registries.harnesses.unregister(harness.id));
      }
      return accepted;
    },
    registerMultiplexer: (multiplexer) => {
      const accepted = registries.multiplexers.register(multiplexer);
      if (accepted) {
        onRegistered(() => registries.multiplexers.unregister(multiplexer.id));
      }
      return accepted;
    },
  };
}

/**
 * Import one plugin's entry and call its factory, returning its disposer (if any).
 *
 * The api is per-plugin and stages an undo for every registration it accepts, so
 * a factory that throws *after* registering something leaves nothing behind —
 * including the first-wins claim on the id it half-took, which would otherwise
 * block the plugin that should own it.
 */
async function loadOne(
  plugin: DiscoveredPlugin,
  pi: ExtensionAPI,
  cwd: string,
  registries: PluginRegistries,
  onRegistered: (undo: () => void) => void,
): Promise<(() => void | Promise<void>) | undefined> {
  const api = pluginApi(pi, cwd, registries, onRegistered);
  const module = (await import(
    `${pathToFileURL(plugin.entry).href}${cacheBust(plugin.entry)}`
  )) as { default?: unknown };
  const factory = module.default;
  if (typeof factory !== "function") {
    throw new Error(
      `entry module ${plugin.entry} has no default-export factory`,
    );
  }
  const result = await (factory as CowboyPluginFactory)(api);
  return typeof result === "function" ? result : undefined;
}
