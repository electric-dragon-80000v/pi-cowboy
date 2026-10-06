/** sandbox.test.ts — AgentSandbox allocation (create + adopt + rollbacks) and teardown (retention/state). */

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateWorktreeOptions,
  WorktreeCheckout,
} from "../src/spawn/herdr-launcher.js";
import {
  AgentSandbox,
  formatLaunchCleanupNote,
  type SandboxRequest,
} from "../src/spawn/sandbox.js";

const {
  resolveMainCheckoutMock,
  createWorktreeCheckoutMock,
  removeGitWorktreeMock,
  deleteWorktreeBranchMock,
  isWorktreeDirtyMock,
  hostAtMock,
  isAttachedMock,
  releaseMock,
  stopMock,
} = vi.hoisted(() => ({
  resolveMainCheckoutMock: vi.fn(),
  createWorktreeCheckoutMock: vi.fn(),
  removeGitWorktreeMock: vi.fn(),
  deleteWorktreeBranchMock: vi.fn(),
  isWorktreeDirtyMock: vi.fn(),
  hostAtMock: vi.fn(),
  isAttachedMock: vi.fn(),
  releaseMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/infrastructure/git-client.js")
  >()),
  resolveMainCheckout: resolveMainCheckoutMock,
  removeGitWorktree: removeGitWorktreeMock,
  deleteWorktreeBranch: deleteWorktreeBranchMock,
  isWorktreeDirty: isWorktreeDirtyMock,
}));

vi.mock("../src/spawn/herdr-launcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/spawn/herdr-launcher.js")>()),
  createWorktreeCheckout: createWorktreeCheckoutMock,
}));

const REF = {
  engine: "herdr",
  name: "cow-fix-login-abc12345",
  paneId: "p1",
  tabId: "t1",
  workspaceId: "w1",
  paneCreated: false,
};

const pi = {} as ExtensionAPI;

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-wt-"));
}

beforeEach(() => {
  resolveMainCheckoutMock.mockReset();
  createWorktreeCheckoutMock.mockReset();
  removeGitWorktreeMock.mockReset();
  deleteWorktreeBranchMock.mockReset();
  deleteWorktreeBranchMock.mockResolvedValue({ kind: "deleted" });
  isWorktreeDirtyMock.mockReset();
  isWorktreeDirtyMock.mockResolvedValue(false);
  hostAtMock.mockReset();
  hostAtMock.mockResolvedValue(REF);
  isAttachedMock.mockReset();
  isAttachedMock.mockResolvedValue(false);
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(true);
  stopMock.mockReset();
  stopMock.mockResolvedValue(true);
});

function created(
  pathname: string,
  branch = "cow-fix-login-abc12345",
): WorktreeCheckout {
  return { path: pathname, branch, repoCwd: "/work/repo" };
}

function host() {
  return {
    hostAt: hostAtMock,
    isAttached: isAttachedMock,
    release: releaseMock,
    stop: stopMock,
  } as never;
}

/** Shared allocation request; cases override naming/root/host. */
function request(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    naming: { kind: "generated", taskSlug: "fix-login", id: "abc12345" },
    parentCwd: "/work/repo/src",
    worktreeRoot: tempRoot(),
    materialization: "copy-on-write",
    dirtyCheckout: "dirty",
    host: host(),
    ...overrides,
  };
}

/** Provision a sandbox against a real temp checkout on disk. */
async function allocated(worktreePath: string): Promise<AgentSandbox> {
  fs.mkdirSync(worktreePath, { recursive: true });
  resolveMainCheckoutMock.mockResolvedValue("/work/repo");
  createWorktreeCheckoutMock.mockResolvedValue(created(worktreePath));
  return AgentSandbox.allocate(
    pi,
    request({
      parentCwd: "/work/repo/src",
      worktreeRoot: path.dirname(worktreePath),
    }),
  );
}

