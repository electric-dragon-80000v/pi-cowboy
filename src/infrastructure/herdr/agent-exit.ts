/**
 * agent-exit.ts — Layer 3: confirm that herdr no longer hosts an agent.
 *
 * The harness owns how its process is asked to exit: its TUI keybindings travel
 * through the multiplexer's `PaneControl`, so no listener here guesses a
 * sequence. This module owns only the confirmation — a stop is never reported
 * done until herdr's registry agrees the agent is gone — and never closes the
 * pane, because worktree removal after a stop needs the placement to survive.
 * Only called for an explicit stop, never while admitting a spawn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrAgents } from "./agents.js";
import { HerdrTransport } from "./herdr-transport.js";
import { keepPolling, pollUntil, settled } from "./polling.js";

/** Registry-gone confirmation window (ms). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Registry-gone probe interval (ms). */
const GONE_POLL_INTERVAL_MS = 1_000;

/** `waitForAgentGone` knobs. */
export interface WaitForAgentGoneOptions {
  /** Registry-gone confirmation window (ms). */
  timeoutMs?: number;
}

/** Confirms agent absence in herdr's registry; it never sends a key. */
export class HerdrAgentExit {
  constructor(private readonly agents: HerdrAgents) {}

  /** True once herdr's registry no longer lists the agent on `paneId`. */
  async waitForAgentGone(
    paneId: string,
    opts?: WaitForAgentGoneOptions,
  ): Promise<boolean> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const gone = await pollUntil<true>(
      async () => {
        try {
          // Only an empty response confirms absence; a failed probe is unknown.
          if (!(await this.agents.getAgentInfo(paneId))) return settled(true);
        } catch {
          // A transient CLI/server failure authorizes no replacement launch.
        }
        return keepPolling();
      },
      { intervalMs: GONE_POLL_INTERVAL_MS, timeoutMs },
    );
    return gone ?? false;
  }
}

/** Exit state machine over the shared transport for one pi instance. */
export function createHerdrAgentExit(pi: ExtensionAPI): HerdrAgentExit {
  const transport = new HerdrTransport(pi);
  return new HerdrAgentExit(new HerdrAgents(transport));
}

export async function waitForAgentGone(
  pi: ExtensionAPI,
  paneId: string,
  opts?: WaitForAgentGoneOptions,
): Promise<boolean> {
  return createHerdrAgentExit(pi).waitForAgentGone(paneId, opts);
}
