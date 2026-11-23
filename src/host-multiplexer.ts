/**
 * host-multiplexer.ts — which execution multiplexer this process is running inside.
 *
 * The extension has panes to launch subagents into only when something hosts it.
 * Which built-in multiplexer does, is answered here rather than by a boolean
 * about one of them: a second built-in adds a member to `HOST_MULTIPLEXERS` and a
 * branch to the detector below, and every reader follows without a second list to
 * keep in step. A plugin multiplexer never appears here: the session resolves it
 * from the registry once plugins have loaded (see session-runtime.ts).
 *
 * Detection is environment-only and per-multiplexer — a built-in multiplexer that
 * cannot announce itself cannot host a session — and the answer is `undefined`
 * outside every built-in multiplexer rather than a default, so "not hosted at
 * all" stays distinct from "hosted by the built-in".
 */

import { assertNever } from "./utils.js";

/** The legacy herdr multiplexer (the `herdr` CLI), and the id its addresses carry. */
export const HERDR = "herdr";

/**
 * herdr-core, the terminal core behind Herdr Desktop (the `hc` CLI), and the id
 * its addresses carry.
 */
export const HERDR_CORE = "herdr-core";

/**
 * Every multiplexer this process can be detected to run inside, in detection order.
 * The union derives from this list, so a member added here is a `HostMultiplexer`
 * everywhere at once. Each member is also a valid `AgentMultiplexer` id (see
 * agents/agent-host.ts): the multiplexer a process runs inside is one the extension
 * can register a runtime for.
 */
export const HOST_MULTIPLEXERS = [HERDR, HERDR_CORE] as const;

/** One member of `HOST_MULTIPLEXERS`. */
export type HostMultiplexer = (typeof HOST_MULTIPLEXERS)[number];

/** The variable herdr sets in every process it starts. */
const HERDR_ENV_VAR = "HERDR_ENV";

/**
 * The variable herdr-core sets in every terminal it runs: that terminal's own
 * address, which is also the parent a child started from it is recorded under.
 */
export const HC_TERMINAL_ID_VAR = "HC_TERMINAL_ID";

/** The address of the herdr-core terminal this process runs in, or undefined outside one. */
export function hcTerminalId(): string | undefined {
  const value = process.env[HC_TERMINAL_ID_VAR];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Whether `multiplexer` announces itself in a process it started. One branch per
 * multiplexer, exhaustive over `HostMultiplexer`: a new member fails to compile here until
 * it says how it is detected, so "we added a multiplexer" and "we can detect that
 * multiplexer" can never drift apart.
 */
function isHosting(multiplexer: HostMultiplexer): boolean {
  switch (multiplexer) {
    case HERDR:
      return process.env[HERDR_ENV_VAR] === "1";
    // A legacy herdr pane is the nearer host whenever both are set: a herdr
    // session run inside an herdr-core terminal hands its panes the terminal's
    // address too, and a child parented on that terminal would be filed under
    // the herdr session rather than under the chat that started it.
    case HERDR_CORE:
      return process.env[HERDR_ENV_VAR] !== "1" && hcTerminalId() !== undefined;
    default:
      return assertNever(multiplexer);
  }
}

/** Whether `multiplexer` announces itself in this process; one answer per built-in. */
export function multiplexerHosts(multiplexer: HostMultiplexer): boolean {
  return isHosting(multiplexer);
}

/**
 * Which multiplexer hosts this process, or `undefined` when none does. herdr marks
 * the processes in its panes with `HERDR_ENV=1`; herdr-core gives each terminal
 * its address in `HC_TERMINAL_ID`.
 */
export function getHostMultiplexer(): HostMultiplexer | undefined {
  return HOST_MULTIPLEXERS.find(multiplexerHosts);
}

/**
 * Why a session runs no agents: no registered multiplexer detects itself as
 * hosting this process. A plugin multiplexer answers that question for itself
 * (see multiplexer-registry.ts), so a session inside one never reaches this
 * reason.
 */
export const NO_HOST_REASON =
  "Warning: pi-cowboy is disabled. Run pi inside herdr, a Herdr Desktop (herdr-core) terminal, or a compatible multiplexer plugin you have installed";
