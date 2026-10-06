/**
 * indicator.test.ts — the extension's presence marker: 🤠 on his own row in the
 * screen's top-right corner, standing over a green pasture. The pasture is the
 * smallest square that can hold twice its stock, so half of it is always empty:
 * one 🐄 per live agent, one 💩 per agent that has ended and waits to be
 * cleaned up. The cows are placed in it at random and take one step per tick
 * while grazing is on; a dropping stays where it fell. Cowboy and pasture are
 * mounted as two non-capturing overlays while the extension is on and taken down
 * through their handles while it is off. The cowboy holds his own two columns
 * with no padding around him and is shifted left over the pasture's middle
 * column by an overlay offset, while the pasture reports its own width, so
 * neither overlay covers a cell it does not draw. The component re-counts the
 * fleet itself, on a timer, so that it stays current without anything having to
 * tell it a run ended. The pasture is drawn only while the grazing setting is
 * on: with it off the cowboy stands alone and that timer is stopped, so nothing
 * is counted, drawn, stepped, or repainted until the setting changes.
 * src/shell.js is mocked so the mounted marker reads its setting from a store
 * the test installs.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  AGENT_MARKER,
  DROPPING,
  grazedPasture,
  greenBackground,
  GRASS_RGB,
  hideExtensionIndicator,
  INDICATOR_MARKER,
  MIN_PASTURE_EDGE,
  moveHerd,
  pastureEdge,
  PresenceMarker,
  reconcilePasture,
  showExtensionIndicator,
  type AgentCounts,
  type BackgroundColor,
  type Pasture,
  type PastureCell,
  type PastureStock,
  type Random,
} from "../../src/ui/indicator.js";
import type { AgentSpawn } from "../../src/types.js";
import {
  recordOverlayMount,
  type OverlayCallOptions,
  type OverlayMount,
  type OverlayStubTheme,
} from "../helpers/overlay-mounts.js";
import {
  getAgentSpawns,
  getIndicatorMarker,
  resetShell,
} from "./shell-mock.js";
import { createMemoryStore } from "./store.js";

// The mounted marker reads the grazing setting off the shell's store.
vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

/** A rendered frame's width, which the marker ignores: the overlay sizes it. */
const TERMINAL_WIDTH = 80;

/** The grass the plain-text blocks below are read through: no colour at all. */
const plainGrass: BackgroundColor = (text) => text;

/** A random source that hands out the pasture's first cells in reading order. */
const inOrder: Random = () => 0;

/** A random source that hands out `values` in call order, one per call. */
function sequence(...values: number[]): Random {
  let at = 0;
  return () => {
    if (at >= values.length) throw new Error("the random source ran out");
    const value = values[at];
    at += 1;
    return value;
  };
}

/** A deterministic pseudo-random source, so a long run of placements is reproducible. */
function seeded(seed = 1): Random {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** A pasture written as rows: `C` is a cow, `D` a dropping, `.` an empty cell. */
function pasture(...rows: string[]): Pasture {
  const alphabet: Record<string, PastureCell> = {
    C: "cow",
    D: "dropping",
    ".": "empty",
  };
  return rows.map((row) => row.split("").map((cell) => alphabet[cell]!));
}

/** The pasture written back as rows, so a test can read what stands where. */
function layout(drawn: Pasture): string[] {
  return drawn.map((row) =>
    row
      .map((cell) => (cell === "cow" ? "C" : cell === "dropping" ? "D" : "."))
      .join(""),
  );
}

/**
 * A drawn block written out in a template, one row per line, with the
 * template's own indentation stripped and any colour taken back off. Trailing
 * padding is dropped — an empty cell at the end of a pasture row prints as
 * spaces — and the template's opening blank line and closing indent are not
 * rows.
 */
function block(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => stripTerminalSequences(line).trimEnd());
  const body = lines.slice(1, -1);
  const indent = Math.min(
    ...body
      .filter((line) => line !== "")
      .map((line) => line.length - line.trimStart().length),
  );
  return body.map((line) => (line === "" ? "" : line.slice(indent)));
}

/** A rendered block the way `block` reads an expected one: colour and padding off. */
function rendered(rows: string[]): string[] {
  return rows.map((row) => stripTerminalSequences(row).trimEnd());
}

/**
 * The cells the marker is drawing, each read at the shared cell width. A
 * dropping prints as wide as a cow, so slicing a row into two-column cells
 * lines the two kinds up.
 */
function drawnCells(marker: PresenceMarker): PastureCell[] {
  return marker.pastureRows().flatMap((drawn) => {
    const row = stripTerminalSequences(drawn);
    const cells: PastureCell[] = [];
    for (let at = 0; at < row.length; at += 2) {
      const cell = row.slice(at, at + 2);
      cells.push(
        cell === AGENT_MARKER
          ? "cow"
          : cell === DROPPING
            ? "dropping"
            : "empty",
      );
    }
    return cells;
  });
}

