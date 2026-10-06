/**
 * herdr-client.test.ts — the herdr client facade and its re-export barrel.
 *
 * HerdrClient's workspace read, plus the export contract: every pi-bound free
 * function resolves with the same argv and identities.
 */

import { describe, expect, it } from "vitest";
import {
  createAgentTab,
  listAgentRecords,
  listWorktrees,
  runHerdr,
  stopAgentAndWait,
} from "../src/infrastructure/herdr-client.js";
import { HerdrClient } from "../src/infrastructure/herdr/herdr-client.js";
import {
  HerdrError,
  HerdrTransport,
} from "../src/infrastructure/herdr/herdr-transport.js";
import { fail, mockPi, ok, recordingPi } from "./helpers/herdr-pi.js";

/** Values the flat herdr-client module exports. */
const FLAT_SURFACE = [
  "AGENT_START_MAX_ATTEMPTS",
  "AGENT_START_RETRY_BASE_DELAY_MS",
  "AGENT_START_TIMEOUT_MS",
  "closePane",
  "createAgentTab",
  "findTaskAttempts",
  "focusTab",
  "getAgentInfo",
  "getCurrentWorkspaceId",
  "HerdrError",
  "listAgentRecords",
  "listWorktrees",
  "normalizeHerdrPath",
  "removeHerdrWorktree",
  "renamePane",
  "renameTab",
  "runHerdr",
  "sendAgentKeys",
  "startPiAgent",
  "stopAgentAndWait",
  "strField",
  "submitAgentPrompt",
];

describe("HerdrClient.getCurrentWorkspaceId", () => {
  it("returns the calling pane's workspace id", async () => {
    const { pi, calls } = recordingPi([ok({ pane: { workspace_id: "w9" } })]);
    await expect(new HerdrClient(pi).getCurrentWorkspaceId()).resolves.toBe(
      "w9",
    );
    expect(calls.map((c) => c.args)).toEqual([
      ["pane", "current", "--current"],
    ]);
  });

  it("throws HerdrError when the workspace cannot be determined", async () => {
    const pi = mockPi(() => ok({ pane: {} }));
    await expect(new HerdrClient(pi).getCurrentWorkspaceId()).rejects.toThrow(
      HerdrError,
    );
  });
});

describe("herdr-client barrel", () => {
  it("exports the flat herdr surface, by identity", async () => {
    const barrel = await import("../src/infrastructure/herdr-client.js");
    expect(Object.keys(barrel)).toEqual(expect.arrayContaining(FLAT_SURFACE));
    // Identity, not just presence.
    expect(barrel.HerdrError).toBe(HerdrError);
    expect(barrel.HerdrTransport).toBe(HerdrTransport);
  });

  it("routes each free function through its layer with the expected argv", async () => {
    const { pi, calls } = recordingPi([
      ok({ pane: { workspace_id: "w9" } }),
      ok({ tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p4" } }),
      ok({
        agents: [
          { name: "cow-x-01234567", agent_status: "idle", pane_id: "p1" },
        ],
      }),
      ok({ worktrees: [] }),
      ok({}),
      fail("agent_not_found", "gone"),
    ]);

    await expect(
      runHerdr(pi, ["pane", "current", "--current"]),
    ).resolves.toEqual({ pane: { workspace_id: "w9" } });
    await expect(
      createAgentTab(pi, {
        workspaceId: "w1",
        cwd: "/repo",
        label: "general-purpose",
      }),
    ).resolves.toEqual({ tabId: "w1:t3", paneId: "w1:p4" });

    const records = await listAgentRecords(pi);
    expect(records[0]).toMatchObject({
      name: "cow-x-01234567",
      paneId: "p1",
      state: "idle",
    });

    await expect(listWorktrees(pi, "/repo")).resolves.toEqual([]);
    await expect(
      stopAgentAndWait(pi, "w1:p1", {
        interruptGraceMs: 0,
        confirmMs: 0,
      }),
    ).resolves.toBe(true);

    expect(calls.map((c) => c.args)).toEqual([
      ["pane", "current", "--current"],
      [
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
      ["agent", "list"],
      ["worktree", "list", "--cwd", "/repo"],
      ["agent", "send-keys", "w1:p1", "ctrl+c"],
      ["agent", "get", "w1:p1"],
    ]);
  });
});
