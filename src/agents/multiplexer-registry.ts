/**
 * multiplexer-registry.ts — which multiplexer a session runs.
 *
 * A multiplexer is a `(pi) => ExecutionRuntime` under an id, and config's
 * `multiplexer` key prefers one by id. `createMultiplexerRegistry()` builds the
 * map a session resolves that id from; its built-in is seeded at construction,
 * exactly as a plugin's registration arrives, so there is one registry and no
 * caller can tell a built-in from a plugin by how it arrived. The map is a
 * closure of the object, so a session installs a fresh registry and the
 * previous session's plugin multiplexers cannot outlive it.
 *
 * Registration is id-keyed, so a plugin module's import order never decides
 * which multiplexer wins: the first registration for an id is kept and every later
 * one is refused with a warning.
 *
 * A multiplexer hosts a session only where it detects itself: every registration
 * answers `hosts()`, and `hosting()` collects the answers in registration order —
 * the built-in first, then plugins in package-name order. That answer decides
 * both whether a session runs at all (see session-runtime.ts) and which
 * multiplexer it runs, so a multiplexer nothing can detect never drives one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrRuntime } from "../infrastructure/herdr-host.js";
import {
  HERDR,
  getHostMultiplexer,
  multiplexerHosts,
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
 * The id config bakes in when it names no multiplexer: the built-in hosting this
 * process, the built-in otherwise. Config merges before any plugin registers, so
 * only the built-ins can answer this early; the session's own host answer comes
 * from the registry's `hosting()`.
 */
export function defaultMultiplexer(): AgentMultiplexer {
  return getHostMultiplexer() ?? BUILTIN_MULTIPLEXER;
}

/**
 * One registered multiplexer: an id, the environment it hosts, and the factory
 * that builds its runtime.
 */
export interface MultiplexerRegistration {
  /** How the `multiplexer` config key and a persisted address name this multiplexer. */
  readonly id: AgentMultiplexer;
  /**
   * Whether this process runs inside this multiplexer. Environment-only, like the
   * built-in detector: a multiplexer that cannot announce itself cannot host a
   * session, and a plugin's own answer is the only thing that can make its
   * multiplexer the host.
   */
  hosts(): boolean;
  /** Build the multiplexer's host + view + pane control + placements for one parent session. */
  create(pi: ExtensionAPI): ExecutionRuntime;
}

/** One session's multiplexers: the built-in plus whatever that session's plugins registered. */
export interface MultiplexerRegistry {
  /**
   * Register a multiplexer, answering whether it was accepted. The first
   * registration for an id is kept: a plugin that claims the built-in's id, or an
   * id another plugin already claimed in this session, is refused with a warning
   * and answered `false`.
   */
  register(registration: MultiplexerRegistration): boolean;
  /**
   * Forget one plugin multiplexer — the undo a plugin's own load needs when its
   * factory throws after registering. The built-in id is never removed, and
   * neither is an id this registry did not register.
   */
  unregister(id: AgentMultiplexer): void;
  /** Whether a multiplexer id is registered. */
  has(id: AgentMultiplexer): boolean;
  /**
   * Every registered multiplexer that hosts this process, in registration order:
   * the built-in first, then plugins in package-name order. Empty outside every
   * registered multiplexer — a session with no host launches nothing.
   */
  hosting(): readonly AgentMultiplexer[];
  /**
   * The multiplexer id a session runs: the configured one when it hosts this
   * process, otherwise the first host. The built-in is the last resort, and only
   * after `hosting()` has answered empty.
   */
  resolveId(configured: AgentMultiplexer): AgentMultiplexer;
  /**
   * Build the runtime a session runs. The one call a session makes to get its
   * multiplexer, so the config key and the registry can never disagree about
   * which multiplexer is live.
   *
   * A plugin multiplexer whose factory throws is not a session-ending condition:
   * it costs that multiplexer, and the session degrades to the built-in — the
   * same degrade-instead-of-fail rule an unregistered id follows. Only the
   * built-in failing is fatal, because there is nothing left to fall back to.
   *
   * The built-in it degrades to need not host this process, so the answer is not
   * the session's last word: a session checks it against `hosting()` and runs
   * nothing when the multiplexer it resolved to could not start.
   */
  runtime(pi: ExtensionAPI, configured: AgentMultiplexer): ExecutionRuntime;
}

/** The multiplexers one session runs with, seeded with the built-in. */
export function createMultiplexerRegistry(): MultiplexerRegistry {
  const registered = new Map<string, MultiplexerRegistration>();
  /** The ids this registry's plugins own, so `unregister` cannot remove another's. */
  const owned = new Set<string>();

  registered.set(BUILTIN_MULTIPLEXER, {
    id: BUILTIN_MULTIPLEXER,
    hosts: () => multiplexerHosts(BUILTIN_MULTIPLEXER),
    create: createHerdrRuntime,
  });

  /**
   * One registration's host answer. A multiplexer whose detection throws is not a
   * session-ending condition: it cannot host this process, and it is named.
   */
  const hostsProcess = (registration: MultiplexerRegistration): boolean => {
    try {
      return registration.hosts();
    } catch (error) {
      console.warn(
        `[subagents] multiplexer "${registration.id}" could not answer whether it hosts this process: ${errorMessage(error)}`,
      );
      return false;
    }
  };

  /** One multiplexer's runtime, or undefined when its factory threw or produced none. */
  const build = (
    id: AgentMultiplexer,
    pi: ExtensionAPI,
  ): ExecutionRuntime | undefined => {
    try {
      return registered.get(id)?.create(pi);
    } catch (error) {
      console.warn(
        `[subagents] multiplexer "${id}" failed to start: ${errorMessage(error)}`,
      );
      return undefined;
    }
  };

  const registry: MultiplexerRegistry = {
    register(registration) {
      const refusal =
        registration.id === BUILTIN_MULTIPLEXER
          ? "the built-in multiplexer owns that id"
          : registered.has(registration.id)
            ? "another plugin already registered that id in this load"
            : undefined;
      if (refusal !== undefined) {
        console.warn(
          `[subagents] Ignoring multiplexer "${registration.id}": ${refusal}`,
        );
        return false;
      }
      registered.set(registration.id, registration);
      owned.add(registration.id);
      return true;
    },
    unregister(id) {
      if (!owned.has(id)) return;
      registered.delete(id);
      owned.delete(id);
    },
    has(id) {
      return registered.has(id);
    },
    hosting() {
      return [...registered.values()]
        .filter(hostsProcess)
        .map((registration) => registration.id);
    },
    resolveId(configured) {
      const hosting = registry.hosting();
      if (hosting.includes(configured)) return configured;
      return hosting[0] ?? defaultMultiplexer();
    },
    runtime(pi, configured) {
      const id = registry.resolveId(configured);
      const runtime = build(id, pi);
      if (runtime !== undefined) return runtime;
      if (id === BUILTIN_MULTIPLEXER) {
        throw new Error(`the built-in multiplexer "${id}" produced no runtime`);
      }
      console.warn(
        `[subagents] multiplexer "${id}" produced no runtime; falling back to "${BUILTIN_MULTIPLEXER}"`,
      );
      const fallback = build(BUILTIN_MULTIPLEXER, pi);
      if (fallback === undefined) {
        throw new Error(
          `the built-in multiplexer "${BUILTIN_MULTIPLEXER}" produced no runtime`,
        );
      }
      return fallback;
    },
  };
  return registry;
}
