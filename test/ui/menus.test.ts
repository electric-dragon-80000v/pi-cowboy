/**
 * menus.test.ts — topmost /cowboy menu: row order, hosted model/spawn-default rows,
 * and hand-off rows returning to the list. Real in-memory ConfigStore throughout.
 * src/pi-settings.js is stubbed to keep the walk off the developer's pi settings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../../src/agents/agent-types.js";
import { registerOrchestrators } from "../../src/orchestrators/orchestrator-types.js";
import { DEFAULT_ORCHESTRATORS } from "../../src/orchestrators/default-orchestrators.js";
import { showExtensionIndicator } from "../../src/ui/indicator.js";
import type { ThinkingLevel } from "../../src/types.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { reasoningModel, registryOver } from "./models.js";
import { resetShell, setPi, setSession } from "./shell-mock.js";
import {
  createMemoryStore,
  type MemoryStore,
  type MemoryStoreOptions,
} from "./store.js";
import { each, walk, type TraversalInput } from "./walk.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

/** pi's defaultThinkingLevel stub; the hosted model screen falls back to it. */
const piSettings = vi.hoisted(() => ({
  thinking: undefined as ThinkingLevel | undefined,
}));
vi.mock("../../src/pi-settings.js", () => ({
  getPiDefaultThinkingLevel: async () => piSettings.thinking,
}));

const { showAgentsMainMenu } = await import("../../src/ui/menu/menus.js");

/** Three models so the picker always offers more than the current value. */
const MODEL_OPTIONS = ["anthropic/claude-3", "openai/gpt-4", "openai/gpt-4o"];

let memory: MemoryStore;

/** The mocked pi's active tools. */
let activeTools: string[];
let setActiveTools: ReturnType<typeof vi.fn<(names: string[]) => void>>;

function installStore(options: MemoryStoreOptions = {}): void {
  memory = createMemoryStore({
    projectStatus: options.projectStatus ?? "absent",
    global: options.global,
    project: options.project,
  });
  memory.install();
}

/** Wide frame keeps each pick-list row on one line. */
async function openMain(width = 100): Promise<MenuSession> {
  const session = openMenu(
    (ctx: ExtensionCommandContext) => showAgentsMainMenu(ctx, MODEL_OPTIONS),
    width,
  );
  // The menu resolves pi's thinking level first, so the screen arrives a microtask later.
  await session.whenScreens(1);
  return session;
}

beforeEach(() => {
  resetShell();
  // The menus run from a /cowboy command, so a session context is always there.
  setSession({
    cwd: "/repo",
    model: undefined,
    modelRegistry: registryOver([reasoningModel("anthropic", "claude-3")]),
    scopedModels: [],
  } as never);
  piSettings.thinking = undefined;
  activeTools = ["read", "bash", "cowboy_agent"];
  setActiveTools = vi.fn<(names: string[]) => void>((names) => {
    activeTools = names;
  });
  setPi({
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    getActiveTools: () => [...activeTools],
    setActiveTools,
    registerTool: () => {},
    registerMessageRenderer: () => {},
  });
  installStore();
  // One extra type and orchestrator, so each picker has a marked current value and something new.
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
  registerOrchestrators(
    new Map([
      [
        "reviewer",
        {
          ...DEFAULT_ORCHESTRATORS.default!,
          name: "reviewer",
          displayName: "Reviewer",
        },
      ],
    ]),
  );
});

describe("Agents menu — structure", () => {
  it("frames the menu", async () => {
    expect((await openMain()).title()).toBe("Agents");
  });

  it("opens with the hosted rows, above the rows that were already there", async () => {
    const session = await openMain();

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Model overrides",
      "Default orchestrator",
      "Agent",
      "Status",
      "Spawn agent",
      "Settings",
      "Enabled",
    ]);
    // The cursor opens on the first hosted row, not on a separator.
    expect(session.activeRow()?.label).toBe("Model overrides");
  });

  const rowTable = [
    ["Model overrides", "(no model)"],
    ["Default orchestrator", "default"],
    ["Agent", "general-purpose"],
    ["Status", ""],
    ["Spawn agent", ""],
    ["Settings", ""],
    ["Enabled", "ON"],
  ] as const;

  for (const traversal of each(rowTable, ([label, value]): TraversalInput => ({
    name: `row ${label}`,
    steps: [{ focus: label }, { expect: { rows: [[label, value]] } }],
  }))) {
    it(`renders ${traversal.name}`, async () => {
      const session = await openMain();
      await walk(session, traversal.steps, memory.store, traversal.name);
    });
  }
});

