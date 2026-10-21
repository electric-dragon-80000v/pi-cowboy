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
import type { ModelEntry } from "../../src/agents/harness.js";
import type { HarnessModelOptions } from "../../src/agents/harness/harness-registry.js";
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
import { listedModel, reasoningModel, registryOver } from "./models.js";
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
const PI_MODELS = ["anthropic/claude-3", "openai/gpt-4", "openai/gpt-4o"].map(
  (key) => listedModel(key),
);

/** The per-harness structure registration hands the menu; one entry per runnable harness. */
let harnessModelOptions: HarnessModelOptions;

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
    (ctx: ExtensionCommandContext) =>
      showAgentsMainMenu(ctx, harnessModelOptions),
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
  // An unset default holds nothing, so the row renders "(none)".
  setSession({
    cwd: "/repo",
    model: undefined,
    modelRegistry: REGISTRY,
  } as unknown as Parameters<typeof setSession>[0]);
  harnessModelOptions = new Map([["pi", PI_MODELS]]);
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
    ["Pi Default Model", "(none) · inherit"],
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

  it("shows (none) when only the parent has a model", async () => {
    setSession({
      cwd: "/repo",
      model: reasoningModel("anthropic", "claude-3"),
      modelRegistry: REGISTRY,
    } as unknown as Parameters<typeof setSession>[0]);

    const session = await openModelSettings();

    expect(session.activeRow()).toEqual({
      label: "Pi Default Model",
      value: "(none) · inherit",
    });
  });
});

