/**
 * git-materializer.ts — Layer 3: how a fresh worktree's working tree is populated.
 *
 * Copy-on-write is an optimization, not a requirement: when the volume cannot
 * clone, `clone()` catches that one failure, asks git for a classic checkout
 * instead (`fallbackToCheckout`), and reports it as the "cow-fallback" outcome.
 * Every other failure still throws, so the caller fails the spawn and removes
 * the worktree. The clone itself is `cow-clone.ts`, which probes the volume
 * before anything is wiped, so an unclonable volume is known before any work
 * starts.
 *
 * One `WorktreeMaterialization` strategy drives both `worktreeAddArgs` and this
 * step, so the add and the materialization can never disagree. The separate
 * `WorktreeCheckoutType` policy picks what a dirty main checkout contributes:
 * the whole cloned tree ("dirty") or tracked-from-HEAD plus seeded ignored
 * state ("clean"). A clean main checkout is always cloned whole.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  WorktreeCheckoutType,
  WorktreeMaterialization,
} from "../../spawn/worktree-policy.js";
import { DEFAULT_WORKTREE_CHECKOUT_TYPE } from "../../spawn/worktree-policy.js";
import {
  CowCloneError,
  defaultCowCloneDeps,
  materializeCowClone,
  type CowCloneMode as MaterializeMode,
  type ExecLike,
} from "./cow-clone.js";
import {
  GitCommandRunner,
  GitError,
  GIT_WORKTREE_TIMEOUT_MS,
  locateMainCheckout,
} from "./git-runner.js";

// --- Constants ---

/** Why a dirty main checkout seeds instead of cloning. */
const SEEDED_REASON =
  'main checkout has uncommitted changes and the dirty-checkout policy is "clean"; tracked files stay as git\'s checkout, ignored state CoW-seeded';

/** Why a dirty main checkout was cloned whole. */
const CLONED_WIP_REASON =
  "main checkout has uncommitted changes; its tracked edits and untracked files were cloned into the worktree";

/** Why a copy-on-write materialization ended up as a plain checkout. */
const FALLBACK_REASON =
  "the worktree volume cannot clone; the checkout was completed by git instead";

// --- Types ---

/**
 * How a worktree checkout ended up materialized:
 *  - "cow": full CoW clone of the main checkout. The parent was clean, or the
 *    dirty-checkout policy is "dirty" and the parent's WIP came along.
 *  - "seeded": main was dirty — tracked files came from HEAD (the parent's
 *    uncommitted changes are never imported); only ignored state was CoW-seeded.
 * Failure to produce one of these throws.
 */
export type CowCloneMode = "cow" | "seeded";

export interface CowCloneResult {
  mode: CowCloneMode;
  /** Human-readable detail, e.g. why a dirty main was seeded instead of fully cloned. */
  reason?: string;
}

/**
 * How a checkout ended up materialized. Tagged so the outcome shape and the
 * strategy that produced it can never disagree: the fallback to git's classic
 * checkout has its own shape, so no outcome can claim a clone that never
 * happened.
 */
export type WorktreeMaterializationOutcome =
  /** Copy-on-write clone (or CoW-seeded ignored state) of the parent working tree. */
  | { readonly kind: "cow"; readonly clone: CowCloneResult }
  /** Copy-on-write was asked for, the volume cannot clone, git completed the checkout. */
  | { readonly kind: "cow-fallback"; readonly reason: string }
  /** Git's own classic checkout during `git worktree add`; nothing shared with the parent. */
  | { readonly kind: "checkout" };

// --- Strategy ---

/**
 * What a materialization was asked to produce, so the verification can check
 * exactly that. Which dirty-checkout policy applies is only meaningful when the
 * parent itself was dirty.
 */
type MaterializationExpectation =
  | { readonly kind: "clean-parent" }
  | {
      readonly kind: "dirty-parent";
      readonly policy: WorktreeCheckoutType;
    };

/**
 * `git worktree add` arguments per strategy. Copy-on-write populates the tree
 * itself, so the add leaves the index empty; a classic checkout lets git
 * populate it during the add.
 */
export function worktreeAddArgs(
  strategy: WorktreeMaterialization,
): readonly string[] {
  return strategy === "copy-on-write" ? ["--no-checkout"] : [];
}

