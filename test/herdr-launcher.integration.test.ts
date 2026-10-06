import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentTab,
  findTaskAttempts,
  getAgentInfo,
  runHerdr,
  startPiAgent,
  stopAgentAndWait,
} from "../src/infrastructure/herdr-client.js";
import {
  deleteWorktreeBranch,
  formatRetentionReason,
  worktreeRetentionReason,
} from "../src/infrastructure/git-client.js";
import { createWorktreeCheckout } from "../src/spawn/herdr-launcher.js";
import type { WorktreeMaterialization } from "../src/spawn/worktree-policy.js";
import { resolvedBin } from "./helpers/resolved-bin.js";

const execFileAsync = promisify(execFile);

/** pi.exec mock with canned stdout. */
function mockPi(
  respond: (args: string[]) => { code: number; stdout: string; stderr: string },
): ExtensionAPI {
  return {
    exec: async (_cmd: string, args: string[], _opts?: unknown) =>
      respond(args),
  } as unknown as ExtensionAPI;
}

/** Canned herdr responses, real exec otherwise; records calls for shell-out assertions. */
function hybridPi(
  herdrResponse: (args: string[]) => {
    code: number;
    stdout: string;
    stderr: string;
  },
  herdrCalls?: string[][],
  otherCalls?: string[][],
  otherResponse?: (
    cmd: string,
    args: string[],
  ) => { code: number; stdout: string; stderr: string } | undefined,
): ExtensionAPI {
  return {
    exec: async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd === "herdr") {
        herdrCalls?.push(args);
        return herdrResponse(args);
      }
      otherCalls?.push([cmd, ...args]);
      const response = otherResponse?.(cmd, args);
      if (response) return response;
      try {
        const { stdout, stderr } = await execFileAsync(resolvedBin(cmd), args, {
          cwd: (opts as { cwd?: string } | undefined)?.cwd,
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        return {
          code: typeof e.code === "number" ? e.code : 1,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
        };
      }
    },
  } as unknown as ExtensionAPI;
}

describe("runHerdr", () => {
  it("parses JSON results", async () => {
    const pi = mockPi(() => ({
      code: 0,
      stdout: JSON.stringify({
        id: "x",
        result: { pane: { workspace_id: "w9" } },
      }),
      stderr: "",
    }));
    const result = (await runHerdr(pi, ["pane", "current", "--current"])) as {
      pane: { workspace_id: string };
    };
    expect(result.pane.workspace_id).toBe("w9");
  });

  it("throws HerdrError with the human message on a non-zero exit", async () => {
    const pi = mockPi(() => ({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({
        error: { code: "agent_not_ready", message: "startup timed out" },
      }),
    }));
    await expect(runHerdr(pi, ["agent", "start", "x"])).rejects.toMatchObject({
      name: "HerdrError",
      code: "agent_not_ready",
      message: "startup timed out",
    });
  });
});

describe("getAgentInfo", () => {
  it("gets an agent by its exact herdr name", async () => {
    const pi = mockPi((args) => {
      expect(args.slice(0, 2)).toEqual(["agent", "get"]);
      if (args[2] === "missing") {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_not_found", message: "not found" },
          }),
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          id: "x",
          result: {
            agent: {
              name: "cow-abc",
              agent_status: "done",
              pane_id: "w1:p2",
              interactive_ready: true,
            },
          },
        }),
        stderr: "",
      };
    });
    const info = await getAgentInfo(pi, "cow-abc");
    expect(info).toMatchObject({
      name: "cow-abc",
      state: "done",
      paneId: "w1:p2",
      interactiveReady: true,
    });
    expect(await getAgentInfo(pi, "missing")).toBeUndefined();
  });

  it("preserves the target name when agent get omits it", async () => {
    const pi = mockPi(() => ({
      code: 0,
      stdout: JSON.stringify({
        id: "x",
        result: {
          agent: {
            agent: "pi",
            agent_status: "working",
            pane_id: "w1:p2",
          },
        },
      }),
      stderr: "",
    }));
    await expect(getAgentInfo(pi, "cow-abc")).resolves.toMatchObject({
      name: "cow-abc",
      state: "working",
      paneId: "w1:p2",
    });
  });
});

