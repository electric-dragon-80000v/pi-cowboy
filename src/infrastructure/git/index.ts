/**
 * index.ts — Barrel for the git infrastructure folder.
 *
 * Layer 1 git-runner.ts → Layer 2 git-worktree.ts → Layer 3 git-materializer.ts,
 * git-merger.ts, git-retention.ts. Importers use `../git-client.js`.
 */

export * from "./git-runner.js";
export * from "./git-worktree.js";
export * from "./git-materializer.js";
export * from "./git-merger.js";
export * from "./git-retention.js";
