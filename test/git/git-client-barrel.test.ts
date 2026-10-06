/**
 * git-client-barrel.test.ts — the compatibility facade
 * (src/infrastructure/git-client.ts).
 *
 * Freezes the barrel contract: every legacy name resolves at the old import path
 * by reference to its owning layer, and the layer abstractions resolve
 * additively. Modules load dynamically (the repo forbids `import *` outside node
 * builtins).
 */

import { afterEach, describe, expect, it } from "vitest";
import type {
  AttachmentProbe,
  BranchCleanupResult,
  CowCloneMode,
  CowCloneResult,
  MergeBranchOptions,
  MergeBranchResult,
  WorktreeMaterializationOutcome,
} from "../../src/infrastructure/git-client.js";
import {
  brokenPi,
  cleanupTmpDirs,
  freshTmp,
  makeRepo,
  realPi,
} from "../helpers/git-repo.js";

const FACADE = await import("../../src/infrastructure/git-client.js");
const LAYERS = {
  runner: await import("../../src/infrastructure/git/git-runner.js"),
  worktree: await import("../../src/infrastructure/git/git-worktree.js"),
  materializer:
    await import("../../src/infrastructure/git/git-materializer.js"),
  merger: await import("../../src/infrastructure/git/git-merger.js"),
  retention: await import("../../src/infrastructure/git/git-retention.js"),
} as const;

afterEach(cleanupTmpDirs);

/** Facade TYPE surface: `tsc` fails here if a name stopped being re-exported. */
export type LegacyTypeSurface = {
  attachmentProbe: AttachmentProbe;
  branchCleanup: BranchCleanupResult;
  cloneMode: CowCloneMode;
  cloneResult: CowCloneResult;
  mergeOptions: MergeBranchOptions;
  mergeResult: MergeBranchResult;
  materializationOutcome: WorktreeMaterializationOutcome;
};

/** Every legacy value export, and its owning layer. */
const LEGACY_OWNERS: ReadonlyArray<
  readonly [name: string, owner: keyof typeof LAYERS]
> = [
  ["GitError", "runner"],
  ["GIT_WORKTREE_TIMEOUT_MS", "runner"],
  ["gitRun", "runner"],
  ["gitProbe", "runner"],
  ["resolveMainCheckout", "runner"],
  ["removeGitWorktree", "worktree"],
  ["worktreeAddArgs", "materializer"],
  ["materializeWorktree", "materializer"],
  ["cowCloneWorktree", "materializer"],
  ["mergeBranchIntoTarget", "merger"],
  ["deleteWorktreeBranch", "merger"],
  ["isWorktreeDirty", "retention"],
  ["worktreeRetentionReason", "retention"],
  ["formatRetentionClause", "retention"],
  ["formatRetentionReason", "retention"],
];

/** Layer abstractions reachable through the same path. */
const LAYER_ADDITIONS = [
  "GitCommandRunner",
  "GitWorktree",
  "CowCloneMaterializer",
  "BranchMerger",
  "BranchCleaner",
  "locateMainCheckout",
  "ignoredSeedPaths",
] as const;

/** One export by name, without an `any` index. */
function exportOf(module: object, name: string): unknown {
  return (module as unknown as Record<string, unknown>)[name];
}

describe("git-client compatibility facade", () => {
  it("re-exports every legacy name, from the layer that now owns it", () => {
    const mismatched = LEGACY_OWNERS.filter(
      ([name, owner]) =>
        exportOf(FACADE, name) !== exportOf(LAYERS[owner], name),
    );

    expect(mismatched).toEqual([]);
  });

  it("exposes the layer abstractions additively", () => {
    const missing = LAYER_ADDITIONS.filter(
      (name) => exportOf(FACADE, name) === undefined,
    );

    expect(missing).toEqual([]);
  });

  it("keeps the legacy constant and error identity", () => {
    expect(FACADE.GIT_WORKTREE_TIMEOUT_MS).toBe(60_000);
    expect(new FACADE.GitError("boom").name).toBe("GitError");
    expect(FACADE.GitError).toBe(LAYERS.runner.GitError);
  });

  it("serves calls through the facade (the old import path stays real)", async () => {
    const repo = await makeRepo(freshTmp());

    expect(FACADE.worktreeAddArgs("copy-on-write")).toEqual(["--no-checkout"]);
    expect(FACADE.worktreeAddArgs("checkout")).toEqual([]);
    expect(
      await FACADE.gitProbe(realPi(), ["branch", "--show-current"], repo),
    ).toBe("main");
    expect(
      await FACADE.gitProbe(brokenPi(), ["branch", "--show-current"], repo),
    ).toBeUndefined();
    expect(await FACADE.isWorktreeDirty(realPi(), repo)).toBe(false);
    expect(await FACADE.isWorktreeDirty(brokenPi(), repo)).toBeUndefined();
  });
});