describe("findTaskAttempts", () => {
  const AGENTS = [
    {
      name: "cow-fix-login-flow-01234567",
      agent_status: "working",
      pane_id: "p1",
    },
    { name: "cow-other-task-89abcdef", agent_status: "idle", pane_id: "p2" },
    // Nameless shape: no task identity, never matches.
    { name: "cow-0123456789abcdef0", agent_status: "done", pane_id: "p3" },
  ];

  function piWithAgents(): ExtensionAPI {
    return mockPi((args) => {
      expect(args[0]).toBe("agent");
      expect(args[1]).toBe("list");
      return {
        code: 0,
        stdout: JSON.stringify({
          id: "x",
          result: { agents: AGENTS },
        }),
        stderr: "",
      };
    });
  }

  it("finds live herdr agents carrying the task slug", async () => {
    const attempts = await findTaskAttempts(piWithAgents(), "fix-login-flow");
    expect(attempts).toHaveLength(1);
    // The probe narrows herdr's record to the one field the registry needs: the naming identity.
    expect(attempts[0]).toEqual({
      name: "cow-fix-login-flow-01234567",
    });
  });

  it("does not match a shorter slug prefix (fix vs fix-login-flow)", async () => {
    const attempts = await findTaskAttempts(piWithAgents(), "fix");
    expect(attempts).toEqual([]);
  });

  it("matches multiple attempts of the same task (all live panes)", async () => {
    const pi = mockPi(() => ({
      code: 0,
      stdout: JSON.stringify({
        id: "x",
        result: {
          agents: [
            {
              name: "cow-fix-login-flow-11111111",
              agent_status: "working",
              pane_id: "p1",
            },
            {
              name: "cow-fix-login-flow-22222222",
              agent_status: "blocked",
              pane_id: "p2",
            },
          ],
        },
      }),
      stderr: "",
    }));
    const attempts = await findTaskAttempts(pi, "fix-login-flow");
    expect(attempts.map((a) => a.name).sort()).toEqual([
      "cow-fix-login-flow-11111111",
      "cow-fix-login-flow-22222222",
    ]);
  });

  it("matches Herdr 0.8.x list records that omit the custom name via the worktree cwd", async () => {
    const pi = mockPi(() => ({
      code: 0,
      stdout: JSON.stringify({
        id: "x",
        result: {
          agents: [
            {
              agent: "pi",
              agent_status: "working",
              cwd: "/repo/.herdr-subagents/repo/cow-fix-login-flow-01234567",
              pane_id: "w1:p1",
            },
          ],
        },
      }),
      stderr: "",
    }));
    // Herdr 0.8.x drops the custom name, but the durable worktree directory
    // carries the same `cow-<slug>-<id>` identity, so the run still owns the task.
    await expect(findTaskAttempts(pi, "fix-login-flow")).resolves.toEqual([
      { name: "cow-fix-login-flow-01234567" },
    ]);
  });

  it("returns an empty list when the agent-list probe fails (best effort)", async () => {
    const pi = mockPi(() => ({
      code: 1,
      stdout: "",
      stderr: '{"error":{"code":"boom","message":"herdr failed"}}',
    }));
    const attempts = await findTaskAttempts(pi, "fix-login-flow");
    expect(attempts).toEqual([]);
  });
});

describe("createAgentTab", () => {
  it("parses tab + root pane ids from the create response", async () => {
    let seen: string[] = [];
    const pi = mockPi((args) => {
      seen = args;
      return {
        code: 0,
        stdout: JSON.stringify({
          id: "x",
          result: {
            tab: { tab_id: "w1:t3" },
            root_pane: { pane_id: "w1:p4" },
          },
        }),
        stderr: "",
      };
    });
    const { tabId, paneId } = await createAgentTab(pi, {
      workspaceId: "w1",
      cwd: "/repo",
      label: "general-purpose",
    });
    expect(tabId).toBe("w1:t3");
    expect(paneId).toBe("w1:p4");
    expect(seen).not.toContain("--env");
  });
});

