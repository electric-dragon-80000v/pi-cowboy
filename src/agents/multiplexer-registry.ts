/**
 * multiplexer-registry.ts — which multiplexer a session runs.
 *
 * A multiplexer is a `(pi) => ExecutionRuntime` under an id, and config's
 * the `multiplexer` key selects one by id. The built-in is registered below, at module
 * load, into the same map a plugin's registration writes to, so there is one
 * registry and no caller can tell a built-in from a plugin by how it arrived.
 *
 * Registration is id-keyed, so a plugin module's import order never decides
 * which multiplexer wins: the first registration for an id is kept and every later
 * one is refused with a warning. A configured id with no registration falls
 * back to the multiplexer hosting this process — the built-in one when nothing hosts
 * it — instead of failing the session, the same degrade-instead-of-fail rule the
 * harness setting follows.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrRuntime } from "../infrastructure/herdr-host.js";
import {
  HERDR,
  getHostMultiplexer,
  type HostMultiplexer,
} from "../host-multiplexer.js";
import { errorMessage } from "../utils.js";
import type { AgentMultiplexer, ExecutionRuntime } from "./agent-host.js";

/**
 * The built-in multiplexer this package ships, under the id a process running
 * inside it carries. A plugin may never claim it; a host multiplexer this package
 * does not build (a plugin's own) is the plugin's to register.
 */
export const BUILTIN_MULTIPLEXER: HostMultiplexer = HERDR;

/**
 * The multiplexer a session falls back to when `multiplexer` names one nothing
 * registered: the multiplexer hosting this process when there is one, the built-in
 * otherwise. A process inside a multiplexer always has that multiplexer available, so a
 * stale config degrades to the multiplexer that can actually run here rather than to
 * one that cannot.
 */
export function defaultMultiplexer(): AgentMultiplexer {
  return getHostMultiplexer() ?? BUILTIN_MULTIPLEXER;
}

/** One registered multiplexer: an id and the factory that builds its runtime. */
export interface MultiplexerRegistration {
  /** How the `multiplexer` config key and a persisted address name this multiplexer. */
  readonly id: AgentMultiplexer;
  /** Build the multiplexer's host + view + pane control + placements for one parent session. */
  create(pi: ExtensionAPI): ExecutionRuntime;
}

const MULTIPLEXER_REGISTRY = new Map<string, MultiplexerRegistration>();

/** The ids the current plugin load owns; forgotten with the load (see resetPluginMultiplexers). */
const PLUGIN_MULTIPLEXER_IDS = new Set<string>();

/**
 * Register a multiplexer, answering whether it was accepted. The first registration
 * for an id is kept: a plugin that claims the built-in's id, or an id another
 * plugin already claimed in this load, is refused with a warning and answered
 * `false`. The plugin loader resets the registry between loads
 * (`resetPluginMultiplexers`), so a plugin registering again after a session disposed
 * it is the first registration again rather than a duplicate.
 */
export function registerMultiplexer(
  registration: MultiplexerRegistration,
): boolean {
  const refusal =
    registration.id === BUILTIN_MULTIPLEXER
      ? "the built-in multiplexer owns that id"
      : MULTIPLEXER_REGISTRY.has(registration.id)
        ? "another plugin already registered that id in this load"
        : undefined;
  if (refusal !== undefined) {
    console.warn(
      `[subagents] Ignoring multiplexer "${registration.id}": ${refusal}`,
    );
    return false;
  }
  MULTIPLEXER_REGISTRY.set(registration.id, registration);
  PLUGIN_MULTIPLEXER_IDS.add(registration.id);
  return true;
}

/**
 * Forget one plugin multiplexer — the undo a plugin's own load needs when its factory
 * throws after registering. The built-in id is never removed, and neither is an
 * id this load did not register.
 */
export function unregisterMultiplexer(id: AgentMultiplexer): void {
  if (!PLUGIN_MULTIPLEXER_IDS.has(id)) return;
  MULTIPLEXER_REGISTRY.delete(id);
  PLUGIN_MULTIPLEXER_IDS.delete(id);
}

/**
 * Forget every plugin multiplexer, leaving the built-in. The plugin loader calls this
 * when it tears a load down, so the next load registers into a clean registry
 * instead of colliding with the previous session's entries.
 */
export function resetPluginMultiplexers(): void {
  for (const id of PLUGIN_MULTIPLEXER_IDS) MULTIPLEXER_REGISTRY.delete(id);
  PLUGIN_MULTIPLEXER_IDS.clear();
}

/**
 * The built-in multiplexer, registered at module load exactly as a plugin multiplexer is:
 * one registration path, so a session resolves its multiplexer from the registry
 * alone and no composition root has to remember to wire the default in.
 */
MULTIPLEXER_REGISTRY.set(BUILTIN_MULTIPLEXER, {
  id: BUILTIN_MULTIPLEXER,
  create: createHerdrRuntime,
});

/** Whether a multiplexer id is registered. */
export function hasMultiplexer(id: AgentMultiplexer): boolean {
  return MULTIPLEXER_REGISTRY.has(id);
}

/**
 * The multiplexer id a session runs: the configured one when it is registered, the
 * multiplexer hosting this process otherwise. A config that names a multiplexer this
 * machine lacks degrades to the multiplexer that can run here rather than leaving
 * the session without one.
 */
export function resolveMultiplexerId(
  configured: AgentMultiplexer,
): AgentMultiplexer {
  return hasMultiplexer(configured) ? configured : defaultMultiplexer();
}

/**
 * Build the runtime a session runs: the configured multiplexer when it is registered,
 * the multiplexer hosting this process otherwise. The one call a session makes to get
 * its multiplexer, so the config key and the registry can never disagree about which
 * multiplexer is live.
 *
 * A plugin multiplexer whose factory throws is not a session-ending condition: it
 * costs that multiplexer, and the session degrades to the built-in — the same
 * degrade-instead-of-fail rule an unregistered id follows. Only the built-in
 * failing is fatal, because there is nothing left to fall back to.
 */
export function multiplexerRuntime(
  pi: ExtensionAPI,
  configured: AgentMultiplexer,
): ExecutionRuntime {
  const id = resolveMultiplexerId(configured);
  const runtime = buildMultiplexer(id, pi);
  if (runtime !== undefined) return runtime;
  if (id === BUILTIN_MULTIPLEXER) {
    throw new Error(`the built-in multiplexer "${id}" produced no runtime`);
  }
  console.warn(
    `[subagents] multiplexer "${id}" produced no runtime; falling back to "${BUILTIN_MULTIPLEXER}"`,
  );
  const fallback = buildMultiplexer(BUILTIN_MULTIPLEXER, pi);
  if (fallback === undefined) {
    throw new Error(
      `the built-in multiplexer "${BUILTIN_MULTIPLEXER}" produced no runtime`,
    );
  }
  return fallback;
}

/** One multiplexer's runtime, or undefined when its factory threw or produced none. */
function buildMultiplexer(
  id: AgentMultiplexer,
  pi: ExtensionAPI,
): ExecutionRuntime | undefined {
  try {
    return MULTIPLEXER_REGISTRY.get(id)?.create(pi);
  } catch (error) {
    console.warn(
      `[subagents] multiplexer "${id}" failed to start: ${errorMessage(error)}`,
    );
    return undefined;
  }
}