describe("Model Settings — the listing rule", () => {
  const configured = {
    agent: { default: "openai/gpt-4", auditor: "anthropic/claude-3" },
  };

  it("opens on the default rows and reaches the first listed type", async () => {
    installStore({ global: configured });
    const session = await openModelSettings();

    expect(session.activeRow()).toEqual({
      label: "Pi Default Model",
      value: "openai/gpt-4 · inherit",
    });
    expect(session.text()).toContain("anthropic/claude-3");
    expect(session.text()).toContain("• auditor");
    expect(session.text()).toContain(
      "Clear all model and thinking overrides...",
    );

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
      "Clear all model and thinking overrides...",
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

  it("shows the level as configured, never rewritten to the model's list", async () => {
    // "max" is opt-in on this model (gated behind thinkingLevelMap), and the row
    // still shows it: what the launch asks for is the configured level.
    installStore({
      global: {
        agent: { defaultThinking: "max", auditor: "anthropic/claude-3" },
      },
    });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "max",
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
      value: "anthropic/claude-3 [project] · inherit",
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
      value: "openai/gpt-4o [session] · inherit",
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

  it("tags a project-layer thinking override", async () => {
    installStore({
      projectStatus: "loaded",
      global: { agent: { auditor: "anthropic/claude-3" } },
      project: { agent: { thinking: { auditor: "high" } } },
    });

    expect((await openModelSettings()).rows()).toContainEqual({
      label: "• auditor",
      value: "high [project]",
    });
  });

  it("leaves a level untagged when a project null mask names none", async () => {
    // The mask hides the layers below without naming a level, so the cell shows
    // pi's own default and no layer may claim it.
    installStore({
      projectStatus: "loaded",
      global: { agent: { auditor: "anthropic/claude-3" } },
      project: { agent: { thinking: { auditor: null } } },
    });

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
        // The layer comes first: a model and its level are written together.
        {
          expect: {
            rows: [
              ["Session", ""],
              ["Global", ""],
              ["Clear...", ""],
            ],
          },
        },
        { open: "Session" },
        { open: "gpt-4o [openai]" },
        // Picking a model leads straight to the levels it can run at.
        {
          expect: {
            rows: [
              ["Off", ""],
              ["Low", ""],
              ["High", ""],
              ["Inherit", ""],
            ],
          },
        },
        { open: "High" },
        {
          expect: {
            rows: [["• auditor", /high \[session\]/]],
            notified: ["auditor set to openai/gpt-4o · high (session)"],
            store: (store) => {
              expect(store.sessionModelOverride("auditor")).toBe(
                "openai/gpt-4o",
              );
              expect(store.thinkingFor("auditor", undefined, "pi")).toBe(
                "high",
              );
            },
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
            // The clear picker lists only layers carrying either half.
            rows: [["Global", ""]],
            hides: ["Session", "Project", "All levels"],
          },
        },
        { open: "Global" },
        {
          expect: {
            notified: ["auditor cleared (global)"],
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
        // Nothing is written yet, so the layer picker offers no Clear row.
        { expect: { shows: ["Session", "Global"], hides: ["Clear..."] } },
        { open: "Global" },
        { open: "claude-3 [anthropic]" },
        { open: "Low" },
        {
          expect: {
            rows: [["• auditor", "low"]],
            notified: ["auditor set to anthropic/claude-3 · low (global)"],
            store: (store) => {
              expect(store.agentConfigSnapshot().auditor).toBe(
                "anthropic/claude-3",
              );
              expect(store.agentConfigSnapshot().thinking?.auditor).toBe("low");
            },
          },
        },
      ],
      memory.store,
      "override another type",
    );
  });

  it("opens the level list on the level the launch would send", async () => {
    const session = await openModelSettings();
    session.open("Override another type...");
    await session.settle();
    session.open("• auditor");
    await session.settle();
    session.open("Global");
    await session.settle();
    session.open("claude-3 [anthropic]");
    await session.settle();

    // A pi launch applies pi's own default, so the list opens on it rather
    // than on an "inherit" its row never shows.
    expect(session.rows()).toContainEqual({
      label: "Medium",
      value: "(current)",
    });
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
        { open: "Clear all model and thinking overrides..." },
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
            shows: [/Clear all model and thinking overrides at the all/],
          },
        },
        { enter: true },
        {
          expect: {
            notified: ["Model and thinking overrides cleared (all)"],
            store: (store) => {
              expect(store.agentConfigSnapshot().default).toBeNull();
              expect(store.agentConfigSnapshot().auditor).toBeUndefined();
              expect(store.modelSettingsLevels().global).toBe(false);
              expect(store.modelSettingsLevels().project).toBe(false);
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
        { open: "Clear all model and thinking overrides..." },
        { open: "Global" },
        { open: "No" },
        {
          expect: {
            notNotified: ["Model and thinking overrides cleared"],
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
  /** The model keys opencode's own list answered for this machine. */
  const OPENCODE_MODELS = ["anthropic/claude-opus-4", "openai/gpt-4o"].map(
    (key) => listedModel(key),
  );

  /** This machine has opencode, and its list is that harness's own. */
  function installOpencode(): void {
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      ["opencode", OPENCODE_MODELS],
    ]);
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
              ["Pi Default Model", "(none)"],
              ["OpenCode Default Model", "(none)"],
            ],
          },
        },
        { open: "OpenCode Default Model" },
        {
          expect: {
            // No layer carries a pair yet, so there is nothing to clear.
            rows: [
              ["Session", ""],
              ["Global", ""],
              ["Project", ""],
            ],
            hides: ["Clear..."],
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
            // This model advertises no thinking control, so its pair is the
            // model alone and the pick needs no level step.
            active: "OpenCode Default Model",
            activeValue: "openai/gpt-4o · inherit",
            notified: [
              "OpenCode Default Model set to openai/gpt-4o · inherit (global)",
            ],
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
      value: "anthropic/claude-opus-4 [project] · inherit",
    });
  });

  it("removes the pair when (none) is picked", async () => {
    installStore({
      global: {
        agent: { defaultModelByHarness: { opencode: "openai/gpt-4" } },
      },
    });
    installOpencode();
    // A parent model is set, yet the row offers (none): the pick clears the key.
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
        { open: "(none)" },
        {
          expect: {
            // (none) removes the model and the level at the layer: a level has
            // no model of its own to run at.
            active: "OpenCode Default Model",
            activeValue: "(none) · inherit",
            notified: ["OpenCode Default Model cleared (global)"],
            store: (store) =>
              expect(store.defaultModelForHarness("opencode")).toBeNull(),
          },
        },
      ],
      memory.store,
      "opencode (none) pick at global",
    );

    // Removing the harness's only entry prunes the table it lived in.
    expect(
      memory.writes.at(-1)?.config.agent?.defaultModelByHarness,
    ).toBeUndefined();
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

describe("Model Settings — a picker offers only its harness's models", () => {
  const OPENCODE_MODELS = ["anthropic/claude-opus-4", "openai/gpt-4o"].map(
    (key) => listedModel(key),
  );
  const CONFIGURED = {
    agent: {
      default: "openai/gpt-4-configured",
      auditor: "anthropic/claude-3-configured",
    },
  };

  function installOpencode(): void {
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      ["opencode", OPENCODE_MODELS],
    ]);
  }

  it("keeps pi's configured models out of the OpenCode picker", async () => {
    installStore({ global: CONFIGURED });
    installOpencode();
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "OpenCode Default Model" },
        { open: "Global" },
        {
          expect: {
            // Only opencode's own list: neither pi's catalog nor pi's config.
            shows: ["claude-opus-4 [anthropic]", "gpt-4o [openai]"],
            hides: [
              "claude-3 [anthropic]",
              "gpt-4-configured",
              "claude-3-configured",
            ],
          },
        },
      ],
      memory.store,
      "opencode picker excludes pi",
    );
  });

  it("still merges pi's configured models into the Pi Default Model picker", async () => {
    installStore({ global: CONFIGURED });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "Pi Default Model" },
        { open: "Global" },
        {
          expect: {
            shows: [
              "claude-3 [anthropic]",
              "gpt-4o [openai]",
              "gpt-4-configured [openai]",
              "claude-3-configured [anthropic]",
            ],
          },
        },
      ],
      memory.store,
      "pi picker keeps its config",
    );
  });

  it("offers nothing under the OpenCode row when its list is empty", async () => {
    // An empty harness entry is what a failed opencode model fetch leaves behind.
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      ["opencode", []],
    ]);
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "OpenCode Default Model" },
        { open: "Global" },
        {
          expect: {
            shows: ["(none)"],
            hides: [
              "claude-3 [anthropic]",
              "gpt-4 [openai]",
              "gpt-4o [openai]",
            ],
          },
        },
      ],
      memory.store,
      "empty opencode offering",
    );
  });
});

