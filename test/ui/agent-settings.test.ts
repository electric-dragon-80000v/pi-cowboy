/**
 * Characterization suite for the Agent settings menu: row order/values, store writes + layers,
 * and notification wording — driven only through the Component interface.
 *
 * The relocated spawn-defaults rows live in menus.test.ts; this suite pins their absence here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../../src/config/config-store.js";
import { probed, unprobed } from "../../src/availability.js";
import type { HarnessId } from "../../src/agents/harness.js";
import type { WorktreeMaterialization } from "../../src/spawn/worktree-policy.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi, shellState } from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { each, walk, type TraversalInput } from "./walk.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const { showSpawnOptionsMenu } =
  await import("../../src/ui/menu/menu-agent-settings.js");

function openAgentSettings(): MenuSession {
  return openMenu((ctx: ExtensionCommandContext) => showSpawnOptionsMenu(ctx));
}

let memory: MemoryStore;

beforeEach(() => {
  resetShell();
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  memory = createMemoryStore({ projectStatus: "absent" });
  memory.install();
});

/** Row labels in cursor order, starting from the row the cursor opens on. */
function rowLabels(): string[] {
  return openAgentSettings()
    .walkRows()
    .map((row) => row.label);
}

describe("Agent settings — structure", () => {
  it("frames the menu", () => {
    const session = openAgentSettings();

    expect(session.title()).toBe("Agent settings");
  });

  it("shows each section header once its rows scroll into view", () => {
    const session = openAgentSettings();

    session.focus("Default thinking level");
    expect(session.text()).toContain("Spawn defaults");

    session.focus("Worktree materialization");
    expect(session.text()).toContain("Worktrees");

    session.focus("Disable default agents");
    expect(session.text()).toContain("Tools");
  });

  it("no longer lists the relocated spawn-defaults rows", () => {
    const session = openAgentSettings();

    // Relocated rows must not render here (nor keep a duplicate handler).
    expect(session.text()).not.toContain("Default agent type");
    expect(session.text()).not.toContain("Orchestrator");
    expect(session.walkRows().map((row) => row.label)).not.toContain(
      "Default agent type",
    );
  });

  it("discovers every row in cursor order", () => {
    expect(rowLabels()).toEqual([
      // Opens on the first selectable row; the leading header is never visited.
      "Default thinking level",
      "Default harness",
      "Worktree root",
      "Worktree materialization",
      "Worktree checkout",
      "Disable default agents",
    ]);
    expect(rowLabels()).not.toContain("Delivery");
  });

  const rowTable = [
    ["Default thinking level", "inherit"],
    ["Default harness", "pi"],
    ["Worktree root", "(default)"],
    ["Worktree materialization", "copy-on-write"],
    ["Worktree checkout", "clean"],
    ["Disable default agents", "OFF"],
  ] as const;

  for (const traversal of each(rowTable, ([label, value]): TraversalInput => ({
    name: `row ${label}`,
    // Focus scrolls the row into the viewport before it renders.
    steps: [{ focus: label }, { expect: { rows: [[label, value]] } }],
  }))) {
    it(`renders ${traversal.name} with its default value`, async () => {
      const session = openAgentSettings();
      await walk(session, traversal.steps, memory.store, traversal.name);
    });
  }
});

describe("Agent settings — worktree materialization", () => {
  it("offers only checkout, and says why, on a volume that cannot clone", async () => {
    shellState.cowAvailability = probed<WorktreeMaterialization>(["checkout"]);
    const session = openAgentSettings();

    session.focus("Worktree materialization");
    expect(session.activeRow()?.value).toBe("checkout");
    expect(session.text()).toContain("cannot clone");

    // Wraps onto checkout alone: copy-on-write is not reachable.
    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe("checkout");
  });
});

describe("Agent settings — worktree checkout", () => {
  it("sits directly under Worktree materialization", () => {
    const labels = rowLabels();

    expect(labels.indexOf("Worktree checkout")).toBe(
      labels.indexOf("Worktree materialization") + 1,
    );
  });

  it("explains each value in terms of the parent's uncommitted and untracked files", () => {
    const session = openAgentSettings();

    session.focus("Worktree checkout");

    const frame = session.text();
    expect(frame).toContain("uncommitted");
    expect(frame).toContain("untracked files");
  });

  it("shows the configured policy instead of the default", () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { agent: { worktreeCheckoutType: "dirty" } },
    });
    memory.install();

    const session = openAgentSettings();
    session.focus("Worktree checkout");

    expect(session.activeRow()?.value).toBe("dirty");
  });
});

