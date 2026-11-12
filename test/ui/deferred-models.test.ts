/**
 * deferred-models.test.ts — the model pickers' deferred harness list.
 *
 * A slow harness no longer holds a screen open: the override and spawn screens
 * build from the lists already settled, and the harness's own list is awaited
 * only after a layer has been picked. The cases pin that order on both flows.
 *
 * Mocked boundaries: src/shell.js (store, session, and the model catalog) and
 * src/pi-settings.js (pi's default thinking level).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../../src/agents/agent-types.js";
import type { ModelEntry, ModelList } from "../../src/agents/harness.js";
import type { HarnessModelOptions } from "../../src/agents/harness/harness-registry.js";
import { probed } from "../../src/availability.js";
import { openMenu, type MenuSession } from "./harness.js";
import {
  resetShell,
  setHarnessAvailability,
  setPi,
  setSession,
  shellState,
} from "./shell-mock.js";
import { createMemoryStore } from "./store.js";
import { listedModel, reasoningModel, registryOver } from "./models.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const piSettings = vi.hoisted(() => ({ thinking: undefined as unknown }));
vi.mock("../../src/pi-settings.js", () => ({
  getPiDefaultThinkingLevel: async () => piSettings.thinking,
}));

const { showAgentsMainMenu } = await import("../../src/ui/menu/menus.js");

/** The lists a screen opened with: pi's, and nothing for opencode yet. */
const SETTLED: HarnessModelOptions = new Map([
  ["pi", ["anthropic/claude-3", "openai/gpt-4"].map((key) => listedModel(key))],
]);

const OPENCODE_MODELS: readonly ModelEntry[] = [
  {
    key: "anthropic/claude-opus-4",
    label: "claude-opus-4",
    thinkingLevels: { kind: "advisory", levels: [] },
  },
];

/** A list the test releases when it chooses. */
function deferredList(): {
  list: Promise<ModelList>;
  resolve: (value: ModelList) => void;
} {
  let resolve: (value: ModelList) => void = () => {};
  const list = new Promise<ModelList>((done) => {
    resolve = done;
  });
  return { list, resolve };
}

const REGISTRY = registryOver([
  reasoningModel("anthropic", "claude-3"),
  reasoningModel("openai", "gpt-4"),
]);

beforeEach(() => {
  resetShell();
  setHarnessAvailability(probed(["pi", "opencode"]));
  piSettings.thinking = undefined;
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  createMemoryStore({
    projectStatus: "absent",
    global: {},
    project: null,
  }).install();
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
    modelRegistry: REGISTRY,
  } as unknown as Parameters<typeof setSession>[0]);
});

describe("Model overrides — a foreign harness's list is deferred", () => {
  /** The topmost menu, then the model screen hosting the harness rows. */
  async function toModelScreen(): Promise<MenuSession> {
    const session = openMenu(
      (ctx: ExtensionCommandContext) => showAgentsMainMenu(ctx, SETTLED),
      100,
    );
    await session.whenScreens(1);
    session.open("Model overrides");
    await session.settle();
    return session;
  }

  it("lists the harness without waiting for its models", async () => {
    const slow = deferredList();
    shellState.harnessModelLists.set("opencode", slow.list);

    const session = await toModelScreen();

    // The screen is built and readable while opencode's list is still in flight.
    expect(session.text()).toContain("OpenCode Default Model");
    expect(session.text()).not.toContain("Loading models");
  });

  it("awaits the list only once the layer is picked", async () => {
    const slow = deferredList();
    shellState.harnessModelLists.set("opencode", slow.list);
    const session = await toModelScreen();

    session.open("OpenCode Default Model");
    await session.settle();
    // The layer picker is immediate: no list is needed to choose a layer.
    expect(session.text()).not.toContain("Loading models");
    session.open("Session");
    await session.settle();

    expect(session.text()).toContain("Loading models");

    slow.resolve({ kind: "listed", entries: OPENCODE_MODELS });
    await session.settle();

    expect(session.text()).toContain("claude-opus-4");
  });

  it("says why when the harness cannot list its models", async () => {
    const slow = deferredList();
    shellState.harnessModelLists.set("opencode", slow.list);
    const session = await toModelScreen();

    session.open("OpenCode Default Model");
    await session.settle();
    session.open("Session");
    await session.settle();
    slow.resolve({
      kind: "unavailable",
      notice: "Could not list the OpenCode models (boom).",
    });
    await session.settle();

    expect(
      session.notifications.map((notification) => notification.message),
    ).toContain("Could not list the OpenCode models (boom).");
  });
});