/** Capture an allocation rejection for message assertions. */
async function allocationError(
  overrides: Partial<SandboxRequest>,
): Promise<Error> {
  const err = await AgentSandbox.allocate(pi, request(overrides)).catch(
    (caught: unknown) => caught,
  );
  if (!(err instanceof Error)) throw new Error("expected allocation to throw");
  return err;
}

describe("AgentSandbox.allocate", () => {
  it("names branch, worktree directory, and herdr agent from the one spawn id", async () => {
    const root = tempRoot();
    const id = "z7k3m9q2";
    const branch = `cow-wire-up-${id}`;
    const worktreePath = path.join(root, branch);
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    createWorktreeCheckoutMock.mockResolvedValue(created(worktreePath, branch));

    const sandbox = await AgentSandbox.allocate(
      pi,
      request({
        naming: { kind: "generated", taskSlug: "wire-up", id },
        parentCwd: "/work/repo/src",
        worktreeRoot: root,
      }),
    );

    // One id on four surfaces: spawn, branch, directory, herdr name.
    expect(branch.endsWith(`-${id}`)).toBe(true);
    expect(sandbox.branch).toBe(branch);
    expect(path.basename(sandbox.worktree!.path)).toBe(branch);
    expect(hostAtMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: branch, label: branch }),
    );
  });

  it("serializes creation per repository, so two spawns never add at once", async () => {
    const root = tempRoot();
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    const order: string[] = [];
    let creating = 0;
    let overlaps = 0;
    createWorktreeCheckoutMock.mockImplementation(
      async (_pi: unknown, options: CreateWorktreeOptions) => {
        creating += 1;
        if (creating > 1) overlaps += 1;
        order.push(`start ${options.branch}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${options.branch}`);
        creating -= 1;
        return created(options.path, options.branch);
      },
    );

    await Promise.all([
      AgentSandbox.allocate(
        pi,
        request({
          naming: { kind: "generated", taskSlug: "one", id: "aaaaaaaa" },
          parentCwd: "/work/repo/src",
          worktreeRoot: root,
        }),
      ),
      AgentSandbox.allocate(
        pi,
        request({
          naming: { kind: "generated", taskSlug: "two", id: "bbbbbbbb" },
          parentCwd: "/work/repo/src",
          worktreeRoot: root,
        }),
      ),
    ]);

    expect(overlaps).toBe(0);
    // Each creation starts only after the previous one ended — never interleaved.
    expect(order.map((line) => line.split(" ")[0])).toEqual([
      "start",
      "end",
      "start",
      "end",
    ]);
  });

  it("keeps different repositories creating at the same time", async () => {
    const root = tempRoot();
    resolveMainCheckoutMock.mockImplementation(
      async (_pi: unknown, cwd: string) =>
        cwd.includes("repo-b") ? "/work/repo-b" : "/work/repo-a",
    );
    let creating = 0;
    let peak = 0;
    createWorktreeCheckoutMock.mockImplementation(
      async (_pi: unknown, options: CreateWorktreeOptions) => {
        creating += 1;
        peak = Math.max(peak, creating);
        await new Promise((resolve) => setTimeout(resolve, 5));
        creating -= 1;
        return created(options.path, options.branch);
      },
    );

    await Promise.all([
      AgentSandbox.allocate(
        pi,
        request({ parentCwd: "/work/repo-a/src", worktreeRoot: root }),
      ),
      AgentSandbox.allocate(
        pi,
        request({
          naming: { kind: "generated", taskSlug: "two", id: "bbbbbbbb" },
          parentCwd: "/work/repo-b/src",
          worktreeRoot: root,
        }),
      ),
    ]);

    expect(peak).toBe(2);
  });

  it("resolves the main checkout, then creates a pinned branch directly", async () => {
    const root = tempRoot();
    const worktreePath = path.join(root, "cow-fix-login-abc12345");
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    createWorktreeCheckoutMock.mockResolvedValue(created(worktreePath));

    const sandbox = await AgentSandbox.allocate(
      pi,
      request({ parentCwd: "/work/repo/src", worktreeRoot: root }),
    );

    expect(sandbox.branch).toBe("cow-fix-login-abc12345");
    expect(sandbox.worktree).toEqual({
      path: worktreePath,
      branch: "cow-fix-login-abc12345",
    });
    expect(sandbox.hostRef).toEqual(REF);
    expect(sandbox.projectTrusted).toBe(true);
    expect(sandbox.state).toEqual({ kind: "bound" });

    expect(resolveMainCheckoutMock).toHaveBeenCalledWith(pi, "/work/repo/src");
    expect(createWorktreeCheckoutMock).toHaveBeenCalledWith(pi, {
      repoCwd: "/work/repo",
      path: worktreePath,
      branch: "cow-fix-login-abc12345",
      materialization: "copy-on-write",
      dirtyCheckout: "dirty",
    } satisfies CreateWorktreeOptions);
    expect(hostAtMock).toHaveBeenCalledWith({
      unit: "pane",
      cwd: worktreePath,
      label: "cow-fix-login-abc12345",
      name: "cow-fix-login-abc12345",
      checkout: {
        path: worktreePath,
        repoCwd: "/work/repo",
        branch: "cow-fix-login-abc12345",
      },
    });
  });

  it("uses an explicit branch name for the branch, directory, and herdr agent", async () => {
    const root = tempRoot();
    const branch = "cow-my-thing";
    const worktreePath = path.join(root, branch);
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    createWorktreeCheckoutMock.mockResolvedValue(created(worktreePath, branch));

    const sandbox = await AgentSandbox.allocate(
      pi,
      request({
        naming: { kind: "explicit", branch },
        parentCwd: "/work/repo/src",
        worktreeRoot: root,
      }),
    );

    expect(sandbox.branch).toBe(branch);
    expect(sandbox.worktree).toEqual({ path: worktreePath, branch });
    expect(createWorktreeCheckoutMock).toHaveBeenCalledWith(pi, {
      repoCwd: "/work/repo",
      path: worktreePath,
      branch,
      materialization: "copy-on-write",
      dirtyCheckout: "dirty",
    } satisfies CreateWorktreeOptions);
    expect(hostAtMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: branch, label: branch }),
    );
  });

  it("rejects an empty explicit branch before touching git or herdr", async () => {
    const error = await allocationError({
      naming: { kind: "explicit", branch: "   " },
    });

    expect(error.message).toBe(
      "explicit worktree naming requires a branch name",
    );
    expect(resolveMainCheckoutMock).not.toHaveBeenCalled();
    expect(createWorktreeCheckoutMock).not.toHaveBeenCalled();
  });

  it("falls back to the parent directory with a warning outside a git repository", async () => {
    resolveMainCheckoutMock.mockRejectedValue(new Error("not a repository"));
    const notifications: Array<{ message: string; kind: string }> = [];

    const sandbox = await AgentSandbox.allocate(
      pi,
      request({
        parentCwd: "/nowhere",
        materialization: "checkout",
        notify: (message, kind) => notifications.push({ message, kind }),
      }),
    );

    expect(sandbox.branch).toBe("cow-fix-login-abc12345");
    expect(sandbox.worktree).toBeUndefined();
    expect(sandbox.hostRef).toBeUndefined();
    expect(sandbox.state).toEqual({ kind: "bound" });
    expect(notifications).toEqual([
      {
        message:
          "[cowboy] Parent is not inside a git repository — spawning in the parent cwd without a worktree",
        kind: "warning",
      },
    ]);
    expect(createWorktreeCheckoutMock).not.toHaveBeenCalled();
  });

  it("reports a failed git create with its cleanup note and never adopts", async () => {
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    createWorktreeCheckoutMock.mockRejectedValue(new Error("branch exists"));

    const error = await allocationError({});

    expect(error.message).toContain(
      "could not create the herdr worktree: branch exists",
    );
    expect(error.message).toContain(
      "Launch-failure cleanup: no worktree residue was left behind.",
    );
    expect(hostAtMock).not.toHaveBeenCalled();
  });

  it("rolls the git checkout back when adoption fails", async () => {
    const root = tempRoot();
    const worktreePath = path.join(root, "cow-fix-login-abc12345");
    resolveMainCheckoutMock.mockResolvedValue("/work/repo");
    createWorktreeCheckoutMock.mockResolvedValue(created(worktreePath));
    hostAtMock.mockRejectedValue(new Error("herdr worktree open failed"));

    const error = await allocationError({
      parentCwd: "/work/repo/src",
      worktreeRoot: root,
    });

    expect(error.message).toContain(
      "could not create the herdr worktree: herdr worktree open failed",
    );
    expect(error.message).toContain(
      "Launch-failure cleanup: no worktree residue was left behind.",
    );
    expect(removeGitWorktreeMock).toHaveBeenCalledWith(
      pi,
      "/work/repo",
      worktreePath,
    );
    expect(deleteWorktreeBranchMock).toHaveBeenCalledWith(
      pi,
      worktreePath,
      "/work/repo",
      expect.any(Function),
    );
    // The git plane's probe is the host's attachment answer.
    const probe = deleteWorktreeBranchMock.mock.calls[0]![3] as (
      candidate: string,
    ) => Promise<boolean>;
    isAttachedMock.mockResolvedValue(true);
    await expect(probe(worktreePath)).resolves.toBe(true);
    expect(isAttachedMock).toHaveBeenCalledWith(worktreePath, {
      repoCwd: "/work/repo",
    });
  });

  it("serializes checkouts for one repository reached through two spellings", async () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-lock-"));
    const linked = `${real}-link`;
    fs.symlinkSync(real, linked);
    try {
      resolveMainCheckoutMock.mockImplementation((_pi: unknown, cwd: string) =>
        Promise.resolve(cwd.startsWith(linked) ? linked : real),
      );
      const wtRoot = path.join(real, "worktrees");
      fs.mkdirSync(wtRoot, { recursive: true });

      let inFlight = 0;
      let overlapped = false;
      createWorktreeCheckoutMock.mockImplementation(
        async (_pi: unknown, options: { path: string }) => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          fs.mkdirSync(options.path, { recursive: true });
          return created(options.path);
        },
      );

      const names = ["cow-one-aaaaaaaa", "cow-two-bbbbbbbb"];
      await Promise.all(
        [real, linked].map((repoCwd, i) =>
          AgentSandbox.allocate(
            pi,
            request({
              naming: {
                kind: "explicit",
                branch: names[i]!,
              },
              parentCwd: path.join(repoCwd, "src"),
              worktreeRoot: wtRoot,
            }),
          ),
        ),
      );

      expect(createWorktreeCheckoutMock).toHaveBeenCalledTimes(2);
      expect(overlapped).toBe(false);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")(
    "serializes checkouts when the repository is bind-mounted under a second path",
    async (ctx) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-bind-"));
      const real = path.join(base, "real");
      const bound = path.join(base, "bound");
      fs.mkdirSync(real, { recursive: true });
      fs.mkdirSync(bound, { recursive: true });
      try {
        execFileSync("mount", ["--bind", real, bound]);
      } catch {
        // Without privileges there is no bind mount to test against; the
        // symlinked spelling above already covers two names for one repository.
        ctx.skip();
        fs.rmSync(base, { recursive: true, force: true });
        return;
      }
      try {
        resolveMainCheckoutMock.mockImplementation(
          (_pi: unknown, cwd: string) =>
            Promise.resolve(cwd.startsWith(bound) ? bound : real),
        );
        const wtRoot = path.join(real, "worktrees");
        fs.mkdirSync(wtRoot, { recursive: true });

        let inFlight = 0;
        let overlapped = false;
        createWorktreeCheckoutMock.mockImplementation(
          async (_pi: unknown, options: { path: string }) => {
            inFlight += 1;
            if (inFlight > 1) overlapped = true;
            await new Promise((resolve) => setTimeout(resolve, 10));
            inFlight -= 1;
            fs.mkdirSync(options.path, { recursive: true });
            return created(options.path);
          },
        );

        await Promise.all(
          [real, bound].map((repoCwd, i) =>
            AgentSandbox.allocate(
              pi,
              request({
                naming: { kind: "explicit", branch: `cow-bind-${i}-aaaaaaaa` },
                parentCwd: path.join(repoCwd, "src"),
                worktreeRoot: wtRoot,
              }),
            ),
          ),
        );

        expect(createWorktreeCheckoutMock).toHaveBeenCalledTimes(2);
        expect(overlapped).toBe(false);
      } finally {
        try {
          execFileSync("umount", [bound]);
        } catch {
          // already gone
        }
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  );
});