/**
 * IGNORED paths a CoW seed should copy, from `git status --ignored
 * --porcelain -z` entries. Only `!!` entries (untracked files would dirty the
 * worktree); newline-containing paths are skipped (the seed list is
 * newline-separated).
 */
export function ignoredSeedPaths(entries: readonly string[]): string[] {
  const rels: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("!! ")) continue;
    const rel = entry.slice(3);
    if (rel === "" || rel.includes("\n")) continue;
    rels.push(rel);
  }
  return rels;
}

// --- Materialization ---

/** Materializes a fresh worktree's working tree per strategy. */
export class CowCloneMaterializer {
  constructor(
    private readonly runner: GitCommandRunner,
    private readonly exec: ExecLike,
  ) {}

  /**
   * Populate a fresh worktree. "checkout" is already complete (git laid the tree
   * down during `git worktree add`); "copy-on-write" delegates to `clone`.
   */
  async materialize(
    wtPath: string,
    strategy: WorktreeMaterialization,
    dirtyCheckout: WorktreeCheckoutType,
  ): Promise<WorktreeMaterializationOutcome> {
    if (strategy === "checkout") return { kind: "checkout" };
    return this.clone(wtPath, dirtyCheckout);
  }

  /**
   * CoW-clone a `--no-checkout` worktree from the main checkout, then let git
   * complete the checkout. A clean main, or a dirty main with the "dirty"
   * policy, gets the whole tree ("cow"); a dirty main with "clean" gets tracked
   * files from HEAD plus CoW-seeded ignored state ("seeded") — ignored files
   * cannot dirty `git status`. A volume that cannot clone falls back to git's
   * classic checkout ("cow-fallback"); every other failure throws.
   */
  async clone(
    wtPath: string,
    dirtyCheckout: WorktreeCheckoutType,
  ): Promise<WorktreeMaterializationOutcome> {
    const wt = path.resolve(wtPath);

    const mainRoot = await this.mainCheckoutOf(wt);

    const mainStatus = await this.mainStatus(mainRoot);
    const expectation: MaterializationExpectation =
      mainStatus === ""
        ? { kind: "clean-parent" }
        : { kind: "dirty-parent", policy: dirtyCheckout };
    const wholeTree =
      expectation.kind === "clean-parent" || expectation.policy === "dirty";

    try {
      await this.cloneWorkingTree(
        wt,
        mainRoot,
        wholeTree
          ? { kind: "all" }
          : { kind: "seed", rels: await this.ignoredRels(mainRoot) },
      );
    } catch (err) {
      if (!(err instanceof CowCloneError) || err.reason !== "unsupported") {
        throw err;
      }
      await this.fallbackToCheckout(wt);
      return { kind: "cow-fallback", reason: FALLBACK_REASON };
    }

    await this.completeCheckout(wt, wholeTree);

    await this.verifyMaterialization(wt, mainRoot, expectation);

    if (expectation.kind === "clean-parent") {
      return { kind: "cow", clone: { mode: "cow" } };
    }
    return {
      kind: "cow",
      clone: wholeTree
        ? { mode: "cow", reason: CLONED_WIP_REASON }
        : { mode: "seeded", reason: SEEDED_REASON },
    };
  }

  /**
   * Resolve `wt`'s main checkout root. A `.git` directory (not file) is the main
   * checkout itself — never replaced — and the main checkout must not live
   * inside the worktree, or wiping the worktree would destroy it.
   */
  private async mainCheckoutOf(wt: string): Promise<string> {
    let marker: string;
    try {
      if (!fs.statSync(wt).isDirectory()) cowFail("target is not a directory");
      if (!fs.lstatSync(path.join(wt, ".git")).isFile()) {
        cowFail("target is not a linked worktree (.git is not a file)");
      }
      marker = fs.readFileSync(path.join(wt, ".git"), "utf8");
    } catch (err) {
      if (err instanceof GitError) throw err;
      cowFail("target is not a git worktree");
    }

    const common = await this.runner.probe(
      ["rev-parse", "--git-common-dir"],
      wt,
    );
    if (common === undefined) cowFail("git rev-parse --git-common-dir failed");
    const { commonDir, mainRoot } = locateMainCheckout(common, wt);

    if (!fs.existsSync(path.join(mainRoot, ".git"))) {
      cowFail("main checkout not found");
    }
    if (path.resolve(mainRoot) === path.resolve(wt)) {
      cowFail("target is the main checkout");
    }
    if (isWithin(wt, mainRoot)) {
      cowFail("main checkout lives inside the worktree");
    }

    const trimmed = marker.trim();
    const pointer = trimmed.startsWith("gitdir:")
      ? trimmed.slice("gitdir:".length).trim()
      : "";
    if (pointer === "") cowFail("malformed .git worktree marker");
    const gitdir = path.isAbsolute(pointer)
      ? pointer
      : path.resolve(wt, pointer);
    if (!gitdir.startsWith(commonDir + path.sep)) {
      cowFail("worktree gitdir is outside this repo");
    }
    if (!fs.existsSync(gitdir)) cowFail("worktree gitdir missing");

    return mainRoot;
  }

