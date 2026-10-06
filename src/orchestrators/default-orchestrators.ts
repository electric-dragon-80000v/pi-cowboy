/**
 * default-orchestrators.ts — Embedded default orchestration templates.
 *
 * Always available; a `.toml` file with the same name overrides. `default`
 * reproduces the pre-cue single-phase wording byte-for-byte (pinned by
 * test/orchestrator-cues.test.ts) and is the BASE every other name starts
 * from: a loaded template overrides only the cue events it defines.
 */

import type { OrchestratorConfig } from "./types.js";

/** Spawn acknowledgement. The worktree line lives in `{{#has_worktree}}` — it exists only for a worktree run. */
const SPAWNED_CUE = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.){{/has_worktree}}

Agent ID: {{agent_id}}`;

/** Queued acknowledgement: why the task has not started and what the limit is doing. */
const QUEUED_CUE = `Agent QUEUED — the concurrency limit is reached ({{queue_running}} {{queue_running_label}} already spawned), so this task is waiting for a slot. It is NOT spawned yet: the process has not started. It will start automatically when another agent settles; you'll get a message when it starts and when it settles. Do NOT re-delegate — this task IS in flight.{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.){{/has_worktree}}

Agent ID: {{agent_id}}`;

/** Settled report: result, error, worktree verdict, process liveness, status note. */
const SETTLED_CUE = `{{result}}{{#error}}

Error: {{error}}{{/error}}{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}){{#retention}} — KEPT: {{retention}}{{/retention}}.{{#process_alive}} The agent process and its herdr pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process.{{/process_alive}} {{#retention}}Clean the worktree up, then call cleanup_cowboy_agent to remove it.{{/retention}}{{^retention}}The worktree stays until you call cleanup_cowboy_agent to remove it — call it once the branch is merged or rejected.{{/retention}}){{/has_worktree}}{{status_note}}`;

export const DEFAULT_ORCHESTRATORS: Record<string, OrchestratorConfig> = {
  default: {
    name: "default",
    displayName: "Default",
    // The cues already carry the delegation/merge/cleanup wording, so a default delegation adds no guidance section.
    guidance: "",
    cues: {
      spawned: SPAWNED_CUE,
      queued: QUEUED_CUE,
      settled: SETTLED_CUE,
    },
  },
};
