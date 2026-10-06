/**
 * context.ts — Per-cue template variables and the pure builders producing them.
 *
 * A variable exists only on the cue that renders it, so a template naming
 * what its cue cannot supply fails validation instead of rendering empty.
 * Builders take explicit inputs (never an AgentSpawn). An inapplicable fact
 * is ABSENT — never empty-string filler — so templates branch with
 * `{{#name}}` / `{{^name}}`.
 *
 * The flat `{{snake_case}}` keys are the Mustache contract: the worktree
 * facts and the settled outcome each have exactly one present shape and one
 * absent shape, so a half-present worktree or a result alongside an error
 * cannot be constructed.
 */

import type { CueEvent } from "./types.js";

/**
 * Worktree facts for one cue: the whole block or nothing — a bare flag or a
 * lone path cannot be written.
 */
type WorktreeCueFacts =
  | { has_worktree: true; worktree_path: string; worktree_branch: string }
  | {
      has_worktree?: never;
      worktree_path?: never;
      worktree_branch?: never;
    };

/** Facts of a spawn whose worktree is resolved (or absent). */
export type SpawnedCueContext = {
  agent_id?: string;
} & WorktreeCueFacts;

/** A spawn waiting for a concurrency slot. */
export type QueuedCueContext = SpawnedCueContext & {
  queue_running?: number;
  queue_running_label?: string;
};

/** How a settled run ended: exactly one of a result, an error, or a stop (neither). */
type SettledOutcomeFacts =
  | { result: string; error?: never }
  | { error: string; result?: never }
  | { result?: never; error?: never };

/**
 * A settled run's worktree block: present-or-absent as a unit. Retention and
 * liveness ride only with a worktree — a clean tree simply omits them, which
 * is what the template's `{{^retention}}` arm branches on.
 */
type SettledWorktreeFacts =
  | {
      has_worktree: true;
      worktree_path: string;
      worktree_branch: string;
      retention?: string;
      process_alive?: boolean;
    }
  | {
      has_worktree?: never;
      worktree_path?: never;
      worktree_branch?: never;
      retention?: never;
      process_alive?: never;
    };

/**
 * A settled run: its outcome plus how its tree is left behind. `status_note`
 * is orthogonal to the outcome — any ending can carry one — so it stays
 * outside both unions.
 */
export type SettledCueContext = SettledOutcomeFacts &
  SettledWorktreeFacts & {
    status_note?: string;
  };

/** Event → context, keeping renderCue and validation per-cue typed. */
export interface CueContextFor {
  spawned: SpawnedCueContext;
  queued: QueuedCueContext;
  settled: SettledCueContext;
}

// --- Builder inputs ---

/** Worktree facts as the execution layer knows them. */
interface CueWorktree {
  path: string;
  branch: string;
}

/** Settled worktree facts: identity plus how the worktree is left behind. */
interface SettledCueWorktree extends CueWorktree {
  /** Retention reason — the worktree holds unmerged work and was kept. */
  retention?: string;
  /** The subagent process (and its pane) is still alive after the settle. */
  processAlive?: boolean;
}

/** How a settled run ended. The builder renders exactly one outcome shape. */
export type SettledOutcome =
  | { kind: "completed"; result: string }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

// --- Builders ---

/** The present worktree block; the caller adds it only when there is a tree. */
function worktreeVariables(worktree: CueWorktree): {
  has_worktree: true;
  worktree_path: string;
  worktree_branch: string;
} {
  return {
    has_worktree: true,
    worktree_path: worktree.path,
    worktree_branch: worktree.branch,
  };
}

/** Exactly one outcome shape; an empty result is absent, never filler. */
function outcomeVariables(outcome: SettledOutcome): SettledOutcomeFacts {
  switch (outcome.kind) {
    case "completed":
      return outcome.result !== "" ? { result: outcome.result } : {};
    case "failed":
      return { error: outcome.error };
    case "stopped":
      return {};
  }
}

/** The settled worktree block, or nothing when there is no tree. */
function settledWorktreeVariables(
  worktree?: SettledCueWorktree,
): SettledWorktreeFacts {
  if (!worktree) return {};
  return {
    ...worktreeVariables(worktree),
    ...(worktree.retention !== undefined
      ? { retention: worktree.retention }
      : {}),
    ...(worktree.processAlive ? { process_alive: true } : {}),
  };
}

export function spawnCueContext(input: {
  agentId: string;
  worktree?: CueWorktree;
}): SpawnedCueContext {
  if (!input.worktree) return { agent_id: input.agentId };
  return { agent_id: input.agentId, ...worktreeVariables(input.worktree) };
}

/** Context for the queued acknowledgement. */
export function queuedCueContext(input: {
  agentId: string;
  worktree?: CueWorktree;
  queueRunning: number;
}): QueuedCueContext {
  return {
    ...spawnCueContext(input),
    queue_running: input.queueRunning,
    queue_running_label: input.queueRunning === 1 ? "agent" : "agents",
  };
}

/**
 * Context for the settled report. `statusNote` keeps its own leading space
 * (getStatusNote formats it that way); the cue interpolates it bare.
 * `retention`/`process_alive` exist only for a worktree settle —
 * `process_alive` only when true — since templates branch on absence.
 */
export function settledCueContext(input: {
  outcome: SettledOutcome;
  statusNote?: string;
  worktree?: SettledCueWorktree;
}): SettledCueContext {
  const { outcome, statusNote, worktree } = input;
  return {
    ...outcomeVariables(outcome),
    ...(statusNote ? { status_note: statusNote } : {}),
    ...settledWorktreeVariables(worktree),
  };
}

// --- Variable-name sets ---
//
// One `-?` projection per cue — never a shared list — so the compiler rejects
// a missing or extra key and the name set cannot drift from its context type.

type CueVariableNames<T> = { readonly [K in keyof T]-?: true };

const SPAWNED_CUE_VARIABLES: CueVariableNames<SpawnedCueContext> = {
  agent_id: true,
  has_worktree: true,
  worktree_path: true,
  worktree_branch: true,
};

const QUEUED_CUE_VARIABLES: CueVariableNames<QueuedCueContext> = {
  agent_id: true,
  has_worktree: true,
  worktree_path: true,
  worktree_branch: true,
  queue_running: true,
  queue_running_label: true,
};

const SETTLED_CUE_VARIABLES: CueVariableNames<SettledCueContext> = {
  result: true,
  error: true,
  status_note: true,
  has_worktree: true,
  worktree_path: true,
  worktree_branch: true,
  retention: true,
  process_alive: true,
};

/** Variable names the spawned cue may reference. */
export const spawnedCueVariables = Object.keys(
  SPAWNED_CUE_VARIABLES,
) as readonly (keyof SpawnedCueContext)[];

/** Variable names the queued cue may reference. */
export const queuedCueVariables = Object.keys(
  QUEUED_CUE_VARIABLES,
) as readonly (keyof QueuedCueContext)[];

/** Variable names the settled cue may reference. */
export const settledCueVariables = Object.keys(
  SETTLED_CUE_VARIABLES,
) as readonly (keyof SettledCueContext)[];

/** The variable set for one cue event; undefined for a runtime-unknown event. */
export function cueVariables(event: CueEvent): readonly string[] | undefined {
  switch (event) {
    case "spawned":
      return spawnedCueVariables;
    case "queued":
      return queuedCueVariables;
    case "settled":
      return settledCueVariables;
    default:
      return undefined;
  }
}
