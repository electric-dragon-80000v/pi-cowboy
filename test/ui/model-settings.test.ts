/**
 * Characterization suite for the Model Settings screen: row values + tags, the listing rule,
 * and which layer a mutation lands in — all against a REAL ConfigStore.
 *
 * Entered through the real path (topmost menu's "Model overrides" row); mocked boundaries are
 * src/shell.js (store + session) and src/pi-settings.js (pi's default thinking level).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../../src/agents/agent-types.js";
import type { ConfigStore } from "../../src/config/config-store.js";
import { probed, unprobed } from "../../src/availability.js";
import type { ThinkingLevel } from "../../src/types.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import {
  resetShell,
  setHarnessAvailability,
  setPi,
  setSession,
} from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { reasoningModel, registryOver } from "./models.js";
import { each, walk, type TraversalInput } from "./walk.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

/** Stubbed pi defaultThinkingLevel: explicit fallback chain, off the developer's real pi settings. */
const piSettings = vi.hoisted(() => ({
  thinking: undefined as ThinkingLevel | undefined,
}));
vi.mock("../../src/pi-settings.js", () => ({
  getPiDefaultThinkingLevel: async () => piSettings.thinking,
}));

const { showAgentsMainMenu } = await import("../../src/ui/menu/menus.js");

/** Three models, so the picker always has more than the current value. */
const MODEL_OPTIONS = ["anthropic/claude-3", "openai/gpt-4", "openai/gpt-4o"];

const REGISTRY = registryOver([
  reasoningModel("anthropic", "claude-3"),
  reasoningModel("openai", "gpt-4"),
  reasoningModel("openai", "gpt-4o"),
]);

let memory: MemoryStore;

interface SetupOptions {
  global?: Record<string, unknown>;
  project?: Record<string, unknown> | null;
  projectStatus?: "absent" | "untrusted" | "loaded" | "malformed";
}

function installStore(options: SetupOptions = {}): void {
  memory = createMemoryStore({
    projectStatus: options.projectStatus ?? "absent",
    global: options.global,
    project: options.project,
  });
  memory.install();
}

/** Reach the screen the way a user does: topmost menu → "Model overrides" row. */
async function openModelSettings(width = 100): Promise<MenuSession> {
  const session = openMenu(
    (ctx: ExtensionCommandContext) => showAgentsMainMenu(ctx, MODEL_OPTIONS),
    width,
  );
  await session.whenScreens(1);
  session.open("Model overrides");
  await session.settle();
  return session;
}

beforeEach(() => {
  resetShell();
  // This machine has no opencode, so no OpenCode row appears on the model screen.
  setHarnessAvailability(probed(["pi"]));
  piSettings.thinking = undefined;
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  installStore();
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
  // No session model, so the parent id is null and rows render "(no model)".
  setSession({
    cwd: "/repo",
    model: undefined,
    modelRegistry: REGISTRY,
  } as unknown as Parameters<typeof setSession>[0]);
});

describe("Model Settings — structure on a fresh config", () => {
  it("frames the screen and hides the clear-all row", async () => {
    const session = await openModelSettings();

    expect(session.title()).toBe("Agents");
    expect(session.text()).toContain("Model Settings");
    expect(session.text()).toContain("Pi Default Model");
    expect(session.text()).not.toContain("Agent model");
    expect(session.text()).toContain("Override another type...");
    // Nothing to clear: no layer carries a model setting.
    expect(session.text()).not.toContain("Clear all model overrides...");
  });

  const rowTable = [
    ["Pi Default Model", "(no model)"],
    ["Override another type...", ""],
  ] as const;

  for (const traversal of each(rowTable, ([label, value]): TraversalInput => ({
    name: `row ${label}`,
    steps: [{ focus: label }, { expect: { rows: [[label, value]] } }],
  }))) {
    it(`renders ${traversal.name}`, async () => {
      const session = await openModelSettings();
      await walk(session, traversal.steps, memory.store, traversal.name);
    });
  }

  it("names the parent as the source when the session has a model to inherit", async () => {
    setSession({
      cwd: "/repo",
      model: reasoningModel("anthropic", "claude-3"),
      modelRegistry: REGISTRY,
    } as unknown as Parameters<typeof setSession>[0]);

    const session = await openModelSettings();

    expect(session.activeRow()).toEqual({
      label: "Pi Default Model",
      value: "(inherits parent)",
    });
  });
});

