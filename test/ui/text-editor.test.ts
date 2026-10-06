/**
 * The multi-line prompt field: the spawn wizard's prompt step, reached after
 * Spawn. Driven through the Component interface only (see harness.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../../src/agents/agent-types.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setCoordinator, setPi, setSession } from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { showSpawnAgentMenu } =
  await import("../../src/ui/menu/menu-spawn-wizard.js");

const MODEL_OPTIONS: string[] = [];
const WIDE = 100;

let memory: MemoryStore;

function openWizard(): MenuSession {
  return openMenu(
    (ctx: ExtensionCommandContext) => showSpawnAgentMenu(ctx, MODEL_OPTIONS),
    WIDE,
  );
}

/** Press Spawn on the options screen, stopping on the prompt step. */
async function toPromptStep(session: MenuSession) {
  await session.whenScreens(1);
  await session.settle();
  session.focus("Spawn");
  session.press(KEY.enter);
  await session.whenScreens(2);
  await session.settle();
}

beforeEach(() => {
  resetShell();
  setPi({ exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
  memory = createMemoryStore({ projectStatus: "absent" });
  memory.install();
  registerAgents(
    new Map([
      [
        "auditor",
        {
          name: "auditor",
          displayName: "Auditor",
          description: "Audits a change",
          systemPrompt: "",
        },
      ],
    ]),
  );
  setSession({
    cwd: "/repo",
    model: undefined,
    modelRegistry: undefined,
  } as unknown as Parameters<typeof setSession>[0]);
  setCoordinator({ spawn: async () => {} });
});

describe("Prompt step — multi-line body", () => {
  it("frames the editor under the screen title, without a row to select", async () => {
    const session = openWizard();
    await toPromptStep(session);

    expect(session.title()).toBe("Agent Prompt (optional)");
    // The editor is the body: no cursor row, and its own text area.
    expect(session.activeRow()).toBeNull();
    expect(session.text()).toContain("Agent Prompt");
  });

  it("keeps each line of a multi-line prompt", async () => {
    const session = openWizard();
    await toPromptStep(session);

    session.typeText("first line");
    session.press(KEY.newline);
    session.typeText("second line");
    await session.settle();

    expect(session.text()).toContain("first line");
    expect(session.text()).toContain("second line");
  });

  it("accepts an empty prompt, leaving the step", async () => {
    const session = openWizard();
    await toPromptStep(session);

    session.press(KEY.enter);
    await session.settle();

    expect(session.notifications.map((n) => n.message)).not.toContain(
      "Cannot be empty",
    );
    expect(session.closedScreens).toContain(1);
  });
});
