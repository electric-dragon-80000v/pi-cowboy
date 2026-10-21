import type { Api, Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentType, AgentInvocation } from "./agents/types.js";
import type { AgentHostRef } from "./agents/agent-host.js";
import type { AnyHarnessId } from "./agents/harness.js";
import type { OrchestratorConfig } from "./orchestrators/types.js";

/**
 * pi's closed thinking vocabulary: `off` plus the six effort levels its CLI
 * accepts. The schema is the one definition — the agent-template config
 * validates against it — and the type is its inference, so the two cannot
 * disagree.
 */
export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/**
 * A thinking token for a spawn: one of pi's levels, or one in the vocabulary of
 * the harness that will run it. Each harness names its own levels, so the set
 * is open; whether a token means anything on a launch is that launch's
 * business. The known members stay in the union for completion.
 */
export type SpawnThinkingLevel = ThinkingLevel | (string & {});

/**
 * Built-in fallbacks for the configurable spawn defaults. A persisted setting
 * that is unset or names a type/template that no longer resolves degrades to
 * these — a removed registry entry never fails a spawn.
 */
export const DEFAULT_AGENT_TYPE = "general-purpose";
export const DEFAULT_ORCHESTRATOR_NAME = "default";

/**
 * Model specification and associated thinking level for a subagent run.
 *
 * Variants:
 * - Resolved Pi model with catalog entry.
 * - Foreign harness model key with display label.
 * - `inherit`: Explicitly inherits the parent session's model while specifying a thinking level.
 * - `levelOnly`: Specifies a thinking level for the harness's default model without setting a model override.
 * - Absent (`undefined`): No model or thinking override specified; inherits defaults.
 *
 * The thinking level is packaged within `ModelChoice` because thinking tokens are
 * validated within the context of the selected harness.
 */
export type ModelChoice =
  | {
      model: Model<Api>;
      /** The concurrency pool identity, always "provider/id". */
      key: string;
      /** The level as the layers named it; null = none was named. */
      thinking: string | null;
    }
  | {
      /** The harness whose vocabulary `key` belongs to. */
      harness: AnyHarnessId;
      key: string;
      /** The display form: the harness list's label for the key, or the key itself. */
      name: string;
      /** The level as the layers named it; null = none was named. */
      thinking: string | null;
    }
  | {
      /**
       * The child inherits the parent's own model rather than naming one. The
       * level still rides here: choosing an effort without choosing a model is
       * a real spawn, and a level outside this shape would be a level with no
       * model at all.
       */
      inherit: true;
      thinking: string | null;
    }
  | {
      /**
       * The level alone. No layer named a model, so the child runs the
       * harness's own default model at this level; `thinking` is always set,
       * because a spawn that names neither model nor level carries no choice.
       */
      levelOnly: true;
      thinking: string;
    };

/** Shared by every spawn/run shape; add a tunable here once. */
export interface RunTunables {
  /** The model and the level it runs at, resolved as one answer. */
  modelChoice?: ModelChoice;
  /** Fork the parent session into the run (`pi --fork <sessionFile>`). */
  fork?: boolean;
}

