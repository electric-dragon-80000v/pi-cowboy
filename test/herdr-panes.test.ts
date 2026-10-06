/**
 * herdr-panes.test.ts — Layer 2: pane and tab resources.
 *
 * Pins each operation's argv and timeout, plus the failure-policy split: a
 * best-effort operation never rejects, and the caller-facing ones surface.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HerdrError,
  HerdrTransport,
} from "../src/infrastructure/herdr/herdr-transport.js";
import { HerdrPanes } from "../src/infrastructure/herdr/panes.js";
import { fail, mockPi, ok, recordingPi } from "./helpers/herdr-pi.js";

function panesFor(pi: ExtensionAPI): HerdrPanes {
  return new HerdrPanes(new HerdrTransport(pi));
}

describe("HerdrPanes.createAgentTab", () => {
  it("creates the tab with the workspace, cwd, label, and no focus", async () => {
    const { pi, calls } = recordingPi([
      ok({ tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p4" } }),
    ]);

    await expect(
      panesFor(pi).createAgentTab({
        workspaceId: "w1",
        cwd: "/repo",
        label: "general-purpose",
      }),
    ).resolves.toEqual({ tabId: "w1:t3", paneId: "w1:p4" });
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: [
          "tab",
          "create",
          "--workspace",
          "w1",
          "--cwd",
          "/repo",
          "--label",
          "general-purpose",
          "--no-focus",
        ],
        opts: { timeout: 60_000 },
      },
    ]);
  });

  it("throws when herdr returns no tab/pane ids", async () => {
    const pi = mockPi(() => ok({ tab: { tab_id: "w1:t3" } }));
    await expect(
      panesFor(pi).createAgentTab({
        workspaceId: "w1",
        cwd: "/repo",
        label: "general-purpose",
      }),
    ).rejects.toThrow(/returned no tab\/pane ids/);
  });
});

describe("HerdrPanes best-effort operations", () => {
  it("closes a pane and swallows a failure", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(panesFor(pi).closePane("w1:p1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["pane", "close", "w1:p1"],
        opts: { timeout: 15_000 },
      },
    ]);

    const gone = mockPi(() => fail("pane_not_found", "gone"));
    await expect(panesFor(gone).closePane("w1:p1")).resolves.toBeUndefined();

    const broken = mockPi(() => fail("server_error", "boom"));
    await expect(panesFor(broken).closePane("w1:p1")).resolves.toBeUndefined();

    const silent = mockPi(() => ({ code: 1, stdout: "", stderr: "" }));
    await expect(panesFor(silent).closePane("w1:p1")).resolves.toBeUndefined();
  });

  it("names a pane and swallows a failure", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      panesFor(pi).renamePane("w1:p1", { kind: "label", label: "🐄" }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["pane", "rename", "w1:p1", "🐄"],
        opts: { timeout: 15_000 },
      },
    ]);

    const gone = mockPi(() => fail("pane_not_found", "gone"));
    await expect(
      panesFor(gone).renamePane("w1:p1", { kind: "label", label: "🐄" }),
    ).resolves.toBeUndefined();

    const broken = mockPi(() => fail("server_error", "boom"));
    await expect(
      panesFor(broken).renamePane("w1:p1", { kind: "label", label: "🐄" }),
    ).resolves.toBeUndefined();
  });

  it("clears a pane's name with --clear", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      panesFor(pi).renamePane("w1:p1", { kind: "clear" }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["pane", "rename", "w1:p1", "--clear"],
        opts: { timeout: 15_000 },
      },
    ]);
  });

  it("names a tab and swallows a failure", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      panesFor(pi).renameTab("w1:t1", "🐄"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["tab", "rename", "w1:t1", "🐄"],
        opts: { timeout: 15_000 },
      },
    ]);

    const gone = mockPi(() => fail("tab_not_found", "gone"));
    await expect(
      panesFor(gone).renameTab("w1:t1", "🐄"),
    ).resolves.toBeUndefined();

    const broken = mockPi(() => fail("server_error", "boom"));
    await expect(
      panesFor(broken).renameTab("w1:t1", "🐄"),
    ).resolves.toBeUndefined();
  });

  it("runs a command in the pane and propagates a failure", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(
      panesFor(pi).runInPane("w1:p1", "echo hi"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["pane", "run", "w1:p1", "echo hi"],
        opts: { timeout: 15_000 },
      },
    ]);

    const broken = mockPi(() => fail("server_error", "boom"));
    await expect(
      panesFor(broken).runInPane("w1:p1", "echo hi"),
    ).rejects.toThrow(HerdrError);
  });
});

describe("HerdrPanes.focusTab", () => {
  it("focuses a tab and surfaces herdr's rejection", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await expect(panesFor(pi).focusTab("w1:t1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["tab", "focus", "w1:t1"],
        opts: { timeout: 15_000 },
      },
    ]);

    const broken = mockPi(() => fail("tab_not_found", "gone"));
    await expect(panesFor(broken).focusTab("w1:t1")).rejects.toThrow(
      HerdrError,
    );
  });
});