describe("startPiAgent", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient unavailable-shell error until the shell is ready", async () => {
    let calls = 0;
    const pi = mockPi((args) => {
      if (args[0] !== "agent")
        throw new Error(`unexpected command: ${args[0]}`);
      calls++;
      if (calls < 3) {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: {
              code: "agent_pane_unavailable",
              message: "agent target pane w1:p2 is not an available shell",
            },
          }),
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ id: "x", result: {} }),
        stderr: "",
      };
    });

    vi.useFakeTimers();
    const promise = startPiAgent(pi, {
      name: "cow-abc",
      paneId: "w1:p2",
      piArgs: ["-p", "briefing"],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    expect(calls).toBe(3);
  });

  it("does not retry a non-fatal readiness error", async () => {
    let calls = 0;
    const pi = mockPi(() => {
      calls++;
      return {
        code: 1,
        stdout: "",
        stderr: JSON.stringify({
          error: { code: "agent_not_ready", message: "startup timed out" },
        }),
      };
    });

    await expect(
      startPiAgent(pi, { name: "cow-x", paneId: "w1:p1", piArgs: [] }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("reports the attempt count when the shell never becomes available", async () => {
    const pi = mockPi(() => ({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({
        error: {
          code: "agent_pane_unavailable",
          message: "agent target pane w1:p1 is not an available shell",
        },
      }),
    }));

    vi.useFakeTimers();
    const promise = startPiAgent(pi, {
      name: "cow-x",
      paneId: "w1:p1",
      piArgs: [],
    });
    // Attach the handler before advancing, or the rejection is unhandled.
    const assertion = expect(promise).rejects.toThrow(
      /failed after 5 attempts/,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });
});

describe("stopAgentAndWait", () => {
  it("confirms an interrupted agent is gone without closing its pane", async () => {
    const commands: string[][] = [];
    const pi = mockPi((args) => {
      commands.push(args);
      if (args[0] === "agent" && args[1] === "get") {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_not_found", message: "not found" },
          }),
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ id: "x", result: {} }),
        stderr: "",
      };
    });

    await expect(
      stopAgentAndWait(pi, "w1:p1", {
        interruptGraceMs: 0,
        confirmMs: 0,
      }),
    ).resolves.toBe(true);
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ["agent", "send-keys", "w1:p1"],
      ["agent", "get", "w1:p1"],
    ]);
  });

  it("confirms an agent that outlived the interrupt grace without closing its pane", async () => {
    let getCalls = 0;
    const commands: string[][] = [];
    const pi = mockPi((args) => {
      commands.push(args);
      if (args[0] === "agent" && args[1] === "get") {
        getCalls++;
        if (getCalls === 1) {
          return {
            code: 0,
            stdout: JSON.stringify({
              id: "x",
              result: {
                agent: {
                  agent_status: "idle",
                  pane_id: "w1:p1",
                },
              },
            }),
            stderr: "",
          };
        }
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "agent_not_found", message: "not found" },
          }),
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ id: "x", result: {} }),
        stderr: "",
      };
    });

    await expect(
      stopAgentAndWait(pi, "w1:p1", {
        interruptGraceMs: 0,
        confirmMs: 0,
      }),
    ).resolves.toBe(true);
    expect(commands.map((args) => args.slice(0, 3))).toEqual([
      ["agent", "send-keys", "w1:p1"],
      ["agent", "get", "w1:p1"],
      ["agent", "get", "w1:p1"],
    ]);
  });

  it("does not treat a failed registry probe as confirmation", async () => {
    const pi = mockPi((args) => {
      if (args[0] === "agent" && args[1] === "get") {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { code: "server_busy", message: "temporary failure" },
          }),
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ id: "x", result: {} }),
        stderr: "",
      };
    });

    await expect(
      stopAgentAndWait(pi, "w1:p1", {
        interruptGraceMs: 0,
        confirmMs: 0,
      }),
    ).resolves.toBe(false);
  });
});

