/**
 * loader.ts — discover, import and run the installed pi-cowboy plugins.
 *
 * Each discovered package's entry module is imported and its default export
 * called once with the plugin api, in discovery order (name order), so a plugin
 * registers its harnesses and multiplexers into the process-level registries. A
 * plugin that fails to import or throws during its factory is skipped with a
 * warning — one broken plugin costs its own registrations, never the session.
 *
 * Loading happens once per session, and only once: a second call in the same
 * session returns the live load, because the registries live as long as the
 * process and re-registering would only repeat the work. Disposing the load
 * forgets it — it runs the plugin disposers, drops the load's registrations from
 * the registries, and clears the guard — so the next session (or a `/reload`,
 * which re-imports this module) reloads into a clean registry.
 *
 * A session can start while a teardown is still running (pi replaces sessions),
 * so the two are ordered rather than raced: teardown stops being the live load
 * the moment it begins, and a load starting after that waits for the teardown to
 * finish before it registers — because the teardown clears the registries, and
 * registering first would have it clear the new session's entries.
 */

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerMultiplexer,
  resetPluginMultiplexers,
  unregisterMultiplexer,
} from "../agents/multiplexer-registry.js";
import {
  registerHarness,
  resetPluginHarnesses,
  unregisterHarness,
} from "../agents/harness/registry.js";
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

/** The process's one live load: loaded, and not being torn down. */
let current: LoadedPlugins | null = null;

/** The in-flight load, so two overlapping callers await one discovery and import. */
let pending: Promise<LoadedPlugins> | null = null;

/**
 * The teardown in flight, if any. A load waits for it before registering
 * anything: a teardown clears the registries when it finishes, so registering
 * first would have it clear the new session's entries.
 */
let disposing: Promise<void> | null = null;

/**
 * Discover and load every installed plugin, once per load. Returns the load so
 * the caller can report what loaded and dispose it at unload.
 *
 * The in-flight promise is memoized, so two overlapping callers (pi's reload and
 * a session replacement can produce them) await one discovery and import every
 * plugin once — not twice.
 */
export function loadPlugins(
  pi: ExtensionAPI,
  cwd: string,
  notify: PluginNoticeSink,
): Promise<LoadedPlugins> {
  if (current !== null) return Promise.resolve(current);
  pending ??= startLoad(pi, cwd, notify);
  return pending;
}

async function startLoad(
  pi: ExtensionAPI,
  cwd: string,
  notify: PluginNoticeSink,
): Promise<LoadedPlugins> {
  // A teardown clears the registries when it finishes, so it has to finish before
  // this load registers anything — otherwise it would clear this session's
  // entries. Awaiting it here is what makes that impossible.
  const teardown = disposing;
  if (teardown !== null) {
    await teardown;
    if (disposing === teardown) disposing = null;
  }

  const disposers: Array<() => void | Promise<void>> = [];
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
    try {
      const dispose = await loadOne(plugin, pi, cwd);
      if (dispose !== undefined) disposers.push(dispose);
      loaded.push(plugin.name);
    } catch (error) {
      notify(
        `[cowboy] plugin "${plugin.name}" (${plugin.source}) could not load and was skipped: ${errorMessage(error)}`,
        "warning",
      );
    }
  }

  /**
   * This load's teardown, memoized so its body runs exactly once: a second call,
   * or a stale handle disposed after a later session, awaits the same pass
   * instead of running a disposer twice or clearing a registry that is no longer
   * this load's.
   */
  let ownTeardown: Promise<void> | undefined;
  const self: LoadedPlugins = {
    loaded,
    dispose: () => {
      ownTeardown ??= (async () => {
        // Stop being the live load the moment teardown begins: a session starting
        // now must load fresh plugins rather than adopt a dying handle whose
        // registrations are about to be cleared.
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
        // Unconditional, and safe: `startLoad` awaits this teardown before it
        // registers anything, so no other load's entries can be in the registry
        // while this pass runs.
        resetPluginHarnesses();
        resetPluginMultiplexers();
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
  onRegistered: (undo: () => void) => void,
): CowboyPluginApi {
  return {
    pi,
    cwd,
    registerHarness: (harness) => {
      const accepted = registerHarness(harness);
      if (accepted) onRegistered(() => unregisterHarness(harness.id));
      return accepted;
    },
    registerMultiplexer: (multiplexer) => {
      const accepted = registerMultiplexer(multiplexer);
      if (accepted) onRegistered(() => unregisterMultiplexer(multiplexer.id));
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
): Promise<(() => void | Promise<void>) | undefined> {
  const undo: Array<() => void> = [];
  const api = pluginApi(pi, cwd, (next) => undo.push(next));
  try {
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
  } catch (error) {
    // Reverse order, like a teardown: the last thing registered is undone first.
    for (const next of undo.reverse()) next();
    throw error;
  }
}