describe("Model Settings — a per-type row follows its resolved harness", () => {
  const OPENCODE_MODELS = ["anthropic/claude-opus-4", "openai/gpt-4o"].map(
    (key) => listedModel(key),
  );

  /** An agent type whose template names opencode. */
  function registerOpencodeType(): void {
    registerAgents(
      new Map([
        [
          "auditor",
          {
            name: "auditor",
            displayName: "Auditor",
            description: "Audits a change",
            systemPrompt: "",
            harnessType: "opencode",
          },
        ],
      ]),
    );
  }

  it("offers opencode's keys when the type resolves to opencode", async () => {
    registerOpencodeType();
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      ["opencode", OPENCODE_MODELS],
    ]);
    installStore({ global: { agent: { auditor: "openai/gpt-4" } } });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "• auditor" },
        { open: "Global" },
        {
          expect: {
            shows: ["claude-opus-4 [anthropic]", "gpt-4o [openai]"],
            hides: ["claude-3 [anthropic]"],
          },
        },
      ],
      memory.store,
      "type resolving to opencode",
    );
  });

  it("shows no level when the harness has no default this screen knows", async () => {
    registerOpencodeType();
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      ["opencode", OPENCODE_MODELS],
    ]);
    // A per-type model override and no thinking anywhere: the launch sends no
    // level, so the row must not report pi's medium for an opencode spawn.
    installStore({ global: { agent: { auditor: "openai/gpt-4o" } } });
    const session = await openModelSettings();

    expect(session.rows()).toContainEqual({
      label: "• auditor",
      value: "inherit",
    });
  });

  it("falls back to pi's keys when opencode cannot launch", async () => {
    registerOpencodeType();
    // The default beforeEach: opencode is unproven, so the type resolves to pi.
    installStore({ global: { agent: { auditor: "openai/gpt-4" } } });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "• auditor" },
        { open: "Global" },
        {
          expect: {
            shows: ["claude-3 [anthropic]", "gpt-4o [openai]"],
            hides: ["claude-opus-4"],
          },
        },
      ],
      memory.store,
      "type falling back to pi",
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
  /** The openModelSettings path with its own pi list (one id carries a vim key). */
  async function openWith(models: readonly ModelEntry[]): Promise<MenuSession> {
    harnessModelOptions = new Map([["pi", models]]);
    const session = openMenu(
      (ctx: ExtensionCommandContext) =>
        showAgentsMainMenu(ctx, harnessModelOptions),
      100,
    );
    await session.whenScreens(1);
    session.open("Model overrides");
    await session.settle();
    return session;
  }

  it("types a filter letter into the model search instead of moving its cursor", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openWith([
      ...PI_MODELS,
      listedModel("openai/gpt-4j"),
    ]);

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

  it("moves the layer picker with j/k", async () => {
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

describe("Model Settings — the default rows write the pair", () => {
  it("writes the pi family's scalar at a file layer and the shared session slot", async () => {
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "Pi Default Model" },
        { open: "Global" },
        { open: "claude-3 [anthropic]" },
        { open: "High" },
        {
          expect: {
            rows: [["Pi Default Model", "anthropic/claude-3 · high"]],
            notified: [
              "Pi Default Model set to anthropic/claude-3 · high (global)",
            ],
            store: (store) => {
              expect(store.agent.defaultModel).toBe("anthropic/claude-3");
              expect(store.agent.defaultThinking).toBe("high");
            },
          },
        },
      ],
      memory.store,
      "pi default pair at global",
    );

    // One scalar, so every pi-family id reads the same answer.
    expect(memory.store.defaultThinkingForHarness("pig")).toBe("high");

    await walk(
      session,
      [
        { open: "Pi Default Model" },
        { open: "Session" },
        // The row may carry the picker's check mark, so it is matched by label.
        { open: /gpt-4o \[openai\]/ },
        { open: "Low" },
        {
          expect: {
            rows: [["Pi Default Model", "openai/gpt-4o · low [session]"]],
            notified: ["Pi Default Model set to openai/gpt-4o · low (session)"],
            store: (store) =>
              expect(store.defaultThinkingForHarness("pi-bolt")).toBe("low"),
          },
        },
        // Inherit unpins the session level and leaves the model in place.
        { open: "Pi Default Model" },
        { open: "Session" },
        { open: /gpt-4o \[openai\]/ },
        { open: "Inherit" },
        {
          expect: {
            rows: [["Pi Default Model", "openai/gpt-4o [session] · high"]],
            notified: [
              "Pi Default Model set to openai/gpt-4o · inherit (session)",
            ],
            store: (store) => {
              expect(store.defaultThinkingForHarness("pig")).toBe("high");
              expect(store.sessionDefaultModel).toBe("openai/gpt-4o");
            },
          },
        },
      ],
      memory.store,
      "pi default pair at session",
    );
  });

  it("gives each harness its own default pair, tagged with its layer", async () => {
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      [
        "opencode",
        [
          listedModel("openai/gpt-4o", {
            kind: "closed",
            levels: ["low", "high"],
          }),
        ],
      ],
    ]);
    installStore({
      projectStatus: "loaded",
      project: {},
      global: { agent: { defaultThinkingByHarness: { opencode: "low" } } },
    });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { expect: { rows: [["OpenCode Default Model", "(none) · low"]] } },
        { open: "OpenCode Default Model" },
        { open: "Project" },
        { open: "gpt-4o [openai]" },
        { open: "High" },
        {
          expect: {
            rows: [
              ["OpenCode Default Model", "openai/gpt-4o · high [project]"],
            ],
            notified: [
              "OpenCode Default Model set to openai/gpt-4o · high (project)",
            ],
            store: (store) => {
              expect(store.defaultModelForHarness("opencode")).toBe(
                "openai/gpt-4o",
              );
              expect(store.defaultThinkingForHarness("opencode")).toBe("high");
            },
          },
        },
      ],
      memory.store,
      "opencode default pair at project",
    );

    expect(memory.lastLayer()).toBe("project");
    expect(
      memory.writes.at(-1)?.config.agent?.defaultThinkingByHarness,
    ).toEqual({
      opencode: "high",
    });
    expect(memory.writes.at(-1)?.config.agent?.defaultModelByHarness).toEqual({
      opencode: "openai/gpt-4o",
    });
  });

  it("drops the level a layer carried when the picked model takes none", async () => {
    // A model with no thinking control is one half of a pair, so picking it
    // asks no level question and removes the token the layer already holds.
    setHarnessAvailability(probed(["pi", "opencode"]));
    harnessModelOptions = new Map([
      ["pi", PI_MODELS],
      ["opencode", [listedModel("openai/gpt-4o")]],
    ]);
    installStore({
      global: { agent: { defaultThinkingByHarness: { opencode: "low" } } },
    });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { open: "OpenCode Default Model" },
        { open: "Global" },
        { open: "gpt-4o [openai]" },
        {
          expect: {
            rows: [["OpenCode Default Model", "openai/gpt-4o · inherit"]],
            notified: [
              "OpenCode Default Model set to openai/gpt-4o · inherit (global)",
            ],
            store: (store) =>
              expect(store.defaultThinkingForHarness("opencode")).toBeNull(),
          },
        },
      ],
      memory.store,
      "opencode model with no control",
    );
  });
});

