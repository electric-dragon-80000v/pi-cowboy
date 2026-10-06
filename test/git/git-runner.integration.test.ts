/**
 * git-runner.integration.test.ts — Layer 1 (src/infrastructure/git/git-runner.ts).
 *
 * How each primitive reports a non-zero exit vs. a process that never started,
 * plus the two repo-layout questions layers above ask.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitCommandRunner,
  GitError,
  GIT_WORKTREE_TIMEOUT_MS,
  gitProbe,
  gitRun,
  locateMainCheckout,
  resolveMainCheckout,
} from "../../src/infrastructure/git/git-runner.js";
import {
  addWorktree,
  brokenPi,
  cleanupTmpDirs,
  freshTmp,
  makeCleanRepo,
  makeRepo,
  realPi,
} from "../helpers/git-repo.js";

afterEach(cleanupTmpDirs);

describe("GitCommandRunner.run", () => {
  it("normalizes the exit code with trimmed stdout/stderr", async () => {
    const repo = await makeRepo(freshTmp());
    const result = await new GitCommandRunner(realPi()).run(
      ["rev-parse", "--show-toplevel"],
      repo,
    );

    expect(result).toEqual({ code: 0, stdout: repo, stderr: "" });
  });

  it("reports a non-zero exit as data rather than throwing", async () => {
    const repo = await makeRepo(freshTmp());
    const result = await new GitCommandRunner(realPi()).run(
      ["rev-parse", "--verify", "--quiet", "refs/heads/nope"],
      repo,
    );

    expect(result?.code).not.toBe(0);
    expect(result?.code).toBeDefined();
  });

  it("returns undefined when pi.exec itself fails (transport, not git)", async () => {
    const runner = new GitCommandRunner(brokenPi());
    expect(await runner.run(["status"], "/tmp")).toBeUndefined();
  });
});

describe("GitCommandRunner.probe", () => {
  it("returns trimmed stdout when git answers", async () => {
    const repo = await makeRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    expect(await runner.probe(["branch", "--show-current"], repo)).toBe("main");
  });

  it("returns undefined on a non-zero exit — the question was not answered", async () => {
    const repo = await makeRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    expect(
      await runner.probe(
        ["rev-parse", "--verify", "--quiet", "refs/heads/nope"],
        repo,
      ),
    ).toBeUndefined();
  });

  it("returns undefined instead of throwing when the command cannot run", async () => {
    const runner = new GitCommandRunner(brokenPi());
    expect(await runner.probe(["status"], "/tmp")).toBeUndefined();
  });
});

describe("GitCommandRunner.exec", () => {
  it("returns trimmed stdout on success", async () => {
    const repo = await makeRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    expect(await runner.exec(["rev-parse", "--show-toplevel"], repo)).toBe(
      repo,
    );
  });

  it("throws a GitError naming the argv and git's stderr on a non-zero exit", async () => {
    const repo = await makeRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    await expect(
      runner.exec(["rev-parse", "--verify", "refs/heads/nope"], repo),
    ).rejects.toBeInstanceOf(GitError);
    await expect(
      runner.exec(["rev-parse", "--verify", "refs/heads/nope"], repo),
    ).rejects.toThrow(
      /git rev-parse --verify refs\/heads\/nope failed in .*\(exit \d+\)/,
    );
  });

  it("throws when the process could not run at all", async () => {
    const runner = new GitCommandRunner(brokenPi());

    await expect(runner.exec(["status"], "/tmp")).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(runner.exec(["status"], "/tmp")).rejects.toThrow(
      /could not be run/,
    );
  });
});

describe("GitCommandRunner.test", () => {
  it("answers yes/no for a git question", async () => {
    const repo = await makeRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    expect(
      await runner.test(["rev-parse", "--verify", "refs/heads/main"], repo),
    ).toBe(true);
    expect(
      await runner.test(["rev-parse", "--verify", "refs/heads/nope"], repo),
    ).toBe(false);
  });

  it("answers no when the command could not run", async () => {
    const runner = new GitCommandRunner(brokenPi());
    expect(await runner.test(["status"], "/tmp")).toBe(false);
  });
});

describe("GitCommandRunner.lines", () => {
  it("keeps non-empty entries and drops the separator's empty tail", async () => {
    const repo = await makeCleanRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    const entries = await runner.lines(
      ["status", "--ignored", "--porcelain", "-z"],
      repo,
      "\0",
    );

    expect(entries).toEqual(["!! .env", "!! node_modules/"]);
    expect(entries?.every((entry) => entry !== "")).toBe(true);
  });

  it("returns no lines for empty output", async () => {
    const repo = await makeRepo(freshTmp());
    const runner = new GitCommandRunner(realPi());

    expect(await runner.lines(["status", "--porcelain"], repo)).toEqual([]);
  });

  it("returns undefined when the probe fails, so callers never read it as 'no lines'", async () => {
    const runner = new GitCommandRunner(brokenPi());

    expect(
      await runner.lines(["status", "--porcelain"], "/tmp"),
    ).toBeUndefined();
    expect(
      await runner.lines(["status", "--porcelain"], join(freshTmp(), "nope")),
    ).toBeUndefined();
  });
});

describe("GitCommandRunner.helper", () => {
  it("runs a bundled helper through the shell and reports its raw result", async () => {
    const runner = new GitCommandRunner(realPi());
    const run = await runner.helper("sh", ["-c", "echo mode=clone"], {
      timeoutMs: GIT_WORKTREE_TIMEOUT_MS,
    });

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("mode=clone");
  });

  it("reports a helper that cannot start as exit 1 with the transport error in stderr", async () => {
    const runner = new GitCommandRunner(brokenPi("no such helper"));
    const run = await runner.helper("sh", ["-c", "true"], { timeoutMs: 1000 });

    expect(run).toEqual({ code: 1, stdout: "", stderr: "no such helper" });
  });
});

describe("gitRun / gitProbe", () => {
  it("gitRun mirrors run: code + trimmed output, undefined on transport failure", async () => {
    const repo = await makeRepo(freshTmp());

    expect(await gitRun(realPi(), ["branch", "--show-current"], repo)).toEqual({
      code: 0,
      stdout: "main",
      stderr: "",
    });
    expect(
      await gitRun(brokenPi(), ["branch", "--show-current"], repo),
    ).toBeUndefined();
  });

  it("gitProbe mirrors probe: trimmed stdout, undefined on failure", async () => {
    const repo = await makeRepo(freshTmp());

    expect(await gitProbe(realPi(), ["branch", "--show-current"], repo)).toBe(
      "main",
    );
    expect(
      await gitProbe(realPi(), ["rev-parse", "--verify", "nope"], repo),
    ).toBeUndefined();
    expect(await gitProbe(brokenPi(), ["status"], repo)).toBeUndefined();
  });
});

describe("locateMainCheckout", () => {
  it("resolves a relative common dir against the probed cwd", () => {
    expect(locateMainCheckout(".git", "/work/repo")).toEqual({
      commonDir: "/work/repo/.git",
      mainRoot: "/work/repo",
    });
  });

  it("takes an absolute common dir as-is and reports its parent as the main root", () => {
    expect(locateMainCheckout("/work/repo/.git", "/elsewhere")).toEqual({
      commonDir: "/work/repo/.git",
      mainRoot: "/work/repo",
    });
  });
});

describe("resolveMainCheckout", () => {
  it("resolves the main checkout for a repo root and for a linked worktree of it", async () => {
    const repo = await makeRepo(freshTmp());
    const wt = join(freshTmp(), "wt-cow-resolve-00000000");
    await addWorktree(repo, wt, "cow-resolve-00000000");

    expect(await resolveMainCheckout(realPi(), repo)).toBe(repo);
    expect(await resolveMainCheckout(realPi(), wt)).toBe(repo);
  });

  it("throws a GitError when the cwd is not inside a git repository", async () => {
    const outside = freshTmp();

    await expect(resolveMainCheckout(realPi(), outside)).rejects.toBeInstanceOf(
      GitError,
    );
    await expect(resolveMainCheckout(realPi(), outside)).rejects.toThrow(
      /cannot create worktree: .* is not inside a git repository/,
    );
  });
});

describe("GIT_WORKTREE_TIMEOUT_MS", () => {
  it("is the worktree-operation budget the plane pins every add/remove/reset to", () => {
    expect(GIT_WORKTREE_TIMEOUT_MS).toBe(60_000);
  });
});
