/**
 * system-prompt.test.ts — mode cycle, three toggles, and the create-file row.
 * src/shell.js is the in-memory store; node:fs stubs only probe + starter-file
 * write (the rest stays real — pi's theme loader reads files at import time).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { customPromptPath } from "../../src/config/config-io.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi } from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { each, walk, type Traversal } from "./walk.js";

const fsSpies = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (actual.default ?? actual) as Record<string, unknown>;
  return { ...actual, default: { ...real, ...fsSpies } };
});

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { showSystemPromptMenu } =
  await import("../../src/ui/menu/menu-system-prompt.js");

let memory: MemoryStore;

function installStore(global: Record<string, unknown> = {}): void {
  memory = createMemoryStore({ projectStatus: "absent", global });
  memory.install();
}

function openSystemPrompt(width = 120): MenuSession {
  return openMenu(
    (ctx: ExtensionCommandContext) => showSystemPromptMenu(ctx),
    width,
  );
}

beforeEach(() => {
  resetShell();
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  fsSpies.existsSync.mockReset().mockReturnValue(false);
  fsSpies.mkdirSync.mockReset();
  fsSpies.writeFileSync.mockReset();
  installStore();
});

describe("System Prompt — structure", () => {
  it("lists the mode and the three implicit-load toggles", () => {
    const session = openSystemPrompt();

    expect(session.title()).toBe("System Prompt");
    expect(session.walkRows()).toEqual([
      { label: "System prompt mode", value: "replace" },
      { label: "Include context files", value: "ON" },
      { label: "Load skills implicitly", value: "ON" },
      { label: "Load extensions implicitly", value: "ON" },
    ]);
    expect(session.text()).not.toContain("Create prompt file");
  });

  it("renders the mode from the store", () => {
    installStore({ agent: { systemPromptMode: "inherit" } });

    expect(openSystemPrompt().activeRow()).toEqual({
      label: "System prompt mode",
      value: "inherit",
    });
  });
});

describe("System Prompt — mode cycling", () => {
  it("cycles replace → inherit → custom, persisting each step", async () => {
    const session = openSystemPrompt();

    await walk(
      session,
      [
        { focus: "System prompt mode" },
        { expect: { activeValue: "replace" } },
        { enter: true },
        {
          expect: {
            activeValue: "inherit",
            notified: ["System prompt mode set to inherit"],
            store: (store) =>
              expect(store.agent.systemPromptMode).toBe("inherit"),
          },
        },
        { enter: true },
        {
          expect: {
            activeValue: "custom",
            notified: ["System prompt mode set to custom"],
            store: (store) =>
              expect(store.agent.systemPromptMode).toBe("custom"),
            rows: [["Create prompt file", customPromptPath()]],
          },
        },
        { enter: true },
        {
          expect: {
            activeValue: "replace",
            hides: ["Create prompt file"],
            store: (store) =>
              expect(store.agent.systemPromptMode).toBe("replace"),
          },
        },
      ],
      memory.store,
      "cycle system prompt mode",
    );

    expect(memory.writes.length).toBeGreaterThan(0);
    expect(memory.writes.every((write) => write.layer === "global")).toBe(true);
  });

  it("omits the create-file row when the prompt file already exists", () => {
    installStore({ agent: { systemPromptMode: "custom" } });
    fsSpies.existsSync.mockReturnValue(true);

    expect(openSystemPrompt().text()).not.toContain("Create prompt file");
  });
});

describe("System Prompt — toggles", () => {
  const toggles = [
    {
      row: "Include context files",
      note: "Include context files set to OFF",
      check: (store: MemoryStore["store"]) =>
        expect(store.agent.includeContextFiles).toBe(false),
    },
    {
      row: "Load skills implicitly",
      note: "Load skills implicitly set to OFF",
      check: (store: MemoryStore["store"]) =>
        expect(store.agent.loadSkillsImplicitly).toBe(false),
    },
    {
      row: "Load extensions implicitly",
      note: "Load extensions implicitly set to OFF",
      check: (store: MemoryStore["store"]) =>
        expect(store.agent.loadExtensionsImplicitly).toBe(false),
    },
  ] as const;

  const cases: Traversal[] = each(toggles, (toggle) => ({
    name: `${toggle.row} off`,
    steps: [
      { focus: toggle.row },
      { expect: { activeValue: "ON" } },
      { enter: true },
      {
        expect: {
          activeValue: "OFF",
          notified: [toggle.note],
          store: toggle.check,
        },
      },
      { enter: true },
      { expect: { activeValue: "ON" } },
    ],
  }));

  it.each(cases)(
    "cycles $name and writes only the global layer",
    async (traversal) => {
      const session = openSystemPrompt();
      await walk(session, traversal.steps, memory.store, traversal.name);

      // The cycle ends back at ON; the per-step assertion pinned OFF.
      expect(memory.store.agent.defaultThinking).not.toBe("changed");
      expect(memory.lastLayer()).toBe("global");
    },
  );
});

describe("System Prompt — create prompt file", () => {
  async function openInCustomMode(): Promise<MenuSession> {
    installStore({ agent: { systemPromptMode: "custom" } });
    return openSystemPrompt();
  }

  it("writes a starter template and announces the path", async () => {
    const session = await openInCustomMode();
    await walk(
      session,
      [
        { open: "Create prompt file" },
        {
          expect: {
            notified: [`Created prompt file: ${customPromptPath()}`],
          },
        },
      ],
      memory.store,
      "create prompt file",
    );

    expect(fsSpies.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("pi-cowboy"),
      { recursive: true },
    );
    expect(fsSpies.writeFileSync).toHaveBeenCalledWith(
      customPromptPath(),
      expect.stringContaining("You are a Pi, an expert coding sub-agent."),
      "utf-8",
    );
  });

  it("reports a write failure instead of throwing", async () => {
    fsSpies.writeFileSync.mockImplementation(() => {
      throw new Error("disk full");
    });
    const session = await openInCustomMode();

    session.open("Create prompt file");
    await session.settle();

    expect(session.notifications.map((n) => n.message)).toContain(
      "Failed to create prompt file: disk full",
    );
    expect(session.notifications.map((n) => n.kind)).toContain("error");
  });
});

describe("System Prompt — keyboard navigation", () => {
  it("wraps from the last row back to the first with Down", () => {
    const session = openSystemPrompt();
    session.focus("Load extensions implicitly");

    session.press(KEY.down);
    expect(session.activeRow()?.label).toBe("System prompt mode");
  });

  it("cancels the menu on Esc", async () => {
    const session = openSystemPrompt();
    session.press(KEY.escape);
    await session.settle();

    expect(await session.finished).toBeUndefined();
  });
});
