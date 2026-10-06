import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrRuntime } from "../src/infrastructure/herdr-host.js";
import type { AgentHostRef } from "../src/agents/agent-host.js";
import { fail, ok, recordingPi } from "./helpers/herdr-pi.js";

const {
  focusTabMock,
  runHerdrMock,
  getCurrentWorkspaceIdMock,
  createAgentTabMock,
  removeHerdrWorktreeMock,
  renamePaneMock,
  renameTabMock,
  findTaskAttemptsMock,
  stopAgentAndWaitMock,
} = vi.hoisted(() => ({
  focusTabMock: vi.fn(),
  runHerdrMock: vi.fn(),
  getCurrentWorkspaceIdMock: vi.fn(),
  createAgentTabMock: vi.fn(),
  removeHerdrWorktreeMock: vi.fn(),
  renamePaneMock: vi.fn(),
  renameTabMock: vi.fn(),
  findTaskAttemptsMock: vi.fn(),
  stopAgentAndWaitMock: vi.fn(),
}));

vi.mock("../src/infrastructure/herdr-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/herdr-client.js")
    >();
  return {
    ...actual,
    focusTab: focusTabMock,
    runHerdr: runHerdrMock,
    getCurrentWorkspaceId: getCurrentWorkspaceIdMock,
    createAgentTab: createAgentTabMock,
    removeHerdrWorktree: removeHerdrWorktreeMock,
    renamePane: renamePaneMock,
    renameTab: renameTabMock,
    findTaskAttempts: findTaskAttemptsMock,
    stopAgentAndWait: stopAgentAndWaitMock,
  };
});

beforeEach(() => {
  focusTabMock.mockReset();
  runHerdrMock.mockReset();
  getCurrentWorkspaceIdMock.mockReset();
  createAgentTabMock.mockReset();
  removeHerdrWorktreeMock.mockReset();
  renamePaneMock.mockReset();
  renameTabMock.mockReset();
  findTaskAttemptsMock.mockReset();
  stopAgentAndWaitMock.mockReset();
});

const REF: AgentHostRef = {
  engine: "herdr",
  name: "cow-fix-01234567",
  paneId: "w1:p2",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: true,
};

describe("createHerdrRuntime view", () => {
  it("focuses the ref's tab", async () => {
    const pi = {} as unknown as ExtensionAPI;
    await createHerdrRuntime(pi).view.focus(REF);
    expect(focusTabMock).toHaveBeenCalledWith(pi, "w1:t1");
  });
});

describe("createHerdrRuntime host.hostAt", () => {
  const pi = {} as unknown as ExtensionAPI;
  const checkout = {
    path: "/wt",
    repoCwd: "/repo",
    branch: "cow-fix-01234567",
  };

  it("adopts the checkout via worktree open from the main checkout", async () => {
    runHerdrMock.mockResolvedValue({
      worktree: { path: "/wt", branch: "cow-fix-01234567" },
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "w1:t1" },
      root_pane: { pane_id: "w1:p1" },
    });
    await expect(
      createHerdrRuntime(pi).host.hostAt({
        unit: "pane",
        cwd: "/wt",
        label: "cow-fix-01234567",
        name: "cow-fix-01234567",
        checkout,
      }),
    ).resolves.toEqual({
      engine: "herdr",
      name: "cow-fix-01234567",
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      paneCreated: false,
    });
    expect(runHerdrMock).toHaveBeenCalledWith(
      pi,
      [
        "worktree",
        "open",
        "--cwd",
        "/repo",
        "--path",
        "/wt",
        "--label",
        "cow-fix-01234567",
        "--no-focus",
      ],
      { timeoutMs: 60_000 },
    );
    expect(renamePaneMock).toHaveBeenCalledWith(pi, "w1:p1", {
      kind: "label",
      label: "🐄 cow-fix-01234567",
    });
    // Herdr created this tab, so it is named after adoption.
    expect(renameTabMock).toHaveBeenCalledWith(
      pi,
      "w1:t1",
      "🐄 cow-fix-01234567",
    );
  });

  it("removes the workspace and throws when the open reports the wrong branch", async () => {
    runHerdrMock.mockResolvedValueOnce({
      worktree: { path: "/wt", branch: "worktree/generated-slug" },
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "w1:t1" },
      root_pane: { pane_id: "w1:p1" },
    });
    removeHerdrWorktreeMock.mockResolvedValue(true);
    await expect(
      createHerdrRuntime(pi).host.hostAt({
        unit: "pane",
        cwd: "/wt",
        label: "cow-fix-01234567",
        name: "cow-fix-01234567",
        checkout,
      }),
    ).rejects.toThrow(/did not adopt "cow-fix-01234567"/);
    expect(removeHerdrWorktreeMock).toHaveBeenCalledWith(pi, "w1");
    expect(renamePaneMock).not.toHaveBeenCalled();
    expect(renameTabMock).not.toHaveBeenCalled();
  });

  it("removes a parsed workspace and throws when the open response is incomplete", async () => {
    runHerdrMock.mockResolvedValueOnce({
      workspace: { workspace_id: "w1" },
      worktree: { path: "/wt", branch: "cow-fix-01234567" },
    });
    removeHerdrWorktreeMock.mockResolvedValue(true);
    await expect(
      createHerdrRuntime(pi).host.hostAt({
        unit: "pane",
        cwd: "/wt",
        label: "cow-fix-01234567",
        checkout,
      }),
    ).rejects.toThrow(/did not adopt "cow-fix-01234567"/);
    expect(removeHerdrWorktreeMock).toHaveBeenCalledWith(pi, "w1");
    expect(renamePaneMock).not.toHaveBeenCalled();
    expect(renameTabMock).not.toHaveBeenCalled();
  });

  it("names the workspace when its removal fails, so the pane can be closed by hand", async () => {
    runHerdrMock.mockResolvedValueOnce({
      worktree: { path: "/wt", branch: "worktree/generated-slug" },
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "w1:t1" },
      root_pane: { pane_id: "w1:p1" },
    });
    removeHerdrWorktreeMock.mockResolvedValue(false);
    await expect(
      createHerdrRuntime(pi).host.hostAt({
        unit: "pane",
        cwd: "/wt",
        label: "cow-fix-01234567",
        name: "cow-fix-01234567",
        checkout,
      }),
    ).rejects.toThrow(/may still exist \(workspace w1\)/);
  });

  it("says nothing about a leftover pane when the workspace was removed", async () => {
    runHerdrMock.mockResolvedValueOnce({
      worktree: { path: "/wt", branch: "worktree/generated-slug" },
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "w1:t1" },
      root_pane: { pane_id: "w1:p1" },
    });
    removeHerdrWorktreeMock.mockResolvedValue(true);
    await expect(
      createHerdrRuntime(pi).host.hostAt({
        unit: "pane",
        cwd: "/wt",
        label: "cow-fix-01234567",
        name: "cow-fix-01234567",
        checkout,
      }),
    ).rejects.not.toThrow(/may still exist/);
  });

  it("creates a tab in the current workspace without a checkout", async () => {
    getCurrentWorkspaceIdMock.mockResolvedValue("w1");
    createAgentTabMock.mockResolvedValue({
      tabId: "w1:t1",
      paneId: "w1:p1",
    });
    await expect(
      createHerdrRuntime(pi).host.hostAt({
        unit: "pane",
        cwd: "/repo",
        label: "general-purpose",
        name: "cow-fix-01234567",
      }),
    ).resolves.toEqual({
      engine: "herdr",
      name: "cow-fix-01234567",
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      paneCreated: true,
    });
    expect(createAgentTabMock).toHaveBeenCalledWith(pi, {
      workspaceId: "w1",
      cwd: "/repo",
      label: "🐄 general-purpose",
    });
    expect(renamePaneMock).toHaveBeenCalledWith(pi, "w1:p1", {
      kind: "label",
      label: "🐄 general-purpose",
    });
    // The tab was labelled at creation, so it is never renamed.
    expect(renameTabMock).not.toHaveBeenCalled();
  });

  it("marks a placement with an empty title without a dangling separator", async () => {
    getCurrentWorkspaceIdMock.mockResolvedValue("w1");
    createAgentTabMock.mockResolvedValue({
      tabId: "w1:t1",
      paneId: "w1:p1",
    });
    await createHerdrRuntime(pi).host.hostAt({
      unit: "pane",
      cwd: "/repo",
      label: "",
      name: "cow-fix-01234567",
    });
    expect(createAgentTabMock).toHaveBeenCalledWith(pi, {
      workspaceId: "w1",
      cwd: "/repo",
      label: "🐄",
    });
    expect(renamePaneMock).toHaveBeenCalledWith(pi, "w1:p1", {
      kind: "label",
      label: "🐄",
    });
  });
});

