/**
 * repo-lock.ts — one worktree creation at a time per repository.
 *
 * `git worktree add` registers its worktree by creating `.git/worktrees/<id>/` and
 * only then writing `commondir` into it, truncate-then-write. The file is empty for
 * that instant, and git treats an empty one as fatal ("failed to read
 * .git/worktrees/<id>/commondir: Undefined error: 0") in any process enumerating
 * worktrees during it — including `git worktree add` itself, which lists the
 * existing worktrees before creating its own. Concurrent creations in one
 * repository therefore collide, so they queue here.
 *
 * Keys are per repository: repositories never wait on each other, and a caller
 * holds at most one key at a time (a spawn only ever touches its own repo), so
 * there is no lock ordering to deadlock on.
 */

/** Serializes `fn` per key: calls sharing a key run in arrival order, never concurrently. */
export class RepoLock {
  /** Tail of each key's queue — the settlement of the last run admitted for it. */
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const queued = (this.tails.get(key) ?? Promise.resolve()).then(fn);
    // The queue holds settlement, not the value, so one failure cannot block the runs behind it.
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await queued;
    } finally {
      // Only the last run clears the key; a queued run has already replaced the tail.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
