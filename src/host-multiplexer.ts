/**
 * host-multiplexer.ts — which execution multiplexer this process is running inside.
 *
 * The extension has panes to launch subagents into only when something is
 * hosting it, so activation is gated on the answer here rather than on a
 * boolean about one multiplexer: a second multiplexer adds a member to `HOST_MULTIPLEXERS`
 * and a branch to the detector below, and every reader follows without a second
 * list to keep in step.
 *
 * Detection is environment-only and per-multiplexer — a multiplexer that cannot announce
 * itself cannot host a session — and the answer is `undefined` outside every
 * multiplexer rather than a default, so "not hosted at all" stays distinct from
 * "hosted by the built-in".
 */

import { assertNever } from "./utils.js";

/** The herdr multiplexer: the built-in multiplexer this package ships, and the id its addresses carry. */
export const HERDR = "herdr";

/**
 * Every multiplexer this process can be detected to run inside, in detection order.
 * The union derives from this list, so a member added here is a `HostMultiplexer`
 * everywhere at once. Each member is also a valid `AgentMultiplexer` id (see
 * agents/agent-host.ts): the multiplexer a process runs inside is one the extension
 * can register a runtime for.
 */
export const HOST_MULTIPLEXERS = [HERDR] as const;

/** One member of `HOST_MULTIPLEXERS`. */
export type HostMultiplexer = (typeof HOST_MULTIPLEXERS)[number];

/** The variable herdr sets in every process it starts. */
const HERDR_ENV_VAR = "HERDR_ENV";

/**
 * Whether `multiplexer` announces itself in a process it started. One branch per
 * multiplexer, exhaustive over `HostMultiplexer`: a new member fails to compile here until
 * it says how it is detected, so "we added a multiplexer" and "we can detect that
 * multiplexer" can never drift apart.
 */
function isHosting(multiplexer: HostMultiplexer): boolean {
  switch (multiplexer) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- one multiplexer today, so this comparison is literal-vs-literal; it stops being one as soon as a second member lands, and making that land here is the point of the switch.
    case HERDR:
      return process.env[HERDR_ENV_VAR] === "1";
    default:
      return assertNever(multiplexer);
  }
}

/**
 * Which multiplexer hosts this process, or `undefined` when none does. herdr marks
 * the processes in its panes with `HERDR_ENV=1`; a multiplexer added later detects
 * itself the same way, in this one place.
 */
export function getHostMultiplexer(): HostMultiplexer | undefined {
  return HOST_MULTIPLEXERS.find((multiplexer) => isHosting(multiplexer));
}
