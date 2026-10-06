/** merge-branch.integration.test.ts — the merge_cowboy_branch tool handler (git-plane guardrails: test/git/git-merger.integration.test.ts). */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExecOptions,
} from "@earendil-works/pi-coding-agent";
import { executeMergeBranchTool } from "../src/agents/tool-merge.js";
import type { MergeBatchParams } from "../src/agents/schemas/merge-batch.schema.js";
import {
  getPiInstance,
  getSessionCtx,
  setPiInstance,
  setSessionCtx,
} from "../src/shell.js";
import type { MergeItemOutcome } from "../src/agents/tool-merge.js";
import {
  cleanupTmpDirs,
  freshTmp,
  git,
  gitPi,
  gitStatus,
  makeAgentBranch,
  makeRepo,
} from "./helpers/git-repo.js";

async function runMerge(
  params: MergeBatchParams,
  sessionCwd: string,
): Promise<{ text: string; notify: ReturnType<typeof vi.fn> }> {
  const notify = vi.fn();
  const result = await executeMergeBranchTool(
    "call-1",
    params,
    undefined,
    undefined,
    { cwd: sessionCwd, ui: { notify } } as unknown as ExtensionContext,
  );
  return { text: result.content[0].text, notify };
}

afterEach(() => {
  cleanupTmpDirs();
  vi.restoreAllMocks();
});

/**
 * The shell's current binding, or null when nothing has bound it: the getters
 * refuse to invent a value, so an unbound shell reads as null here.
 */
function shellBinding(): { pi: unknown; ctx: unknown } {
  try {
    return { pi: getPiInstance(), ctx: getSessionCtx() };
  } catch {
    return { pi: null, ctx: null };
  }
}

describe("executeMergeBranchTool", () => {
  it("merges and returns a human-readable result", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-tool-33333333", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: repo } as ExtensionContext);
    try {
      const result = await executeMergeBranchTool(
        "call-1",
        { branches: ["cow-tool-33333333"] },
        undefined,
        undefined,
        { cwd: repo } as ExtensionContext,
      );
      expect(result.content[0].text).toMatch(
        /Merged "cow-tool-33333333" into "main"/,
      );
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });

  it("throws before merging anything when a branch repeats", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-tool-44444444", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: repo } as ExtensionContext);
    try {
      await expect(
        executeMergeBranchTool(
          "call-1",
          { branches: ["cow-tool-44444444", "cow-tool-44444444"] },
          undefined,
          undefined,
          { cwd: repo } as ExtensionContext,
        ),
      ).rejects.toThrow(/duplicate branches.*No item was handled/);
      await expect(
        git(["merge-base", "--is-ancestor", "cow-tool-44444444", "HEAD"], repo),
      ).rejects.toThrow();
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });

  it("rejects a repeat that differs only by surrounding whitespace", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-tool-44445555", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: repo } as ExtensionContext);
    try {
      await expect(
        executeMergeBranchTool(
          "call-1",
          { branches: ["  cow-tool-44445555", "cow-tool-44445555 "] },
          undefined,
          undefined,
          { cwd: repo } as ExtensionContext,
        ),
      ).rejects.toThrow(/duplicate branches.*No item was handled/);
      await expect(
        git(["merge-base", "--is-ancestor", "cow-tool-44445555", "HEAD"], repo),
      ).rejects.toThrow();
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });

  it("stays silent when the merge runs in the session repo", async () => {
    const repo = await makeRepo(freshTmp());
    await makeAgentBranch(repo, "cow-tool-55555555", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: repo } as ExtensionContext);
    try {
      const { text, notify } = await runMerge(
        { branches: ["cow-tool-55555555"] },
        repo,
      );
      expect(text.startsWith("WARNING:")).toBe(false);
      expect(text).toMatch(/Merged "cow-tool-55555555" into "main"/);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });

  it("warns loudly (notify + banner) when `repo` points at another repo, and still merges", async () => {
    const sessionRepo = await makeRepo(freshTmp());
    const mergeRepo = await makeRepo(freshTmp());
    await makeAgentBranch(mergeRepo, "cow-tool-66666666", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: sessionRepo } as ExtensionContext);
    try {
      const { text, notify } = await runMerge(
        { branches: ["cow-tool-66666666"], repo: mergeRepo },
        sessionRepo,
      );
      const expected = `WARNING: merging in ${mergeRepo}, outside your session repo (${sessionRepo}) — verify this was intended.`;
      expect(text.split("\n")[0]).toBe(expected);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(expected, "warning");
      expect(text).toMatch(/Merged "cow-tool-66666666" into "main"/);
      await git(
        ["merge-base", "--is-ancestor", "cow-tool-66666666", "HEAD"],
        mergeRepo,
      );
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });

  it("warns on the already-merged path too when outside the session repo", async () => {
    const sessionRepo = await makeRepo(freshTmp());
    const mergeRepo = await makeRepo(freshTmp());
    await makeAgentBranch(mergeRepo, "cow-tool-77777777", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: sessionRepo } as ExtensionContext);
    try {
      await runMerge(
        { branches: ["cow-tool-77777777"], repo: mergeRepo },
        sessionRepo,
      );
      const { text, notify } = await runMerge(
        { branches: ["cow-tool-77777777"], repo: mergeRepo },
        sessionRepo,
      );
      expect(text.split("\n")[0]).toBe(
        `WARNING: merging in ${mergeRepo}, outside your session repo (${sessionRepo}) — verify this was intended.`,
      );
      expect(text).toMatch(/already merged/);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });

  it("throws loudly — before merging — when the session scope cannot be resolved", async () => {
    const outsideGit = freshTmp();
    const mergeRepo = await makeRepo(freshTmp());
    await makeAgentBranch(mergeRepo, "cow-tool-88888888", "feat.txt", "new\n");
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: outsideGit } as ExtensionContext);
    try {
      await expect(
        executeMergeBranchTool(
          "call-1",
          { branches: ["cow-tool-88888888"], repo: mergeRepo },
          undefined,
          undefined,
          { cwd: outsideGit } as unknown as ExtensionContext,
        ),
      ).rejects.toThrow(/cannot verify the session repo/);
      await expect(
        git(
          ["merge-base", "--is-ancestor", "cow-tool-88888888", "HEAD"],
          mergeRepo,
        ),
      ).rejects.toThrow();
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  });
});

