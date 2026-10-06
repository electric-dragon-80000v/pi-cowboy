/** repo-lock.test.ts — per-repo serialization of worktree creation. */

import { describe, expect, it } from "vitest";
import { RepoLock } from "../src/spawn/repo-lock.js";

/** Yield long enough that an unserialized pair would overlap. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe("RepoLock", () => {
  it("runs one key's work in arrival order, never concurrently", async () => {
    const lock = new RepoLock();
    const order: string[] = [];
    const run = (name: string) =>
      lock.run("/repo", async () => {
        order.push(`start ${name}`);
        await tick();
        order.push(`end ${name}`);
      });

    await Promise.all([run("a"), run("b"), run("c")]);

    expect(order).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  it("runs different keys concurrently", async () => {
    const lock = new RepoLock();
    let live = 0;
    let peak = 0;
    const run = (key: string) =>
      lock.run(key, async () => {
        live += 1;
        peak = Math.max(peak, live);
        await tick();
        live -= 1;
      });

    await Promise.all([run("/repo-a"), run("/repo-b")]);

    expect(peak).toBe(2);
  });

  it("returns the run's own value and its own failure", async () => {
    const lock = new RepoLock();
    const boom = new Error("boom");

    await expect(
      lock.run("/repo", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(lock.run("/repo", async () => "ok")).resolves.toBe("ok");
  });

  it("does not let a failed run block the runs queued behind it", async () => {
    const lock = new RepoLock();
    const order: string[] = [];

    const failed = lock.run("/repo", async () => {
      order.push("failed");
      throw new Error("boom");
    });
    await lock.run("/repo", async () => {
      order.push("after");
    });
    await failed.catch(() => undefined);

    expect(order).toEqual(["failed", "after"]);
  });
});
