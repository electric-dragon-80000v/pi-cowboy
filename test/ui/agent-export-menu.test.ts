/**
 * agent-export-menu.test.ts — the status menu's export sub-flow: the two
 * choices, the clipboard, the editable path, the overwrite, and the write.
 * Manager and clipboard are fakes; a case that writes uses its own directory.
 */
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentSpawn } from "../../src/types.js";
import type { HandoverExportOutcome } from "../../src/agents/handover-export.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi, shellState } from "./shell-mock.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { clipboard } = vi.hoisted(() => ({
  clipboard: {
    copy: vi.fn(async (_text: string) => {}),
  },
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, copyToClipboard: clipboard.copy };
});

const { showAgentStatusMenu } =
  await import("../../src/ui/menu/menu-agent-status.js");

const AGENT_ID = "live1234-agent";

/** A live run: launched into a pane, working, with an owned worktree. */
function liveSpawn(): AgentSpawn {
  return {
    id: AGENT_ID,
    lifecycle: { phase: "spawned", startedAt: Date.now() },
    display: {
      type: "general-purpose",
      description: "Fix the login flow",
      worktree: {
        kind: "owned",
        path: "/repo/worktrees/cow-fix-login-abcd1234",
        branch: "cow-fix-login-abcd1234",
      },
    },
    execution: {
      promise: Promise.resolve(""),
      history: [],
      harness: "pi",
      host: {
        multiplexer: "herdr",
        name: "cow-fix-login-abcd1234",
        paneId: "pane-1",
        tabId: "tab-1",
        workspaceId: "ws-1",
        paneCreated: true,
      },
    },
  } as unknown as AgentSpawn;
}

/** A directory each case owns, so nothing writes into the real /tmp name. */
let exportDir: string;
const exported: string[] = [];
let exportImpl: (id: string) => Promise<HandoverExportOutcome> = (id) =>
  Promise.resolve(preparedExport(id));

/** The artifact an export of `id` produces, in this case's own directory. */
function preparedExport(
  id: string,
  sessionId = "ses_1",
): HandoverExportOutcome {
  return {
    kind: "prepared",
    defaultPath: path.join(
      exportDir,
      `cow-fix-login-abcd1234-pi-${sessionId}.md`,
    ),
    text: `TASK FOR ${id}`,
    sessionId,
  };
}

/** The default path the current case's export is offered at. */
function defaultPath(): string {
  return (preparedExport(AGENT_ID) as { defaultPath: string }).defaultPath;
}

function installManager(agents: AgentSpawn[]): void {
  shellState.manager = {
    listAgents: () => agents,
    exportHandover: (id: string) => {
      exported.push(id);
      return exportImpl(id);
    },
  };
}

async function openExport(): Promise<MenuSession> {
  installManager([liveSpawn()]);
  const session = openMenu(
    (ctx: ExtensionCommandContext) => showAgentStatusMenu(ctx),
    200,
  );
  session.open(/live1234-agent/);
  await session.settle();
  session.open("Export");
  return session;
}

beforeEach(() => {
  resetShell();
  exported.length = 0;
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-export-menu-"));
  exportImpl = (id) => Promise.resolve(preparedExport(id));
  clipboard.copy.mockReset();
  clipboard.copy.mockResolvedValue(undefined);
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
});

afterEach(() => {
  fs.rmSync(exportDir, { recursive: true, force: true });
});

describe("Agent export — the choice list", () => {
  it("offers the clipboard and a file, reading nothing yet", async () => {
    const session = await openExport();

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Export to clipboard",
      "Export to file",
    ]);
    expect(exported).toEqual([]);
  });

  it("closes without exporting on Esc", async () => {
    const session = await openExport();

    session.press(KEY.escape);
    await session.settle();

    expect(session.closedScreens).toEqual([]);
    expect(exported).toEqual([]);
    expect(session.notifications).toEqual([]);
  });

  it("stays on the choices when the read faults, so the other option remains", async () => {
    exportImpl = () =>
      Promise.resolve({
        kind: "faulted",
        fault: {
          kind: "session-export-failed",
          harness: "pi",
          detail: "no session file",
        },
      });
    const session = await openExport();

    session.open("Export to file");
    await session.settle();

    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.at(-1)).toEqual({
      message:
        '✗ Agent live1234-agent was not exported: harness "pi" could not export its session (no session file).',
      kind: "error",
    });
    const labels = session.rows().map((row) => row.label);
    expect(labels).toContain("Export to clipboard");
    expect(labels).toContain("Export to file");
  });
});

