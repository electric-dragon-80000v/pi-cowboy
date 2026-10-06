/**
 * concurrency.test.ts — Concurrency Settings menu via its entry point and render/handleInput.
 * Parameterized by expandTree (one leaf per layer) and each (one case per row).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi } from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import {
  each,
  expandTree,
  walk,
  type Branch,
  type Expect,
  type Traversal,
} from "./walk.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { showConcurrencySettingsMenu } =
  await import("../../src/ui/menu/menu-concurrency.js");

const MODEL_OPTIONS = ["anthropic/claude-3", "openai/gpt-4"];

function openConcurrency(width = 80): MenuSession {
  return openMenu(
    (ctx: ExtensionCommandContext) =>
      showConcurrencySettingsMenu(ctx, MODEL_OPTIONS),
    width,
  );
}

let memory: MemoryStore;

beforeEach(() => {
  resetShell();
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  memory = createMemoryStore({ projectStatus: "absent" });
  memory.install();
});

interface LayerCase {
  layer: "Session" | "Global" | "Project";
  /** Persisted layer, or null when not persisted. */
  persisted: "global" | "project" | null;
  /** Provenance tag once this layer wins. */
  tag: string | null;
  effective: number;
}

const LAYER_CASES: LayerCase[] = [
  { layer: "Session", persisted: null, tag: "7 [session]", effective: 7 },
  { layer: "Global", persisted: "global", tag: null, effective: 7 },
  { layer: "Project", persisted: "project", tag: "7 [project]", effective: 7 },
];

function storeFor(c: LayerCase) {
  return (store: MemoryStore["store"]): void => {
    expect(store.concurrency.default).toBe(c.effective);
    if (c.layer === "Session") {
      expect(store.sessionConcurrency.default).toBe(c.effective);
    } else if (c.layer === "Global") {
      expect(store.globalConcurrency.default).toBe(c.effective);
    } else {
      expect(store.projectConcurrency.default).toBe(c.effective);
    }
  };
}

function leafExpectation(c: LayerCase): Expect {
  return {
    active: "Default concurrency limit",
    activeValue: c.tag ?? String(c.effective),
    store: storeFor(c),
    notified: [
      `Default concurrency set to ${c.effective} (${c.layer.toLowerCase()})`,
    ],
  };
}

/** Shared set-limit prefix, one continuation per layer. */
const setLimitTree: Branch = {
  name: "set default limit to 7",
  steps: [{ open: "Default concurrency limit" }],
  branches: LAYER_CASES.map((c) => ({
    name: c.layer,
    steps: [
      { open: c.layer },
      { expect: { noActiveRow: true, shows: ["Concurrency Settings"] } },
      { fill: "7" },
      {
        expect: {
          store: (store) => expect(store.concurrency.default).toBe(4),
        },
      },
      { enter: true },
      { expect: leafExpectation(c) },
    ],
  })),
};

describe("Concurrency Settings — structure", () => {
  it("lists the default limit and hides clear-all on a fresh config", () => {
    const session = openConcurrency();

    expect(session.title()).toBe("Concurrency Settings");
    expect(session.text()).toContain("Per-provider limits");
    expect(session.text()).toContain("Add per-provider limit...");
    expect(session.text()).toContain("Per-model limits");
    expect(session.text()).toContain("Add per-model limit...");
    expect(session.text()).not.toContain("Clear all concurrency limits...");
  });

  it("discovers every row reachable downward from the cursor", () => {
    const session = openConcurrency();
    const rows = session.walkRows();
    const labels = rows.map((row) => row.label);

    expect(labels).toEqual([
      "Default concurrency limit",
      "Add per-provider limit...",
      "Add per-model limit...",
    ]);
    // Separator rows never take the cursor, so every discovered label is a real row.
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
  });

  it("renders the configured default with its effective value", () => {
    const session = openConcurrency();
    expect(session.activeRow()).toEqual({
      label: "Default concurrency limit",
      value: "4",
    });
  });

  it("reveals the clear-all row once a layer carries a limit", () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { concurrency: { default: 9 } },
    });
    memory.install();

    const session = openConcurrency();
    const rows = session.walkRows();

    expect(rows).toContainEqual({
      label: "Default concurrency limit",
      value: "9",
    });
    expect(rows.map((row) => row.label)).toContain(
      "Clear all concurrency limits...",
    );
  });

  it("renders per-provider and per-model limits from the store", () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: {
        concurrency: {
          providers: { anthropic: 3 },
          models: { "anthropic/claude-3": 2 },
        },
      },
    });
    memory.install();

    const session = openConcurrency();
    const rows = session.rows();

    expect(rows).toContainEqual({ label: "anthropic", value: "3 slots" });
    expect(rows).toContainEqual({
      label: "anthropic/claude-3",
      value: "2 slots",
    });
  });

  it("tags a per-provider limit that comes from the session layer", () => {
    const session = openConcurrency();
    memory.store.mutate.concurrency.setProvider("anthropic", 5, "session");
    const rebuilt = openConcurrency();
    void session;

    expect(rebuilt.rows()).toContainEqual({
      label: "anthropic",
      value: "5 slots [session]",
    });
  });
});