describe("Model Settings — the listing rule", () => {
  const configured = {
    agent: { default: "openai/gpt-4", auditor: "anthropic/claude-3" },
  };

  it("opens on the default row and reaches the first listed type with one Down", async () => {
    installStore({ global: configured });
    const session = await openModelSettings();

    expect(session.activeRow()).toEqual({
      label: "Pi Default Model",
      value: "openai/gpt-4",
    });
    expect(session.text()).toContain("anthropic/claude-3");
    expect(session.text()).toContain("• auditor");
    expect(session.text()).toContain("Clear all model overrides...");

    // The spacer and group header above the first listed type are skipped.
    session.press(KEY.down);
    expect(session.activeRow()?.label).toBe("• auditor");
  });

  it("never lists a type without an explicit per-type override", async () => {
    installStore({ global: configured });
    const session = await openModelSettings();

    const labels = session.walkRows().map((row) => row.label);

    expect(labels).toEqual([
      "Pi Default Model",
      "• auditor",
      "Override another type...",
      "Clear all model overrides...",
    ]);
  });

  it("shows the spawn-effective thinking level on the type row", async () => {
    installStore({
      global: {
        agent: { defaultThinking: "low", auditor: "anthropic/claude-3" },
      },
    });
    const session = await openModelSettings();

    expect(session.rows()).toContainEqual({
      label: "• auditor",
      value: "low",
    });
  });

  it("falls back to pi's default thinking level when nothing else is set", async () => {
    piSettings.thinking = "high";
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "high",
    });
  });

  it("clamps the thinking level to what the model supports", async () => {
    // "max" is opt-in (gated behind thinkingLevelMap), so the row shows the nearest level below.
    installStore({
      global: {
        agent: { defaultThinking: "max", auditor: "anthropic/claude-3" },
      },
    });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "high",
    });
  });

  it("merges types resolving to the same model into one group", async () => {
    registerAgents(
      new Map([
        ["auditor", { name: "auditor", description: "A", systemPrompt: "" }],
        ["scribe", { name: "scribe", description: "S", systemPrompt: "" }],
      ]),
    );
    installStore({
      global: {
        agent: { auditor: "anthropic/claude-3", scribe: "anthropic/claude-3" },
      },
    });

    const rows = (await openModelSettings()).rows();
    expect(rows).toContainEqual({ label: "• auditor", value: "medium" });
    expect(rows).toContainEqual({ label: "• scribe", value: "medium" });
  });
});

describe("Model Settings — provenance tags", () => {
  it("tags the default row with its winning non-global layer", async () => {
    installStore({
      projectStatus: "loaded",
      project: { agent: { default: "anthropic/claude-3" } },
    });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "Pi Default Model",
      value: "anthropic/claude-3 [project]",
    });
  });

  it("tags a session default above the configured one", async () => {
    installStore({ global: { agent: { default: "openai/gpt-4" } } });
    memory.store.mutate.agent.setModelOverride(
      "default",
      "openai/gpt-4o",
      "session",
    );

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "Pi Default Model",
      value: "openai/gpt-4o [session]",
    });
  });

  it("tags a project-layer per-type override", async () => {
    installStore({
      projectStatus: "loaded",
      project: { agent: { auditor: "anthropic/claude-3" } },
    });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "medium [project]",
    });
  });

  it("tags a session-layer per-type override above the project one", async () => {
    installStore({
      projectStatus: "loaded",
      project: { agent: { auditor: "anthropic/claude-3" } },
    });
    memory.store.mutate.agent.setModelOverride(
      "auditor",
      "openai/gpt-4o",
      "session",
    );

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "medium [session]",
    });
  });

  it("leaves a global-layer override untagged", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "medium",
    });
  });
});

