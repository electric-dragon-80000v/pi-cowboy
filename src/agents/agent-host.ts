/**
 * agent-host.ts — execution-backend contracts (types only).
 * AgentHost: hostAt/start/observe/stop/release/isAttached/findAttempts/deliver.
 * AgentView: placement presentation (focus).
 * HerdrHostRef/AgentHostRef: host address. CheckoutBinding/ViewRequest: placement input.
 * DeliverOutcome: what a pane submit attempt did. HostObservation: live agent state.
 * LiveAttempt: conflict identity for dedup. ExecutionRuntime: host + view for one
 * parent session.
 */

/** Implementation selector; intentionally closed. */
type AgentEngine = "herdr";

/** A host address as herdr models it: one pi process in one pane of one tab of one workspace. */
interface HerdrHostRef {
  readonly engine: AgentEngine;
  /** Stable agent identity (herdr: agent name). The tab title may differ. */
  readonly name: string;
  readonly paneId: string;
  /** Hosting tab when known; absent on registry-reconstructed addresses (release/observe use pane + workspace). */
  readonly tabId?: string;
  readonly workspaceId: string;
  /** False for adopted worktree placements: failed-launch cleanup must not close them. */
  readonly paneCreated: boolean;
}

/** What the domain types against; only the herdr impl names the variant. */
export type AgentHostRef = HerdrHostRef;

/** What a submit to an agent did. `submitted` is the only state a steer acts on. */
export type DeliverOutcome =
  /** The text and the submission keypress both reached the agent. */
  | { kind: "submitted" }
  /**
   * The agent did not take the message, and `detail` says why — the pane hosts
   * no agent, the agent is waiting on an approval, herdr was unreachable. Nothing
   * was submitted.
   */
  | { kind: "not-submitted"; detail: string };

/** Only pane placement exists today. */
type PlacementUnit = "pane";

/** Checkout for a placement to attach to; the backend registers it, git owns it. */
export interface CheckoutBinding {
  /** Worktree checkout path (the placement's cwd). */
  path: string;
  /** Main checkout — herdr requires this for `worktree open`. */
  repoCwd: string;
  /** Branch the checkout is on (`cow-<task>-<id>`). */
  branch: string;
}

export interface ViewRequest {
  readonly unit: PlacementUnit;
  readonly cwd: string;
  /** Human-facing placement title; a herdr tab's label carries the spawn marker in front of it, and it names the agent when the request names none. */
  readonly label: string;
  /** Stable agent identity; defaults to label, diverges on the fresh-tab path (pretty tab title, branch-derived agent name). */
  readonly name?: string;
  readonly checkout?: CheckoutBinding;
}

/** Presentation of a live host. Unit-specific by nature (pane focus is neighbor-relative; tab focus is by id). */
export interface AgentView {
  focus(ref: AgentHostRef): Promise<void>;
}

export interface HostObservation {
  /** herdr's own vocabulary. */
  readonly state: "idle" | "working" | "blocked" | "done" | "unknown";
}

/** Live attempt naming a task conflict; carries no stop address by design, so dedup can never end another session's work. */
export interface LiveAttempt {
  /** Stable agent identity (herdr: agent name). */
  readonly name: string;
}

export interface AgentHost {
  /** Obtain a host address: adopts the checkout (`worktree open`) or creates a fresh placement in the current workspace. */
  hostAt(request: ViewRequest): Promise<AgentHostRef>;
  /** Launch the child process into the host. `piArgs` already carries `--system-prompt <file>` and the `@<task-file>` message. */
  start(
    ref: AgentHostRef,
    options: { name: string; piArgs: string[] },
  ): Promise<void>;
  /** Live snapshot, or undefined when the host is gone. */
  observe(ref: AgentHostRef): Promise<HostObservation | undefined>;
  /** Interrupt and wait; never closes the placement (worktree removal depends on it). */
  stop(
    ref: AgentHostRef,
    options?: {
      interruptGraceMs?: number;
      confirmMs?: number;
    },
  ): Promise<boolean>;
  /**
   * Undo hostAt. Destroying a placement ends its process (kill of last
   * resort; backends that cannot end it must not offer release).
   * `placement` closes a self-created placement; `worktree-association`
   * drops a checkout registration (the placement dies with it).
   */
  release(
    ref: AgentHostRef,
    scope: "placement" | "worktree-association",
  ): Promise<boolean>;
  /** Whether any live host (possibly another session's) still has this checkout; guards branch deletion — a throw counts as attached. */
  isAttached(
    worktreePath: string,
    opts?: { repoCwd?: string },
  ): Promise<boolean>;
  /** Live attempts for a task slug (survives parent reload); a failed probe returns [] so availability never blocks spawning. */
  findAttempts(taskSlug: string): Promise<LiveAttempt[]>;
  /**
   * Submit a message to the run's agent. A working agent queues it for its next
   * model call; a settled one starts another turn. The agent surface refuses a
   * target that hosts no agent, so there is one way in and no half-delivered
   * state: `not-submitted` means the message was refused and `detail` says why.
   */
  deliver(ref: AgentHostRef, message: string): Promise<DeliverOutcome>;
}

/** One backend's host + view, built once per parent session. */
export interface ExecutionRuntime {
  readonly host: AgentHost;
  readonly view: AgentView;
}