  /** Main checkout porcelain status; unreadable fails loud. */
  private async mainStatus(mainRoot: string): Promise<string> {
    const mainStatus = await this.runner.probe(
      ["status", "--porcelain"],
      mainRoot,
    );
    if (mainStatus === undefined)
      cowFail("could not read main checkout status");
    return mainStatus;
  }

  /** CoW-clone the working tree through the shared cloner; a failure is fatal. */
  private async cloneWorkingTree(
    wt: string,
    mainRoot: string,
    mode: MaterializeMode,
  ): Promise<void> {
    try {
      await materializeCowClone(
        { wtPath: wt, mainRoot },
        mode,
        defaultCowCloneDeps(this.exec),
      );
    } catch (err) {
      // "This volume cannot clone" is the one failure with somewhere to go, so
      // it reaches the caller as itself; everything else stays fatal.
      if (err instanceof CowCloneError && err.reason === "unsupported")
        throw err;
      cowFail(err instanceof CowCloneError ? err.message : String(err));
    }
  }

  /**
   * Lay the tree down the way a classic checkout would. The worktree was added
   * with `--no-checkout`, so a reset from HEAD is exactly what the add would
   * have done on its own: tracked files from HEAD, nothing shared with the parent.
   */
  private async fallbackToCheckout(wt: string): Promise<void> {
    const done = await this.runner.test(
      ["reset", "--hard", "HEAD"],
      wt,
      GIT_WORKTREE_TIMEOUT_MS,
    );
    if (!done) {
      cowFail(
        "the worktree volume cannot clone and its checkout could not be completed",
      );
    }
  }

  /** Dirty main: CoW-seed only the IGNORED paths; tracked files come from HEAD. */
  private async ignoredRels(mainRoot: string): Promise<string[]> {
    const entries = await this.runner.lines(
      ["status", "--ignored", "--porcelain", "-z"],
      mainRoot,
      "\0",
    );
    if (entries === undefined) {
      cowFail("could not read main checkout ignored files");
    }
    return ignoredSeedPaths(entries);
  }

  /**
   * Complete the checkout. A mixed reset refreshes the index without rewriting
   * files, so CoW shares survive; when the tracked files were never copied they
   * are materialized from HEAD instead — which would clobber a cloned working
   * tree, so it is the seed path only.
   */
  private async completeCheckout(
    wt: string,
    wholeTree: boolean,
  ): Promise<void> {
    const done = wholeTree
      ? await this.runner.test(["reset", "-q"], wt, GIT_WORKTREE_TIMEOUT_MS)
      : await this.runner.test(
          ["checkout", "-q", "HEAD", "--", "."],
          wt,
          GIT_WORKTREE_TIMEOUT_MS,
        );
    if (!done) {
      cowFail(
        wholeTree
          ? "could not refresh the worktree index after materialization"
          : "could not materialize tracked files in the worktree",
      );
    }
  }

