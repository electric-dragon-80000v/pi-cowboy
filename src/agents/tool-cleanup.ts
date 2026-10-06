/**
 * tool-cleanup.ts — cleanup_cowboy_agent tool implementation.
 *
 * Validates `agent_id` and renders the structured `CleanupReport`; the
 * cleanup itself is the manager's `cleanup()`. Cleanup never stops a live
 * agent — a run still in flight is refused, and an id with no spawn record
 * (a `/reload` rebuilt the store) runs the locator first. An unsafe
 * worktree (dirty, unverifiable) is kept with its reason, not destroyed.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getManager } from "../shell.js";
import { formatActiveAgents } from "../orchestrators/protocol.js";
import type { CleanupBatchParams } from "./schemas/cleanup-batch.schema.js";
import type { CleanupReport } from "./cleanup-policy.js";
import { renderCleanupReport } from "./cleanup-report.js";
import { runBatch } from "./batch.js";
import type { ToolResult } from "./tool-result.js";

/**
 * One id's outcome in a cleanup batch. A kept worktree, a still-live run,
 * and a contested id are not variants here — they ride inside the
 * `CleanupReport` (`outcome.kind === "refused"`), exactly as the single-id
 * tool reports them. Only an id nothing answers to becomes `unknown` data.
 */
export type CleanupItemOutcome =
  | { kind: "cleaned"; agentId: string; report: CleanupReport }
  | { kind: "unknown"; agentId: string; activeAgents: string };

/** Per-item result block: the structured summary for a cleaned run, the not-found line for an unknown id. */
export function renderCleanupOutcome(outcome: CleanupItemOutcome): string {
  switch (outcome.kind) {
    case "cleaned":
      return renderCleanupReport(outcome.report);
    case "unknown":
      return `Agent ${outcome.agentId} not found. Active agents: ${outcome.activeAgents}`;
  }
}

/**
 * cleanup_cowboy_agent handler. Cleans up every id in `agent_ids` sequentially
 * in input order — teardown shares herdr/git state, so items never run in
 * parallel. Best effort: one id's outcome never blocks the rest. Cleanup
 * never throws per item (refusals ride inside each report); `agent_ids` is
 * non-empty by the schema boundary, so a whole-call throw (before anything is
 * removed) only fires on a repeated id.
 */
export async function executeCleanupAgentTool(
  _toolCallId: string,
  params: CleanupBatchParams,
  _signal: AbortSignal | undefined,
  _onUpdate:
    | ((update: ToolResult<{ agents: CleanupItemOutcome[] }>) => void)
    | undefined,
  _ctx: ExtensionContext,
): Promise<ToolResult<{ agents: CleanupItemOutcome[] }>> {
  const agentIds = params.agent_ids;

  return runBatch({
    toolName: "cleanup_cowboy_agent",
    param: "agent_ids",
    detailsKey: "agents",
    items: agentIds,
    render: renderCleanupOutcome,
    handleItem: async (agentId): Promise<CleanupItemOutcome> => {
      const manager = getManager();
      // A spawn outlives a replaced session (/new, /resume, /fork): the
      // shell-owned spawn store keeps it for exactly this call.
      if (!manager.getSpawn(agentId)) {
        const located = await manager.locate(agentId);
        if (located.kind === "not-found") {
          return {
            kind: "unknown",
            agentId,
            activeAgents: formatActiveAgents(manager),
          };
        }
      }
      const report = await manager.cleanup(agentId);
      return { kind: "cleaned", agentId, report };
    },
  });
}