describe("Model Settings — per-type pairs", () => {
  it("writes a type's pair at the picked layer and tags both values", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { focus: "• auditor" },
        { enter: true },
        { open: "Session" },
        { open: "gpt-4 [openai]" },
        { open: "High" },
        {
          expect: {
            rows: [["• auditor", /high \[session\]/]],
            notified: ["auditor set to openai/gpt-4 · high (session)"],
            store: (store) => {
              expect(store.sessionModelOverride("auditor")).toBe(
                "openai/gpt-4",
              );
              expect(store.thinkingFor("auditor", undefined, "pi")).toBe(
                "high",
              );
              // The session write leaves the config layers untouched.
              expect(
                store.agentConfigSnapshot().thinking?.auditor,
              ).toBeUndefined();
            },
          },
        },
      ],
      memory.store,
      "auditor pair at session",
    );
  });

  it("clears a level at its layer, leaving no null entry behind", async () => {
    installStore({
      global: {
        agent: {
          auditor: "anthropic/claude-3",
          thinking: { auditor: "high" },
        },
      },
    });
    const session = await openModelSettings();

    await walk(
      session,
      [
        { focus: "• auditor" },
        { enter: true },
        { open: "Global" },
        // The current model carries the picker's check mark, so it is matched
        // by its label rather than by the exact rendered row.
        { open: /claude-3 \[anthropic\]/ },
        { open: "Inherit" },
        {
          expect: {
            // Back to the level a launch would send with nothing configured.
            rows: [["• auditor", "medium"]],
            notified: ["auditor set to anthropic/claude-3 · inherit (global)"],
            store: (store) => {
              expect(
                store.agentConfigSnapshot().thinking?.auditor,
              ).toBeUndefined();
              expect(store.thinkingOverrideLevels("auditor").global).toBe(
                false,
              );
            },
          },
        },
      ],
      memory.store,
      "auditor thinking cleared",
    );
  });

  it("lists a type whose only override is thinking, and clears that layer", async () => {
    installStore({ global: { agent: { thinking: { auditor: "high" } } } });
    const session = await openModelSettings();

    expect(session.walkRows().map((row) => row.label)).toContain("• auditor");

    session.open("Override another type...");
    await session.settle();
    expect(session.walkRows().map((row) => row.label)).not.toContain(
      "• auditor",
    );
    session.press(KEY.escape);
    await session.settle();

    await walk(
      session,
      [
        { open: "• auditor" },
        { open: "Clear..." },
        {
          expect: {
            // Only the layer carrying the thinking entry.
            rows: [["Global", ""]],
            hides: ["Session", "Project", "All levels"],
          },
        },
        { open: "Global" },
        {
          expect: {
            notified: ["auditor cleared (global)"],
            store: (store) =>
              expect(
                store.agentConfigSnapshot().thinking?.auditor,
              ).toBeUndefined(),
          },
        },
      ],
      memory.store,
      "thinking-only type clears",
    );
  });

  it("renders the model tag at one column whether or not a thinking tag precedes it", async () => {
    registerAgents(
      new Map([
        ["auditor", { name: "auditor", description: "A", systemPrompt: "" }],
        ["scribe", { name: "scribe", description: "S", systemPrompt: "" }],
      ]),
    );
    installStore({
      projectStatus: "loaded",
      project: {
        agent: {
          auditor: "anthropic/claude-3",
          scribe: "anthropic/claude-3",
        },
      },
      global: { agent: { thinking: { auditor: "high" } } },
    });

    const lines = (await openModelSettings()).frame();
    const tagged = lines.find((line) => line.includes("• auditor"));
    const plain = lines.find((line) => line.includes("• scribe"));

    // The thinking column carries the level; only its model key is tagged.
    expect(tagged).toContain("high");
    expect(plain).toContain("medium");
    // Both rows share a group, so their model tags line up.
    expect(tagged!.indexOf("[project]")).toBe(plain!.indexOf("[project]"));
  });
});
