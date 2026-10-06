/**
 * agent-stopper.ts — Layer 3: interrupt, then confirm the agent is gone.
 *
 * One invariant: a stop is never reported done until herdr's registry agrees the
 * agent is gone. Interrupt first (best effort) so pi can exit on its own and
 * leave the pane reusable; the pane is never closed (worktree removal after a
 * stop needs the placement to survive). Only called for an explicit stop — never
 * on its own, never while admitting a spawn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrAgents } from "./agents.js";
import { HerdrTransport } from "./herdr-transport.js";
import { keepPolling, pollUntil, settled } from "./polling.js";

/** Interrupt grace window (ms). */
const DEFAULT_INTERRUPT_GRACE_MS = 8_000;

/** Registry-gone confirmation window after the grace window (ms). */
const DEFAULT_CONFIRM_MS = 15_000;

/** Registry-gone probe interval (ms). */
const GONE_POLL_INTERVAL_MS = 1_000;

/** `stopAgentAndWait` knobs. */
export interface StopAgentOptions {
  /** Interrupt grace window (ms). */
  interruptGraceMs?: number;
  /** Registry-gone confirmation window after the grace window (ms). */
  confirmMs?: number;
}

/**
 * Stop agents until herdr's registry confirms them gone. The pane id is the only
 * reliable agent target (herdr 0.8.x drops the custom `agent start` name).
 */
export class HerdrAgentStopper {
  constructor(private readonly agents: HerdrAgents) {}

  /** Stop the agent on `paneId`; true when the registry confirmed it gone. */
  async stopAgentAndWait(
    paneId: string,
    opts?: StopAgentOptions,
  ): Promise<boolean> {
    const interruptGraceMs =
      opts?.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    const confirmMs = opts?.confirmMs ?? DEFAULT_CONFIRM_MS;

    await this.agents.interruptAgent(paneId);

    if (await this.waitUntilAgentGone(paneId, interruptGraceMs)) return true;

    return this.waitUntilAgentGone(paneId, confirmMs);
  }

  /** True once herdr's registry no longer lists the agent on `paneId`. */
  private async waitUntilAgentGone(
    paneId: string,
    timeoutMs: number,
  ): Promise<boolean> {
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

/** Kill state machine over the shared transport for one pi instance. */
export function createHerdrAgentStopper(pi: ExtensionAPI): HerdrAgentStopper {
  const transport = new HerdrTransport(pi);
  return new HerdrAgentStopper(new HerdrAgents(transport));
}

export async function stopAgentAndWait(
  pi: ExtensionAPI,
  paneId: string,
  opts?: StopAgentOptions,
): Promise<boolean> {
  return createHerdrAgentStopper(pi).stopAgentAndWait(paneId, opts);
}