describe("Agents menu — the Model overrides row", () => {
  it("hosts the whole Model Settings screen in place", async () => {
    const session = await openMain();
    session.open("Model overrides");
    await session.settle();

    // Hosted in place: still one ctx.ui.custom screen.
    expect(session.screenCount).toBe(1);
    expect(session.text()).toContain("Model Settings");
    expect(session.text()).toContain("Global default model");
    expect(session.text()).toContain("Override another type...");
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Global default model",
      "Override another type...",
    ]);
  });

  it("walks level → model from the screen's default row and persists to the picked layer", async () => {
    const session = await openMain();
    await walk(
      session,
      [
        { open: "Model overrides" },
        { open: "Global default model" },
        {
          expect: {
            rows: [
              ["Session", ""],
              ["Global", ""],
              ["Project", ""],
            ],
            active: "Session",
          },
        },
        { open: "Global" },
        {
          expect: {
            shows: [
              /\(inherits parent\)\s+✓/,
              "claude-3 [anthropic]",
              "gpt-4 [openai]",
              "gpt-4o [openai]",
            ],
          },
        },
        { open: "gpt-4 [openai]" },
        {
          expect: {
            active: "Global default model",
            activeValue: "openai/gpt-4",
            notified: ["default model set to openai/gpt-4 (global)"],
            store: (store) =>
              expect(store.agentConfigSnapshot().default).toBe("openai/gpt-4"),
          },
        },
        { escape: true },
        {
          expect: {
            // Leaving the screen repaints the topmost row from the store.
            active: "Model overrides",
            activeValue: "openai/gpt-4",
          },
        },
      ],
      memory.store,
      "set default model at global",
    );

    expect(memory.lastLayer()).toBe("global");
  });

  it("persists to the session layer without writing a file", async () => {
    const session = await openMain();
    await walk(
      session,
      [
        { open: "Model overrides" },
        { open: "Global default model" },
        { focus: "Session" },
        { expect: { shows: ["Not saved"], active: "Session" } },
        { enter: true },
        { open: "gpt-4o [openai]" },
        {
          expect: {
            active: "Global default model",
            activeValue: "gpt-4o [session]",
            notified: ["default model set to openai/gpt-4o (session)"],
            store: (store) =>
              expect(store.sessionDefaultModel).toBe("openai/gpt-4o"),
          },
        },
      ],
      memory.store,
      "set default model at session",
    );

    expect(memory.writes).toHaveLength(0);
  });

  it("shows the default's winning non-global layer on the topmost row", async () => {
    installStore({
      projectStatus: "loaded",
      global: { agent: { default: "openai/gpt-4" } },
      project: { agent: { default: "anthropic/claude-3" } },
    });

    expect((await openMain()).activeRow()).toEqual({
      label: "Model overrides",
      value: "anthropic/claude-3 [project]",
    });
  });

  it("hides the project entry when the project target is unavailable", async () => {
    installStore({ projectStatus: "untrusted" });
    const session = await openMain();
    session.open("Model overrides");
    session.open("Global default model");

    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Session",
      "Global",
    ]);
  });

  it("clears the default at the picked layer through the inherit entry", async () => {
    installStore({ global: { agent: { default: "openai/gpt-4" } } });
    const session = await openMain();

    session.open("Model overrides");
    session.open("Global default model");
    session.open("Global");
    session.open("(inherits parent)");
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "default inherits parent model",
    );
    expect(memory.store.agentConfigSnapshot().default).toBeNull();
    expect(memory.lastLayer()).toBe("global");

    // Inherit unwinds the chain: the library forwards only a DEFINED value,
    // so the level picker completes itself and rebuilds the row behind it.
    expect(session.activeRow()).toEqual({
      label: "Global default model",
      value: "(no model)",
    });

    session.press(KEY.escape);
    await session.settle();

    expect(session.activeRow()).toEqual({
      label: "Model overrides",
      value: "(no model)",
    });
  });
});

