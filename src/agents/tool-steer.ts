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
import { COWBOY_TOOLS, CONSTRAINED_SAMPLING } from "../cowboy-tools.js";
import { formatActiveAgents } from "../orchestrators/protocol.js";
import { getManager } from "../shell.js";
import { lifecycleStatus } from "../types.js";
import { errorMessage } from "../utils.js";
import type { SteerOutcome } from "./subagent-session.js";
import {
  SteerBatchSchema,
  type SteerBatchParams,
} from "./schemas/steer-batch.schema.js";
import { runBatch, type BatchItem } from "./batch.js";
import type { ToolResult, ToolSeverity } from "./tool-result.js";

/** The steer tool: one message, every id in input order. */
export const steerAgentTool = {
  name: COWBOY_TOOLS.steerAgent,
  label: COWBOY_TOOLS.steerAgent,
  description:
    "Send one message to one or more agents in one call: pass every id in `agent_ids` and the single `message` delivered to each. Each id is handled independently in input order — delivered, or refused with its reason — and one id's refusal never blocks the rest. A repeated id in `agent_ids` is rejected before anything is delivered — pass each id once. A spawned agent receives the message before its next model call; a SETTLED one is REVIVED — spawned again, given the message, and it sends you another completion message when it settles again. That second result arrives only as that completion message: the spawn's result promise closed with the first turn and never opens again. Delivery is fire-and-forget: nothing here waits for an agent to act on it, so do not poll for a reply. The message is entered into the agent's pi session, so it can also be a bash command: `!command` runs the command and sends its output to the agent's context; `!!command` runs it without adding the output to the agent's context. A QUEUED agent cannot be steered — it has no pane yet; wait for a concurrency slot first. An agent whose pane is gone (cleaned up) cannot be steered either, and neither can an agent being TORN DOWN (wait for its report) or handed over (wait for the handover to finish). Every refusal states its reason and what to do about it.",
  parameters: SteerBatchSchema,
  execute: executeSteerAgentTool,
  constrainedSampling: CONSTRAINED_SAMPLING,
};

/**
 * How one steer outcome reads: only a delivered message is a success. A
 * message that reached a pane the agent cannot act on, and a refusal, both
 * leave the requested work undone.
 */
export function steerSeverity(outcome: SteerItemOutcome): ToolSeverity {
  switch (outcome.kind) {
    case "delivered":
      return "success";
    case "delivered-not-revived":
    case "refused":
      return "warning";
  }
}

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
    severity: steerSeverity,
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
