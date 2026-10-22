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
import { COWBOY_TOOLS, CONSTRAINED_SAMPLING } from "../cowboy-tools.js";
import { getManager } from "../shell.js";
import { formatActiveAgents } from "../orchestrators/protocol.js";
import {
  CleanupBatchSchema,
  type CleanupBatchParams,
} from "./schemas/cleanup-batch.schema.js";
import type { CleanupReport } from "./cleanup-policy.js";
import { renderCleanupReport } from "./cleanup-report.js";
import { runBatch } from "./batch.js";
import type { ToolResult, ToolSeverity } from "./tool-result.js";

/** The cleanup tool: every id in input order, each with its own report block. */
export const cleanupAgentTool = {
  name: COWBOY_TOOLS.cleanupAgent,
  label: COWBOY_TOOLS.cleanupAgent,
  description:
    "Remove one or more SETTLED agents' artifacts in one call: pass every id in `agent_ids`. Each id is handled independently in input order — located, cleaned up, and reported with its own agent status / pane / worktree / branch block — and one id's outcome never blocks the rest. A repeated id in `agent_ids` is rejected before anything is removed — pass each id once. Removes the herdr pane/tab, the worktree, and the cow- branch when it is merged into the parent HEAD. Gated on a reported result — an agent that is still active is REFUSED for its item only: nothing is stopped, removed, or released, and the report says why (stop it with stop_cowboy_agent, then clean up once it has settled). Best effort — each item's result is a structured report of what was done. A worktree with uncommitted changes, or whose state cannot be verified, is KEPT with the reason rather than destroyed (clean it, then retry). An unmerged branch does NOT block removal — the branch and its commits live in the repo, so the worktree is removed and the branch is kept for you to merge later. A torn-down run also loses its staging directory (<tmpdir>/pi-cowboy/<id>/) — those files may carry secrets, so they go with the run; a cleanup that keeps the worktree, and a refusal, removes nothing. An agent whose spawning session was replaced (/new, /resume, /fork) is still tracked, so pass the original full agent id from its spawn or completion result — and an id whose record did not survive a /reload is not rejected outright either: the artifacts themselves are located (herdr's worktree/pane registries, then the worktree root on disk by id) and cleaned up when the run is established as over. That recovered report marks the agent status `unrecorded` and states the evidence its verdict rests on: it refuses, keeping everything, while herdr still reports the pane `working` or when the pane cannot be read at all, and it refuses when two artifacts answer to the id (listing them). The recovered path is the one exception to the staging-directory removal: it has no record of the run, so it reports the agent's deliverable (<tmpdir>/pi-cowboy/<id>/result.md) instead of deleting it, and nothing the agent wrote is lost silently.",
  parameters: CleanupBatchSchema,
  execute: executeCleanupAgentTool,
  constrainedSampling: CONSTRAINED_SAMPLING,
};

/**
 * One id's outcome in a cleanup batch. A kept worktree, a still-live run,
 * and a contested id are not variants here — they ride inside the
 * `CleanupReport` (`outcome.kind === "refused"`), exactly as the single-id
 * tool reports them. Only an id nothing answers to becomes `unknown` data.
 */
export type CleanupItemOutcome =
  | { kind: "cleaned"; agentId: string; report: CleanupReport }
  | { kind: "unknown"; agentId: string; activeAgents: string };

/**
 * How one cleanup outcome reads: a torn-down run is the success; a kept
 * worktree, a live run, and an id nothing answers to all left the artifacts in
 * place and are reported, not failed.
 */
export function cleanupSeverity(outcome: CleanupItemOutcome): ToolSeverity {
  if (outcome.kind === "unknown") return "warning";
  return outcome.report.outcome.kind === "torn-down" ? "success" : "warning";
}

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
    severity: cleanupSeverity,
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