describe("Agents menu — the hosted spawn-defaults rows", () => {
  it("marks the current agent type and sets another one", async () => {
    const session = await openMain(200);
    session.open("Agent");

    expect(session.text()).toMatch(/general-purpose \[[^\]]*\] ✓/);
    expect(session.text()).toContain("auditor [Audits a change]");

    session.focus(/^auditor/);
    session.press(KEY.enter);
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "Agent set to auditor",
    );
    expect(memory.store.agent.defaultAgentType).toBe("auditor");
    expect(memory.lastLayer()).toBe("global");
    expect(session.activeRow()).toEqual({
      label: "Agent",
      value: "auditor",
    });
  });

  it("marks the current orchestrator and sets another one", async () => {
    const session = await openMain(200);
    session.open("Default orchestrator");

    expect(session.text()).toMatch(/default +✓/);
    expect(session.text()).toContain("reviewer");

    session.focus(/^reviewer/);
    session.press(KEY.enter);
    await session.settle();

    // The notification still names the spawn default.
    expect(session.notifications.map((n) => n.message)).toContain(
      "Default orchestrator set to reviewer",
    );
    expect(memory.store.agent.defaultOrchestrator).toBe("reviewer");
    expect(memory.lastLayer()).toBe("global");
    expect(session.activeRow()).toEqual({
      label: "Default orchestrator",
      value: "reviewer",
    });
  });

  it("keeps the configured default when the picker is cancelled", async () => {
    const session = await openMain();
    session.open("Agent");
    session.press(KEY.escape);
    await session.settle();

    expect(memory.store.agent.defaultAgentType).toBe("general-purpose");
    expect(memory.writes).toHaveLength(0);
  });
});

describe("Agents menu — the rows that hand off to a full-screen flow", () => {
  it("opens the Settings menu from its row", async () => {
    const session = await openMain();
    session.open("Settings");
    await session.settle();

    expect(session.screenCount).toBe(2);
    expect(session.title()).toBe("Settings");
  });

  it("opens the spawn wizard from its row", async () => {
    const session = await openMain();
    session.open("Spawn agent");
    await session.settle();

    expect(session.screenCount).toBe(2);
    expect(session.title()).toBe("Spawn Options");
  });

  it("returns to the agents menu when the nested flow is cancelled", async () => {
    const session = await openMain();
    session.open("Settings");
    await session.settle();

    session.press(KEY.escape);
    await session.settle();

    expect(session.title()).toBe("Agents");
    expect(session.activeRow()?.label).toBe("Model overrides");
  });

  it("closes the menu when the list itself is cancelled", async () => {
    const session = await openMain();
    session.press(KEY.escape);
    await session.settle();

    expect(session.closedScreens).toEqual([0]);
  });
});

describe("Agents menu — the Enabled switch", () => {
  it("turns the extension off, unloading the Cowboy tools, taking the marker down, and collapsing the menu", async () => {
    const session = await openMain();
    showExtensionIndicator(session.context.ui);
    const marker = session.overlays.at(-1)!;
    expect(marker.hidden()).toBe(false);

    session.open("Enabled");
    await session.settle();

    expect(memory.store.agent.extensionEnabled).toBe(false);
    expect(memory.lastLayer()).toBe("global");
    expect(setActiveTools).toHaveBeenCalledTimes(1);
    expect(setActiveTools.mock.calls[0]![0]).toEqual(["read", "bash"]);
    expect(session.notifications.map((n) => n.message)).toContain(
      "pi-cowboy disabled",
    );
    expect(marker.hidden()).toBe(true);
    // Rebuilt in place, not reopened: the same screen keeps the switch as its
    // only row and as the cursor row.
    expect(session.screenCount).toBe(1);
    expect(session.walkRows().map((row) => row.label)).toEqual(["Enabled"]);
    expect(session.activeRow()).toEqual({ label: "Enabled", value: "OFF" });
  });

  it("opens as the whole menu while off, and turns the extension back on", async () => {
    installStore({ global: { agent: { extensionEnabled: false } } });
    const session = await openMain();

    expect(session.walkRows().map((row) => row.label)).toEqual(["Enabled"]);
    expect(session.activeRow()).toEqual({ label: "Enabled", value: "OFF" });

    session.press(KEY.enter);
    await session.settle();

    expect(memory.store.agent.extensionEnabled).toBe(true);
    expect(setActiveTools.mock.calls.at(-1)![0]).toEqual([
      "read",
      "bash",
      "cowboy_agent",
      "stop_cowboy_agent",
      "merge_cowboy_branch",
      "steer_cowboy_agent",
      "cleanup_cowboy_agent",
    ]);
    expect(session.notifications.map((n) => n.message)).toContain(
      "pi-cowboy enabled",
    );
    const marker = session.overlays.at(-1);
    expect(marker?.options?.overlay).toBe(true);
    expect(marker?.hidden()).toBe(false);
    // The rows come back in their own order, the switch last and still held.
    expect(session.activeRow()).toEqual({ label: "Enabled", value: "ON" });
    session.focus("Model overrides");
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Model overrides",
      "Default orchestrator",
      "Agent",
      "Status",
      "Spawn agent",
      "Settings",
      "Enabled",
    ]);
  });

  it("keeps the cursor on the switch, so pressing again flips the other way", async () => {
    const session = await openMain();

    session.open("Enabled");
    await session.settle();
    const afterOff = memory.store.agent.extensionEnabled;
    session.press(KEY.enter);
    await session.settle();

    expect(afterOff).toBe(false);
    expect(memory.store.agent.extensionEnabled).toBe(true);
    expect(session.activeRow()).toEqual({ label: "Enabled", value: "ON" });
    expect(session.walkRows()).toHaveLength(7);
  });
});

