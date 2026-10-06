/**
 * tool-merge.ts — merge_cowboy_branch tool implementation.
 *
 * Merges a finished subagent's branch via the guardrailed
 * `mergeBranchIntoTarget` helper (conflicts are reported, never
 * auto-resolved). The `repo` param can point at any on-disk repository, so
 * an out-of-session merge warns loudly (notification + first-line banner);
 * an unresolvable session scope throws instead of skipping the check.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getPiInstance, getSessionCtx } from "../shell.js";
import {
  mergeBranchIntoTarget,
  assertValidBranchRef,
  type MergeBranchResult,
} from "../infrastructure/git-client.js";
import {
  GitCommandRunner,
  locateMainCheckout,
} from "../infrastructure/git/git-runner.js";
import type { MergeBatchParams } from "./schemas/merge-batch.schema.js";
import { runBatch, type BatchItem } from "./batch.js";
import type { ToolResult } from "./tool-result.js";

/** Case is preserved: both roots come from `git rev-parse`, which spells one repo one way. */
export function normalizeRepoRoot(root: string): string {
  const normalized = path.normalize(root);
  const { root: fsRoot } = path.parse(normalized);
  return normalized.length > fsRoot.length
    ? normalized.replace(/[/\\]+$/, "")
    : normalized;
}

export function isSameRepoRoot(a: string, b: string): boolean {
  return normalizeRepoRoot(a) === normalizeRepoRoot(b);
}

/** First-line banner naming both checkouts: where the merge landed versus the session repo. */
export function formatOutsideRepoWarning(
  mainRoot: string,
  sessionRoot: string,
): string {
  return `WARNING: merging in ${mainRoot}, outside your session repo (${sessionRoot}) — verify this was intended.`;
}

/** Throws instead of guessing, so a merge never proceeds without a scope check. */
async function resolveSessionMainRoot(
  pi: ExtensionAPI,
  sessionCwd: string,
): Promise<string> {
  const runner = new GitCommandRunner(pi);
  const toplevel = await runner.probe(
    ["rev-parse", "--show-toplevel"],
    sessionCwd,
  );
  if (toplevel === undefined) {
    throw new Error(
      `merge_cowboy_branch cannot verify the session repo: ${sessionCwd} is not inside a git repository (git rev-parse --show-toplevel failed). ` +
        `Refusing to merge without a repo-scope check — run the session from inside a git checkout or pass an explicit \`repo\` inside one.`,
    );
  }
  const common = await runner.probe(
    ["rev-parse", "--git-common-dir"],
    toplevel,
  );
  if (common === undefined) {
    throw new Error(
      `merge_cowboy_branch cannot verify the session repo: could not resolve the git directory for ${sessionCwd}. ` +
        `Refusing to merge without a repo-scope check.`,
    );
  }
  const { mainRoot } = locateMainCheckout(common, toplevel);
  if (!fs.existsSync(path.join(mainRoot, ".git"))) {
    throw new Error(
      `merge_cowboy_branch cannot verify the session repo: no main checkout found for ${sessionCwd} (unsupported repo layout). ` +
        `Refusing to merge without a repo-scope check.`,
    );
  }
  return mainRoot;
}

/**
 * One branch's outcome in a merge batch. A conflicted merge stays in
 * progress (never auto-resolved), so a conflict halts the batch and every
 * later branch reports `not-attempted`; any other failure is per item and
 * never blocks the rest.
 */
export type MergeItemOutcome =
  | { kind: "merged"; branch: string; target: string; output?: string }
  | { kind: "already-merged"; branch: string; target: string }
  | { kind: "conflict"; branch: string; target: string; files: string[] }
  | { kind: "failed"; branch: string; error: string }
  | { kind: "unknown"; branch: string }
  | { kind: "not-attempted"; branch: string; reason: string };

/** A conflict throw carries its file list between these markers (see git-merger.ts). */
const CONFLICT_MARKER = "has conflicts in:";

function isConflictError(message: string): boolean {
  return message.includes(CONFLICT_MARKER);
}

