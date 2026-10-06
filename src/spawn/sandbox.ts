/**
 * sandbox.ts — all-or-nothing execution-environment transaction.
 * allocate: git worktree create, then host adoption; either returns fully provisioned or throws unwound.
 * teardown: binds agent-cleanup.ts over cleanupDeps; retention rules live in cleanup-policy.ts / git-client.ts.
 * Never shells out directly — see herdr-launcher.ts and git-client.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { WorktreeRetentionReason } from "../types.js";
import {
  deleteWorktreeBranch,
  formatRetentionClause,
  isWorktreeDirty,
  removeGitWorktree,
  resolveMainCheckout,
  type BranchCleanupResult,
} from "../infrastructure/git-client.js";
import type {
  AgentHost,
  AgentHostRef,
  CheckoutBinding,
} from "../agents/agent-host.js";
import {
  createWorktreeTeardown,
  type CleanupDeps,
  type WorktreeTeardownOutcome,
} from "../agents/agent-cleanup.js";
import type {
  CleanupOptions,
  PaneTarget,
  WorktreeTarget,
} from "../agents/cleanup-policy.js";
import { errorMessage } from "../utils.js";
import { getRepoLock } from "../shell.js";
import {
  buildWorktreeBranch,
  resolveWorktreeRoot,
  type WorktreeCheckoutType,
  type WorktreeMaterialization,
} from "./worktree-policy.js";
import {
  createWorktreeCheckout,
  type WorktreeCheckout,
} from "./herdr-launcher.js";

// --- Request ---

/**
 * How a sandbox's branch — and with it the worktree directory and herdr agent
 * name — is chosen: generated from the task slug + spawn id, or an explicit
 * name supplied by a caller that already named the worktree.
 */
export type SandboxNaming =
  | { kind: "generated"; taskSlug: string; id: string }
  | { kind: "explicit"; branch: string };

/** Everything `AgentSandbox.allocate` needs; shell-free — the caller passes shell values in. */
export interface SandboxRequest {
  /** How branch, directory, and agent/tab are named. */
  naming: SandboxNaming;
  /** Parent session cwd — the repo anchor for the new worktree. */
  parentCwd: string;
  /** Configured worktree root; relative values resolve against the repo root. */
  worktreeRoot: string | undefined;
  materialization: WorktreeMaterialization;
  /** Whether the new worktree starts dirty with a dirty parent's WIP; the caller resolves it. */
  dirtyCheckout: WorktreeCheckoutType;
  /** UI warning hook for the no-repo case. */
  notify?: (message: string, kind: "warning") => void;
  /** Execution backend that adopts the checkout (tests inject a fake). */
  host: AgentHost;
}

/** A resolved checkout request: the repo and worktree paths are known, so provisioning can run under the repo lock. */
interface ProvisionRequest {
  repoRoot: string;
  requestedPath: string;
  branch: string;
  materialization: WorktreeMaterialization;
  dirtyCheckout: WorktreeCheckoutType;
  /** Same warning hook as `SandboxRequest`, passed through to the materializer's fallback. */
  notify?: (message: string, kind: "warning") => void;
}

// --- State model ---

/**
 * Where a sandbox runs. Worktree is always paired (checkout + host address) so adoption
 * failure rolls the checkout back inside allocation; `parent-cwd` is the no-repo fallback.
 */
type SandboxPlacement =
  | { kind: "worktree"; checkout: CheckoutBinding; ref: AgentHostRef }
  | { kind: "parent-cwd" };

/**
 * Sandbox environment lifecycle. `preserved` carries the retention reason (see cleanup-policy);
 * `teardown-failed` is neither safe-to-forget nor a deliberate preserve.
 */
type SandboxState =
  | { kind: "bound" }
  | { kind: "preserved"; reason: WorktreeRetentionReason }
  | { kind: "destroyed" }
  | { kind: "teardown-failed"; detail: string };

/**
 * The identity a repository's lock is keyed by: the directory's own, not the
 * name it was reached by. One repository has several paths — a symlinked home,
 * a bind mount — and `path.resolve` follows neither, so two spellings would
 * each take a lock, which is the collision `RepoLock` exists to prevent.
 *
 * Device and inode name the directory itself, and unlike a path they survive
 * both. A root that cannot be stat'ed has no identity yet; its resolved path
 * keeps distinct unreachable roots distinct.
 */