describe("Settings menu — after the model screen moved out", () => {
  it("no longer lists a Model overrides row", async () => {
    const session = await openMain();
    session.open("Settings");
    await session.settle();

    expect(session.title()).toBe("Settings");
    expect(session.walkRows().map((row) => row.label)).toEqual([
      "Concurrency Settings",
      "Agent behavior",
      "System prompt",
      "Show cowboy 🤠",
      "Grazing 🐄",
    ]);
    expect(session.text()).not.toContain("Model overrides");
  });
});

describe("Settings menu — the active indicator switch", () => {
  /** The Settings screen, opened from the main menu. */
  async function openSettings(): Promise<MenuSession> {
    const session = await openMain();
    session.open("Settings");
    await session.settle();
    return session;
  }

  it("opens on the resolved setting", async () => {
    const session = await openSettings();

    session.focus("Show cowboy 🤠");
    expect(session.activeRow()).toEqual({
      label: "Show cowboy 🤠",
      value: "ON",
    });
  });

  it("takes the marker down, persists globally, and holds the cursor on the row", async () => {
    const session = await openSettings();
    showExtensionIndicator(session.context.ui);
    const marker = session.overlays.at(-1)!;
    expect(marker.hidden()).toBe(false);

    session.focus("Show cowboy 🤠");
    session.press(KEY.enter);
    await session.settle();

    expect(memory.store.agent.showActiveIndicator).toBe(false);
    expect(memory.lastLayer()).toBe("global");
    expect(session.notifications).toEqual([]);
    expect(marker.hidden()).toBe(true);
    expect(session.activeRow()).toEqual({
      label: "Show cowboy 🤠",
      value: "OFF",
    });
    // Toggling repaints the row in place; no screen was reopened.
    expect(session.screenCount).toBe(2);
  });

  it("mounts the marker again when switched back on", async () => {
    installStore({ global: { agent: { showActiveIndicator: false } } });
    const session = await openSettings();

    session.focus("Show cowboy 🤠");
    expect(session.activeRow()).toEqual({
      label: "Show cowboy 🤠",
      value: "OFF",
    });
    session.press(KEY.enter);
    await session.settle();

    expect(memory.store.agent.showActiveIndicator).toBe(true);
    expect(session.notifications).toEqual([]);
    const marker = session.overlays.at(-1);
    expect(marker?.options?.overlay).toBe(true);
    expect(marker?.hidden()).toBe(false);
    expect(session.activeRow()).toEqual({
      label: "Show cowboy 🤠",
      value: "ON",
    });
  });
});

describe("Settings menu — the grazing switch", () => {
  /** The Settings screen, opened from the main menu. */
  async function openSettings(): Promise<MenuSession> {
    const session = await openMain();
    session.open("Settings");
    await session.settle();
    return session;
  }

  it("opens ON by default, under the indicator row", async () => {
    const session = await openSettings();

    session.focus("Grazing 🐄");
    expect(session.activeRow()).toEqual({ label: "Grazing 🐄", value: "ON" });
  });

  it("persists globally, leaves the marker up, and holds the cursor on the row", async () => {
    const session = await openSettings();
    showExtensionIndicator(session.context.ui);
    const marker = session.overlays.at(-1)!;

    session.focus("Grazing 🐄");
    session.press(KEY.enter);
    await session.settle();

    expect(memory.store.agent.grazingEnabled).toBe(false);
    expect(memory.lastLayer()).toBe("global");
    expect(session.notifications).toEqual([]);
    // The setting gates the pasture, not the marker: the marker stays mounted.
    expect(marker.hidden()).toBe(false);
    expect(session.activeRow()).toEqual({ label: "Grazing 🐄", value: "OFF" });
    // Toggling repaints the row in place; no screen was reopened.
    expect(session.screenCount).toBe(2);
  });

  it("opens OFF when the pasture is not drawn, and draws it again", async () => {
    installStore({ global: { agent: { grazingEnabled: false } } });
    const session = await openSettings();

    session.focus("Grazing 🐄");
    expect(session.activeRow()).toEqual({ label: "Grazing 🐄", value: "OFF" });

    session.press(KEY.enter);
    await session.settle();

    expect(memory.store.agent.grazingEnabled).toBe(true);
    expect(session.activeRow()).toEqual({ label: "Grazing 🐄", value: "ON" });
  });
});
