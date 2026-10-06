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

import { isActivePhase, lifecycleStatus, type AgentStatus } from "../types.js";
import { CONFIGURED_MODEL_KEY, readModelKey } from "../models/model-request.js";
import { getManager, getStore } from "../shell.js";
import {
  formatActiveAgents,
  runDelegationBatch,
} from "../orchestrators/protocol.js";
import type { CowboyAgents } from "./schemas/cowboy-agents.schema.js";
import type { StopBatchParams } from "./schemas/stop-batch.schema.js";
import { getAgentConfig } from "./agent-types.js";
import { resolveAgentTypeParam } from "./spawn-defaults.js";
import { runBatch } from "./batch.js";
import { successResult, type ToolResult } from "./tool-result.js";

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
  return successResult(message, details);
}

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
  | { kind: "failed"; agentId: string; error: string };

/** Per-item result line the model reads back, in input order. */
export function renderStopOutcome(outcome: StopItemOutcome): string {
  switch (outcome.kind) {
    case "stopped":
      return `Stopped agent ${outcome.agentId}`;
    case "already-settled":
      return `Agent ${outcome.agentId} is already ${outcome.status}. Active agents: ${outcome.activeAgents}`;
    case "unknown":
      return `Agent ${outcome.agentId} not found. Active agents: ${outcome.activeAgents}`;
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
    handleItem: async (agentId): Promise<StopItemOutcome> => {
      const spawn = getManager().getSpawn(agentId);

      if (!spawn) {
        return {
          kind: "unknown",
          agentId,
          activeAgents: formatActiveAgents(),
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

    // The configured default travels in its own key so a caller-supplied model
    // is never mistaken for the injected default across repeated hook runs.
    const calledModel = readModelKey(item.model);
    const effectiveModel =
      calledModel ??
      getStore().modelFor(subagentType, parentModelId, agentConfig);
    if (effectiveModel && !calledModel) {
      item[CONFIGURED_MODEL_KEY] = effectiveModel;
    }

    if (item.thinking === undefined) {
      item.thinking =
        agentConfig?.thinkingLevel ?? getStore().agent.defaultThinking;
    }
  }
}
