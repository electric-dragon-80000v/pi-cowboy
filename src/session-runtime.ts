/**
 * session-runtime.ts — what a session loads once its config is in: the plugins
 * that register harnesses and multiplexers, the multiplexer the config selected,
 * and the probe that decides which harnesses this machine can launch.
 *
 * It exists as its own step so events.ts stays the lifecycle wiring it is: the
 * order inside is load-bearing (the session's registries come first, plugins
 * register into them before anything resolves a harness or a multiplexer, and
 * the probe runs after plugins so a plugin harness is offered like a built-in),
 * and a caller that got the order wrong could not tell from the outside.
 *
 * The host question is answered here, not at the entry point: only once this
 * session's plugins have registered their multiplexers can anything ask which of
 * them is hosting the process.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionRuntime } from "./agents/agent-host.js";
import type { HarnessRegistry } from "./agents/harness/harness-registry.js";
import type { MultiplexerRegistry } from "./agents/multiplexer-registry.js";
import { createPluginLoader, type LoadedPlugins } from "./plugin/loader.js";
import {
  prefetchHarnessModels,
  startHarnessAvailabilityProbe,
} from "./harness-availability-launch.js";
import { NO_HOST_REASON } from "./host-multiplexer.js";
import { getStore, installSessionRegistries, setRuntime } from "./shell.js";

/** What bringing the session runtime up hands back. */
export type SessionRuntimeBoot =
  | {
      readonly kind: "hosted";
      readonly plugins: LoadedPlugins;
      /**
       * The session's one multiplexer. Returned rather than only recorded so the manager
       * can be wired from it (see createAgentManagerTransport) instead of resolving
       * it again per call.
       */
      readonly runtime: ExecutionRuntime;
    }
  | {
      readonly kind: "unhosted";
      readonly plugins: LoadedPlugins;
      /** Why this session can launch no agent; reported before its tools go inactive. */
      readonly reason: string;
    };

/**
 * Bring up the session's runtime: install the session's registries, load plugins
 * into them, ask which registered multiplexer hosts this process, then either
 * build it and record it and probe the harness vocabulary (notices go to the UI)
 * and start warming slow model lists, or answer that nothing can host this
 * process. Returns the plugin load so its disposers can run at shutdown, and —
 * when hosted — the runtime so the manager is wired from the same one.
 */
export async function startSessionRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<SessionRuntimeBoot> {
  // A session's vocabulary starts at the built-ins; only this session's plugins
  // add to it, so nothing a previous session registered can answer here.
  const registries = installSessionRegistries();
  // Plugins register their harnesses and multiplexers before anything resolves one;
  // a plugin that fails to load is skipped with a warning, never fatal.
  const plugins = await createPluginLoader(registries).load(
    pi,
    ctx.cwd,
    (message, kind) => {
      if (ctx.hasUI) ctx.ui.notify(message, kind);
    },
  );
  // Validate harness configuration sections now that all plugin codecs are
  // registered.
  const store = getStore();
  registries.harnesses.validateConfigs(
    store.harnessConfigLayers(),
    (id, issue) => store.reportHarnessConfigIssue(id, issue),
  );
  // Report configured harness IDs that do not match any registered harness.
  reportUnregisteredConfig(ctx, registries);
  // The multiplexers that detect this process, plugin ones included; a session
  // runs only inside one of them.
  const hosting = registries.multiplexers.hosting();
  if (hosting.length === 0) {
    return { kind: "unhosted", plugins, reason: NO_HOST_REASON };
  }
  // The session's multiplexer: the configured one when it hosts this process,
  // the first host otherwise (see multiplexer-registry.ts).
  const runtime = registries.multiplexers.runtime(pi, getStore().multiplexer);
  // The host the session resolved to could not start, and the built-in is no
  // substitute for a multiplexer that does not host this process.
  if (!hosting.includes(runtime.multiplexer)) {
    return { kind: "unhosted", plugins, reason: NO_HOST_REASON };
  }
  setRuntime(runtime);
  // Which harnesses this machine can launch — plugin harnesses included, now
  // that they have registered — decides which stay on offer.
  const probe = startHarnessAvailabilityProbe();
  if (ctx.hasUI) {
    for (const notice of probe.notices) ctx.ui.notify(notice, "warning");
  }
  // Slow model lists start warming now, never awaited; every later listing joins
  // whatever its harness started.
  prefetchHarnessModels(pi);
  return { kind: "hosted", plugins, runtime };
}

/**
 * Report configured harness and multiplexer ids that nothing registered. Config loads
 * before plugins do, so validation cannot check registration; without this the
 * id is silently ignored — the launch just falls back to pi, or to the multiplexer
 * hosting the process — with no line saying why.
 */
function reportUnregisteredConfig(
  ctx: ExtensionContext,
  registries: {
    readonly harnesses: HarnessRegistry;
    readonly multiplexers: MultiplexerRegistry;
  },
): void {
  if (!ctx.hasUI) return;
  const store = getStore();
  const known = new Set(registries.harnesses.ids());
  const unknown = store
    .configuredHarnessIds()
    .filter((id) => !known.has(id))
    .map((id) => `harness "${id}"`);
  if (!registries.multiplexers.has(store.multiplexer)) {
    unknown.push(`multiplexer "${store.multiplexer}"`);
  }
  if (unknown.length === 0) return;
  ctx.ui.notify(
    `[cowboy] nothing registered for ${unknown.join(", ")}; those settings are ignored and the launch falls back to the default.`,
    "warning",
  );
}