/** Temp repo with a clean checkout plus gitignored state (only CoW carries it over). */
async function makeRepoWithIgnoredState(dir: string): Promise<string> {
  const repo = join(dir, "repo");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(repo, "tracked.txt"), "hello\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd: repo });
  mkdirSync(join(repo, "node_modules"));
  writeFileSync(join(repo, "node_modules", "dep.txt"), "dep\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  return repo;
}

async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd,
  });
  return stdout.trim();
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["branch", "--list", branch], {
    cwd,
  });
  return stdout.trim() !== "";
}

/** Canned herdr `worktree open` response. */
function herdrOpenResponse(wt: string, branch: string) {
  return () => ({
    code: 0,
    stdout: JSON.stringify({
      id: "x",
      result: {
        workspace: { workspace_id: "w1" },
        worktree: {
          path: wt,
          branch,
          label: "feature",
          is_linked_worktree: true,
        },
        tab: { tab_id: "w1:t9" },
        root_pane: { pane_id: "w1:p9" },
      },
    }),
    stderr: "",
  });
}

/** Every materialization the constructor accepts; only the tree it lays down differs. */
const MATERIALIZATIONS: readonly WorktreeMaterialization[] = [
  "copy-on-write",
  "checkout",
];

/** Only the checkout strategy's tree needs no clone-capable volume. */
const CHECKOUT_ONLY: readonly WorktreeMaterialization[] = ["checkout"];

describe.each(CHECKOUT_ONLY)(
  "createWorktreeCheckout (%s materialization)",
  (strategy) => {
    let tmp: string | undefined;

    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it("creates the worktree on the pinned branch without touching herdr", async () => {
      tmp = mkdtempSync(join(tmpdir(), `herdr-create-${strategy}-`));
      const repo = await makeRepoWithIgnoredState(tmp);
      const wt = join(tmp, "wt");
      const herdrCalls: string[][] = [];
      const otherCalls: string[][] = [];
      // Only herdr is canned; `git worktree add` and materialization run for real.
      const pi = hybridPi(
        herdrOpenResponse(wt, "cow-feature"),
        herdrCalls,
        otherCalls,
      );

      const created = await createWorktreeCheckout(pi, {
        repoCwd: repo,
        path: wt,
        branch: "cow-feature",
        materialization: strategy,
      });

      expect(created.path).toBe(wt);
      expect(created.branch).toBe("cow-feature");
      // Adoption is the host's job: the git half never shells out to herdr.
      expect(herdrCalls).toEqual([]);
      expect(await gitStatus(wt)).toBe("");
      expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("hello\n");
      expect(await gitStatus(repo)).toBe("");
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("hello\n");

      // A plain checkout runs no clone helper and shares nothing with the parent.
      expect(otherCalls.some(([cmd]) => clonedThroughPi(cmd))).toBe(false);
      expect(existsSync(join(wt, "node_modules", "dep.txt"))).toBe(false);
      expect(existsSync(join(wt, ".env"))).toBe(false);
    });

    it("carries a dirty parent's tracked work into the checkout under the dirty policy", async () => {
      tmp = mkdtempSync(join(tmpdir(), `herdr-create-${strategy}-dirty-`));
      const repo = await makeRepoWithIgnoredState(tmp);
      writeFileSync(join(repo, "tracked.txt"), "changed in main\n");
      writeFileSync(join(repo, "brand-new.txt"), "untracked\n");
      const wt = join(tmp, "wt");
      const before = await gitStatus(repo);
      const herdrCalls: string[][] = [];
      const pi = hybridPi(herdrOpenResponse(wt, "cow-feature"), herdrCalls);

      await createWorktreeCheckout(pi, {
        repoCwd: repo,
        path: wt,
        branch: "cow-feature",
        materialization: strategy,
        dirtyCheckout: "dirty",
      });

      // The parent's tracked edit rode along; its untracked and ignored state did not.
      expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe(
        "changed in main\n",
      );
      // `gitStatus` trims, so the porcelain status code loses its leading space.
      expect(await gitStatus(wt)).toBe("M tracked.txt");
      expect(existsSync(join(wt, "brand-new.txt"))).toBe(false);
      expect(existsSync(join(wt, "node_modules", "dep.txt"))).toBe(false);
      expect(existsSync(join(wt, ".env"))).toBe(false);
      // The parent is never touched on the way through.
      expect(before).not.toBe("");
      expect(await gitStatus(repo)).toBe(before);
      expect(herdrCalls).toEqual([]);
    });
  },
);