function canonicalRepoKey(repoRoot: string): string {
  try {
    const stats = fs.statSync(repoRoot, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return path.resolve(repoRoot);
  }
}

// --- Sandbox ---

/** One delegation's execution environment. `allocate` is total; `teardown` is the only destroy path. */
export class AgentSandbox {
  /** Pinned `cow-<task>-<id>` branch; also names the agent. */
  readonly branch: string;
  /** Whether the subagent session may load the target project's resources. */
  readonly projectTrusted: boolean;
  private readonly host: AgentHost;
  private readonly placement: SandboxPlacement;
  private current: SandboxState = { kind: "bound" };

  private constructor(
    host: AgentHost,
    placement: SandboxPlacement,
    branch: string,
    projectTrusted: boolean,
  ) {
    this.host = host;
    this.placement = placement;
    this.branch = branch;
    this.projectTrusted = projectTrusted;
  }

  /**
   * Provision a sandbox: git create (phase 1), then host adoption (phase 2). Either phase
   * failing unwinds inside this boundary, so the caller never sees a half-provisioned sandbox.
   * Outside a git repository, falls back to the parent cwd with a warning.
   */
  static async allocate(
    pi: ExtensionAPI,
    request: SandboxRequest,
  ): Promise<AgentSandbox> {
    const {
      naming,
      parentCwd,
      worktreeRoot,
      materialization,
      dirtyCheckout,
      notify,
      host,
    } = request;

    const branch =
      naming.kind === "generated"
        ? buildWorktreeBranch(naming.taskSlug, naming.id)
        : naming.branch.trim();
    // A generated name is valid by construction; an explicit one must at least
    // name something (git rejects an unusable branch name itself).
    if (naming.kind === "explicit" && branch === "") {
      throw new Error("explicit worktree naming requires a branch name");
    }

    // Outside a git repository no worktree is possible.
    let repoRoot: string;
    try {
      repoRoot = await resolveMainCheckout(pi, parentCwd);
    } catch {
      notify?.(
        `[cowboy] Parent is not inside a git repository — spawning in the parent cwd without a worktree`,
        "warning",
      );
      return new AgentSandbox(host, { kind: "parent-cwd" }, branch, true);
    }

    const root = resolveWorktreeRoot(worktreeRoot, repoRoot);
    // Both roots are created: a configured root that is missing is a first-run setup
    // state, and the mkdir makes it. Creating it is the only side effect here.
    fs.mkdirSync(root, { recursive: true });

    const requestedPath = path.join(root, branch);
    // Creating and adopting a checkout is serialized per repository: concurrent
    // `git worktree add`s race on `.git/worktrees/<id>/commondir`, and the loser dies
    // (see RepoLock). Nothing else is serialized, so a spawn whose checkout is ready
    // goes on to launch while the next checkout is being created.
    return getRepoLock().run(canonicalRepoKey(repoRoot), () =>
      AgentSandbox.provision(pi, host, {
        repoRoot,
        requestedPath,
        branch,
        materialization,
        dirtyCheckout,
        notify,
      }),
    );
  }

  /** Phases 1 and 2 of provisioning: create the checkout, then adopt it. Both unwind inside this boundary. */
  private static async provision(
    pi: ExtensionAPI,
    host: AgentHost,
    request: ProvisionRequest,
  ): Promise<AgentSandbox> {
    const { repoRoot, requestedPath, branch, materialization, dirtyCheckout } =
      request;
    // Phase 1: git worktree add on the pinned branch plus materialization.
    let created: WorktreeCheckout;
    try {
      created = await createWorktreeCheckout(pi, {
        repoCwd: repoRoot,
        path: requestedPath,
        branch,
        materialization,
        dirtyCheckout,
        notify: request.notify,
      });
    } catch (err: unknown) {
      throw await allocationError(
        pi,
        host,
        { worktreePath: requestedPath, branchName: branch, repoCwd: repoRoot },
        `could not create the herdr worktree: ${errorMessage(err)}`,
      );
    }

    // Phase 2: adoption. The host never destroys filesystem state, so a failed adoption rolls back here.
    let ref: AgentHostRef;
    try {
      ref = await host.hostAt({
        unit: "pane",
        cwd: created.path,
        // Herdr's echoed label (the repo name) is identical across parallel spawns — name by branch instead.
        label: branch,
        name: branch,
        checkout: {
          path: created.path,
          repoCwd: repoRoot,
          branch: created.branch,
        },
      });
    } catch (err: unknown) {
      await removeGitWorktree(pi, repoRoot, created.path);
      await deleteWorktreeBranch(pi, created.path, repoRoot, (candidate) =>
        host.isAttached(candidate, { repoCwd: repoRoot }),
      );
      throw await allocationError(
        pi,
        host,
        {
          worktreePath: created.path,
          branchName: created.branch,
          repoCwd: repoRoot,
        },
        `could not create the herdr worktree: ${errorMessage(err)}`,
      );
    }

    return new AgentSandbox(
      host,
      {
        kind: "worktree",
        checkout: {
          path: created.path,
          branch: created.branch,
          repoCwd: repoRoot,
        },
        ref,
      },
      branch,
      true,
    );
  }

  /** Current lifecycle state of the environment. */
  get state(): SandboxState {
    return this.current;
  }

  /** Verified checkout path + branch, or undefined for the parent-cwd fallback. */
  get worktree(): { path: string; branch: string } | undefined {
    return this.placement.kind === "worktree"
      ? {
          path: this.placement.checkout.path,
          branch: this.placement.checkout.branch,
        }
      : undefined;
  }

  /** The adopted host address, or undefined for the parent-cwd fallback. */
  get hostRef(): AgentHostRef | undefined {
    return this.placement.kind === "worktree" ? this.placement.ref : undefined;
  }

  /**
   * Tear down in order — placement, worktree, then branch-prune-if-merged. Retention is
   * not re-derived here; a second teardown of a destroyed sandbox reports `absent`.
   */
  async teardown(
    pi: ExtensionAPI,
    opts?: CleanupOptions,
  ): Promise<WorktreeTeardownOutcome> {
    const placement = this.placement;
    if (placement.kind === "parent-cwd") {
      this.current = { kind: "destroyed" };
      return { kind: "absent" };
    }
    if (this.current.kind === "destroyed") {
      return { kind: "absent", path: placement.checkout.path };
    }
    const outcome = await createWorktreeTeardown(
      cleanupDeps(pi, this.host),
    ).removeWorktree(
      {
        kind: "adopted",
        worktree: {
          workspaceId: placement.ref.workspaceId,
          worktreePath: placement.checkout.path,
          repoCwd: placement.checkout.repoCwd,
          branchName: placement.checkout.branch,
        },
        pane: {
          paneId: placement.ref.paneId,
          origin:
            placement.ref.paneCreated === true ? "self-created" : "adopted",
        } satisfies PaneTarget,
        ref: placement.ref,
      },
      opts,
    );
    this.current = stateAfterTeardown(outcome);
    return outcome;
  }
}

/** Map a teardown outcome onto the sandbox's next state. */
function stateAfterTeardown(outcome: WorktreeTeardownOutcome): SandboxState {
  switch (outcome.kind) {
    case "kept":
      return { kind: "preserved", reason: outcome.reason };
    case "removed":
    case "absent":
      return { kind: "destroyed" };
    case "removal-failed":
      return { kind: "teardown-failed", detail: outcome.detail };
  }
}

// --- Allocation failure ---

/** Bind direct herdr and git functions to the teardown orchestrator; the host never destroys filesystem state. */
function cleanupDeps(pi: ExtensionAPI, host: AgentHost): CleanupDeps {
  return {
    isWorktreeDirty: (worktreePath) => isWorktreeDirty(pi, worktreePath),
    worktreeExists: async (worktreePath) => fs.existsSync(worktreePath),
    removeWorktree: (ref) => host.release(ref, "worktree-association"),
    removeGitWorktree: async (worktreePath, repoCwd) => {
      await removeGitWorktree(pi, repoCwd, worktreePath);
      return !fs.existsSync(worktreePath);
    },
    deleteBranch: (worktreePath, repoCwd) =>
      deleteWorktreeBranch(pi, worktreePath, repoCwd, (candidate) =>
        host.isAttached(candidate, { repoCwd }),
      ),
    closePane: async (ref) => {
      await host.release(ref, "placement");
    },
  };
}

/** Probe-remove a never-live worktree after an allocation failure and report failure plus cleanup. */
async function allocationError(
  pi: ExtensionAPI,
  host: AgentHost,
  attempted: Pick<WorktreeTarget, "worktreePath" | "branchName" | "repoCwd">,
  error: string,
): Promise<Error> {
  // Nothing was adopted, so no ref rides along.
  const outcome = await createWorktreeTeardown(
    cleanupDeps(pi, host),
  ).removeWorktree({ kind: "detached", worktree: attempted, pane: null });
  return new Error(`${error}\n\n${formatLaunchCleanupNote(outcome)}`);
}

/** Branch verdict for the launch-failure cleanup note. */
function formatLaunchedBranchOutcome(
  branchName: string,
  branch: BranchCleanupResult,
): string {
  switch (branch.kind) {
    case "deleted":
      return `branch ${branchName} deleted`;
    case "kept":
      return `branch ${branchName} kept (${branch.reason})`;
    case "delete-failed":
      return `branch ${branchName} NOT deleted — ${branch.detail}`;
    case "not-applicable":
      return `branch ${branchName} already gone`;
  }
}

/** Render a teardown outcome as the trailing note of a launch error. A kept tree has no spawn, so only manual inspection can remove it. */
export function formatLaunchCleanupNote(
  outcome: WorktreeTeardownOutcome,
): string {
  switch (outcome.kind) {
    case "removed":
      return outcome.via === "herdr"
        ? `Launch-failure cleanup: worktree ${outcome.path} removed — its herdr workspace, tab, and pane were closed with it. ${formatLaunchedBranchOutcome(outcome.branchName, outcome.branch)}.`
        : // The git-side verdict only. Whether a herdr pane survived belongs to
          // the adoption error that precedes this note, which names it.
          `Launch-failure cleanup: worktree ${outcome.path} removed. ${formatLaunchedBranchOutcome(outcome.branchName, outcome.branch)}.`;
    case "kept":
      return (
        `Launch-failure cleanup: worktree ${outcome.path} KEPT — ${formatRetentionClause(outcome.reason)}. ` +
        `No agent spawn exists for it, so extension cleanup cannot see it — inspect and remove it manually.`
      );
    case "removal-failed":
      return `Launch-failure cleanup FAILED for worktree ${outcome.path}: ${outcome.detail} — it may still exist, and no agent spawn exists for it, so inspect it manually.`;
    case "absent":
      return `Launch-failure cleanup: no worktree residue was left behind.`;
  }
}