describe("createHerdrRuntime host.findAttempts", () => {
  it("delegates to the herdr registry probe", async () => {
    const pi = {} as unknown as ExtensionAPI;
    const attempts = [{ name: "cow-fix-01234567" }];
    findTaskAttemptsMock.mockResolvedValue(attempts);
    await expect(
      createHerdrRuntime(pi).host.findAttempts("fix-login"),
    ).resolves.toBe(attempts);
    expect(findTaskAttemptsMock).toHaveBeenCalledWith(pi, "fix-login");
  });
});

describe("createHerdrRuntime host.deliver", () => {
  it("submits the message to the agent in one call", async () => {
    const { pi, calls } = recordingPi([ok(undefined)]);

    await expect(
      createHerdrRuntime(pi).host.deliver(REF, "tighten the loop"),
    ).resolves.toEqual({ kind: "submitted" });
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["agent", "prompt", "w1:p2", "tighten the loop"],
        opts: { timeout: 15_000 },
      },
    ]);
  });

  it("passes a multi-line message through as one payload", async () => {
    const { pi, calls } = recordingPi([ok(undefined)]);

    await expect(
      createHerdrRuntime(pi).host.deliver(REF, "line one\nline two"),
    ).resolves.toEqual({ kind: "submitted" });
    expect(calls[0]?.args).toEqual([
      "agent",
      "prompt",
      "w1:p2",
      "line one\nline two",
    ]);
  });

  it("surfaces herdr's refusal when the pane hosts no agent", async () => {
    const { pi } = recordingPi([fail("agent_not_found", "gone")]);

    await expect(
      createHerdrRuntime(pi).host.deliver(REF, "hi"),
    ).resolves.toEqual({
      kind: "not-submitted",
      detail: expect.stringContaining("agent_not_found"),
    });
  });

  it("surfaces a blocked agent as a refusal, typing nothing into the dialog", async () => {
    const { pi } = recordingPi([fail("agent_blocked", "waiting on you")]);

    await expect(
      createHerdrRuntime(pi).host.deliver(REF, "hi"),
    ).resolves.toEqual({
      kind: "not-submitted",
      detail: expect.stringContaining("agent_blocked"),
    });
  });
});

describe("createHerdrRuntime host.stop", () => {
  const pi = {} as unknown as ExtensionAPI;

  it("interrupts by default (no interrupt option)", async () => {
    await createHerdrRuntime(pi).host.stop(REF, {
      interruptGraceMs: 2_000,
      confirmMs: 0,
    });
    expect(stopAgentAndWaitMock).toHaveBeenCalledWith(pi, "w1:p2", {
      interruptGraceMs: 2_000,
      confirmMs: 0,
    });
  });
});