describe("Agent export — the clipboard", () => {
  it("copies the artifact, reports it, and closes", async () => {
    const session = await openExport();

    session.open("Export to clipboard");
    await session.settle();

    expect(clipboard.copy).toHaveBeenCalledWith(`TASK FOR ${AGENT_ID}`);
    expect(exported).toEqual([AGENT_ID]);
    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.at(-1)).toEqual({
      message: `✓ Exported handover for agent ${AGENT_ID} to the clipboard.`,
      kind: "info",
    });
  });

  it("reports a clipboard that refused the text and stays on the choices", async () => {
    clipboard.copy.mockRejectedValue(new Error("no clipboard tool"));
    const session = await openExport();

    session.open("Export to clipboard");
    await session.settle();

    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.at(-1)).toEqual({
      message: `✗ Failed to export agent ${AGENT_ID} to the clipboard: no clipboard tool`,
      kind: "error",
    });
    expect(session.activeRow()?.label).toBe("Export to clipboard");
  });
});

describe("Agent export — the file", () => {
  it("prefills the default path from the run's identities", async () => {
    const session = await openExport();

    session.open("Export to file");
    await session.settle();

    expect(session.text()).toContain(defaultPath());
    expect(exported).toEqual([AGENT_ID]);
  });

  it("writes the path the user typed, then reports it and closes", async () => {
    const session = await openExport();
    const chosen = path.join(exportDir, "chosen.md");
    session.open("Export to file");
    await session.settle();

    session.fillField(chosen, 200);
    session.press(KEY.enter);
    await session.settle();

    expect(fs.readFileSync(chosen, "utf8")).toBe(`TASK FOR ${AGENT_ID}`);
    expect(fs.existsSync(defaultPath())).toBe(false);
    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.at(-1)).toEqual({
      message: `✓ Exported handover for agent ${AGENT_ID} to ${chosen}.`,
      kind: "info",
    });
  });

  it("keeps the field open on its text when the write fails", async () => {
    const session = await openExport();
    const missing = path.join(exportDir, "nowhere", "chosen.md");
    session.open("Export to file");
    await session.settle();

    session.fillField(missing, 200);
    session.press(KEY.enter);
    await session.settle();

    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.at(-1)).toMatchObject({
      message: expect.stringContaining(
        `Failed to export agent ${AGENT_ID} to ${missing}`,
      ),
      kind: "error",
    });
    // The field stays on screen with the entered path, so it can be corrected.
    expect(session.text()).toContain(missing);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("asks before overwriting, and Esc returns to the field with the file kept", async () => {
    const session = await openExport();
    fs.writeFileSync(defaultPath(), "OLD");
    session.open("Export to file");
    await session.settle();

    session.press(KEY.enter);
    await session.settle();

    expect(session.text()).toContain(`Overwrite ${defaultPath()}?`);

    session.press(KEY.escape);
    await session.settle();

    expect(fs.readFileSync(defaultPath(), "utf8")).toBe("OLD");
    expect(session.closedScreens).toEqual([]);
    expect(session.text()).toContain(defaultPath());
  });

  it("replaces the file on Y, then reports it and closes", async () => {
    const session = await openExport();
    fs.writeFileSync(defaultPath(), "OLD");
    session.open("Export to file");
    await session.settle();

    session.press(KEY.enter);
    await session.settle();
    session.press("y");
    await session.settle();

    expect(fs.readFileSync(defaultPath(), "utf8")).toBe(`TASK FOR ${AGENT_ID}`);
    expect(session.closedScreens).toEqual([]);
    expect(session.notifications.at(-1)).toEqual({
      message: `✓ Exported handover for agent ${AGENT_ID} to ${defaultPath()}.`,
      kind: "info",
    });
  });
});
