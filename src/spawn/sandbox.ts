/**
 * sandbox.ts — all-or-nothing execution-environment transaction.
 * createAdoptedWorktree: git worktree create, then host adoption; either returns an adopted checkout or throws unwound.
 * allocate: that unit plus the spawn's own naming, repo fallback, and sandbox state around it.
 * teardown: binds agent-cleanup.ts over cleanupDeps; retention rules live in cleanup-policy.ts / git-client.ts.
 * Never shells out directly — see herdr-launcher.ts and git-client.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { WorktreeRetentionReason } from "../types.js";
import {
  deleteCreatedBranch,
  deleteWorktreeBranch,
  formatRetentionClause,
  isWorktreeDirty,
  removeGitWorktree,
  resolveMainCheckout,
  type BranchCleanupResult,
  type WorktreeMaterializationOutcome,
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
import type { CleanupOptions, PaneTarget } from "../agents/cleanup-policy.js";
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

/** A git worktree checkout adopted by the host, with no agent attached. */
export interface AdoptedWorktree {
  path: string;
  /** Branch the checkout is on; the name is also its directory under the root. */
  branch: string;
  /** Main checkout the worktree was created from. */
  repoCwd: string;
  /** How the working tree was actually populated; `copy-on-write` can degrade to a classic checkout. */
  materialization: WorktreeMaterializationOutcome;
  /** The adopted host address. */
  ref: AgentHostRef;
}

/** Everything one worktree creation and adoption needs; shell-free, like `SandboxRequest`. */
export interface AdoptWorktreeRequest {
  /** Main checkout: the adoption source and the removal cwd. */
  repoCwd: string;
  /** Absolute path the worktree occupies; the caller resolved it under the worktree root. */
  path: string;
  branch: string;
  materialization: WorktreeMaterialization;
  /** Whether the new checkout starts dirty with a dirty parent's WIP; the caller resolves it. */
  dirtyCheckout: WorktreeCheckoutType;
  /** Same warning hook as `SandboxRequest`, passed through to the materializer's fallback. */
  notify?: (message: string, kind: "warning") => void;
  /** Execution backend that adopts the checkout (tests inject a fake). */
  host: AgentHost;
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
   * Provision a sandbox: git create (phase 1), then host adoption (phase 2), both inside
   * `createAdoptedWorktree`'s boundary, so the caller never sees a half-provisioned sandbox.
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

    const worktree = await createAdoptedWorktree(pi, {
      repoCwd: repoRoot,
      path: path.join(resolveWorktreeRoot(worktreeRoot, repoRoot), branch),
      branch,
      materialization,
      dirtyCheckout,
      notify,
      host,
    });

    return new AgentSandbox(
      host,
      {
        kind: "worktree",
        checkout: {
          path: worktree.path,
          branch: worktree.branch,
          repoCwd: worktree.repoCwd,
        },
        ref: worktree.ref,
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

// --- Worktree creation and adoption ---

/**
 * Create a git worktree and adopt it in the host — the half a spawn and the
 * `/cowboy worktree` command share. The two phases unwind inside this boundary:
 * a failed adoption removes the worktree and its branch, so no caller is left
 * with a worktree the host does not know about. Creating and adopting is
 * serialized per repository (concurrent `git worktree add`s race on
 * `.git/worktrees/<id>/commondir`, and the loser dies — see RepoLock); nothing
 * else is, so a spawn whose checkout is ready goes on to launch while the next
 * checkout is being created.
 */
export async function createAdoptedWorktree(
  pi: ExtensionAPI,
  request: AdoptWorktreeRequest,
): Promise<AdoptedWorktree> {
  const target = path.resolve(request.path);
  // Both directories are created: a configured root that is missing is a
  // first-run setup state, and a branch name may add a level of its own.
  fs.mkdirSync(path.dirname(target), { recursive: true });

  return getRepoLock().run(canonicalRepoKey(request.repoCwd), () =>
    adoptWorktree(pi, request.host, { ...request, path: target }),
  );
}

/** Phases 1 and 2: create the checkout, then adopt it. Both unwind inside this boundary. */
async function adoptWorktree(
  pi: ExtensionAPI,
  host: AgentHost,
  request: AdoptWorktreeRequest,
): Promise<AdoptedWorktree> {
  const {
    repoCwd,
    path: target,
    branch,
    materialization,
    dirtyCheckout,
    notify,
  } = request;
  // Phase 1: git worktree add on the branch plus materialization.
  let created: WorktreeCheckout;
  try {
    created = await createWorktreeCheckout(pi, {
      repoCwd,
      path: target,
      branch,
      materialization,
      dirtyCheckout,
      notify,
    });
  } catch (err: unknown) {
    // The create's own failure paths prune the branch they minted; the checkout
    // they may have left behind is this boundary's to remove.
    throw createFailureMessage(
      err,
      await removeFailedCheckout(pi, repoCwd, target),
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
        repoCwd,
        branch: created.branch,
      },
    });
  } catch (err: unknown) {
    const checkout = await removeFailedCheckout(pi, repoCwd, created.path);
    // The branch is this create's own — the add minted it moments ago and nothing
    // has committed on it — so it goes by name, without the guards that keep a
    // caller's branch or an unmerged one.
    const branch = await deleteCreatedBranch(pi, created.branch, repoCwd);
    throw createFailureMessage(
      err,
      `${checkout}. ${formatLaunchedBranchOutcome(created.branch, branch)}`,
    );
  }

  return {
    path: created.path,
    branch: created.branch,
    repoCwd,
    materialization: created.materialization,
    ref,
  };
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
    deleteBranch: (options) =>
      deleteWorktreeBranch(pi, options, (candidate) =>
        host.isAttached(candidate, { repoCwd: options.repoCwd }),
      ),
    closePane: async (ref) => {
      await host.release(ref, "placement");
    },
    // Allocation-time cleanup tears no harness state: a checkout that failed
    // its create never hosted a launch, so no harness prepared a pane here.
    harnessTeardown: async () => {},
  };
}

/**
 * Remove the checkout a failed create may have left behind, and report what
 * became of it. Nothing in such a checkout is anyone's work: under `dirty` it holds
 * a copy of the parent's, which the parent still has.
 */
async function removeFailedCheckout(
  pi: ExtensionAPI,
  repoCwd: string,
  worktreePath: string,
): Promise<string> {
  await removeGitWorktree(pi, repoCwd, worktreePath);
  return fs.existsSync(worktreePath)
    ? `worktree ${worktreePath} NOT removed — inspect it manually`
    : `worktree ${worktreePath} removed`;
}

/** The error a failed create is reported with, plus the cleanup that ran with it. */
function createFailureMessage(reason: unknown, cleanup: string): Error {
  return new Error(
    `could not create the herdr worktree: ${errorMessage(reason)}\n\nLaunch-failure cleanup: ${cleanup}.`,
  );
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