describe("Agent settings — default harness", () => {
  it("sits directly under Default thinking level", () => {
    const labels = rowLabels();

    expect(labels.indexOf("Default harness")).toBe(
      labels.indexOf("Default thinking level") + 1,
    );
  });

  it("shows the configured harness instead of the default", () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { agent: { harnessType: "pig" } },
    });
    memory.install();

    const session = openAgentSettings();
    session.focus("Default harness");

    expect(session.activeRow()?.value).toBe("pig");
  });

  it("offers only the harnesses this machine can launch", async () => {
    shellState.harnessAvailability = probed<HarnessId>(["pi", "pig"]);
    const session = openAgentSettings();

    session.focus("Default harness");
    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe("pig");

    // Wraps past pi: the missing pi-bolt is never reached.
    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe("pi");
  });

  it("offers only pi when the machine has no pi-compatible binary", async () => {
    shellState.harnessAvailability = probed<HarnessId>(["pi"]);
    const session = openAgentSettings();

    session.focus("Default harness");
    session.press(KEY.enter);
    await session.settle();

    expect(session.activeRow()?.value).toBe("pi");
    expect(memory.store.agent.harnessType).toBe("pi");
  });

  it("shows the harness a spawn would use, not one the machine cannot launch", () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { agent: { harnessType: "pig" } },
    });
    memory.install();
    shellState.harnessAvailability = probed<HarnessId>(["pi"]);

    const session = openAgentSettings();
    session.focus("Default harness");

    expect(session.activeRow()?.value).toBe("pi");
  });

  it("names the harnesses it left out, and says nothing about them once they are back", () => {
    shellState.harnessAvailability = probed<HarnessId>(["pi"]);
    const narrowed = openAgentSettings();
    narrowed.focus("Default harness");
    expect(narrowed.text()).toContain("Not on PATH: pig, pi-bolt.");

    shellState.harnessAvailability = unprobed<HarnessId>();
    const everyHarness = openAgentSettings();
    everyHarness.focus("Default harness");
    expect(everyHarness.text()).not.toContain("Not on PATH");
  });
});

describe("Agent settings — toggles", () => {
  const toggles = [
    {
      row: "Worktree materialization",
      first: "copy-on-write",
      second: "checkout",
      note: "Worktree materialization set to checkout",
      check: (store: ConfigStore) =>
        expect(store.agent.worktreeMaterialization).toBe("checkout"),
    },
    {
      row: "Worktree checkout",
      first: "clean",
      second: "dirty",
      note: "Worktree checkout set to dirty",
      check: (store: ConfigStore) =>
        expect(store.agent.worktreeCheckoutType).toBe("dirty"),
    },
    {
      row: "Disable default agents",
      first: "OFF",
      second: "ON",
      note: "Disable default agents ON (takes effect on next session)",
      check: (store: ConfigStore) =>
        expect(store.agent.disableDefaultAgents).toBe(true),
    },
  ] as const;

  it.each(toggles)("$row cycles $first → $second → $first", async (toggle) => {
    const session = openAgentSettings();

    session.focus(toggle.row);
    expect(session.activeRow()?.value).toBe(toggle.first);

    session.press(KEY.enter);
    await session.settle();
    // Toggle rows update in place (no rebuild), so read the frame directly.
    expect(session.activeRow()?.value).toBe(toggle.second);
    expect(session.notifications.map((n) => n.message)).toContain(toggle.note);
    toggle.check(memory.store);
    expect(memory.lastLayer()).toBe("global");

    // A toggle row cycles back to its first value.
    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe(toggle.first);
  });

  it("cycles 'Default harness' through every harness and wraps", async () => {
    const session = openAgentSettings();

    session.focus("Default harness");
    expect(session.activeRow()?.value).toBe("pi");

    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe("pig");
    expect(session.notifications.map((n) => n.message)).toContain(
      "Default harness set to pig",
    );
    expect(memory.store.agent.harnessType).toBe("pig");
    expect(memory.lastLayer()).toBe("global");

    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe("pi-bolt");
    expect(memory.store.agent.harnessType).toBe("pi-bolt");

    session.press(KEY.enter);
    await session.settle();
    expect(session.activeRow()?.value).toBe("pi");
    expect(memory.store.agent.harnessType).toBe("pi");
  });
});

describe("Agent settings — default thinking level", () => {
  it("offers every level plus inherit, at a picked layer", async () => {
    const session = openAgentSettings();
    session.open("Default thinking level");
    expect(session.text()).toContain("Saves to the global config file");

    session.open("Global");
    const labels = session.walkRows().map((row) => row.label);
    expect(labels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "inherit",
    ]);
  });

  it("persists the chosen level and tags the row", async () => {
    const session = openAgentSettings();
    await walk(
      session,
      [
        { open: "Default thinking level" },
        { focus: "Project" },
        {
          expect: {
            active: "Project",
            shows: ["Saves to the project config file"],
          },
        },
        { enter: true },
        { expect: { shows: ["inherit"] } },
        { open: "high" },
        {
          expect: {
            rows: [["Default thinking level", "high [project]"]],
            notified: ["Default thinking level set to high (project)"],
            store: (store) => expect(store.agent.defaultThinking).toBe("high"),
          },
        },
      ],
      memory.store,
      "thinking = high (project)",
    );

    expect(memory.lastLayer()).toBe("project");
  });

  it("maps inherit back to an unset level", async () => {
    memory = createMemoryStore({
      projectStatus: "absent",
      global: { agent: { defaultThinking: "high" } },
    });
    memory.install();

    const session = openAgentSettings();
    await walk(
      session,
      [
        { open: "Default thinking level" },
        { open: "Global" },
        { open: "inherit" },
        {
          expect: {
            rows: [["Default thinking level", "inherit"]],
            notified: ["Default thinking level set to inherit (global)"],
            store: (store) =>
              expect(store.agent.defaultThinking).toBeUndefined(),
          },
        },
      ],
      memory.store,
      "thinking = inherit",
    );

    expect(memory.lastLayer()).toBe("global");
  });
});