describe("executeMergeBranchTool — batch", () => {
  async function runBatch(
    params: MergeBatchParams,
    sessionCwd: string,
  ): Promise<{
    text: string;
    details: { branches: MergeItemOutcome[] };
    notify: ReturnType<typeof vi.fn>;
  }> {
    const notify = vi.fn();
    const result = await executeMergeBranchTool(
      "call-1",
      params,
      undefined,
      undefined,
      { cwd: sessionCwd, ui: { notify } } as unknown as ExtensionContext,
    );
    return {
      text: result.content[0].text,
      details: result.details,
      notify,
    };
  }

  async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
    const repo = await makeRepo(freshTmp());
    const prev = shellBinding();
    setPiInstance(gitPi());
    setSessionCtx({ cwd: repo } as ExtensionContext);
    try {
      await run(repo);
    } finally {
      setPiInstance(prev.pi as never);
      setSessionCtx(prev.ctx as never);
    }
  }

  it("merges every branch sequentially in input order", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-11111111", "a.txt", "a\n");
      await makeAgentBranch(repo, "cow-batch-22222222", "b.txt", "b\n");

      const { text, details } = await runBatch(
        { branches: ["cow-batch-11111111", "cow-batch-22222222"] },
        repo,
      );

      expect(text).toContain(
        `Merged "cow-batch-11111111" into "main" in ${repo}.`,
      );
      expect(text).toContain(
        `Merged "cow-batch-22222222" into "main" in ${repo}.`,
      );
      expect(text).toContain("\n\n---\n\n");
      expect(text.indexOf('"cow-batch-11111111"')).toBeLessThan(
        text.indexOf('"cow-batch-22222222"'),
      );
      expect(details.branches.map((a) => a.kind)).toEqual(["merged", "merged"]);
      await git(
        ["merge-base", "--is-ancestor", "cow-batch-11111111", "HEAD"],
        repo,
      );
      await git(
        ["merge-base", "--is-ancestor", "cow-batch-22222222", "HEAD"],
        repo,
      );
    });
  });

  it("reports an already-merged branch as data and merges the rest", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-33333333", "a.txt", "a\n");
      await makeAgentBranch(repo, "cow-batch-44444444", "b.txt", "b\n");

      await runBatch({ branches: ["cow-batch-33333333"] }, repo);
      const { text, details } = await runBatch(
        { branches: ["cow-batch-33333333", "cow-batch-44444444"] },
        repo,
      );

      expect(details.branches.map((a) => a.kind)).toEqual([
        "already-merged",
        "merged",
      ]);
      expect(text).toContain(
        `"cow-batch-33333333" is already merged into "main" — nothing to do.`,
      );
    });
  });

  it("reports an unknown branch as data and merges the rest", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-55555555", "a.txt", "a\n");

      const { text, details } = await runBatch(
        { branches: ["cow-batch-missing", "cow-batch-55555555"] },
        repo,
      );

      expect(details.branches.map((a) => a.kind)).toEqual([
        "unknown",
        "merged",
      ]);
      expect(text).toContain(
        `"cow-batch-missing": refusing to merge: branch "cow-batch-missing" does not exist in`,
      );
      expect(text).toContain(`Merged "cow-batch-55555555" into "main"`);
    });
  });

  it("halts on a conflict whose file listing could not run", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-conflict", "base.txt", "agent\n");
      await makeAgentBranch(repo, "cow-batch-77777777", "b.txt", "b\n");
      writeFileSync(join(repo, "base.txt"), "main\n");
      await git(["add", "-A"], repo);
      await git(["commit", "-qm", "main moves"], repo);

      const inner = gitPi();
      setPiInstance({
        exec: async (cmd: string, args: string[], opts?: ExecOptions) => {
          if (args[0] === "diff" && args.includes("--diff-filter=U")) {
            throw new Error("probe unavailable");
          }
          return inner.exec(cmd, args, opts);
        },
      } as unknown as ExtensionAPI);

      const { details } = await runBatch(
        { branches: ["cow-batch-conflict", "cow-batch-77777777"] },
        repo,
      );

      expect(details.branches.map((a) => a.kind)).toEqual([
        "conflict",
        "not-attempted",
      ]);
      const conflict = details.branches[0];
      expect(conflict.kind).toBe("conflict");
      if (conflict.kind === "conflict") {
        expect(conflict.files).toEqual([]);
      }
      await expect(
        git(
          ["merge-base", "--is-ancestor", "cow-batch-77777777", "HEAD"],
          repo,
        ),
      ).rejects.toThrow();
    });
  });

  it("refuses a target that is not a branch name before merging anything", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-88888888", "a.txt", "a\n");

      await expect(
        executeMergeBranchTool(
          "call-1",
          { branches: ["cow-batch-88888888"], target: "main..HEAD" },
          undefined,
          undefined,
          { cwd: repo } as unknown as ExtensionContext,
        ),
      ).rejects.toThrow(/the target ref "main\.\.HEAD"/);
      await expect(
        git(
          ["merge-base", "--is-ancestor", "cow-batch-88888888", "HEAD"],
          repo,
        ),
      ).rejects.toThrow();
    });
  });

  it("refuses a branch that is not a branch name before merging anything", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-88888888", "a.txt", "a\n");

      await expect(
        executeMergeBranchTool(
          "call-1",
          { branches: ["cow-batch-88888888", "not a branch"] },
          undefined,
          undefined,
          { cwd: repo } as unknown as ExtensionContext,
        ),
      ).rejects.toThrow(/the branch ref "not a branch"/);
      await expect(
        git(
          ["merge-base", "--is-ancestor", "cow-batch-88888888", "HEAD"],
          repo,
        ),
      ).rejects.toThrow();
    });
  });

  it("halts on a conflict: the merge stays in progress and later branches are not attempted", async () => {
    await withRepo(async (repo) => {
      await makeAgentBranch(repo, "cow-batch-66666666", "a.txt", "a\n");
      await makeAgentBranch(repo, "cow-batch-conflict", "base.txt", "agent\n");
      await makeAgentBranch(repo, "cow-batch-77777777", "b.txt", "b\n");
      writeFileSync(join(repo, "base.txt"), "main\n");
      await git(["add", "-A"], repo);
      await git(["commit", "-qm", "main moves"], repo);

      const { text, details } = await runBatch(
        {
          branches: [
            "cow-batch-66666666",
            "cow-batch-conflict",
            "cow-batch-77777777",
          ],
        },
        repo,
      );

      expect(details.branches.map((a) => a.kind)).toEqual([
        "merged",
        "conflict",
        "not-attempted",
      ]);
      const conflict = details.branches[1];
      expect(conflict.kind).toBe("conflict");
      if (conflict.kind === "conflict") {
        expect(conflict.files).toContain("base.txt");
      }
      expect(text).toContain("has conflicts in:");
      expect(text).toContain(
        `"cow-batch-77777777" not attempted — the merge of "cow-batch-conflict" conflicted`,
      );
      // The checkout is mid-merge: the third branch provably never merged.
      await expect(
        git(
          ["merge-base", "--is-ancestor", "cow-batch-77777777", "HEAD"],
          repo,
        ),
      ).rejects.toThrow();
      expect(await gitStatus(repo)).toMatch(/base\.txt/);
    });
  });
});
