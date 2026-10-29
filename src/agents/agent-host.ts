/**
 * agent-host.ts — execution-multiplexer contracts (types only).
 * AgentHost: hostAt/start/observe/waitUntilGone/release/isAttached/findAttempts/deliver.
 * AgentView: placement presentation (focus).
 * PaneControl: the pane-side surface a harness prepares and stops through.
 * PlacementCatalog: the multiplexer's own view of the placements it owns (discovery,
 * observation, path spelling) — the multiplexer vocabulary cleanup and status read.
 * HerdrHostRef/AgentHostRef: host address. CheckoutBinding/ViewRequest: placement input.
 * DeliverOutcome: what a pane submit attempt did. HostObservation: live agent state.
 * LiveAttempt: conflict identity for dedup. ExecutionRuntime: host + view + pane +
 * placements for one parent session.
 */

import type { HostMultiplexer } from "../host-multiplexer.js";

/**
 * Which multiplexer an address belongs to. The host multiplexers (see host-multiplexer.ts)
 * are the built-in ones and autocomplete; any other string names a multiplexer a
 * plugin registered, so the vocabulary stays open.
 */
export type AgentMultiplexer = HostMultiplexer | (string & {});

/** A host address as herdr models it: one pi process in one pane of one tab of one workspace. */
interface HerdrHostRef {
  readonly multiplexer: AgentMultiplexer;
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

/** Checkout for a placement to attach to; the multiplexer registers it, git owns it. */
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

/**
 * The pane-side surface a harness prepares and stops through. A harness that
 * must type into its pane — installing a launcher, proving staged state is
 * live, pressing its TUI's exit keys — reaches the pane here, never through the
 * multiplexer's own client, so the same harness runs under any multiplexer that
 * offers this surface.
 */
export interface PaneControl {
  /** How the pane is addressed; the multiplexer's own vocabulary (herdr for the built-in multiplexer). */
  readonly kind: string;
  /**
   * Type one command into the pane. Fire-and-forget by contract: a multiplexer
   * returns before the shell has evaluated the line, so a caller proves what it
   * typed rather than trusting this call (see pane-launcher.ts).
   */
  run(paneId: string, command: string): Promise<void>;
  /**
   * Press logical keys, in order, into the pane's agent. The names are the
   * multiplexer's key vocabulary (`ctrl+c`, `ctrl+d`); a multiplexer validates
   * every name before writing any bytes, so an unsupported key fails without
   * partial input. The pane's foreground process must be the agent: a harness
   * uses this for its TUI's own keybindings, never to run a command.
   */
  sendKeys(paneId: string, keys: readonly string[]): Promise<void>;
  /** Resolve once the pane's output comes to contain `output`, or reject when the budget elapses. */
  waitForOutput(
    paneId: string,
    output: string,
    timeoutMs: number,
  ): Promise<void>;
}

export interface HostObservation {
  /** herdr's own vocabulary. */
  readonly state: "idle" | "working" | "blocked" | "done" | "unknown";
}

/* ── Placement discovery (the multiplexer's own view of what it owns) ──────────── */

/**
 * A checkout the multiplexer knows about, as the multiplexer reports it (herdr: one
 * `worktree list` row). `path` is already canonicalized the way this multiplexer
 * spells its placements, so a caller compares it through
 * `PlacementCatalog.canonicalizePath`.
 */
export interface PlacementWorktree {
  readonly path: string;
  /** The multiplexer's label for the checkout, when it reported one. */
  readonly label?: string;
  /** The branch the checkout carries, when the multiplexer reported it. */
  readonly branch?: string;
  /** Workspace hosting the checkout's tab; absent when the checkout is not open. */
  readonly workspaceId?: string;
}

/**
 * A placement the multiplexer started, as the multiplexer reports it (herdr: one `agent list`
 * record). Nameless records are included: herdr 0.8.x usually drops the name,
 * and `cwd` is then the durable link from a record back to its checkout.
 */
export interface PlacementRecord {
  readonly name?: string;
  readonly state: HostObservation["state"];
  readonly workspaceId?: string;
  readonly tabId?: string;
  /** The placement's working directory, when the multiplexer reports one. */
  readonly cwd?: string;
  readonly paneId: string;
}

/**
 * The multiplexer's own view of the placements it owns: what exists, how one is read
 * back by pane, and how this multiplexer spells a path. Every method here is multiplexer
 * vocabulary — that is exactly why it belongs to the multiplexer and not to the
 * git/filesystem plane, so a session's cleanup and status paths read the
 * placements of the multiplexer it is actually running rather than a multiplexer the
 * extension picked on their behalf.
 */
export interface PlacementCatalog {
  /** The multiplexer these placements belong to; the value a persisted address records. */
  readonly multiplexer: AgentMultiplexer;
  /**
   * Canonicalize a path the way this multiplexer spells its placements, so a caller
   * can compare a path it holds with one the catalog reported.
   */
  canonicalizePath(value: string): string;
  /** Every checkout the multiplexer knows. A failed read throws — unreadable is not empty. */
  listWorktrees(): Promise<readonly PlacementWorktree[]>;
  /** Every placement the multiplexer started, nameless ones included. A failed read throws. */
  listPlacements(): Promise<readonly PlacementRecord[]>;
  /** One placement's raw state by pane id; undefined = gone, a throw = unreadable (never evidence either way). */
  observePane(paneId: string): Promise<HostObservation | undefined>;
}

/** Live attempt naming a task conflict; carries no stop address by design, so dedup can never end another session's work. */
export interface LiveAttempt {
  /** Stable agent identity (herdr: agent name). */
  readonly name: string;
}

/**
 * The agent kind a host starts its process as, in the multiplexer's own vocabulary. The
 * multiplexer matches the process it detects in the pane against the requested kind —
 * herdr does, at `agent start` — so the kind has to be the one the launched
 * binary is detected as. The four built-in kinds autocomplete; any other string
 * is a kind a plugin harness launches under, as long as the multiplexer starts it.
 */
export type AgentMultiplexerKind =
  "pi" | "claude" | "codex" | "opencode" | (string & {});

export interface AgentHost {
  /** Obtain a host address: adopts the checkout (`worktree open`) or creates a fresh placement in the current workspace. */
  hostAt(request: ViewRequest): Promise<AgentHostRef>;
  /**
   * Launch the child process into the host. `piArgs` already carries
   * `--system-prompt <file>` and the `@<task-file>` message; `agentMultiplexerKind` is the
   * kind the multiplexer must detect the process as.
   */
  start(
    ref: AgentHostRef,
    options: {
      name: string;
      piArgs: string[];
      agentMultiplexerKind: AgentMultiplexerKind;
    },
  ): Promise<void>;
  /** Live snapshot, or undefined when the host is gone. */
  observe(ref: AgentHostRef): Promise<HostObservation | undefined>;
  /**
   * Wait until this placement no longer hosts an agent; true once the
   * multiplexer's own registry confirms it gone. Sends no keys — the run's
   * harness asks its process to exit through `PaneControl` first — and never
   * closes the placement (worktree removal depends on it).
   */
  waitUntilGone(
    ref: AgentHostRef,
    options?: { timeoutMs?: number },
  ): Promise<boolean>;
  /**
   * Undo hostAt. Destroying a placement ends its process (kill of last
   * resort; multiplexers that cannot end it must not offer release).
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

/** One multiplexer's host + view + pane control + placement catalog, built once per parent session. */
export interface ExecutionRuntime {
  readonly host: AgentHost;
  readonly view: AgentView;
  /** The pane surface every harness this session launches under prepares through. */
  readonly pane: PaneControl;
  /** The multiplexer's view of the placements it owns (discovery, observation, path spelling). */
  readonly placements: PlacementCatalog;
  /** The multiplexer id this runtime was built from; the value a persisted address records. */
  readonly multiplexer: AgentMultiplexer;
}
