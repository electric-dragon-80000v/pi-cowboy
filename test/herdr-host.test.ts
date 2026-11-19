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
  waitForAgentGoneMock,
  sendAgentKeysMock,
  listWorktreesMock,
  listAgentRecordsMock,
  getAgentInfoMock,
  closePaneMock,
} = vi.hoisted(() => ({
  focusTabMock: vi.fn(),
  runHerdrMock: vi.fn(),
  getCurrentWorkspaceIdMock: vi.fn(),
  createAgentTabMock: vi.fn(),
  removeHerdrWorktreeMock: vi.fn(),
  renamePaneMock: vi.fn(),
  renameTabMock: vi.fn(),
  findTaskAttemptsMock: vi.fn(),
  waitForAgentGoneMock: vi.fn(),
  sendAgentKeysMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  listAgentRecordsMock: vi.fn(),
  getAgentInfoMock: vi.fn(),
  closePaneMock: vi.fn(),
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
    waitForAgentGone: waitForAgentGoneMock,
    sendAgentKeys: sendAgentKeysMock,
    listWorktrees: listWorktreesMock,
    listAgentRecords: listAgentRecordsMock,
    getAgentInfo: getAgentInfoMock,
    closePane: closePaneMock,
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
  waitForAgentGoneMock.mockReset();
  sendAgentKeysMock.mockReset();
  // Default: no checkout is open, no agent names are taken, no panes close.
  listWorktreesMock.mockReset().mockResolvedValue([]);
  listAgentRecordsMock.mockReset().mockResolvedValue([]);
  getAgentInfoMock.mockReset().mockResolvedValue(undefined);
  closePaneMock.mockReset().mockResolvedValue(undefined);
});

const REF: AgentHostRef = {
  multiplexer: "herdr",
  name: "cow-fix-01234567",
  paneId: "w1:p2",
  tabId: "w1:t1",
  workspaceId: "w1",
  paneCreated: true,
};

describe("guarded pane submission", () => {
  it("refuses to type when the expected process is not foreground", async () => {
    runHerdrMock.mockResolvedValue({
      process_info: { foreground_processes: [{ pid: 12 }] },
    });
    const pane = createHerdrRuntime({} as ExtensionAPI).pane;
    await expect(
      pane.submit!("w1:p2", "hello", 13, new AbortController().signal),
    ).rejects.toThrow(/not in pane/);
    expect(runHerdrMock).toHaveBeenCalledTimes(1);
  });

  it("submits only after checking the expected foreground twice", async () => {
    vi.useFakeTimers();
    try {
      runHerdrMock
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined);
      const pane = createHerdrRuntime({} as ExtensionAPI).pane;
      const result = pane.submit!(
        "w1:p2",
        "hello",
        13,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      expect(runHerdrMock.mock.calls.map((call) => call[1])).toEqual([
        ["pane", "process-info", "--pane", "w1:p2"],
        ["pane", "send-text", "w1:p2", "hello"],
        ["pane", "process-info", "--pane", "w1:p2"],
        ["pane", "send-keys", "w1:p2", "enter"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not press enter if the foreground changed after typing", async () => {
    vi.useFakeTimers();
    try {
      runHerdrMock
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ process_info: { foreground_processes: [] } });
      const pane = createHerdrRuntime({} as ExtensionAPI).pane;
      const result = pane.submit!(
        "w1:p2",
        "hello",
        13,
        new AbortController().signal,
      );
      const assertion = expect(result).rejects.toThrow(/not in pane/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(runHerdrMock.mock.calls.map((call) => call[1])).not.toContainEqual(
        ["pane", "send-keys", "w1:p2", "enter"],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the escape sequence a TUI needs before it takes input", async () => {
    vi.useFakeTimers();
    try {
      runHerdrMock
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined);
      const pane = createHerdrRuntime({} as ExtensionAPI).pane;
      const result = pane.submit!(
        "w1:p2",
        "\u001b[Ihello",
        13,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      expect(runHerdrMock.mock.calls.map((call) => call[1])).toContainEqual([
        "pane",
        "send-text",
        "w1:p2",
        "\u001b[Ihello",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a multi-line message as one submission", async () => {
    vi.useFakeTimers();
    try {
      runHerdrMock
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          process_info: { foreground_processes: [{ pid: 13 }] },
        })
        .mockResolvedValueOnce(undefined);
      const pane = createHerdrRuntime({} as ExtensionAPI).pane;
      const result = pane.submit!(
        "w1:p2",
        "first line\nsecond line",
        13,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      expect(runHerdrMock.mock.calls.map((call) => call[1])).toContainEqual([
        "pane",
        "send-text",
        "w1:p2",
        "first line\nsecond line",
      ]);
      expect(runHerdrMock.mock.calls.map((call) => call[1])).toContainEqual([
        "pane",
        "send-keys",
        "w1:p2",
        "enter",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a submit smuggled into the text", async () => {
    runHerdrMock.mockResolvedValue(undefined);
    const pane = createHerdrRuntime({} as ExtensionAPI).pane;
    await expect(
      pane.submit!("w1:p2", "hello\rworld", 13, new AbortController().signal),
    ).rejects.toThrow(/control characters/);
    expect(runHerdrMock).not.toHaveBeenCalled();
  });
});

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
      multiplexer: "herdr",
      name: "cow-fix-01234567-1",
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
      multiplexer: "herdr",
      name: "cow-fix-01234567-1",
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

describe("createHerdrRuntime host.hostAt on an already-open checkout", () => {
  const pi = {} as unknown as ExtensionAPI;
  const checkout = {
    path: "/wt",
    repoCwd: "/repo",
    branch: "cow-fix-01234567",
  };
  const request = {
    unit: "pane" as const,
    cwd: "/wt",
    label: "fix login",
    name: "cow-fix-01234567",
    checkout,
  };

  it("opens a new tab instead of reusing the pane an agent already occupies", async () => {
    // The live agent that already holds this checkout: its tab and root pane.
    listWorktreesMock.mockResolvedValue([
      { path: "/wt", branch: "cow-fix-01234567", openWorkspaceId: "w1" },
    ]);
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" });

    await expect(createHerdrRuntime(pi).host.hostAt(request)).resolves.toEqual({
      multiplexer: "herdr",
      name: "cow-fix-01234567-1",
      paneId: "w1:p2",
      tabId: "w1:t2",
      workspaceId: "w1",
      paneCreated: true,
    });

    // The checkout is adopted, never re-opened: `worktree open` on an open
    // checkout answers with the existing pane, which is another agent's.
    expect(runHerdrMock).not.toHaveBeenCalled();
    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
    expect(createAgentTabMock).toHaveBeenCalledWith(pi, {
      workspaceId: "w1",
      cwd: "/wt",
      label: "🐄 fix login",
    });
  });

  it("does not retitle the live agent's pane or tab", async () => {
    listWorktreesMock.mockResolvedValue([
      { path: "/wt", branch: "cow-fix-01234567", openWorkspaceId: "w1" },
    ]);
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" });

    await createHerdrRuntime(pi).host.hostAt(request);

    // The new tab is labelled when it is created, so nothing renames it, and the
    // resident agent's pane and tab are never touched.
    expect(renameTabMock).not.toHaveBeenCalled();
    expect(renamePaneMock).toHaveBeenCalledTimes(1);
    expect(renamePaneMock).toHaveBeenCalledWith(pi, "w1:p2", {
      kind: "label",
      label: "🐄 fix login",
    });
  });

  it("opens a new tab when a racing open reports the checkout already open", async () => {
    // The pre-probe saw nothing, then another spawn adopted the checkout.
    listWorktreesMock.mockResolvedValue([]);
    runHerdrMock.mockResolvedValue({
      already_open: true,
      worktree: { path: "/wt", branch: "cow-fix-01234567" },
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "w1:t1" },
      root_pane: { pane_id: "w1:p1" },
    });
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" });

    await expect(
      createHerdrRuntime(pi).host.hostAt(request),
    ).resolves.toMatchObject({ paneId: "w1:p2", workspaceId: "w1" });
    // The workspace belongs to the agent that opened it, so a race never removes it.
    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
  });

  it("refuses a racing open whose branch does not match", async () => {
    listWorktreesMock.mockResolvedValue([]);
    runHerdrMock.mockResolvedValue({
      already_open: true,
      worktree: { path: "/wt", branch: "other-branch" },
      workspace: { workspace_id: "w1" },
      tab: { tab_id: "w1:t1" },
      root_pane: { pane_id: "w1:p1" },
    });

    await expect(createHerdrRuntime(pi).host.hostAt(request)).rejects.toThrow(
      /already open, but not as "cow-fix-01234567"/,
    );
    expect(createAgentTabMock).not.toHaveBeenCalled();
    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
  });
});

describe("createHerdrRuntime host agent spots", () => {
  const pi = {} as unknown as ExtensionAPI;
  const request = {
    unit: "pane" as const,
    cwd: "/wt",
    label: "fix login",
    name: "cow-fix-01234567",
    checkout: { path: "/wt", repoCwd: "/repo", branch: "cow-fix-01234567" },
  };

  it("numbers the first agent in a checkout from 1", async () => {
    getCurrentWorkspaceIdMock.mockResolvedValue("w1");
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t1", paneId: "w1:p1" });

    const ref = await createHerdrRuntime(pi).host.hostAt({
      unit: "pane",
      cwd: "/repo",
      label: "general-purpose",
      name: "cow-fix-01234567",
    });

    expect(ref.name).toBe("cow-fix-01234567-1");
  });

  it("reads a bare name as spot 1, so the second agent gets 2", async () => {
    listWorktreesMock.mockResolvedValue([
      { path: "/wt", branch: "cow-fix-01234567", openWorkspaceId: "w1" },
    ]);
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" });
    // The agent running there was named before spots existed.
    getAgentInfoMock.mockImplementation(async (_pi: unknown, target: string) =>
      target === "cow-fix-01234567"
        ? { name: target, paneId: "w1:p1", state: "working" }
        : undefined,
    );

    const ref = await createHerdrRuntime(pi).host.hostAt(request);

    expect(ref.name).toBe("cow-fix-01234567-2");
  });

  it("takes spot 2 for the second agent, so the first keeps its name", async () => {
    listWorktreesMock.mockResolvedValue([
      { path: "/wt", branch: "cow-fix-01234567", openWorkspaceId: "w1" },
    ]);
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" });
    getAgentInfoMock.mockImplementation(async (_pi: unknown, target: string) =>
      target === "cow-fix-01234567-1"
        ? { name: target, paneId: "w1:p1", state: "working" }
        : undefined,
    );

    const ref = await createHerdrRuntime(pi).host.hostAt(request);

    expect(ref.name).toBe("cow-fix-01234567-2");
  });

  it("refuses a checkout whose spots 1 through max are all taken", async () => {
    listWorktreesMock.mockResolvedValue([
      { path: "/wt", branch: "cow-fix-01234567", openWorkspaceId: "w1" },
    ]);
    createAgentTabMock.mockResolvedValue({ tabId: "w1:t2", paneId: "w1:p2" });
    getAgentInfoMock.mockResolvedValue({ state: "working" });

    await expect(createHerdrRuntime(pi).host.hostAt(request)).rejects.toThrow(
      /no free agent spot left/,
    );
  });

  it("gives two placements taken before either launches different spots", async () => {
    // A spot reaches herdr only when `agent start` registers it, so two spawns
    // placed back to back must not both read spot 1 as free.
    getCurrentWorkspaceIdMock.mockResolvedValue("w1");
    createAgentTabMock
      .mockResolvedValueOnce({ tabId: "w1:t1", paneId: "w1:p1" })
      .mockResolvedValueOnce({ tabId: "w1:t2", paneId: "w1:p2" });
    const host = createHerdrRuntime(pi).host;
    const parentRequest = {
      unit: "pane" as const,
      cwd: "/repo",
      label: "general-purpose",
      name: "cow-fix-01234567",
    };

    const first = await host.hostAt(parentRequest);
    const second = await host.hostAt(parentRequest);

    expect([first.name, second.name]).toEqual([
      "cow-fix-01234567-1",
      "cow-fix-01234567-2",
    ]);
  });

  it("gives concurrent placements distinct spots", async () => {
    getCurrentWorkspaceIdMock.mockResolvedValue("w1");
    createAgentTabMock
      .mockResolvedValueOnce({ tabId: "w1:t1", paneId: "w1:p1" })
      .mockResolvedValueOnce({ tabId: "w1:t2", paneId: "w1:p2" });
    const host = createHerdrRuntime(pi).host;
    const parentRequest = {
      unit: "pane" as const,
      cwd: "/repo",
      label: "general-purpose",
      name: "cow-fix-01234567",
    };

    const refs = await Promise.all([
      host.hostAt(parentRequest),
      host.hostAt(parentRequest),
    ]);

    expect(refs.map((ref) => ref.name)).toEqual([
      "cow-fix-01234567-1",
      "cow-fix-01234567-2",
    ]);
  });
});

describe("createHerdrRuntime host.release", () => {
  it("declines to remove a workspace another agent still occupies", async () => {
    const pi = {} as unknown as ExtensionAPI;
    listAgentRecordsMock.mockResolvedValue([
      {
        name: "cow-fix-01234567-2",
        state: "idle",
        paneId: "w1:p3",
        workspaceId: "w1",
      },
    ]);

    await expect(
      createHerdrRuntime(pi).host.release(REF, "worktree-association"),
    ).resolves.toBe(false);
    expect(removeHerdrWorktreeMock).not.toHaveBeenCalled();
  });

  it("removes the workspace once no sibling placement is left", async () => {
    const pi = {} as unknown as ExtensionAPI;
    listAgentRecordsMock.mockResolvedValue([
      { name: REF.name, state: "idle", paneId: REF.paneId, workspaceId: "w1" },
    ]);
    removeHerdrWorktreeMock.mockResolvedValue(true);

    await expect(
      createHerdrRuntime(pi).host.release(REF, "worktree-association"),
    ).resolves.toBe(true);
    expect(removeHerdrWorktreeMock).toHaveBeenCalledWith(pi, "w1");
  });

  it("frees a spot so a later placement can take it again", async () => {
    // A released agent's name is not held by the checkout forever: the next
    // placement reuses the spot instead of reading it as still taken.
    const pi = {} as unknown as ExtensionAPI;
    getCurrentWorkspaceIdMock.mockResolvedValue("w1");
    createAgentTabMock
      .mockResolvedValueOnce({ tabId: "w1:t1", paneId: "w1:p1" })
      .mockResolvedValueOnce({ tabId: "w1:t2", paneId: "w1:p2" });
    const host = createHerdrRuntime(pi).host;
    const parentRequest = {
      unit: "pane" as const,
      cwd: "/repo",
      label: "general-purpose",
      name: "cow-fix-01234567",
    };

    const first = await host.hostAt(parentRequest);
    await host.release(first, "placement");
    const second = await host.hostAt(parentRequest);

    expect(second.name).toBe("cow-fix-01234567-1");
    expect(closePaneMock).toHaveBeenCalledWith(pi, "w1:p1");
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

describe("createHerdrRuntime pane.promptAgent", () => {
  it("submits the message to the agent in one call", async () => {
    const { pi, calls } = recordingPi([ok(undefined)]);

    await expect(
      createHerdrRuntime(pi).pane.promptAgent!(REF.paneId, "tighten the loop"),
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
      createHerdrRuntime(pi).pane.promptAgent!(
        REF.paneId,
        "line one\nline two",
      ),
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
      createHerdrRuntime(pi).pane.promptAgent!(REF.paneId, "hi"),
    ).resolves.toEqual({
      kind: "not-submitted",
      detail: expect.stringContaining("agent_not_found"),
    });
  });

  it("surfaces a blocked agent as a refusal, typing nothing into the dialog", async () => {
    const { pi } = recordingPi([fail("agent_blocked", "waiting on you")]);

    await expect(
      createHerdrRuntime(pi).pane.promptAgent!(REF.paneId, "hi"),
    ).resolves.toEqual({
      kind: "not-submitted",
      detail: expect.stringContaining("agent_blocked"),
    });
  });
});

describe("createHerdrRuntime host.waitUntilGone", () => {
  const pi = {} as unknown as ExtensionAPI;

  it("waits for the registry with the caller's timeout and sends no keys", async () => {
    await createHerdrRuntime(pi).host.waitUntilGone(REF, { timeoutMs: 2_000 });
    expect(waitForAgentGoneMock).toHaveBeenCalledWith(pi, "w1:p2", {
      timeoutMs: 2_000,
    });
    expect(sendAgentKeysMock).not.toHaveBeenCalled();
  });
});

describe("createHerdrRuntime pane.sendKeys", () => {
  const pi = {} as unknown as ExtensionAPI;

  it("sends logical keys to the agent on the pane", async () => {
    await createHerdrRuntime(pi).pane.sendKeys("w1:p2", ["ctrl+c", "ctrl+c"]);
    expect(sendAgentKeysMock).toHaveBeenCalledWith(pi, "w1:p2", [
      "ctrl+c",
      "ctrl+c",
    ]);
  });
});