describe("AgentSandbox.teardown", () => {
  it("reports the parent-cwd fallback as absent without touching git or herdr", async () => {
    resolveMainCheckoutMock.mockRejectedValue(new Error("not a repository"));
    const sandbox = await AgentSandbox.allocate(
      pi,
      request({ parentCwd: "/nowhere" }),
    );

    await expect(sandbox.teardown(pi)).resolves.toEqual({ kind: "absent" });
    expect(sandbox.state).toEqual({ kind: "destroyed" });
    expect(releaseMock).not.toHaveBeenCalled();
    expect(removeGitWorktreeMock).not.toHaveBeenCalled();
  });

  it("removes the placement, worktree, and merged branch, then stays destroyed", async () => {
    const root = tempRoot();
    const worktreePath = path.join(root, "cow-fix-login-abc12345");
    const sandbox = await allocated(worktreePath);

    await expect(sandbox.teardown(pi)).resolves.toEqual({
      kind: "removed",
      path: worktreePath,
      branchName: "cow-fix-login-abc12345",
      via: "herdr",
      branch: { kind: "deleted" },
    });
    expect(sandbox.state).toEqual({ kind: "destroyed" });
    expect(releaseMock).toHaveBeenCalledWith(REF, "worktree-association");
    expect(deleteWorktreeBranchMock).toHaveBeenCalledWith(
      pi,
      worktreePath,
      "/work/repo",
      expect.any(Function),
    );
    // A second teardown of a destroyed sandbox is a no-op report.
    await expect(sandbox.teardown(pi)).resolves.toEqual({
      kind: "absent",
      path: worktreePath,
    });
  });

  it("preserves a dirty worktree and records the retention reason as state", async () => {
    const root = tempRoot();
    const worktreePath = path.join(root, "cow-fix-login-abc12345");
    const sandbox = await allocated(worktreePath);
    isWorktreeDirtyMock.mockResolvedValue(true);

    await expect(sandbox.teardown(pi)).resolves.toEqual({
      kind: "kept",
      path: worktreePath,
      reason: { kind: "dirty" },
    });
    expect(sandbox.state).toEqual({
      kind: "preserved",
      reason: { kind: "dirty" },
    });
    expect(releaseMock).not.toHaveBeenCalled();
    expect(deleteWorktreeBranchMock).not.toHaveBeenCalled();
  });
});

describe("formatLaunchCleanupNote", () => {
  it("explains retained worktrees and the reason retention was required", async () => {
    expect(
      formatLaunchCleanupNote({
        kind: "kept",
        path: "/wt/cow-fix-login-1",
        reason: { kind: "dirty" },
      }),
    ).toContain("KEPT — has uncommitted changes");
  });

  it("reports the git-side verdict only when removal rode git, not the host", async () => {
    // A herdr pane can outlive the checkout when the host's own removal failed;
    // the adoption error names it, so this note must not claim a pane is gone.
    const note = formatLaunchCleanupNote({
      kind: "removed",
      path: "/wt/cow-fix-login-1",
      branchName: "cow-fix-login-1",
      via: "git",
      branch: { kind: "deleted" },
    });
    expect(note).toContain("worktree /wt/cow-fix-login-1 removed");
    expect(note).toContain("branch cow-fix-login-1 deleted");
    expect(note).not.toContain("no pane existed");
    expect(note).not.toContain("pane were closed");
  });
});