/** How many of `kind` the marker is drawing across the whole pasture. */
function markerCells(marker: PresenceMarker, kind: PastureCell): number {
  return drawnCells(marker).filter((cell) => cell === kind).length;
}

/** A fleet the marker can read: `live` grazers and `ended` droppings, each a number or a getter. */
function fleet(
  live: number | (() => number),
  ended: number | (() => number) = 0,
): () => AgentCounts {
  return () => ({
    live: typeof live === "function" ? live() : live,
    ended: typeof ended === "function" ? ended() : ended,
  });
}

/**
 * A marker over a fleet, with every render request recorded. The herd lands in
 * reading order, the pasture is left uncoloured, and grazing is left on, unless
 * a test hands it other sources.
 */
function markerOver(
  counts: () => AgentCounts,
  random: Random = inOrder,
  grass: BackgroundColor = plainGrass,
  isGrazing: () => boolean = () => true,
): { marker: PresenceMarker; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  const tui = { requestRender } as unknown as TUI;
  const marker = new PresenceMarker(tui, counts, isGrazing, grass, random);
  onTestFinished(() => marker.dispose());
  return { marker, requestRender };
}

/** The ui the marker writes into: every custom() call, in order. */
function fakeUi(): { ui: ExtensionUIContext; mounts: OverlayMount[] } {
  const mounts: OverlayMount[] = [];
  const ui = {
    custom: (
      factory: (tui: TUI, theme: OverlayStubTheme) => Component,
      options?: OverlayCallOptions,
    ) => {
      mounts.push(recordOverlayMount(factory, options));
      return Promise.resolve(undefined);
    },
  } as unknown as ExtensionUIContext;
  return { ui, mounts };
}

/** A mount's static overlay options, whose getters are read per frame. */
function optionsOf(mount: OverlayMount): OverlayOptions {
  const options = mount.options?.overlayOptions;
  if (typeof options === "function" || options === undefined) {
    throw new Error("the marker mounted without static overlay options");
  }
  return options;
}

/** A stand-in overlay handle that records whether it was taken down. */
function handleRecorder(): { handle: OverlayHandle; hidden(): boolean } {
  let hidden = false;
  return {
    handle: {
      hide: () => {
        hidden = true;
      },
    } as unknown as OverlayHandle,
    hidden: () => hidden,
  };
}

/** A spawned agent of the given phase: only its phase is ever read here. */
function spawnAgent(id: string, phase: "queued" | "spawned" | "settled"): void {
  const spawns = getAgentSpawns();
  const spawn = {
    id,
    lifecycle: { phase, startedAt: Date.now() },
  } as unknown as AgentSpawn;
  spawns.add(spawn);
  onTestFinished(() => spawns.drop(id));
}

/** A spawned agent that is executing: one cow in the pasture. */
function spawnSpawnedPhase(id: string): void {
  spawnAgent(id, "spawned");
}

/** Install a store whose grazing setting is `grazing`. */
function installStore(grazing: boolean): void {
  createMemoryStore({
    global: { agent: { grazingEnabled: grazing } },
  }).install();
}