describe("Model Settings — per-type rows", () => {
  function storeWithOverrides(): ConfigStore {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    return memory.store;
  }

  it("sets a per-type override at the picked layer and tags it", async () => {
    storeWithOverrides();
    const session = await openModelSettings();
    await walk(
      session,
      [
        { focus: "• auditor" },
        { expect: { active: "• auditor", activeValue: "medium" } },
        { enter: true },
        { expect: { shows: ["Clear..."] } },
        { open: "Session" },
        { open: "gpt-4o [openai]" },
        {
          expect: {
            rows: [["• auditor", "medium [session]"]],
            notified: ["auditor model set to openai/gpt-4o (session)"],
            store: (store) =>
              expect(store.sessionModelOverride("auditor")).toBe(
                "openai/gpt-4o",
              ),
          },
        },
      ],
      memory.store,
      "set per-type override at session",
    );
  });

  it("clears a per-type override through the nested Clear... picker", async () => {
    storeWithOverrides();
    const session = await openModelSettings();
    await walk(
      session,
      [
        { focus: "• auditor" },
        { enter: true },
        { open: "Clear..." },
        {
          expect: {
            // The clear picker lists only layers carrying the key.
            rows: [["Global", ""]],
            hides: ["Session", "Project", "All levels"],
          },
        },
        { open: "Global" },
        {
          expect: {
            notified: ["auditor override cleared (global)"],
            // Without the override the type unlists.
            store: (store) =>
              expect(store.agentConfigSnapshot().auditor).toBeUndefined(),
          },
        },
      ],
      memory.store,
      "clear per-type override",
    );

    expect(memory.lastLayer()).toBe("global");
  });
});

describe("Model Settings — override another type", () => {
  it("adds an override for a type that only inherits", async () => {
    const session = await openModelSettings();
    await walk(
      session,
      [
        { open: "Override another type..." },
        {
          expect: {
            // Only types WITHOUT an override are offered here.
            rows: [
              ["• general-purpose", ""],
              ["• auditor", ""],
            ],
          },
        },
        { open: "• auditor" },
        { open: "Global" },
        { open: "claude-3 [anthropic]" },
        {
          expect: {
            rows: [["• auditor", "medium"]],
            notified: ["auditor model set to anthropic/claude-3 (global)"],
            store: (store) =>
              expect(store.agentConfigSnapshot().auditor).toBe(
                "anthropic/claude-3",
              ),
          },
        },
      ],
      memory.store,
      "override another type",
    );
  });

  it("drops an overridden type out of the list", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openModelSettings();
    session.open("Override another type...");

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toEqual(["• general-purpose"]);
  });
});

describe("Model Settings — clear all overrides", () => {
  it("clears the picked level after confirmation", async () => {
    installStore({
      projectStatus: "loaded",
      global: { agent: { auditor: "anthropic/claude-3" } },
      project: { agent: { default: "openai/gpt-4" } },
    });
    const session = await openModelSettings();
    await walk(
      session,
      [
        { open: "Clear all model overrides..." },
        {
          expect: {
            // One row per layer with settings; "All levels" needs at least two.
            rows: [
              ["Global", ""],
              ["Project", ""],
              ["All levels", ""],
            ],
            active: "Global",
          },
        },
        { open: "All levels" },
        {
          expect: {
            active: "Yes",
            shows: [/Clear all model overrides at the all/],
          },
        },
        { enter: true },
        {
          expect: {
            notified: ["Model overrides cleared (all)"],
            store: (store) => {
              expect(store.agentConfigSnapshot().default).toBeNull();
              expect(store.agentConfigSnapshot().auditor).toBeUndefined();
              expect(store.hasGlobalModelSettings).toBe(false);
              expect(store.hasProjectModelSettings).toBe(false);
            },
          },
        },
      ],
      memory.store,
      "clear all overrides",
    );
  });

  it("keeps the overrides when the confirmation is declined", async () => {
    installStore({ global: { agent: { default: "openai/gpt-4" } } });
    const session = await openModelSettings();
    await walk(
      session,
      [
        { open: "Clear all model overrides..." },
        { open: "Global" },
        { open: "No" },
        {
          expect: {
            notNotified: ["Model overrides cleared"],
            store: (store) =>
              expect(store.agentConfigSnapshot().default).toBe("openai/gpt-4"),
          },
        },
      ],
      memory.store,
      "decline clear all",
    );

    expect(memory.writes).toHaveLength(0);
  });
});

