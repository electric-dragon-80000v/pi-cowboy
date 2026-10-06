/**
 * git-merger.ts — Layer 3: branch lifecycle against the main checkout.
 *
 * - `BranchMerger`: merge a settled agent branch into the target.
 * - `BranchCleaner`: delete the branch a worktree carried once its commits are merged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  GitError,
  GitCommandRunner,
  locateMainCheckout,
} from "./git-runner.js";

// --- Constants ---

/** Large trees can be slow to merge. */
const MERGE_TIMEOUT_MS = 120_000;

/**
 * Rejects refs git would misread: a leading `-` (parsed as a flag), `..`
 * (range) and `@{` (reflog) — both of which resolve even under a
 * fully-qualified `refs/heads/` prefix — and any character outside
 * `[A-Za-z0-9._/-]`. Deliberately stricter than `git check-ref-format`.
 */
const REF_OFFENSE = /^-|\.\.|@\{|[^A-Za-z0-9._/-]/;

// --- Merge types ---

export interface MergeBranchOptions {
  /** Any path inside the repo (the main checkout or one of its worktrees). */
  cwd: string;
  /** Agent branch to merge (e.g. `cow-fix-login-flow-abc12345`). */
  branch: string;
  /** Merge target branch; default "main". */
  target?: string;
}

export interface MergeBranchResult {
  /** Whether a merge (fast-forward or merge commit) was performed. */
  merged: boolean;
  /**
   * True when the branch was already an ancestor of the target — no merge
   * ran, nothing changed.
   */
  alreadyMerged?: boolean;
  /** Effective merge target. */
  target: string;
  /** Main checkout root the merge ran in. */
  mainRoot: string;
  /** Trimmed `git merge` output, when a merge ran. */
  output?: string;
}

// --- Branch cleanup types ---

/**
 * Whether the checkout is still attached to a live placement. A probe that
 * throws counts as attached: never delete on an unanswered question.
 */
export type AttachmentProbe = (worktreePath: string) => Promise<boolean>;

/**
 * Outcome of cleaning up the `cow-` branch a worktree carried. Worktree
 * removal is gated separately; results never carry the branch ref (the
 * caller reports it once as `CleanupReport.branchName`).
 */
export type BranchCleanupResult =
  | { kind: "deleted" }
  /** Not an extension branch, or the branch is already gone. */
  | { kind: "not-applicable" }
  /** Kept: "unmerged" (commits not in parent HEAD) or "checked-out" (still in use by a worktree). */
  | { kind: "kept"; reason: "unmerged" | "checked-out" }
  /** The delete itself failed. */
  | { kind: "delete-failed"; detail: string };

// --- Ref validation ---

/**
 * Which merge operand is being validated — surfaced in the refusal so the
 * operator knows exactly which parameter to fix.
 */
export type BranchRefRole = "branch" | "target";

/**
 * Branch-name grammar at the boundary where a ref becomes a git argument:
 * non-empty and free of {@link REF_OFFENSE}. A Zod schema so refusals carry
 * structured reasons.
 */
export const BranchRefSchema = z.string().check((ctx) => {
  const clause = ctx.value === "" ? "is empty" : refusalClauseFor(ctx.value);
  if (clause !== undefined) {
    ctx.issues.push({ code: "custom", input: ctx.value, message: clause });
  }
});

/** Earliest problem with `ref`, or `undefined` when it is valid. */
function refusalClauseFor(ref: string): string | undefined {
  const token = REF_OFFENSE.exec(ref)?.[0];
  if (token === undefined) return undefined;
  if (token === "-") {
    return `starts with "-": git would parse that as a command-line flag, not a branch name`;
  }
  if (token === "..") {
    return `contains "..": revision ranges are not branch names`;
  }
  if (token === "@{") {
    return `contains "@{": reflog/date syntax is not a branch name`;
  }
  return `contains invalid character ${describeRefChar(token)}: branch names may only use letters, digits, ".", "_", "/", and "-"`;
}

/** A rejected character, quoted; whitespace and control characters as `U+XXXX`. */
function describeRefChar(char: string): string {
  const code = char.charCodeAt(0);
  if (code <= 0x20 || code === 0x7f) {
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return JSON.stringify(char);
}

/**
 * Reject an invalid branch/target ref before it reaches any git argv.
 * Invalid input is never coerced or defaulted. Callers pass the trimmed
 * value; any remaining whitespace is rejected as an invalid character.
 */
export function assertValidBranchRef(ref: string, role: BranchRefRole): void {
  const parsed = BranchRefSchema.safeParse(ref);
  if (parsed.success) return;
  const reasons = parsed.error.issues.map((issue) => issue.message).join("; ");
  throw new Error(
    `refusing to merge: the ${role} ref ${JSON.stringify(ref)} ${reasons}.`,
  );
}

// --- Merge ---

/**
 * Merges a settled agent branch into the target branch (default `main`) in
 * the repo's main checkout.
 */
export class BranchMerger {
  constructor(private readonly runner: GitCommandRunner) {}

  /**
   * Runs in the main checkout, whose HEAD must already be the target — a
   * merge anywhere else lands on the wrong branch. Refuses on an unknown or
   * self branch, a dirty tree, or anything it could not verify; an
   * already-merged branch is reported without running git, and conflicts are
   * left in progress, never auto-resolved.
   */
  async merge(options: MergeBranchOptions): Promise<MergeBranchResult> {
    const branch = options.branch.trim();
    assertValidBranchRef(branch, "branch");
    const target = (options.target ?? "main").trim();
    assertValidBranchRef(target, "target");

    const toplevel = await this.runner.probe(
      ["rev-parse", "--show-toplevel"],
      options.cwd,
    );
    if (toplevel === undefined) {
      throw new Error(
        `cannot merge "${branch}": ${options.cwd} is not inside a git repository`,
      );
    }
    const common = await this.runner.probe(
      ["rev-parse", "--git-common-dir"],
      toplevel,
    );
    if (common === undefined) {
      throw new Error(
        `cannot merge "${branch}": could not resolve the repo's git directory`,
      );
    }
    const { mainRoot } = locateMainCheckout(common, toplevel);
    if (!fs.existsSync(path.join(mainRoot, ".git"))) {
      throw new Error(
        `cannot merge "${branch}": no main checkout found (unsupported repo layout)`,
      );
    }

    const current = await this.runner.probe(
      ["branch", "--show-current"],
      mainRoot,
    );
    if (current !== target) {
      throw new Error(
        current === undefined
          ? `refusing to merge "${branch}": could not read the current branch of the main checkout (${mainRoot})`
          : `refusing to merge "${branch}": the main checkout (${mainRoot}) is on branch "${current || "(detached)"}", not the merge target "${target}". A merge would land on "${current || "(detached)"}" instead of "${target}".`,
      );
    }
    if (branch === target) {
      throw new Error(
        `refusing to merge "${branch}" into itself (already on "${target}")`,
      );
    }

    // Fully qualified so the ref cannot parse as a flag; no `--` separator
    // because `rev-parse --verify` takes exactly one revision.
    const exists = await this.runner.test(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      mainRoot,
    );
    if (!exists) {
      throw new Error(
        `refusing to merge: branch "${branch}" does not exist in ${mainRoot}.`,
      );
    }

    const status = await this.runner.probe(["status", "--porcelain"], mainRoot);
    if (status === undefined) {
      throw new Error(
        `refusing to merge "${branch}": could not read the status of the main checkout (${mainRoot})`,
      );
    }
    if (status !== "") {
      throw new Error(
        `refusing to merge "${branch}": the main checkout (${mainRoot}) has uncommitted changes. Nothing was merged.`,
      );
    }

    // `--` ends option parsing so the refs are never read as flags.
    const ancestor = await this.runner.run(
      ["merge-base", "--is-ancestor", "--", branch, "HEAD"],
      mainRoot,
    );
    if (!ancestor) {
      throw new Error(
        `refusing to merge "${branch}": could not read its merge ancestry`,
      );
    }
    if (ancestor.code === 0) {
      return { merged: false, alreadyMerged: true, target, mainRoot };
    }

    const merge = await this.runner.run(
      ["merge", "--no-edit", "--", branch],
      mainRoot,
      MERGE_TIMEOUT_MS,
    );
    if (!merge) {
      throw new Error(
        `merge of "${branch}" into "${target}" failed to run (transport error); the checkout was not modified`,
      );
    }
    if (merge.code === 0) {
      return {
        merged: true,
        target,
        mainRoot,
        output: merge.stdout || merge.stderr || undefined,
      };
    }

    // Conflicts are reported, never auto-resolved; the merge stays in progress.
    // A probe that could not run reads as "unknown", never as "no conflicts": the merge state
    // itself decides, so a conflict the listing missed still reaches the caller as a conflict.
    const conflicted = await this.runner.probe(
      ["diff", "--name-only", "--diff-filter=U"],
      mainRoot,
    );
    if (conflicted !== undefined && conflicted !== "") {
      throw new Error(conflictMessage(branch, target, mainRoot, conflicted));
    }
    const mergeInProgress = await this.runner.test(
      ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
      mainRoot,
    );
    if (mergeInProgress) {
      throw new Error(conflictMessage(branch, target, mainRoot, undefined));
    }
    throw new Error(
      `merge of "${branch}" into "${target}" failed: ${merge.stderr || merge.stdout || `exit code ${merge.code}`}`,
    );
  }
}

/**
 * The conflict refusal, whose first line is the marker the merge tool classifies on. It reports
 * what is true — the paths, and that the merge is unfinished — and does not instruct the caller,
 * whose reader is an orchestrating agent rather than an operator.
 *
 * The unlisted-files variant keeps the marker and its explanation on one line, so the file-list
 * parser reads no path rather than a placeholder dressed as one.
 */
function conflictMessage(
  branch: string,
  target: string,
  mainRoot: string,
  files: string | undefined,
): string {
  const listing =
    files === undefined
      ? `has conflicts in: (the conflicting files could not be listed — \`git diff --name-only --diff-filter=U\` did not run in ${mainRoot})`
      : `has conflicts in:\n${files}`;
  return (
    `merge of "${branch}" into "${target}" ${listing}\n` +
    `The merge is still in progress in ${mainRoot}. No conflict was resolved automatically.`
  );
}

// --- Branch cleanup ---

/**
 * Deletes the `cow-` branch a worktree carried, once the worktree is gone.
 */
export class BranchCleaner {
  constructor(private readonly runner: GitCommandRunner) {}

  /**
   * Deletes the branch named by the worktree path basename (the label pinned
   * at create time), and only it: a `cow-` branch that exists, is merged
   * into HEAD, and whose checkout is not attached. An unmerged branch is
   * kept — deleting it would orphan its commits. Omit `isAttached` only for
   * a checkout the host never saw.
   */
  async delete(
    worktreePath: string,
    repoCwd: string,
    isAttached?: AttachmentProbe,
  ): Promise<BranchCleanupResult> {
    const base = path.basename(worktreePath);
    if (!base.startsWith("cow-")) return { kind: "not-applicable" };
    try {
      const verify = await this.runner.run(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`],
        repoCwd,
      );
      if (verify === undefined) {
        throw new GitError(
          `git rev-parse --verify refs/heads/${base} could not run in ${repoCwd}`,
        );
      }
      if (verify.code !== 0) return { kind: "not-applicable" };
      const merged = await this.runner.run(
        ["merge-base", "--is-ancestor", "--", base, "HEAD"],
        repoCwd,
      );
      if (merged === undefined) {
        throw new GitError(
          `git merge-base --is-ancestor -- ${base} HEAD could not run in ${repoCwd}`,
        );
      }
      if (merged.code !== 0) return { kind: "kept", reason: "unmerged" };
      // Attachment belongs to the execution backend, hence the injected probe.
      if (isAttached && (await isAttached(worktreePath))) {
        return { kind: "kept", reason: "checked-out" };
      }
      const del = await this.runner.run(["branch", "-D", "--", base], repoCwd);
      if (del === undefined) {
        throw new GitError(`git branch -D ${base} could not run in ${repoCwd}`);
      }
      if (del.code !== 0) {
        return {
          kind: "delete-failed",
          detail: (
            del.stderr ||
            del.stdout ||
            `git branch -D exited ${del.code}`
          )
            .trim()
            .slice(0, 200),
        };
      }
      return { kind: "deleted" };
    } catch (err) {
      return {
        kind: "delete-failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// --- Free-function facade ---

/**
 * Merge a settled agent branch into the target branch (default `main`).
 * See `BranchMerger.merge` for the guardrails.
 */
export async function mergeBranchIntoTarget(
  pi: ExtensionAPI,
  options: MergeBranchOptions,
): Promise<MergeBranchResult> {
  return new BranchMerger(new GitCommandRunner(pi)).merge(options);
}

/**
 * Delete the git branch created for a worktree once the worktree is gone.
 * See `BranchCleaner.delete` for the guards.
 */
export async function deleteWorktreeBranch(
  pi: ExtensionAPI,
  worktreePath: string,
  repoCwd: string,
  isAttached?: AttachmentProbe,
): Promise<BranchCleanupResult> {
  return new BranchCleaner(new GitCommandRunner(pi)).delete(
    worktreePath,
    repoCwd,
    isAttached,
  );
}