describe("Concurrency Settings — setting a limit per layer", () => {
  const limitCases = expandTree(setLimitTree).map((traversal) => {
    const leaf = traversal.path[traversal.path.length - 1];
    const layer = LAYER_CASES.find((entry) => entry.layer === leaf);
    if (!layer) throw new Error(`unmapped layer case: ${traversal.name}`);
    return { traversal, layer };
  });

  it.each(limitCases)(
    "$traversal.name is written to the right layer",
    async ({ traversal, layer }) => {
      const session = openConcurrency();
      await walk(session, traversal.steps, memory.store, traversal.name);

      if (layer.persisted === null) {
        expect(memory.writes).toHaveLength(0);
      } else {
        expect(memory.lastLayer()).toBe(layer.persisted);
      }
    },
  );
});

describe("Concurrency Settings — layer picker availability", () => {
  const pickerRows = ["Session", "Global", "Project"] as const;

  it("offers Session and Global but no Project for an untrusted project", () => {
    memory = createMemoryStore({ projectStatus: "untrusted" });
    memory.install();

    const session = openConcurrency();
    session.open("Default concurrency limit");

    expect(session.text()).toContain("Session");
    expect(session.text()).toContain("Global");
    expect(session.text()).not.toContain("Project");
  });

  it("offers Project when the project target is available", () => {
    const session = openConcurrency();
    session.open("Default concurrency limit");

    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toEqual([...pickerRows]);
  });

  it("explains each layer's persistence as it is focused", () => {
    const session = openConcurrency();
    session.open("Default concurrency limit");

    expect(session.activeRow()?.label).toBe("Session");
    expect(session.text()).toContain("Not saved");

    session.focus("Global");
    expect(session.text()).toContain("Saves to the global config file");

    session.focus("Project");
    expect(session.text()).toContain("Saves to the project config file");
  });
});

describe("Concurrency Settings — clearing", () => {
  it("clears the default limit at the picked layer", async () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { concurrency: { default: 9 } },
    });
    memory.install();

    const session = openConcurrency();
    await walk(
      session,
      [
        { open: "Default concurrency limit" },
        { open: "Clear..." },
        {
          expect: {
            shows: ["Removes from the global config file"],
          },
        },
        { open: "Global" },
        {
          expect: {
            store: (store) =>
              expect(store.globalConcurrency.default).toBeUndefined(),
            notified: ["Removed default concurrency limit (global)"],
          },
        },
      ],
      memory.store,
      "clear default at global",
    );
  });

  it("clears every layer through clear-all after confirmation", async () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { concurrency: { default: 9 } },
    });
    memory.install();

    const session = openConcurrency();
    await walk(
      session,
      [
        { open: "Clear all concurrency limits..." },
        { open: "Global" },
        {
          expect: {
            // Descriptions truncate to the frame width; assert the readable prefix.
            shows: [/Clear all concurrency limits at the global/],
            active: "Yes",
          },
        },
        { enter: true },
        {
          expect: {
            store: (store) =>
              expect(store.globalConcurrency.default).toBeUndefined(),
            notified: ["Concurrency limits cleared (global)"],
          },
        },
      ],
      memory.store,
      "clear all at global",
    );
  });

  it("keeps the configuration when the confirmation is declined", async () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { concurrency: { default: 9 } },
    });
    memory.install();

    const session = openConcurrency();
    await walk(
      session,
      [
        { open: "Clear all concurrency limits..." },
        { open: "Global" },
        { open: "No" },
        {
          expect: {
            store: (store) => expect(store.globalConcurrency.default).toBe(9),
            notNotified: ["Concurrency limits cleared"],
          },
        },
      ],
      memory.store,
      "decline clear all",
    );
  });
});