/** Conflicted paths from a conflict throw; empty when the message does not parse. */
function parseConflictFiles(message: string): string[] {
  const match = message.match(
    /has conflicts in:\n([\s\S]*?)\nThe merge is still/,
  );
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function isUnknownBranchError(message: string, branch: string): boolean {
  return message.includes(`branch "${branch}" does not exist`);
}

/** The scope every merge in one call is checked against. */
interface MergeScope {
  sessionRoot: string;
  cwd: string;
}

/**
 * merge_cowboy_branch handler. Merges every branch in `branches` sequentially
 * in input order — merges share one checkout, so items never run in
 * parallel. `target` and `repo` apply to the whole call. Best effort except
 * conflicts: a conflict halts the batch (the checkout is mid-merge, so
 * nothing further can merge) and the remaining branches report as
 * not-attempted. `branches` is non-empty by the schema boundary; whole-call
 * throws (before anything merges) only for a repeated branch, a ref that is not
 * a branch name, or an unverifiable session scope.
 */
export async function executeMergeBranchTool(
  _toolCallId: string,
  params: MergeBatchParams,
  _signal: AbortSignal | undefined,
  _onUpdate:
    | ((update: ToolResult<{ branches: MergeItemOutcome[] }>) => void)
    | undefined,
  ctx: ExtensionContext,
): Promise<ToolResult<{ branches: MergeItemOutcome[] }>> {
  const target =
    params.target !== undefined && params.target.trim() !== ""
      ? params.target.trim()
      : "main";
  const repo =
    params.repo !== undefined && params.repo.trim() !== ""
      ? params.repo.trim()
      : undefined;

  // Probed on first use and memoized: an unverifiable session scope fails
  // before anything is mutated, and the batch probes once, not once per branch.
  let scope: Promise<MergeScope> | undefined;
  const mergeScope = (): Promise<MergeScope> => {
    scope ??= (async () => {
      const sessionCwd = getSessionCtx().cwd;
      if (typeof sessionCwd !== "string" || sessionCwd.trim() === "") {
        throw new Error(
          "merge_cowboy_branch cannot verify the session repo: the session working directory is unavailable, so the repo-scope check is impossible. " +
            "Refusing to merge without a repo-scope check.",
        );
      }
      return {
        sessionRoot: await resolveSessionMainRoot(getPiInstance(), sessionCwd),
        cwd: repo ?? sessionCwd,
      };
    })();
    return scope;
  };

  return runBatch({
    toolName: "merge_cowboy_branch",
    param: "branches",
    detailsKey: "branches",
    items: params.branches,
    prepare: async () => {
      // Once for the whole call: a ref that is not a branch name would otherwise be
      // refused once per branch, after the earlier branches had already merged.
      assertValidBranchRef(target, "target");
      for (const rawBranch of params.branches) {
        assertValidBranchRef(rawBranch.trim(), "branch");
      }
      await mergeScope();
    },
    halt: {
      on: (outcome) => outcome.kind === "conflict",
      skip: (rawBranch, haltedBy) => {
        const branch = rawBranch.trim();
        const reason = `not attempted — the merge of "${haltedBy.trim()}" conflicted and is still in progress`;
        return {
          outcome: { kind: "not-attempted", branch, reason },
          text: `"${branch}" ${reason}.`,
        };
      },
    },
    handleItem: async (rawBranch): Promise<BatchItem<MergeItemOutcome>> => {
      const { sessionRoot, cwd } = await mergeScope();
      const branch = rawBranch.trim();
      try {
        const result: MergeBranchResult = await mergeBranchIntoTarget(
          getPiInstance(),
          { cwd, branch, target },
        );
        // The merge proceeds on a warning, not a refusal; the banner is the
        // durable signal because notifications can be missed or unavailable.
        const warning = isSameRepoRoot(result.mainRoot, sessionRoot)
          ? undefined
          : formatOutsideRepoWarning(result.mainRoot, sessionRoot);
        if (warning !== undefined) {
          try {
            ctx.ui.notify(warning, "warning");
          } catch {
            // A broken UI sink must never fail the merge itself.
          }
        }
        const prefix = warning !== undefined ? `${warning}\n` : "";
        if (result.alreadyMerged) {
          return {
            outcome: { kind: "already-merged", branch, target },
            text: `${prefix}"${branch}" is already merged into "${result.target}" — nothing to do.`,
          };
        }
        return {
          outcome: {
            kind: "merged",
            branch,
            target: result.target,
            output: result.output,
          },
          text:
            `${prefix}Merged "${branch}" into "${result.target}" in ${result.mainRoot}.` +
            (result.output ? `\n${result.output}` : ""),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isConflictError(message)) {
          return {
            outcome: {
              kind: "conflict",
              branch,
              target,
              files: parseConflictFiles(message),
            },
            text: `"${branch}": ${message}`,
          };
        }
        if (isUnknownBranchError(message, branch)) {
          return {
            outcome: { kind: "unknown", branch },
            text: `"${branch}": ${message}`,
          };
        }
        return {
          outcome: { kind: "failed", branch, error: message },
          text: `"${branch}": ${message}`,
        };
      }
    },
  });
}