export interface AgentSpawn {
  id: string;
  lifecycle: AgentLifecycleState;
  display: AgentDisplayInfo;
  execution: AgentExecutionState;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/** The resolved run params both the manager and coordinator agree on. */
export interface SpawnConfig extends RunTunables {
  /**
   * The caller's explicit `harness_type`, validated at parse. Absent means the
   * agent template's `harness_type` and then the config setting resolve it.
   */
  requestedHarness?: AnyHarnessId;
  /**
   * The spawn's `id`, so stop/cleanup/steer accept exactly what the spawn
   * result reports.
   */
  spawnId: string;
  description: string;
  /**
   * Names the subagent's branch + herdr tab. Absent means the caller
   * supplied no name — there is no derivation fallback.
   */
  taskSlug?: string;
  /**
   * Worktree coordinates with ownership; absent for parent-cwd runs. The
   * branch doubles as the herdr agent name for worktree runs — parent-cwd
   * runs derive theirs from the task slug (or agent type) and spawn id.
   */
  worktree?: AgentWorktree;
  /** Absent/true = load project resources; false = ignore them. */
  projectTrusted?: boolean;
  invocation?: AgentInvocation;
  /** Captured verbatim at spawn time; every spawn carries a resolved template. */
  orchestration: OrchestratorConfig;
  /** Absent for parent-cwd runs, where the host is created at launch. */
  hostRef?: AgentHostRef;
}

// --- Sub-object interfaces for decomposed AgentSpawn ---

export type AgentStatus =
  "queued" | "spawned" | "completed" | "stopped" | "error";

/** Who initiated an agent stop: "user" via the UI, or "agent" via the parent's own interrupt. */
export type StopInitiator = "user" | "agent";

/** A stop is always explicit; nothing stops a subagent on its own. */
type AgentStop = { initiator: StopInitiator };

/** Exactly one of result, error, or stop; the status word matches whichever is present. */
type AgentOutcome =
  | {
      status: "completed";
      result: string;
      completedAt: number;
    }
  | { status: "error"; error: string; completedAt: number }
  | {
      status: "stopped";
      completedAt: number;
      stop: AgentStop;
    };

/** Outcome shapes reachable without the agent ever starting: dispose (error) and queued/pre-launch stops. */
type AgentNeverStartedOutcome =
  | { status: "error"; error: string; completedAt: number }
  | { status: "stopped"; completedAt: number; stop: AgentStop };

/**
 * queued → spawned → settled. A run that ends before it ever launches ends
 * `never-started` instead: it has an outcome but no start, so it carries the
 * queue time, never a fabricated start time.
 */
export type AgentLifecycleState =
  | { phase: "queued"; queuedAt: number }
  | { phase: "spawned"; startedAt: number; launch?: AgentLaunchState }
  | ({
      phase: "settled";
      startedAt: number;
      launch?: AgentLaunchState;
    } & AgentTerminalFacts &
      AgentOutcome)
  | ({
      phase: "never-started";
      queuedAt: number;
    } & AgentTerminalFacts &
      AgentNeverStartedOutcome);

/** One lifecycle phase. */
export type AgentPhase = AgentLifecycleState["phase"];

/**
 * Whether a run in each phase is over. The one declaration of the lattice:
 * `satisfies Record<AgentPhase, boolean>` rejects a phase that is added,
 * renamed, or dropped without an entry here, and the phase lists, the
 * predicates, and every caller that filters spawns all read it.
 */
const PHASE_IS_OVER = {
  queued: false,
  spawned: false,
  settled: true,
  "never-started": true,
} as const satisfies Record<AgentPhase, boolean>;

/** The phases the table marks, in declaration order. */
function phasesWhere(over: boolean): readonly AgentPhase[] {
  return (Object.keys(PHASE_IS_OVER) as AgentPhase[]).filter(
    (phase) => PHASE_IS_OVER[phase] === over,
  );
}

/** Spawns still in flight: the runs stop and steer act on. */
export const ACTIVE_AGENT_PHASES = phasesWhere(false);

/** Ended spawns — settled, or ended before they ever launched — retained until an explicit drop. */
export const TERMINAL_AGENT_PHASES = phasesWhere(true);

/** Every phase, ended ones included. */
export const ALL_AGENT_PHASES = [
  ...ACTIVE_AGENT_PHASES,
  ...TERMINAL_AGENT_PHASES,
];

/** A phase whose run is still in flight. */
export type ActivePhase = {
  [K in AgentPhase]: (typeof PHASE_IS_OVER)[K] extends false ? K : never;
}[AgentPhase];

/** A phase whose run is over. */
export type EndedPhase = {
  [K in AgentPhase]: (typeof PHASE_IS_OVER)[K] extends true ? K : never;
}[AgentPhase];

/** Whether the run is over. The one membership test; every ended/active check reads it. */
export function isEndedPhase(phase: AgentPhase): phase is EndedPhase {
  return PHASE_IS_OVER[phase];
}

/** Whether the run is still in flight. */
export function isActivePhase(phase: AgentPhase): phase is ActivePhase {
  return !PHASE_IS_OVER[phase];
}

/**
 * What only an ended run carries: why its owned worktree was kept instead of
 * removed. Recorded at settlement, or later by cleanup when it refuses to
 * remove a dirty tree.
 */
interface AgentTerminalFacts {
  worktreeRetentionReason?: WorktreeRetentionReason;
}

/** A run that has ended: settled, or ended before it ever launched. */
type AgentEndedState = Extract<AgentLifecycleState, { phase: EndedPhase }>;

/**
 * Whether the run has a decided outcome. A narrowing predicate: the readers
 * that want `completedAt`, `status`, or the retention reason get both ended
 * phases at once instead of re-testing each.
 */
export function hasOutcome(
  state: AgentLifecycleState,
): state is AgentEndedState {
  return isEndedPhase(state.phase);
}

/** The AgentStatus word for a lifecycle state. */
export function lifecycleStatus(state: AgentLifecycleState): AgentStatus {
  switch (state.phase) {
    case "queued":
      return "queued";
    case "spawned":
      return "spawned";
    case "settled":
    case "never-started":
      return state.status;
  }
}

/** The agent's result text, or "" for outcomes without one (error/stop). */
export function lifecycleResult(state: AgentLifecycleState): string {
  return state.phase === "settled" && state.status === "completed"
    ? state.result
    : "";
}

/** When the run's clock starts: its queue time until it launches, its start time after. */
export function lifecycleStartTime(state: AgentLifecycleState): number {
  switch (state.phase) {
    case "queued":
    case "never-started":
      return state.queuedAt;
    case "spawned":
    case "settled":
      return state.startedAt;
  }
}

/**
 * `dirty` = uncommitted changes in the worktree; `unverifiable` = a git probe
 * failed, kept conservatively. Unmerged branch commits do NOT keep the worktree:
 * they live in the repo's object store while the branch stays mergeable.
 */
export type WorktreeRetentionReason =
  { kind: "dirty" } | { kind: "unverifiable"; detail: string };

/**
 * A run's worktree coordinates: path and branch travel as one, absent for
 * parent-cwd runs. `owned` checkouts are extension-created (provisioned and
 * adopted at launch) and removed on cleanup; `picked` ones pre-existed — the
 * run works inside them but never owns them, so cleanup leaves them alone.
 * The producer records the ownership it knows; nothing derives it later.
 */
export type AgentWorktree =
  | { kind: "owned"; path: string; branch: string }
  | { kind: "picked"; path: string; branch: string };

interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /**
   * The task identity shared by every agent of the same task; also the dedup
   * key (never more than one live agent per slug). Absent for nameless spawns.
   */
  taskSlug?: string;
  /** Captured verbatim at spawn time; every spawn carries a resolved template. */
  orchestration: OrchestratorConfig;
  /** Resolved spawn params, captured for UI display. */
  invocation?: AgentInvocation;
  toolCallId?: string;
  /**
   * Where the run executes. Absent for parent-cwd runs — there is no branch
   * to invent for them.
   */
  worktree?: AgentWorktree;
}

