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
import type { ThinkingLevel } from "../../src/types.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi, setSession } from "./shell-mock.js";
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
    expect(session.text()).toContain("Global default model");
    expect(session.text()).not.toContain("Agent model");
    expect(session.text()).toContain("Override another type...");
    // Nothing to clear: no layer carries a model setting.
    expect(session.text()).not.toContain("Clear all model overrides...");
  });

  const rowTable = [
    ["Global default model", "(no model)"],
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
      label: "Global default model",
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
      label: "Global default model",
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
      "Global default model",
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
      label: "Global default model",
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
      label: "Global default model",
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

describe("Model Settings — keyboard navigation", () => {
  it("skips the group header above the first listed type and the rule row", async () => {
    installStore({ global: { agent: { auditor: "anthropic/claude-3" } } });
    const session = await openModelSettings();

    expect(session.activeRow()?.label).toBe("Global default model");

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