// The collision guard fails at `git worktree add`, before any materialization,
// so it holds for every strategy and needs no clone-capable volume.
describe.each(MATERIALIZATIONS)(
  "createWorktreeCheckout (%s materialization)",
  (strategy) => {
    let tmp: string | undefined;

    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    it("does not delete a pre-existing branch when git worktree add fails due to a collision", async () => {
      tmp = mkdtempSync(join(tmpdir(), `herdr-create-collision-${strategy}-`));
      const repo = await makeRepoWithIgnoredState(tmp);
      const wt = join(tmp, "wt");
      // Pre-create the branch: `git worktree add -b` refuses an existing one.
      await execFileAsync("git", ["branch", "cow-feature"], { cwd: repo });

      const herdrCalls: string[][] = [];
      const pi = hybridPi(herdrOpenResponse(wt, "cow-feature"), herdrCalls);

      await expect(
        createWorktreeCheckout(pi, {
          repoCwd: repo,
          path: wt,
          branch: "cow-feature",
          materialization: strategy,
        }),
      ).rejects.toThrow(/already exists/);
      expect(herdrCalls).toEqual([]);
      const verify = await execFileAsync(
        "git",
        ["rev-parse", "--verify", "--quiet", "refs/heads/cow-feature"],
        { cwd: repo },
      );
      expect(verify.stdout.trim()).not.toBe("");
    });
  },
);

/** Whether a command is one of the cloner's helpers rather than git or herdr. */
function clonedThroughPi(cmd: string): boolean {
  return cmd.endsWith("/python3") || cmd.endsWith("/cp") || cmd.endsWith("/du");
}