  /** Check what the materialization was asked to produce; an unreadable probe is a failure, never a pass. */
  private async verifyMaterialization(
    wt: string,
    mainRoot: string,
    expectation: MaterializationExpectation,
  ): Promise<void> {
    /** Set-equality of two path lists; both are compared sorted. */
    function samePaths(a: readonly string[], b: readonly string[]): boolean {
      const left = [...a].sort();
      const right = [...b].sort();
      return (
        left.length === right.length &&
        left.every((path, i) => path === right[i])
      );
    }
    /** The parent's paths the clone was able to carry; the rest it had to leave behind. */
    const carried = (paths: readonly string[]): string[] =>
      paths.filter((rel) => !overlapsWorktree(mainRoot, rel, wt));

    if (expectation.kind === "clean-parent") {
      return this.assertClean(wt, "a clean parent");
    }
    if (expectation.policy === "clean") {
      return this.assertClean(wt, 'the "clean" dirty-checkout policy');
    }
    const main = await this.changeLists(mainRoot);
    const clone = await this.changeLists(wt);
    if (
      !samePaths(carried(main.tracked), clone.tracked) ||
      !samePaths(carried(main.untracked), clone.untracked)
    ) {
      cowFail(
        "worktree does not mirror the main checkout's uncommitted changes",
      );
    }
  }

  /**
   * The parent's tracked changes against HEAD and its untracked, non-ignored
   * files. Read together with the worktree's copy: a fresh worktree's index sits
   * at HEAD, so a staged change reads differently per checkout while the content
   * matches.
   */
  private async changeLists(
    root: string,
  ): Promise<{ tracked: string[]; untracked: string[] }> {
    const tracked = await this.runner.lines(
      ["diff", "HEAD", "--name-only", "-z"],
      root,
      "\0",
    );
    if (tracked === undefined) cowFail("could not read tracked changes");
    const untracked = await this.runner.lines(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      root,
      "\0",
    );
    if (untracked === undefined) cowFail("could not read untracked files");
    return { tracked, untracked };
  }

  /** The worktree must be clean afterwards; an unreadable status is not "clean". */
  private async assertClean(wt: string, expected: string): Promise<void> {
    const wtStatus = await this.runner.probe(["status", "--porcelain"], wt);
    if (wtStatus !== "") {
      cowFail(`${expected} should leave the worktree clean, but it is not`);
    }
  }
}

// --- Free-function facade ---

/** Populate a fresh worktree per strategy (see `CowCloneMaterializer.materialize`). */
export async function materializeWorktree(
  pi: ExtensionAPI,
  wtPath: string,
  strategy: WorktreeMaterialization,
  dirtyCheckout: WorktreeCheckoutType = DEFAULT_WORKTREE_CHECKOUT_TYPE,
): Promise<WorktreeMaterializationOutcome> {
  return new CowCloneMaterializer(
    new GitCommandRunner(pi),
    execOf(pi),
  ).materialize(wtPath, strategy, dirtyCheckout);
}

/** CoW-clone a `--no-checkout` worktree (see `CowCloneMaterializer.clone`). */
export async function cowCloneWorktree(
  pi: ExtensionAPI,
  wtPath: string,
  dirtyCheckout: WorktreeCheckoutType = DEFAULT_WORKTREE_CHECKOUT_TYPE,
): Promise<WorktreeMaterializationOutcome> {
  return new CowCloneMaterializer(new GitCommandRunner(pi), execOf(pi)).clone(
    wtPath,
    dirtyCheckout,
  );
}

/** `pi.exec` as the cloner's seam: the same one place shells out of the extension. */
function execOf(pi: ExtensionAPI): ExecLike {
  return (command, args, options) => pi.exec(command, args, options);
}

// --- Internals ---

/** Throw a GitError for a failed CoW materialization. */
function cowFail(message: string): never {
  throw new GitError(
    `copy-on-write worktree materialization failed: ${message}`,
  );
}

/** Whether `child` is `container` or inside it: node:path has no predicate, `relative` is its primitive. */
function isWithin(container: string, child: string): boolean {
  const rel = path.relative(path.resolve(container), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Whether a main-checkout-relative path is the worktree, holds it, or lives
 * inside it: the entries a whole-tree clone never carries (cow-clone's
 * `mainEntries`). Resolved, so git's trailing slash on an untracked directory
 * does not matter.
 */
function overlapsWorktree(mainRoot: string, rel: string, wt: string): boolean {
  const abs = path.resolve(mainRoot, rel);
  const target = path.resolve(wt);
  return isWithin(abs, target) || isWithin(target, abs);
}
