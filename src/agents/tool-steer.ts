/**
 * tool-steer.ts — steer_cowboy_agent tool implementation.
 *
 * Delivers one message to every id in `agent_ids` (a spawned agent queues it
 * before its next model call; a settled one is revived for another
 * completion). Delivery is fire-and-forget; refusals are reported, never
 * thrown — a throw inside one item is caught and reported as that item's
 * refusal, so only a malformed call fails outright.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatActiveAgents } from "../orchestrators/protocol.js";
import { getManager } from "../shell.js";
import { lifecycleStatus } from "../types.js";
import { errorMessage } from "../utils.js";
import type { SteerOutcome } from "./subagent-session.js";
import type { SteerBatchParams } from "./schemas/steer-batch.schema.js";
import { runBatch, type BatchItem } from "./batch.js";
import type { ToolResult } from "./tool-result.js";

/** One id's outcome in a steer batch: delivery and refusal are data, never throws, so a batch can partially succeed. */
export type SteerItemOutcome =
  | { kind: "delivered"; agentId: string }
  /** The pane took the message; the second turn will not report back. */
  | { kind: "delivered-not-revived"; agentId: string; reason: string }
  | { kind: "refused"; agentId: string; reason: string };

/**
 * steer_cowboy_agent handler. Delivers `message` to every id in `agent_ids`
 * sequentially in input order — delivery shares pane state, so items never
 * run in parallel. Best effort: one id's refusal (a queued agent has no
 * pane; a cleaned-up agent is gone) never blocks the rest. `agent_ids` is
 * non-empty by the schema boundary; whole-call throws (before anything is
 * delivered) only for a repeated id or a blank message.
 */
export async function executeSteerAgentTool(
  _toolCallId: string,
  params: SteerBatchParams,
  _signal: AbortSignal | undefined,
  _onUpdate:
    ((update: ToolResult<{ agents: SteerItemOutcome[] }>) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<ToolResult<{ agents: SteerItemOutcome[] }>> {
  const message = params.message.trim();

  return runBatch({
    toolName: "steer_cowboy_agent",
    param: "agent_ids",
    detailsKey: "agents",
    items: params.agent_ids,
    prepare: () => {
      if (message === "") {
        throw new Error("message is required");
      }
    },
    handleItem: async (agentId): Promise<BatchItem<SteerItemOutcome>> => {
      const spawn = getManager().getSpawn(agentId);
      if (!spawn) {
        const reason = `not found. Active agents: ${formatActiveAgents()}`;
        return {
          outcome: { kind: "refused", agentId, reason },
          text: `Agent ${agentId} was not steered: ${reason}`,
        };
      }

      // Capture before delivery: the refusal text must name the state the
      // message reached, which delivery is about to change.
      const status = lifecycleStatus(spawn.lifecycle);
      let outcome: SteerOutcome;
      try {
        outcome = await getManager().steer(agentId, message);
      } catch (error) {
        // Nothing has reached the pane yet: a refusal is the honest verdict,
        // and one id's failure never takes the rest of the batch with it.
        outcome = {
          kind: "refused",
          reason: `steering failed: ${errorMessage(error)}`,
        };
      }
      if (outcome.kind === "refused") {
        return {
          outcome: { kind: "refused", agentId, reason: outcome.reason },
          text: `Agent ${agentId} was not steered (${status}): ${outcome.reason}`,
        };
      }
      if (outcome.kind === "delivered-not-revived") {
        return {
          outcome: {
            kind: "delivered-not-revived",
            agentId,
            reason: outcome.reason,
          },
          text: `Agent ${agentId} had settled (${status}) and the message reached its pane, but it was not revived: ${outcome.reason}`,
        };
      }
      // Read the lifecycle after delivery: a revive re-projects the spawn to
      // `spawned`, so revival is what the arrival status was not and what
      // delivery left behind.
      const revived =
        status !== "spawned" && spawn.lifecycle.phase === "spawned";
      return {
        outcome: { kind: "delivered", agentId },
        text: revived
          ? `Agent ${agentId} had settled (${status}) — revived: the message was delivered to its pane and the agent is spawned again. Merge nothing yet; a new completion message will arrive when it settles again.`
          : status === "spawned"
            ? `Message delivered to spawned agent ${agentId}. Delivery is fire-and-forget — the agent picks it up on its next turn; its next completion message will report the result.`
            : `Agent ${agentId} was delivered to (${status}), but it was not revived — it has no process left to act on the message.`,
      };
    },
  });
}