beforeEach(() => {
  // The previous test's marker is disposed through the shell it was mounted in,
  // which is also what ends its poll.
  hideExtensionIndicator();
  resetShell();
  // Grazing on: the drawing tests inject the setting themselves, and the
  // mounted marker reads this store. The setting being off has its own tests.
  installStore(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pastureEdge", () => {
  it.each([
    [0, 0],
    [1, MIN_PASTURE_EDGE],
    [2, MIN_PASTURE_EDGE],
    [3, 3],
    [4, 3],
    [5, 4],
    [8, 4],
    [9, 5],
  ])("gives %i occupants an edge of %i", (occupants, edge) => {
    expect(pastureEdge(occupants)).toBe(edge);
  });

  it("never crowds the stock past half its cells", () => {
    const crowded: number[] = [];
    for (let occupants = 1; occupants <= 250; occupants += 1) {
      const edge = pastureEdge(occupants);
      if (edge < MIN_PASTURE_EDGE || edge * edge < 2 * occupants) {
        crowded.push(occupants);
      }
    }
    expect(crowded).toEqual([]);
  });

  it("never makes the square bigger than the stock needs", () => {
    const roomy: number[] = [];
    for (let occupants = 1; occupants <= 250; occupants += 1) {
      const edge = pastureEdge(occupants);
      const smaller = edge - 1;
      if (smaller >= MIN_PASTURE_EDGE && smaller * smaller >= 2 * occupants) {
        roomy.push(occupants);
      }
    }
    expect(roomy).toEqual([]);
  });
});

describe("grazedPasture", () => {
  it("draws one square for the stock and leaves the rest empty", () => {
    expect(grazedPasture({ cows: 3, droppings: 0 }, inOrder)).toEqual([
      ["cow", "cow", "cow"],
      ["empty", "empty", "empty"],
      ["empty", "empty", "empty"],
    ]);
  });

  it("places a cow in the cell the random source picks", () => {
    // Halfway through the four cells takes the third slot, the second row.
    expect(grazedPasture({ cows: 1, droppings: 0 }, () => 0.5)).toEqual([
      ["empty", "empty"],
      ["cow", "empty"],
    ]);
  });

  it("gives no stock no pasture", () => {
    expect(grazedPasture({ cows: 0, droppings: 0 }, inOrder)).toEqual([]);
  });

  it("never puts an occupant in the same cell twice", () => {
    const drawn = grazedPasture({ cows: 5, droppings: 3 }, () => 0.37);
    const cells = drawn.flat();

    expect(cells.filter((cell) => cell !== "empty")).toHaveLength(8);
    expect(cells.filter((cell) => cell === "cow")).toHaveLength(5);
    expect(cells.filter((cell) => cell === "dropping")).toHaveLength(3);
  });

  it("draws a dropping as wide as a cow, so a row never skews", () => {
    expect(visibleWidth(DROPPING)).toBe(visibleWidth(AGENT_MARKER));
  });
});

describe("moveHerd", () => {
  it("leaves the herd where it stands when the turn rolls no step", () => {
    const standing = pasture("CC", "..");

    // A roll of one twentieth or over is a turn spent grazing.
    expect(layout(moveHerd(standing, () => 0.05))).toEqual(["CC", ".."]);
  });

  it("steps the cow the roll picks to the neighbour the roll picks", () => {
    // The step is rolled under one twentieth; the second cow steps down, away
    // from the first.
    expect(
      layout(moveHerd(pasture("CC", ".."), sequence(0.04, 0.9, 0))),
    ).toEqual(["C.", ".C"]);
  });

  it("picks its cow from the cows with somewhere to go", () => {
    // (0,0) and (0,1) are boxed in by the herd; the first cow the turn can
    // pick is (0,2), which steps down.
    const crowded = pasture("CCC", "CC.", "...");

    expect(layout(moveHerd(crowded, sequence(0.04, 0, 0)))).toEqual([
      "CC.",
      "CCC",
      "...",
    ]);
  });

  it("moves one cow at most, however many could step", () => {
    const grazing = pasture("C..", "C..", "...");

    // Both cows have room, but only the one the roll picks leaves its cell.
    expect(layout(moveHerd(grazing, sequence(0.04, 0, 0)))).toEqual([
      ".C.",
      "C..",
      "...",
    ]);
  });

  it("never steps a cow onto a dropping", () => {
    // The cow's only empty neighbour is the cell below it; the dropping to its
    // right stays where it fell.
    expect(layout(moveHerd(pasture("CD", ".."), sequence(0.04, 0, 0)))).toEqual(
      [".D", "C."],
    );
  });

  it("treats a cow boxed in by droppings as having nowhere to go", () => {
    const boxed = pasture(".D.", "DCD", ".D.");

    // No empty neighbour means no mover, so the turn rolls nothing at all.
    const random = vi.fn(() => 0);
    expect(layout(moveHerd(boxed, random))).toEqual([".D.", "DCD", ".D."]);
    expect(random).not.toHaveBeenCalled();
  });

  it("leaves a pasture of droppings alone and rolls nothing", () => {
    const random = vi.fn(() => 0);

    expect(layout(moveHerd(pasture("DD", "DD"), random))).toEqual(["DD", "DD"]);
    expect(random).not.toHaveBeenCalled();
  });

  it("leaves a pasture with no cows as it is", () => {
    expect(layout(moveHerd(pasture("..", ".."), () => 0.9))).toEqual([
      "..",
      "..",
    ]);
  });

  it("gives no cows no pasture", () => {
    expect(moveHerd([], () => 0.9)).toEqual([]);
  });
});

describe("reconcilePasture", () => {
  it("reads every cell back the way it was written", () => {
    const written = pasture("CD.", ".DC", "C.D");

    expect(layout(written)).toEqual(["CD.", ".DC", "C.D"]);
  });

  it("places fresh stock the same way grazedPasture does", () => {
    expect(reconcilePasture(null, { cows: 1, droppings: 1 }, inOrder)).toEqual(
      grazedPasture({ cows: 1, droppings: 1 }, inOrder),
    );
  });

  it("turns a settling agent's cow into a dropping in its own cell, for no roll", () => {
    const random = vi.fn(() => 0);
    const settled = reconcilePasture(
      pasture("CCC", "...", "..."),
      { cows: 2, droppings: 1 },
      random,
    );

    // The last cow in reading order becomes the dropping; the other two hold.
    expect(layout(settled)).toEqual(["CCD", "...", "..."]);
    expect(random).not.toHaveBeenCalled();
  });

  it("clears a cleaned-up agent's dropping for no roll", () => {
    const random = vi.fn(() => 0);
    // Four occupants keep the square at 3×3 when the dropping goes, so the
    // removal does not resize it.
    const cleared = reconcilePasture(
      pasture("CCD", "C..", "..."),
      { cows: 3, droppings: 0 },
      random,
    );

    expect(layout(cleared)).toEqual(["CC.", "C..", "..."]);
    expect(random).not.toHaveBeenCalled();
  });

  it("drops a new live agent into a random empty cell", () => {
    // Both picks are the first empty cell in reading order: (0,2), then (1,0).
    const grown = reconcilePasture(
      pasture("CC.", "...", "..."),
      { cows: 4, droppings: 0 },
      inOrder,
    );

    expect(layout(grown)).toEqual(["CCC", "C..", "..."]);
  });

  it("keeps the stock while it grows the square", () => {
    const grown = reconcilePasture(
      pasture("CC", ".."),
      { cows: 2, droppings: 3 },
      inOrder,
    );

    expect(grown).toHaveLength(4);
    expect(layout(grown)).toEqual(["CCDD", "D...", "....", "...."]);
  });

  it("holds the stock while it shrinks the square", () => {
    const shrunk = reconcilePasture(
      pasture("CCCC", "C...", "....", "...."),
      { cows: 2, droppings: 0 },
      inOrder,
    );

    expect(shrunk).toHaveLength(2);
    expect(layout(shrunk)).toEqual(["CC", ".."]);
  });

  it.each([
    { cows: 0, droppings: 0 },
    { cows: 0, droppings: 5 },
    { cows: 5, droppings: 0 },
    { cows: 40, droppings: 40 },
  ])(
    "places $cows cows and $droppings droppings, each in its own cell",
    (stock) => {
      const cells = reconcilePasture(null, stock, seeded()).flat();

      expect(cells.filter((cell) => cell === "cow")).toHaveLength(stock.cows);
      expect(cells.filter((cell) => cell === "dropping")).toHaveLength(
        stock.droppings,
      );
    },
  );

  it("holds one cow per live agent and one dropping per settled one across a run of counts", () => {
    const steps: PastureStock[] = [
      { cows: 0, droppings: 0 },
      { cows: 0, droppings: 3 },
      { cows: 5, droppings: 3 },
      { cows: 5, droppings: 0 },
      { cows: 12, droppings: 7 },
      { cows: 1, droppings: 1 },
      { cows: 0, droppings: 1 },
      { cows: 1, droppings: 0 },
      { cows: 40, droppings: 40 },
    ];
    const random = seeded();
    let herd: Pasture | null = null;
    const seen: { cows: number; droppings: number; edge: number }[] = [];

    for (const stock of steps) {
      herd = reconcilePasture(herd, stock, random);
      const cells = herd.flat();
      seen.push({
        cows: cells.filter((cell) => cell === "cow").length,
        droppings: cells.filter((cell) => cell === "dropping").length,
        edge: herd.length,
      });
    }

    expect(seen).toEqual(
      steps.map((stock) => ({
        cows: stock.cows,
        droppings: stock.droppings,
        edge: pastureEdge(stock.cows + stock.droppings),
      })),
    );
  });
});

describe("PresenceMarker", () => {
  it.each([
    {
      // No live agent and nothing settled: no herd, so no pasture under the
      // cowboy.
      liveAgents: 0,
      offsetX: 0,
      drawn: [],
    },
    {
      // One cow is the smallest pasture there is: 2×2, and she takes the first
      // cell the shuffle hands her.
      liveAgents: 1,
      offsetX: 0,
      drawn: block(`
        🐄

      `),
    },
    {
      liveAgents: 2,
      offsetX: 0,
      drawn: block(`
        🐄🐄

      `),
    },
    {
      liveAgents: 3,
      offsetX: -2,
      drawn: block(`
        🐄🐄🐄


      `),
    },
    {
      // A fourth cow no longer fits a 2×2 and still leaves half its 9 cells
      // empty, so the pasture stays 3×3.
      liveAgents: 4,
      offsetX: -2,
      drawn: block(`
        🐄🐄🐄
        🐄

      `),
    },
    {
      // A fifth cow needs a 4×4: 8 cows would fill 3×3 exactly.
      liveAgents: 5,
      offsetX: -2,
      drawn: block(`
        🐄🐄🐄🐄
        🐄


      `),
    },
    {
      liveAgents: 8,
      offsetX: -2,
      drawn: block(`
        🐄🐄🐄🐄
        🐄🐄🐄🐄


      `),
    },
  ])(
    "draws the cowboy's own row and the pasture's rows for $liveAgents live agents",
    ({ liveAgents, offsetX, drawn }) => {
      const { marker } = markerOver(fleet(liveAgents));

      // The cowboy is strictly the marker, with no pasture row under him and no
      // padding around him; the pasture keeps every row the square has.
      expect(rendered(marker.render())).toEqual([INDICATOR_MARKER]);
      expect(marker.cowboyWidth).toBe(2);
      expect(rendered(marker.pastureRows())).toEqual(drawn);
      expect(marker.pastureWidth).toBe(pastureEdge(liveAgents) * 2);
      expect(marker.cowboyOffsetX).toBe(offsetX);
    },
  );

  it("draws droppings for settled agents, and shifts the cowboy over them", () => {
    const { marker } = markerOver(fleet(0, 5));

    expect(rendered(marker.render())).toEqual([INDICATOR_MARKER]);
    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        💩💩💩💩
        💩


      `),
    );
    expect(marker.pastureWidth).toBe(8);
    expect(marker.cowboyOffsetX).toBe(-2);
  });

  it.each(Array.from({ length: 21 }, (_, liveAgents) => [liveAgents]))(
    "stands the cowboy over the middle column of the %i-live-agent pasture",
    (liveAgents) => {
      const { marker } = markerOver(fleet(liveAgents));
      marker.render();
      const edge = pastureEdge(liveAgents);

      if (edge === 0) {
        // Nothing to stand over: he is the screen's right edge.
        expect(marker.cowboyOffsetX).toBe(0);
        return;
      }

      // Both are flush with the screen's right edge, so the cowboy's shift
      // gives the column he starts at read from the pasture's left edge, which
      // is where its middle cell starts.
      const cowboyCol =
        marker.pastureWidth - marker.cowboyWidth + marker.cowboyOffsetX;
      expect(cowboyCol).toBe(Math.floor(edge / 2) * 2);
      expect(marker.cowboyOffsetX).toBeLessThanOrEqual(0);
    },
  );

  it.each([
    [0, 0],
    [1, 4],
    [2, 4],
    [5, 8],
  ])(
    "keeps a %i-live-agent pasture %i wide under a cowboy of his own two columns",
    (liveAgents, pastureWidth) => {
      const { marker } = markerOver(fleet(liveAgents));

      marker.render();

      expect(marker.cowboyWidth).toBe(2);
      expect(marker.pastureWidth).toBe(pastureWidth);
    },
  );

  it("grows the pasture as the fleet grows, and gives it back as it shrinks", () => {
    vi.useFakeTimers();
    let liveAgents = 0;
    // The herd lands in reading order, and the hold's roll is above the one
    // twentieth a step takes, so the pasture stands between re-counts.
    const { marker } = markerOver(
      fleet(() => liveAgents),
      sequence(0, 0, 0, 0, 0, 0.9),
    );
    marker.render();

    liveAgents = 5;
    vi.advanceTimersByTime(1_000);
    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄🐄🐄
        🐄


      `),
    );
    expect(marker.pastureWidth).toBe(8);

    // A hold rolls for a step instead of re-placing; this source rolls it no
    // step, so the pasture stands until the next re-count moves it.
    vi.advanceTimersByTime(1_000);
    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄🐄🐄
        🐄


      `),
    );

    liveAgents = 0;
    vi.advanceTimersByTime(1_000);
    expect(rendered(marker.pastureRows())).toEqual([]);
    expect(marker.pastureWidth).toBe(0);
    // The cowboy's own row is untouched by all of it.
    expect(rendered(marker.render())).toEqual([INDICATOR_MARKER]);
  });

  it("turns a settling agent's cow into a dropping in place, and holds it there", () => {
    vi.useFakeTimers();
    let live = 3;
    let settled = 0;
    // Three rolls place the herd, the settle rolls nothing, and the hold's roll
    // is above the one twentieth a step takes, so nothing moves on the last
    // tick either.
    const { marker } = markerOver(
      fleet(
        () => live,
        () => settled,
      ),
      sequence(0, 0, 0, 0.9),
    );
    marker.render();
    expect(drawnCells(marker)).toEqual(pasture("CCC", "...", "...").flat());

    live = 2;
    settled = 1;
    vi.advanceTimersByTime(1_000);
    expect(drawnCells(marker)).toEqual(pasture("CCD", "...", "...").flat());

    const held = drawnCells(marker);
    vi.advanceTimersByTime(1_000);
    expect(drawnCells(marker)).toEqual(held);
  });

  it("paints the grass green across every pasture row, and not the cowboy's", () => {
    const { marker } = markerOver(fleet(3), inOrder, greenBackground);

    expect(rendered(marker.render())).toEqual([INDICATOR_MARKER]);
    expect(marker.render()[0]).not.toContain("\x1b[48;2;");

    // The colour opens and closes around the whole row, so it covers every cell
    // rather than just the cows.
    const drawn = marker.pastureRows();
    expect(drawn).toHaveLength(3);
    expect(
      drawn.every(
        (row) =>
          row.startsWith(`\x1b[48;2;${GRASS_RGB}m`) && row.endsWith("\x1b[49m"),
      ),
    ).toBe(true);
    expect(marker.pastureWidth).toBe(6);
  });

  it("counts the fleet on the first frame, then every second", () => {
    vi.useFakeTimers();
    const countLiveAgents = vi.fn(() => 1);
    const { marker } = markerOver(fleet(countLiveAgents));
    expect(countLiveAgents).not.toHaveBeenCalled();

    marker.render();
    expect(countLiveAgents).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(3);
  });

  it("takes the fleet's count from whichever half is drawn first, and counts it once", () => {
    vi.useFakeTimers();
    const countLiveAgents = vi.fn(() => 1);
    const { marker } = markerOver(fleet(countLiveAgents));

    // The pasture's overlay may be laid out first: it draws the fleet as it is,
    // and the cowboy's frame after it does not count a second time.
    expect(rendered(marker.pastureRows())).toHaveLength(2);
    marker.render();
    expect(countLiveAgents).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(2);
  });

  it("repaints every turn, and takes up a fleet that grew", () => {
    vi.useFakeTimers();
    let liveAgents = 0;
    const { marker, requestRender } = markerOver(fleet(() => liveAgents));
    marker.render();

    // A turn paints whether or not the herd changed cell: the poll is the clock.
    vi.advanceTimersByTime(3_000);
    expect(requestRender).toHaveBeenCalledTimes(3);

    liveAgents = 4;
    vi.advanceTimersByTime(1_000);
    expect(requestRender).toHaveBeenCalledTimes(4);
    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄🐄
        🐄

      `),
    );
  });

  it("steps one cow on every poll while the fleet holds", () => {
    vi.useFakeTimers();
    const { marker } = markerOver(
      fleet(3),
      // Three rolls place the herd, the fourth is the hold's step — under the
      // one twentieth a step takes — and the two after it pick the cow and her
      // cell.
      sequence(0.9, 0.9, 0.9, 0.04, 0.9, 0.9),
    );

    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄

            🐄
      `),
    );

    vi.advanceTimersByTime(1_000);

    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄

          🐄
      `),
    );
  });

  it("draws the cowboy alone, over nothing, while grazing is off", () => {
    vi.useFakeTimers();
    const random = vi.fn(() => 0.9);
    const { marker, requestRender } = markerOver(
      fleet(3),
      random,
      plainGrass,
      () => false,
    );
    marker.render();
    random.mockClear();

    // No pasture means no pasture rows either: the cowboy stands alone with
    // nothing under him to shift him away from the right edge.
    expect(rendered(marker.render())).toEqual([INDICATOR_MARKER]);
    expect(rendered(marker.pastureRows())).toEqual([]);
    expect(marker.pastureWidth).toBe(0);
    expect(marker.cowboyOffsetX).toBe(0);

    vi.advanceTimersByTime(3_000);

    expect(rendered(marker.pastureRows())).toEqual([]);
    // Off, a turn draws no step at all, and asks for no frame to show it in.
    expect(random).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("counts the fleet again when grazing is turned on, so the pasture draws it now", () => {
    vi.useFakeTimers();
    let grazing = false;
    let liveAgents = 3;
    const { marker } = markerOver(
      fleet(() => liveAgents),
      inOrder,
      plainGrass,
      () => grazing,
    );
    marker.render();

    // The fleet changes with no turn to notice it: grazing off runs no poll.
    liveAgents = 1;
    vi.advanceTimersByTime(1_000);
    grazing = true;
    marker.render();

    // The frame that takes the setting counts the fleet as it is now.
    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄

      `),
    );
  });

  it("runs no poll at all while grazing is off", () => {
    vi.useFakeTimers();
    const countLiveAgents = vi.fn(() => 3);
    const { marker, requestRender } = markerOver(
      fleet(countLiveAgents),
      inOrder,
      plainGrass,
      () => false,
    );
    marker.render();

    vi.advanceTimersByTime(5_000);
    marker.render();
    vi.advanceTimersByTime(5_000);

    // Off, no turn counts the fleet, rolls for a step, or repaints — and no
    // timer is left running to do any of it.
    expect(countLiveAgents).toHaveBeenCalledTimes(1);
    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps exactly one poll across repeated flips of the setting", () => {
    vi.useFakeTimers();
    let grazing = true;
    const countLiveAgents = vi.fn(() => 1);
    const { marker } = markerOver(
      fleet(countLiveAgents),
      inOrder,
      plainGrass,
      () => grazing,
    );
    marker.render();

    for (const next of [false, true, false, true, true, false, true]) {
      grazing = next;
      marker.render();
    }

    // The last flip left grazing on, with the one poll a second that is its
    // clock — no second timer from the flips before it.
    const counted = countLiveAgents.mock.calls.length;
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(counted + 1);

    grazing = false;
    marker.render();

    // The flip off takes the poll with it, and the fleet stops being counted.
    const countedOff = countLiveAgents.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(countedOff);
  });

  it("takes the poll down on the turn that finds grazing switched off", () => {
    vi.useFakeTimers();
    let grazing = true;
    const countLiveAgents = vi.fn(() => 1);
    const { marker, requestRender } = markerOver(
      fleet(countLiveAgents),
      inOrder,
      plainGrass,
      () => grazing,
    );
    marker.render();

    // The setting goes off with no frame to take it: the next turn is the one
    // that notices, and it is the last one.
    grazing = false;
    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);

    expect(countLiveAgents).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(2);
  });

  it("leaves no timer behind when it is taken down with grazing off", () => {
    vi.useFakeTimers();
    const countLiveAgents = vi.fn(() => 3);
    const { marker } = markerOver(
      fleet(countLiveAgents),
      inOrder,
      plainGrass,
      () => false,
    );
    marker.render();

    marker.dispose();

    expect(vi.getTimerCount()).toBe(0);
    // A frame after the teardown counts nothing and starts no poll.
    marker.render();
    vi.advanceTimersByTime(5_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(1);
  });

  it("draws the pasture back where it stood when grazing is turned on again", () => {
    vi.useFakeTimers();
    let grazing = false;
    const { marker } = markerOver(
      fleet(3),
      // Three rolls place the herd, and the fourth steps it once grazing is on.
      sequence(0.9, 0.9, 0.9, 0.04, 0.9, 0.9),
      plainGrass,
      () => grazing,
    );
    marker.render();
    vi.advanceTimersByTime(2_000);

    grazing = true;
    vi.advanceTimersByTime(1_000);

    // The flip itself draws the herd; the step comes on the turn after it.
    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄

            🐄
      `),
    );

    vi.advanceTimersByTime(1_000);

    expect(rendered(marker.pastureRows())).toEqual(
      block(`
        🐄🐄

          🐄
      `),
    );
  });

  it("ends the poll when the marker is taken down", () => {
    vi.useFakeTimers();
    const countLiveAgents = vi.fn(() => 0);
    const { marker } = markerOver(fleet(countLiveAgents));
    marker.render();

    marker.dispose();
    vi.advanceTimersByTime(5_000);

    expect(countLiveAgents).toHaveBeenCalledTimes(1);
    // A frame that arrives after the teardown must not resurrect the poll.
    marker.render();
    vi.advanceTimersByTime(5_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(1);
  });

  it("takes both of its overlays down on dispose, each through its own handle", () => {
    vi.useFakeTimers();
    const countLiveAgents = vi.fn(() => 1);
    const { marker } = markerOver(fleet(countLiveAgents));
    marker.render();
    const cowboy = handleRecorder();
    const pasture = handleRecorder();
    marker.attachCowboy(cowboy.handle);
    marker.attachPasture(pasture.handle);

    marker.dispose();

    expect(cowboy.hidden()).toBe(true);
    expect(pasture.hidden()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(countLiveAgents).toHaveBeenCalledTimes(1);
  });
});