describe("Concurrency Settings — numeric validation", () => {
  it("rejects a non-numeric limit and keeps the menu open", async () => {
    const session = openConcurrency();
    session.open("Default concurrency limit");
    session.open("Session");
    session.fillField("abc");
    session.press(KEY.enter);
    await session.settle();

    expect(session.notifications.map((note) => note.message)).toContain(
      "Invalid value — must be a number ≥ 1",
    );
    expect(memory.store.sessionConcurrency.default).toBeUndefined();
    expect(session.screenCount).toBe(1);
  });

  it("rejects a limit below the minimum", async () => {
    const session = openConcurrency();
    session.open("Default concurrency limit");
    session.open("Session");
    session.fillField("0");
    session.press(KEY.enter);
    await session.settle();

    expect(session.notifications.map((note) => note.message)).toContain(
      "Invalid value — must be a number ≥ 1",
    );
    expect(memory.store.sessionConcurrency.default).toBeUndefined();
  });

  it("treats an empty submit as no change (closes the field, writes nothing)", async () => {
    const session = openConcurrency();
    session.open("Default concurrency limit");
    session.open("Session");
    session.fillField("");
    session.press(KEY.enter);
    await session.settle();

    // Empty submits nothing: the field closes and the effective default stands.
    expect(session.screenCount).toBe(1);
    expect(session.activeRow()?.label).toBe("Default concurrency limit");
    expect(session.activeRow()?.value).toBe("4");
    expect(memory.writes).toHaveLength(0);
    expect(session.notifications).toHaveLength(0);
  });
});

describe("Concurrency Settings — every fresh row renders", () => {
  const rowTable = [
    ["Default concurrency limit", "4"],
    ["Add per-provider limit...", ""],
    ["Add per-model limit...", ""],
  ] as const;

  const cases: Traversal[] = each(rowTable, ([label, value]) => ({
    name: `row ${label}`,
    steps: [{ expect: { rows: [[label, value]] } }],
  }));

  for (const traversal of cases) {
    it(traversal.name, async () => {
      const session = openConcurrency();
      await walk(session, traversal.steps, memory.store, traversal.name);
    });
  }
});

describe("Concurrency Settings — keyboard navigation", () => {
  it("moves the cursor with j/k, skipping separator rows", () => {
    const session = openConcurrency();
    const first = session.activeRow();
    expect(first?.label).toBe("Default concurrency limit");

    session.press(KEY.j);
    expect(session.activeRow()?.label).toBe("Add per-provider limit...");

    session.press(KEY.k);
    expect(session.activeRow()?.label).toBe("Default concurrency limit");
  });

  it("wraps from the first row to the last with Up", () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { concurrency: { default: 9 } },
    });
    memory.install();

    const session = openConcurrency();
    session.press(KEY.up);
    expect(session.activeRow()?.label).toBe("Clear all concurrency limits...");
  });
});

/**
 * KNOWN DEFECTS — it.fails pins them; an unexpected pass signals the fix.
 * The separator-skip override never stores a separator index, so when the
 * last item is a separator the library's wrap branch is unreachable and the
 * cursor sticks on the last real row.
 */
describe("Concurrency Settings — known navigation defects", () => {
  it.fails(
    "wraps from the last row to the first with Down (trailing separator)",
    () => {
      const session = openConcurrency();
      session.focus("Add per-model limit...");
      session.press(KEY.down);

      expect(session.activeRow()?.label).toBe("Default concurrency limit");
    },
  );

  it.fails("never gets stuck on the last row", () => {
    const session = openConcurrency();
    session.focus("Add per-model limit...");

    expect(session.downMoved()).toBe(true);
  });
});