describe("Model Settings — per-harness default rows", () => {
  /** A plausible `opencode models`: one bare key per line, with a comment line. */
  const OPENCODE_MODELS = [
    "# Models available to opencode",
    "anthropic/claude-opus-4",
    "openai/gpt-4o",
  ].join("\n");

  /** This machine has opencode, and its CLI answers for itself. */
  function installOpencode(): void {
    setHarnessAvailability(probed(["pi", "opencode"]));
    setPi({
      exec: async () => ({ code: 0, stdout: OPENCODE_MODELS, stderr: "" }),
    });
  }

  /** The raw agent slice of the last write, for asserting the persisted shape. */
  function lastAgentWrite(): Record<string, unknown> | undefined {
    return memory.writes.at(-1)?.config.agent;
  }

  it("hides the harness row while opencode is unproven", async () => {
    // The default shell state: no probe has answered for opencode.
    setHarnessAvailability(unprobed());

    expect((await openModelSettings()).text()).not.toContain(
      "OpenCode Default Model",
    );
  });

  it("hides the harness row on a machine that cannot launch it", async () => {
    expect((await openModelSettings()).text()).not.toContain(
      "OpenCode Default Model",
    );
  });

  it("gives pig and pi-bolt no row of their own", async () => {
    setHarnessAvailability(probed(["pi", "pig", "pi-bolt"]));

    const text = (await openModelSettings()).text();
    expect(text).not.toContain("PiG Default Model");
    expect(text).not.toContain("Pi-Bolt Default Model");
  });

  it("offers opencode's own models under its row and persists the pick", async () => {
    installOpencode();
    const session = await openModelSettings();

    await walk(
      session,
      [
        {
          expect: {
            rows: [
              ["Pi Default Model", "(no model)"],
              ["OpenCode Default Model", "(no model)"],
            ],
          },
        },
        { open: "OpenCode Default Model" },
        {
          expect: {
            rows: [
              ["Session", ""],
              ["Global", ""],
              ["Project", ""],
              ["Clear...", ""],
            ],
          },
        },
        { open: "Global" },
        // Only the entries its own CLI answered with: the pi catalog's models
        // are not on offer under a harness that does not run them.
        {
          expect: {
            shows: ["claude-opus-4 [anthropic]", "gpt-4o [openai]"],
            hides: ["claude-3"],
          },
        },
        { open: "gpt-4o [openai]" },
        {
          expect: {
            active: "OpenCode Default Model",
            activeValue: "openai/gpt-4o",
            notified: ["OpenCode Default Model set to openai/gpt-4o (global)"],
            store: (store) =>
              expect(store.defaultModelForHarness("opencode")).toBe(
                "openai/gpt-4o",
              ),
          },
        },
      ],
      memory.store,
      "opencode default at global",
    );

    expect(memory.lastLayer()).toBe("global");
    expect(lastAgentWrite()?.defaultModelByHarness).toEqual({
      opencode: "openai/gpt-4o",
    });
  });

  it("tags a project-layer harness default and keeps the global one above it", async () => {
    installStore({
      projectStatus: "loaded",
      global: {
        agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } },
      },
      project: {
        agent: {
          defaultModelByHarness: { opencode: "anthropic/claude-opus-4" },
        },
      },
    });
    installOpencode();

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "OpenCode Default Model",
      value: "anthropic/claude-opus-4 [project]",
    });
  });

  it("persists an inherit pick as a real null entry", async () => {
    installStore({
      global: {
        agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } },
      },
    });
    installOpencode();
    // A parent model, so the inherit row has something to name.
    setSession({
      cwd: "/repo",
      model: reasoningModel("anthropic", "claude-3"),
      modelRegistry: REGISTRY,
    } as unknown as Parameters<typeof setSession>[0]);
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "OpenCode Default Model" },
        { open: "Global" },
        { open: "(inherits parent)" },
        {
          expect: {
            active: "OpenCode Default Model",
            activeValue: "(inherits parent)",
            notified: ["OpenCode Default Model inherits parent model"],
            store: (store) =>
              expect(store.defaultModelForHarness("opencode")).toBeNull(),
          },
        },
      ],
      memory.store,
      "opencode inherits parent at global",
    );

    // Null is an answer the file carries, not an absent key.
    expect(memory.writes.at(-1)?.config.agent?.defaultModelByHarness).toEqual({
      opencode: null,
    });
  });

  it("clears a harness default at the picked layer", async () => {
    installStore({
      projectStatus: "loaded",
      global: {
        agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } },
      },
    });
    installOpencode();
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "OpenCode Default Model" },
        { open: "Clear..." },
        { expect: { rows: [["Global", ""]] } },
        { open: "Global" },
        {
          expect: {
            // Without the entry the harness has no default of its own.
            notified: ["OpenCode Default Model cleared (global)"],
            store: (store) =>
              expect(store.defaultModelForHarness("opencode")).toBeNull(),
          },
        },
      ],
      memory.store,
      "clear opencode default",
    );
  });
});