describe("showExtensionIndicator", () => {
  it("mounts the cowboy and the pasture as two non-capturing overlays, top-right", () => {
    const { ui, mounts } = fakeUi();

    showExtensionIndicator(ui);

    // The cowboy takes row 0 and the pasture the rows below him: each is an
    // overlay of its own, so either can be controlled on its own.
    expect(mounts).toHaveLength(2);
    expect(mounts.map((mount) => mount.options?.overlay)).toEqual([true, true]);
    expect(optionsOf(mounts[0]!)).not.toBe(optionsOf(mounts[1]!));
    expect(optionsOf(mounts[0]!)).toMatchObject({
      anchor: "top-right",
      nonCapturing: true,
    });
    expect(optionsOf(mounts[1]!)).toMatchObject({
      anchor: "top-right",
      nonCapturing: true,
    });
  });

  it("gives the cowboy his own two columns, shifted over the pasture's middle one", () => {
    vi.useFakeTimers();
    const { ui, mounts } = fakeUi();
    showExtensionIndicator(ui);
    getIndicatorMarker()?.render();

    // pi reads both per frame: the cowboy's box never grows past his own marker,
    // and his shift follows the pasture under him.
    expect(optionsOf(mounts[0]!).width).toBe(2);
    expect(optionsOf(mounts[0]!).offsetX).toBe(0);

    for (let cow = 0; cow < 5; cow += 1) {
      spawnSpawnedPhase(`cow${cow}`);
    }
    vi.advanceTimersByTime(1_000);

    expect(optionsOf(mounts[0]!).width).toBe(2);
    expect(optionsOf(mounts[0]!).offsetX).toBe(-2);
  });

  it("gives the pasture the width it draws, on the row under the cowboy's", () => {
    vi.useFakeTimers();
    const { ui, mounts } = fakeUi();
    showExtensionIndicator(ui);
    getIndicatorMarker()?.render();

    expect(optionsOf(mounts[1]!).offsetY).toBe(1);
    expect(optionsOf(mounts[1]!).width).toBe(0);

    for (let cow = 0; cow < 5; cow += 1) {
      spawnSpawnedPhase(`cow${cow}`);
    }
    vi.advanceTimersByTime(1_000);

    expect(optionsOf(mounts[1]!).width).toBe(8);
  });

  it("counts the shell's live agents into both halves", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    for (let cow = 0; cow < 4; cow += 1) {
      spawnSpawnedPhase(`herd${cow}`);
    }
    const { ui, mounts } = fakeUi();

    showExtensionIndicator(ui);

    expect(rendered(mounts[0]!.component.render(TERMINAL_WIDTH))).toEqual([
      INDICATOR_MARKER,
    ]);
    expect(rendered(mounts[1]!.component.render(TERMINAL_WIDTH))).toEqual(
      block(`
        🐄🐄🐄
        🐄

      `),
    );
  });

  it("draws a dropping for a settled spawn, and takes it away when it is dropped", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ui } = fakeUi();
    spawnSpawnedPhase("grazing");
    spawnAgent("settled", "settled");

    showExtensionIndicator(ui);
    const marker = getIndicatorMarker()!;
    marker.render();

    expect(markerCells(marker, "cow")).toBe(1);
    expect(markerCells(marker, "dropping")).toBe(1);

    getAgentSpawns().drop("settled");
    vi.advanceTimersByTime(1_000);

    expect(markerCells(marker, "cow")).toBe(1);
    expect(markerCells(marker, "dropping")).toBe(0);
  });

  it("draws no cow for an agent that is only queued", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ui, mounts } = fakeUi();
    spawnAgent("queued", "queued");

    showExtensionIndicator(ui);
    getIndicatorMarker()?.render();

    // A queued agent is not grazing yet, and settling is the only thing that
    // leaves a dropping, so there is no pasture at all.
    expect(rendered(mounts[1]!.component.render(TERMINAL_WIDTH))).toEqual([]);
    expect(optionsOf(mounts[1]!).width).toBe(0);
  });

  it("reads the grazing setting off the shell's store", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    for (let cow = 0; cow < 4; cow += 1) {
      spawnSpawnedPhase(`herd${cow}`);
    }
    installStore(false);
    const { ui, mounts } = fakeUi();

    showExtensionIndicator(ui);

    expect(rendered(mounts[0]!.component.render(TERMINAL_WIDTH))).toEqual([
      INDICATOR_MARKER,
    ]);
    expect(rendered(mounts[1]!.component.render(TERMINAL_WIDTH))).toEqual([]);
    expect(optionsOf(mounts[1]!).width).toBe(0);
  });

  it("keeps the mounted marker, so the handles reaching it can take it down", () => {
    const { ui, mounts } = fakeUi();

    showExtensionIndicator(ui);

    // The cowboy's overlay is the marker itself; the pasture's reads it.
    expect(getIndicatorMarker()).toBe(mounts[0]!.component);
    hideExtensionIndicator();
    expect(mounts.every((mount) => mount.hidden())).toBe(true);
  });

  it("takes a previous marker's overlays down instead of stacking another", () => {
    const { ui, mounts } = fakeUi();

    showExtensionIndicator(ui);
    showExtensionIndicator(ui);

    expect(mounts).toHaveLength(4);
    expect(mounts.slice(0, 2).every((mount) => mount.hidden())).toBe(true);
    expect(mounts.slice(2).every((mount) => mount.hidden())).toBe(false);
    expect(getIndicatorMarker()).toBe(mounts[2]!.component);
  });
});

describe("hideExtensionIndicator", () => {
  it("forgets the marker it took down", () => {
    const { ui, mounts } = fakeUi();
    showExtensionIndicator(ui);

    hideExtensionIndicator();

    expect(mounts.every((mount) => mount.hidden())).toBe(true);
    expect(getIndicatorMarker()).toBeNull();
  });

  it("is a no-op while no marker is mounted", () => {
    expect(() => hideExtensionIndicator()).not.toThrow();
  });
});