describe("createWorktreeCheckout rollback", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("falls back to a plain checkout, keeping the worktree, when the volume cannot clone", async () => {
    tmp = mkdtempSync(join(tmpdir(), "herdr-materialization-fallback-"));
    const repo = await makeRepoWithIgnoredState(tmp);
    const wt = join(tmp, "cow-feature");
    const herdrCalls: string[][] = [];
    const pi = hybridPi(
      () => ({
        code: 0,
        stdout: JSON.stringify({ id: "x", result: { worktrees: [] } }),
        stderr: "",
      }),
      herdrCalls,
      undefined,
      (cmd) =>
        clonedThroughPi(cmd)
          ? { code: 1, stdout: "", stderr: "clone failed: not supported" }
          : undefined,
    );

    const checkout = await createWorktreeCheckout(pi, {
      repoCwd: repo,
      path: wt,
      branch: "cow-feature",
      materialization: "copy-on-write",
    });

    expect(checkout.path).toBe(wt);
    expect(existsSync(join(wt, "tracked.txt"))).toBe(true);
    expect(await branchExists(repo, "cow-feature")).toBe(true);
    expect(herdrCalls).toEqual([]);
  });

  it("tells the caller why a fallback happened", async () => {
    tmp = mkdtempSync(join(tmpdir(), "herdr-materialization-notify-"));
    const repo = await makeRepoWithIgnoredState(tmp);
    const wt = join(tmp, "cow-feature");
    const pi = hybridPi(
      () => ({
        code: 0,
        stdout: JSON.stringify({ id: "x", result: { worktrees: [] } }),
        stderr: "",
      }),
      [],
      undefined,
      (cmd) =>
        clonedThroughPi(cmd)
          ? { code: 1, stdout: "", stderr: "clone failed: not supported" }
          : undefined,
    );
    const warnings: string[] = [];

    await createWorktreeCheckout(pi, {
      repoCwd: repo,
      path: wt,
      branch: "cow-feature",
      materialization: "copy-on-write",
      dirtyCheckout: "dirty",
      notify: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("cannot clone");
    expect(warnings[0]).toContain("uncommitted work was not carried over");
  });

  it("removes the worktree and its branch when the checkout cannot be completed at all", async () => {
    tmp = mkdtempSync(join(tmpdir(), "herdr-materialization-rollback-"));
    const repo = await makeRepoWithIgnoredState(tmp);
    const wt = join(tmp, "cow-feature");
    const herdrCalls: string[][] = [];
    const pi = hybridPi(
      () => ({
        code: 0,
        stdout: JSON.stringify({ id: "x", result: { worktrees: [] } }),
        stderr: "",
      }),
      herdrCalls,
      undefined,
      (cmd, args) => {
        // Cloning is out, and so is git finishing the checkout behind it.
        if (clonedThroughPi(cmd)) {
          return { code: 1, stdout: "", stderr: "clone failed: not supported" };
        }
        if (cmd === "git" && args.includes("reset")) {
          return { code: 1, stdout: "", stderr: "reset failed" };
        }
        return undefined;
      },
    );

    await expect(
      createWorktreeCheckout(pi, {
        repoCwd: repo,
        path: wt,
        branch: "cow-feature",
        materialization: "copy-on-write",
      }),
    ).rejects.toThrow(/materialization failed/);

    expect(existsSync(wt)).toBe(false);
    expect(await branchExists(repo, "cow-feature")).toBe(false);
    expect(herdrCalls).toEqual([]);
  });

  it("removes the branch after rejecting a worktree whose branch cannot be verified", async () => {
    tmp = mkdtempSync(join(tmpdir(), "herdr-branch-rollback-"));
    const repo = await makeRepoWithIgnoredState(tmp);
    const wt = join(tmp, "cow-feature");
    const pi = hybridPi(
      () => ({
        code: 0,
        stdout: JSON.stringify({ id: "x", result: { worktrees: [] } }),
        stderr: "",
      }),
      undefined,
      undefined,
      (cmd, args) =>
        cmd === "git" && args[0] === "branch" && args[1] === "--show-current"
          ? { code: 0, stdout: "unexpected-branch\n", stderr: "" }
          : undefined,
    );

    await expect(
      createWorktreeCheckout(pi, {
        repoCwd: repo,
        path: wt,
        branch: "cow-feature",
        materialization: "checkout",
      }),
    ).rejects.toThrow(/not the requested/);

    expect(existsSync(wt)).toBe(false);
    expect(await branchExists(repo, "cow-feature")).toBe(false);
  });
});

describe("worktreeRetentionReason", () => {
  const WT = "/work/.herdr-subagents/repo/cow-general-purpose-abc12345";

  function retentionPi(overrides: {
    statusCode?: number;
    statusStdout?: string;
    revParseCode?: number;
    mergeBaseCode?: number;
  }): ExtensionAPI {
    return mockPi((args) => {
      if (args[0] === "status") {
        return {
          code: overrides.statusCode ?? 0,
          stdout: overrides.statusStdout ?? "",
          stderr: "",
        };
      }
      if (args[0] === "rev-parse") {
        return { code: overrides.revParseCode ?? 0, stdout: "", stderr: "" };
      }
      if (args[0] === "merge-base") {
        return { code: overrides.mergeBaseCode ?? 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
  }

  it("returns null for a clean worktree", async () => {
    expect(await worktreeRetentionReason(retentionPi({}), WT)).toBeNull();
  });

  it("keeps a dirty worktree (uncommitted changes)", async () => {
    expect(
      await worktreeRetentionReason(
        retentionPi({ statusStdout: " M file.ts\n" }),
        WT,
      ),
    ).toEqual({ kind: "dirty" });
  });

  it("keeps a clean worktree whose branch commits are unmerged — only dirtiness blocks removal", async () => {
    // Unmerged commits live in the repo, not the checkout; the branch itself is kept by deleteWorktreeBranch.
    expect(
      await worktreeRetentionReason(retentionPi({ mergeBaseCode: 1 }), WT),
    ).toBeNull();
  });

  it("treats a failed status probe as unverifiable (conservative keep)", async () => {
    expect(
      await worktreeRetentionReason(retentionPi({ statusCode: 1 }), WT),
    ).toEqual({ kind: "unverifiable", detail: "git status probe failed" });
  });

  it("does not consult branch existence or merge state at all", async () => {
    // Only dirtiness (or the inability to measure it) can keep a tree.
    expect(
      await worktreeRetentionReason(
        retentionPi({ revParseCode: 1, mergeBaseCode: 1 }),
        WT,
      ),
    ).toBeNull();
  });

  it("treats any non-extension worktree the same (no branch checks)", async () => {
    expect(
      await worktreeRetentionReason(
        retentionPi({ mergeBaseCode: 1 }),
        "/work/.herdr-subagents/repo/user-feature",
      ),
    ).toBeNull();
  });
});

describe("formatRetentionReason", () => {
  it("renders each retention kind with the path", () => {
    expect(formatRetentionReason({ kind: "dirty" }, "/wt/cow-x-abc12345")).toBe(
      "Worktree /wt/cow-x-abc12345 has uncommitted changes — NOT removed.",
    );
    expect(
      formatRetentionReason(
        { kind: "unverifiable", detail: "git status probe failed" },
        "/wt/cow-x-abc12345",
      ),
    ).toBe(
      "Worktree /wt/cow-x-abc12345 state could not be verified (git status probe failed) — NOT removed.",
    );
  });
});

describe("deleteWorktreeBranch", () => {
  const WORKTREE = "/work/.herdr-subagents/repo/cow-fix-0123456789abcdef0";
  const BRANCH = "cow-fix-0123456789abcdef0";
  const CWD = "/work/repo";

  interface BranchMockOptions {
    refExists?: boolean;
    merged?: boolean;
    deleteExit?: number;
    deleteStderr?: string;
  }

  /** Canned git-probe responder; the attachment probe is injected. */
  function branchPi(opts: BranchMockOptions): ExtensionAPI {
    const {
      refExists = true,
      merged = true,
      deleteExit = 0,
      deleteStderr = "",
    } = opts;
    return mockPi((args) => {
      switch (args[0]) {
        case "rev-parse":
          return {
            code: refExists ? 0 : 1,
            stdout: "",
            stderr: refExists ? "" : `error: refs/heads/${BRANCH} not found`,
          };
        case "merge-base":
          return { code: merged ? 0 : 1, stdout: "", stderr: "" };
        case "branch":
          return { code: deleteExit, stdout: "", stderr: deleteStderr };
        default:
          return {
            code: 1,
            stdout: "",
            stderr: `unexpected: ${args.join(" ")}`,
          };
      }
    });
  }

  it("reports not-applicable for a non-cow- basename without touching git", async () => {
    const pi = mockPi(() => {
      throw new Error("no git calls expected");
    });
    expect(
      await deleteWorktreeBranch(pi, "/work/repo/some-other-dir", CWD),
    ).toEqual({ kind: "not-applicable" });
  });

  it("reports not-applicable when the branch ref does not exist", async () => {
    const pi = branchPi({ refExists: false });
    expect(await deleteWorktreeBranch(pi, WORKTREE, CWD)).toEqual({
      kind: "not-applicable",
    });
  });

  it("keeps an unmerged branch (merge-base is not an ancestor)", async () => {
    const pi = branchPi({ merged: false });
    expect(await deleteWorktreeBranch(pi, WORKTREE, CWD)).toEqual({
      kind: "kept",
      reason: "unmerged",
    });
  });

  it("keeps a branch whose checkout the backend still has attached", async () => {
    const pi = branchPi({});
    expect(
      await deleteWorktreeBranch(pi, WORKTREE, CWD, async () => true),
    ).toEqual({
      kind: "kept",
      reason: "checked-out",
    });
  });

  it("deletes a merged, no-longer-checked-out branch", async () => {
    const pi = branchPi({});
    expect(await deleteWorktreeBranch(pi, WORKTREE, CWD)).toEqual({
      kind: "deleted",
    });
  });

  it("reports delete-failed with the git stderr when branch -D fails", async () => {
    const pi = branchPi({
      deleteExit: 128,
      deleteStderr: `error: branch '${BRANCH}' not found.`,
    });
    expect(await deleteWorktreeBranch(pi, WORKTREE, CWD)).toEqual({
      kind: "delete-failed",
      detail: `error: branch '${BRANCH}' not found.`,
    });
  });
});
