/**
 * tool-execution.ts — Pi-facing tool adapter: validates params into a
 * delegation intent and wraps the dual payload as a `ToolResult`.
 *
 * - `executeAgentTool`: the cowboy_agent handler. Each call dispatches one or
 *   more spawns through the batch runner in `src/orchestrators/protocol.ts`;
 *   single-item runs with `run_in_background: false` block until the agent
 *   settles and return its inline result, every other shape returns a
 *   background acknowledgement.
 * - `executeStopAgentTool`: the stop_cowboy_agent handler.
 * - `toolCallListener`: injects the configured model/thinking level per item.
 */

import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import { COWBOY_TOOLS, CONSTRAINED_SAMPLING } from "../cowboy-tools.js";
import { isActivePhase, lifecycleStatus, type AgentStatus } from "../types.js";
import {
  CONFIGURED_MODEL_KEY,
  CONFIGURED_THINKING_KEY,
  readModelKey,
} from "../models/model-request.js";
import { getManager, getStore } from "../shell.js";
import {
  formatActiveAgents,
  runDelegationBatch,
} from "../orchestrators/protocol.js";
import type { CowboyAgents } from "./schemas/cowboy-agents.schema.js";
import {
  StopBatchSchema,
  type StopBatchParams,
} from "./schemas/stop-batch.schema.js";
import { getAgentConfig } from "./agent-types.js";
import {
  requestedHarnessId,
  resolveAgentTypeParam,
  resolveHarnessType,
} from "./spawn-defaults.js";
import { runBatch } from "./batch.js";
import {
  foldSeverity,
  resultWithSeverity,
  type ToolResult,
  type ToolSeverity,
} from "./tool-result.js";

/**
 * How a delegation call reads. A spawn acknowledgement — background or queued
 * — is a success, and so is a foreground run that completed; a foreground run
 * that ended stopped is a refusal. A foreground run that failed throws before
 * it produces a result.
 */
export function delegationSeverity(
  details: Record<string, unknown>,
): ToolSeverity {
  const agents = Array.isArray(details.agents) ? details.agents : [];
  return foldSeverity(
    agents.map((agent) =>
      typeof agent === "object" &&
      agent !== null &&
      (agent as { status?: unknown }).status === "stopped"
        ? "warning"
        : "success",
    ),
  );
}

/**
 * cowboy_agent handler. Validates the call shape and dispatches one spawn per
 * item in `agents`. A non-background call requires exactly one item — the
 * guard lives in `runDelegationBatch` so it fires before any side effect.
 */
