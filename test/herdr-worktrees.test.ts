/**
 * herdr-worktrees.test.ts — Layer 2: herdr-managed worktrees.
 *
 * Pins listing (throws, the caller degrades), removal, and the cross-platform
 * path normalizer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrTransport } from "../src/infrastructure/herdr/herdr-transport.js";
import {
  HerdrWorktrees,
  normalizeHerdrPath,
} from "../src/infrastructure/herdr/worktrees.js";
import { fail, mockPi, ok, recordingPi } from "./helpers/herdr-pi.js";

function worktreesFor(pi: ExtensionAPI): HerdrWorktrees {
  return new HerdrWorktrees(new HerdrTransport(pi));
}

describe("HerdrWorktrees.listWorktrees", () => {
  it("lists herdr's raw entries in the extension's shape, scoped by cwd", async () => {
    const { pi, calls } = recordingPi([
      ok({
        worktrees: [
          {
            path: "/repo/.herdr/cow-fix-1",
            label: "cow-fix-1",
            is_linked_worktree: true,
            open_workspace_id: "w2",
          },
          { path: "", is_linked_worktree: false },
          { is_linked_worktree: false },
        ],
      }),
    ]);

    await expect(worktreesFor(pi).listWorktrees("/repo")).resolves.toEqual([
      {
        path: "/repo/.herdr/cow-fix-1",
        label: "cow-fix-1",
        isLinkedWorktree: true,
        openWorkspaceId: "w2",
      },
    ]);
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["worktree", "list", "--cwd", "/repo"],
        opts: { timeout: 15_000 },
      },
    ]);
  });

  it("omits --cwd when no repo is given and treats an empty open workspace as not open", async () => {
    const { pi, calls } = recordingPi([
      ok({
        worktrees: [
          {
            path: "/repo",
            label: "main",
            is_linked_worktree: false,
            open_workspace_id: "",
          },
        ],
      }),
    ]);

    await expect(worktreesFor(pi).listWorktrees()).resolves.toEqual([
      {
        path: "/repo",
        label: "main",
        isLinkedWorktree: false,
        openWorkspaceId: undefined,
      },
    ]);
    expect(calls.map((c) => c.args)).toEqual([["worktree", "list"]]);
  });

  it("keeps the branch herdr reports for the checkout, when it reports one", async () => {
    // The basename is only the convention; a hand-made tree may disagree.
    const { pi } = recordingPi([
      ok({
        worktrees: [
          {
            path: "/repo/.herdr/cow-fix-1",
            label: "cow-fix-1",
            is_linked_worktree: true,
            open_workspace_id: "w2",
            branch: "cow-fix-1",
          },
          { path: "/repo/.herdr/cow-fix-2", is_linked_worktree: true },
        ],
      }),
    ]);

    await expect(worktreesFor(pi).listWorktrees("/repo")).resolves.toEqual([
      {
        path: "/repo/.herdr/cow-fix-1",
        label: "cow-fix-1",
        isLinkedWorktree: true,
        openWorkspaceId: "w2",
        branch: "cow-fix-1",
      },
      {
        path: "/repo/.herdr/cow-fix-2",
        // Herdr reported no label; the reader does not invent one.
        label: undefined,
        isLinkedWorktree: true,
        openWorkspaceId: undefined,
        branch: undefined,
      },
    ]);
  });

  it("surfaces a failed listing to the caller", async () => {
    const pi = mockPi(() => fail("server_error", "boom"));
    await expect(worktreesFor(pi).listWorktrees()).rejects.toThrow("boom");
  });

  it("rejects a listing that carries no worktrees array", async () => {
    // A success envelope without the declared payload is a contract violation,
    // not an empty list: "nothing there" and "no answer" must not merge.
    const pi = mockPi(() => ok({}));
    await expect(worktreesFor(pi).listWorktrees()).rejects.toThrow(
      /no worktrees array/,
    );
  });
});

describe("HerdrWorktrees.removeHerdrWorktree", () => {
  it("force-removes the worktree and confirms removal", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(worktreesFor(pi).removeHerdrWorktree("w1")).resolves.toBe(
      true,
    );
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["worktree", "remove", "--workspace", "w1", "--force"],
        opts: { timeout: 30_000 },
      },
    ]);
  });

  it("swallows a failure (best effort)", async () => {
    const pi = mockPi(() => fail("server_error", "boom"));
    await expect(worktreesFor(pi).removeHerdrWorktree("w1")).resolves.toBe(
      false,
    );
  });
});

describe("normalizeHerdrPath", () => {
  it("normalizes backslashes for cross-platform comparison", () => {
    expect(normalizeHerdrPath("C:\\repo\\wt")).toBe("C:/repo/wt");
    expect(normalizeHerdrPath("/repo/wt")).toBe("/repo/wt");
  });

  it("compares a symlinked spelling against the path it names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-path-"));
    try {
      const real = path.join(root, "real", "cow-fix-1");
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
      expect(normalizeHerdrPath(path.join(root, "link", "cow-fix-1"))).toBe(
        normalizeHerdrPath(real),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
