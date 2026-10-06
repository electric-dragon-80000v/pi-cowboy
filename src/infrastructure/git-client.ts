/**
 * git-client.ts — the git/filesystem plane (see `./git/`).
 *
 * Canonical import path: re-exports the whole surface as one module, so
 * importers never need to know which layer owns an operation.
 *
 *   Layer 1  git/git-runner.ts (transport)
 *   Layer 2  git/git-worktree.ts (entity)
 *   Layer 3  git/git-materializer.ts, git-merger.ts, git-retention.ts
 */

export * from "./git/index.js";