describe("Model Settings — keyboard navigation", () => {
  it("skips the group header above the first listed type and the rule row", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openModelSettings();

    expect(session.activeRow()?.label).toBe("Pi Default Model");

    session.press(KEY.down);
    // The spacer and the group header between them are skipped.
    expect(session.activeRow()?.label).toBe("• auditor");

    session.press(KEY.down);
    expect(session.activeRow()?.label).toBe("Override another type...");

    session.press(KEY.up);
    expect(session.activeRow()?.label).toBe("• auditor");
  });
});

describe("Model Settings — keys reach the focused control", () => {
  /** The openModelSettings path with its own option list (one id carries a vim key). */
  async function openWith(options: string[]): Promise<MenuSession> {
    const session = openMenu(
      (ctx: ExtensionCommandContext) => showAgentsMainMenu(ctx, options),
      100,
    );
    await session.whenScreens(1);
    session.open("Model overrides");
    await session.settle();
    return session;
  }

  it("types a filter letter into the model search instead of moving its cursor", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openWith([...MODEL_OPTIONS, "openai/gpt-4j"]);

    session.focus("• auditor");
    session.press(KEY.enter);
    await session.settle();
    session.open("Session");
    await session.settle();
    expect(session.text()).toContain("gpt-4o");

    session.press(KEY.j);
    await session.settle();

    // The letter filtered the list down to the model whose id carries it, and
    // left the dialog's cursor on that one match.
    expect(session.text()).toContain("gpt-4j");
    expect(session.text()).not.toContain("gpt-4o");
    expect(session.activeRow()?.label).toBe("gpt-4j [openai]");
  });

  it("moves the level picker with j/k", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openModelSettings();

    session.focus("• auditor");
    session.press(KEY.enter);
    await session.settle();

    expect(session.activeRow()?.label).toBe("Session");
    session.press(KEY.j);
    expect(session.activeRow()?.label).toBe("Global");
    session.press(KEY.k);
    expect(session.activeRow()?.label).toBe("Session");
  });
});