/**
 * What a run's launch produced: the file the child reports through. It outlives
 * the run's own process, so a revive resumes the same file.
 */
export interface AgentLaunchState {
  /** Absolute path of the child's report file. */
  resultFile: string;
}

/**
 * The run's execution: the objects a session needs to steer, stop, or notify
 * for it. Placement rides here rather than in the phase — a pane may be absent
 * or present in any of them, and a caller that provisioned the checkout itself
 * (the spawn wizard) passes its ref in. The shell-owned store owns this so a
 * spawn outlives the session that created it: a replaced session still lists,
 * steers, and revives it.
 */
export interface AgentExecutionState {
  /** An owned worktree run's pane address, once launch adopts or creates one. A run that fails first never gets one. */
  host?: AgentHostRef;
  /**
   * The harness that owns this run's pane state, recorded before prepare runs.
   * Absent means the run never reached its launch plan, so there is no harness
   * state to tear down. Cleanup reads it so the harness that prepared a pane
   * is the one that tears it down, regardless of later config changes.
   */
  harness?: AnyHarnessId;
  /** Opened exactly once at the terminal transition; never the run's own promise. */
  promise: Promise<string>;
  /** Kept for the spawn's lifetime so the UI-notify fallback can reach a live context on any later nudge. */
  spawnCtx?: ExtensionContext;
  /** The interrupt handle, created with the spawn; a queued run is cancelled through the registry instead. */
  abortController: AbortController;
}