describe("Agent settings — worktree root", () => {
  it("sets a root and then clears it back to the default", async () => {
    const session = openAgentSettings();
    await walk(
      session,
      [
        { open: "Worktree root" },
        { expect: { noActiveRow: true } },
        { fill: "/tmp/wt-root" },
        { enter: true },
        {
          expect: {
            rows: [["Worktree root", "/tmp/wt-root"]],
            notified: ["Worktree root set to /tmp/wt-root"],
            store: (store) =>
              expect(store.agent.worktreeRoot).toBe("/tmp/wt-root"),
          },
        },
        { open: "Worktree root" },
        { fill: "" },
        { enter: true },
        {
          expect: {
            rows: [["Worktree root", "(default)"]],
            notified: ["Worktree root cleared (default)"],
            store: (store) => expect(store.agent.worktreeRoot).toBeUndefined(),
          },
        },
      ],
      memory.store,
      "worktree root set then cleared",
    );

    expect(memory.lastLayer()).toBe("global");
  });

  it("asks the new root whether it can clone, because the old answer described another volume", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-root-probe-"));
    const execCalls: string[][] = [];
    setPi({
      exec: async (cmd: string, args: string[]) => {
        execCalls.push([cmd, ...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    try {
      await walk(
        openAgentSettings(),
        [{ open: "Worktree root" }, { fill: root }, { enter: true }],
        memory.store,
        "worktree root re-probes its volume",
      );

      await vi.waitFor(() =>
        expect(shellState.cowAvailability).toEqual(
          probed<WorktreeMaterialization>(["copy-on-write", "checkout"]),
        ),
      );
      expect(execCalls.flat().join(" ")).toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Agent settings — keyboard navigation", () => {
  it("moves with j/k and skips group headers", () => {
    const session = openAgentSettings();
    session.focus("Default thinking level");

    session.press(KEY.j);
    expect(session.activeRow()?.label).toBe("Default harness");

    session.press(KEY.k);
    expect(session.activeRow()?.label).toBe("Default thinking level");
  });

  it("opens on the first selectable row, not on a group header", () => {
    const session = openAgentSettings();

    expect(session.activeRow()?.label).toBe("Default thinking level");
  });

  it("keeps the cursor on the first selectable row when Up is pressed there", () => {
    const session = openAgentSettings();
    session.focus("Default thinking level");

    session.press(KEY.up);
    // The leading header blocks the wrap (Up targets index 0, a separator); the defect is pinned below.
    expect(session.activeRow()?.label).toBe("Default thinking level");
  });

  it("wraps from the last row to the first selectable row with Down", () => {
    const session = openAgentSettings();
    session.focus("Disable default agents");

    session.press(KEY.down);
    // The last row is real, so the wrap branch is reachable.
    expect(session.activeRow()?.label).toBe("Default thinking level");
  });

  it("opens the row's value editor on Space", async () => {
    const session = openAgentSettings();
    session.focus("Default thinking level");
    session.press(KEY.space);
    await session.settle();

    // Space opens the layer picker on its first row.
    expect(session.activeRow()?.label).toBe("Global");
    expect(session.text()).toContain("Saves to the global config file");
  });
});

describe("Agent settings — keys reach the focused control", () => {
  it("types j and k into a text-field row as letters", async () => {
    const session = openAgentSettings();
    await walk(
      session,
      [
        { open: "Worktree root" },
        { fill: "/tmp/jk-root" },
        { enter: true },
        {
          expect: {
            rows: [["Worktree root", "/tmp/jk-root"]],
            store: (store) =>
              expect(store.agent.worktreeRoot).toBe("/tmp/jk-root"),
          },
        },
      ],
      memory.store,
      "worktree root with j/k",
    );
  });

  it("moves a picker submenu's list with j/k", async () => {
    const session = openAgentSettings();
    session.open("Default thinking level");
    await session.settle();
    session.press(KEY.enter);
    await session.settle();

    expect(session.activeRow()?.label).toBe("off");
    session.press(KEY.j);
    expect(session.activeRow()?.label).toBe("minimal");
    session.press(KEY.k);
    expect(session.activeRow()?.label).toBe("off");
  });
});

/**
 * KNOWN DEFECT — Up from the first selectable row cannot wrap to the last (Up only targets
 * index 0, a separator). `it.fails` pins it: an unexpected pass is the signal to promote it.
 */
describe("Agent settings — known head-wrap defect", () => {
  it.fails("wraps from the first selectable row to the last with Up", () => {
    const session = openAgentSettings();
    session.focus("Default thinking level");
    session.press(KEY.up);

    expect(session.activeRow()?.label).toBe("Disable default agents");
  });
});
