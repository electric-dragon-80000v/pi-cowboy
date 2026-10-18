/**
 * session-runtime.ts — what a session loads once its config is in: the plugins
 * that register harnesses and multiplexers, the multiplexer the config selected,
 * and the probe that decides which harnesses this machine can launch.
 *
 * It exists as its own step so events.ts stays the lifecycle wiring it is: the
 * order inside is load-bearing (plugins register before anything resolves a
 * harness or a multiplexer, and the probe runs after plugins so a plugin harness is
 * offered like a built-in), and a caller that got the order wrong could not tell
 * from the outside.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  multiplexerRuntime,
  hasMultiplexer,
} from "./agents/multiplexer-registry.js";
import { harnessIds } from "./agents/harness/registry.js";
import type { ExecutionRuntime } from "./agents/agent-host.js";
import { loadPlugins, type LoadedPlugins } from "./plugin/loader.js";
import {
  prefetchHarnessModels,
  startHarnessAvailabilityProbe,
} from "./harness-availability-launch.js";
import { getStore, setRuntime } from "./shell.js";

/** What bringing the session runtime up hands back. */
export interface SessionRuntimeBoot {
  readonly plugins: LoadedPlugins;
  /**
   * The session's one multiplexer. Returned rather than only recorded so the manager
   * can be wired from it (see createAgentManagerTransport) instead of resolving
   * it again per call.
   */
  readonly runtime: ExecutionRuntime;
}

/**
 * Bring up the session's runtime: load plugins, build the configured multiplexer and
 * record it, then probe the harness vocabulary (notices go to the UI) and start
 * warming slow model lists. Returns the plugin load so its disposers can run at
 * shutdown, and the runtime so the manager is wired from the same one.
 */
export async function startSessionRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<SessionRuntimeBoot> {
  // Plugins register their harnesses and multiplexers before anything resolves one;
  // a plugin that fails to load is skipped with a warning, never fatal.
  const plugins = await loadPlugins(pi, ctx.cwd, (message, kind) => {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  });
  // The session's multiplexer: the configured multiplexer (a plugin's) or the built-in.
  const runtime = multiplexerRuntime(pi, getStore().multiplexer);
  setRuntime(runtime);
  // Configured ids nothing registered: validation cannot see this (config loads
  // before plugins register), and silence would let a typo pass for a fallback.
  reportUnregisteredConfig(ctx);
  // Which harnesses this machine can launch — plugin harnesses included, now
  // that they have registered — decides which stay on offer.
  const probe = startHarnessAvailabilityProbe();
  if (ctx.hasUI) {
    for (const notice of probe.notices) ctx.ui.notify(notice, "warning");
  }
  // Slow model lists start warming now, never awaited; every later listing joins
  // whatever its harness started.
  prefetchHarnessModels(pi);
  return { plugins, runtime };
}

/**
 * Report configured harness and multiplexer ids that nothing registered. Config loads
 * before plugins do, so validation cannot check registration; without this the
 * id is silently ignored — the launch just falls back to pi, or to the multiplexer
 * hosting the process — with no line saying why.
 */
function reportUnregisteredConfig(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const store = getStore();
  const known = new Set(harnessIds());
  const unknown = store
    .configuredHarnessIds()
    .filter((id) => !known.has(id))
    .map((id) => `harness "${id}"`);
  if (!hasMultiplexer(store.multiplexer)) {
    unknown.push(`multiplexer "${store.multiplexer}"`);
  }
  if (unknown.length === 0) return;
  ctx.ui.notify(
    `[cowboy] nothing registered for ${unknown.join(", ")}; those settings are ignored and the launch falls back to the default.`,
    "warning",
  );
}