export async function executeAgentTool(
  _toolCallId: string,
  params: CowboyAgents,
  signal: AbortSignal | undefined,
  _onUpdate:
    ((update: ToolResult<Record<string, unknown>>) => void) | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult<Record<string, unknown>>> {
  const { message, details } = await runDelegationBatch(
    params,
    ctx,
    _toolCallId,
    signal,
  );
  return resultWithSeverity(delegationSeverity(details), message, details);
}

/** The stop tool: one batch line per call, rendered as a single icon line. */
export const stopAgentTool = {
  name: COWBOY_TOOLS.stopAgent,
  label: COWBOY_TOOLS.stopAgent,
  description:
    "Stop one or more active agents in one call: pass every id in `agent_ids`. Each id is handled independently in input order — stopped, reported as already settled, or reported unknown — and one id's outcome never blocks the rest. A repeated id in `agent_ids` is rejected before anything is stopped — pass each id once. Stopping interrupts the pi process (its pane is left in place) and settles the agent as stopped. Nothing is removed — the worktree and branch are preserved.",
  parameters: StopBatchSchema,
  execute: executeStopAgentTool,
  constrainedSampling: CONSTRAINED_SAMPLING,
};

/** One id's outcome in a stop batch: stopped and refused states are data, never throws, so a batch can partially succeed. */
export type StopItemOutcome =
  | { kind: "stopped"; agentId: string }
  | {
      kind: "already-settled";
      agentId: string;
      status: AgentStatus;
      activeAgents: string;
    }
  | { kind: "unknown"; agentId: string; activeAgents: string }
  /** The call was not attempted: another operation owns the agent right now. */
  | { kind: "refused"; agentId: string; reason: string }
  | { kind: "failed"; agentId: string; error: string };

/**
 * How one stop outcome reads: a run that was not stopped — because it had
 * already settled, was unknown, or another operation owns it — is a refusal to
 * report, not a failure.
 */
export function stopSeverity(outcome: StopItemOutcome): ToolSeverity {
  switch (outcome.kind) {
    case "stopped":
      return "success";
    case "failed":
      return "error";
    case "already-settled":
    case "unknown":
    case "refused":
      return "warning";
  }
}

/** Per-item result line the model reads back, in input order. */
export function renderStopOutcome(outcome: StopItemOutcome): string {
  switch (outcome.kind) {
    case "stopped":
      return `Stopped agent ${outcome.agentId}`;
    case "already-settled":
      return `Agent ${outcome.agentId} is already ${outcome.status}. Active agents: ${outcome.activeAgents}`;
    case "unknown":
      return `Agent ${outcome.agentId} not found. Active agents: ${outcome.activeAgents}`;
    case "refused":
      return `Agent ${outcome.agentId} was not stopped: ${outcome.reason}`;
    case "failed":
      return `Failed to stop agent ${outcome.agentId}: ${outcome.error}`;
  }
}

/**
 * stop_cowboy_agent handler. Stops every id in `agent_ids` sequentially in
 * input order — teardown shares herdr/git state, so items never run in
 * parallel. Best effort: one id's outcome never blocks the rest. `agent_ids`
 * is non-empty by the schema boundary; whole-call throws (before anything is
 * stopped) only for a repeated id.
 */
export async function executeStopAgentTool(
  _toolCallId: string,
  params: StopBatchParams,
  _signal: AbortSignal | undefined,
  _onUpdate:
    ((update: ToolResult<{ agents: StopItemOutcome[] }>) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<ToolResult<{ agents: StopItemOutcome[] }>> {
  const agentIds = params.agent_ids;

  return runBatch({
    toolName: "stop_cowboy_agent",
    param: "agent_ids",
    detailsKey: "agents",
    items: agentIds,
    render: renderStopOutcome,
    severity: stopSeverity,
    handleItem: async (agentId): Promise<StopItemOutcome> => {
      const spawn = getManager().getSpawn(agentId);

      if (!spawn) {
        return {
          kind: "unknown",
          agentId,
          activeAgents: formatActiveAgents(),
        };
      }

      // The spawn is between runs: there is no process to stop, and the next
      // run's launch is already in flight.
      if (getManager().isHandingOver(agentId)) {
        return {
          kind: "refused",
          agentId,
          reason:
            "it is being handed over to another harness — wait for the handover to finish, then stop the new run if you still want it stopped.",
        };
      }

      if (!isActivePhase(spawn.lifecycle.phase)) {
        return {
          kind: "already-settled",
          agentId,
          status: lifecycleStatus(spawn.lifecycle),
          activeAgents: formatActiveAgents(),
        };
      }

      try {
        return (await getManager().abort(agentId, "agent"))
          ? { kind: "stopped", agentId }
          : {
              kind: "failed",
              agentId,
              error: "the agent could not be stopped",
            };
      } catch (err) {
        return {
          kind: "failed",
          agentId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

/**
 * Inject the configured default model and the agent-type-resolved thinking
 * level into each item in `agents`. Per-item: a batch may carry items with
 * different `agent_type`s and different effective models.
 */
export async function toolCallListener(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<void> {
  if (event.toolName !== "cowboy_agent") return;

  const input = event.input as { agents?: Array<Record<string, unknown>> };
  const items = input.agents ?? [];
  const parentModelId = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : null;

  for (const item of items) {
    const calledType = item.agent_type;
    // Look up the type the spawn will actually resolve.
    const subagentType = resolveAgentTypeParam(calledType);
    const agentConfig = getAgentConfig(subagentType);
    // The requested harness only when this machine can launch it; parse raises
    // the real error for an unknown or unlaunchable value, so a bad one here
    // leaves the template/config resolution in charge instead of throwing.
    const requested = requestedHarnessId(item.harness_type);
    // Resolved the way the launch resolves it — post-availability-fallback —
    // because the harness names which default the chain below consults.
    const harnessType = resolveHarnessType(subagentType, requested);

    // The configured default travels in its own key so a caller-supplied model
    // is never mistaken for the injected default across repeated hook runs.
    const calledModel = readModelKey(item.model);
    const effectiveModel =
      calledModel ??
      getStore().modelFor(
        subagentType,
        parentModelId,
        agentConfig,
        harnessType,
      );
    if (effectiveModel && !calledModel) {
      item[CONFIGURED_MODEL_KEY] = effectiveModel;
    }

    // The configured level travels in its own key for the same reason the model
    // does: it is a default this extension chose, and the resolution that reads
    // it must be able to tell it apart from the caller's own `thinking`. The
    // session's current level serves as the Pi family's final fallback.
    if (item.thinking === undefined) {
      const thinking = getStore().thinkingFor(
        subagentType,
        agentConfig,
        harnessType,
        ctx.thinkingLevel,
      );
      if (thinking !== undefined) item[CONFIGURED_THINKING_KEY] = thinking;
    }
  }
}
