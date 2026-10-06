/**
 * indicator.ts — the extension's presence marker: 🤠 in the top-right corner
 * of the screen while the extension is on, standing on his own row above a
 * green pasture, centred over its middle column. The pasture is the smallest
 * square of cells that can hold twice its stock — one 🐄 per live agent and one
 * 💩 per agent that has ended and waits to be cleaned up — so at least half of
 * it is always empty. It is drawn only while grazing is switched on, when its
 * herd is dropped in at random and one cow may step to a neighbouring cell every
 * second; a dropping stays where it fell. With grazing off the cowboy stands
 * alone and the poll stops with the pasture; the fleet is counted again when it
 * returns. Cowboy and pasture ride an overlay each rather than a widget, so they
 * cost no line of the transcript. Both are anchored at the top-right with no
 * margin: the cowboy takes row 0, in exactly his own two columns, and the pasture
 * covers the rows below him rather than pushing content down. Each overlay is
 * sized to what it draws, and the cowboy is shifted left over the pasture's
 * middle column by an offset rather than by padding, so neither covers a cell
 * it does not draw.
 */

import {
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { TERMINAL_AGENT_PHASES } from "../types.js";
import {
  getAgentSpawns,
  getIndicatorMarker,
  getStore,
  setIndicatorMarker,
} from "../shell.js";

/** The extension's own presence: the cowboy, on his own row above the pasture. */
export const INDICATOR_MARKER = "🤠";

/** One live agent's presence, and one head of pasture stock. */
export const AGENT_MARKER = "🐄";

/** One ended agent's presence: a dropping that stays where it fell. */
export const DROPPING = "💩";

/** The smallest edge a pasture with stock in it can have. */
export const MIN_PASTURE_EDGE = 2;

/** How often the marker re-counts the fleet, and the herd rolls for a step while grazing. */
const POLL_INTERVAL_MS = 1_000;

/** One pasture cell's width in columns: the same for a cow and for a dropping. */
const CELL_WIDTH = visibleWidth(AGENT_MARKER);

/** Paints one pasture row behind whatever stands on it. */
export type BackgroundColor = (text: string) => string;

/**
 * The pasture's grass: an explicit truecolor green, back to the terminal's own
 * background afterwards. It cannot come from the theme, whose palette has no
 * green background, nor from the terminal's ANSI "green" — a colour scheme is
 * free to map that to anything.
 */
export const GRASS_RGB = "76;175;80";

/** Paints `text` with the grass's green behind it. */
export function greenBackground(text: string): string {
  return `\x1b[48;2;${GRASS_RGB}m${text}\x1b[49m`;
}

/** A random source: a fresh number in [0, 1) per call. */
export type Random = () => number;

/**
 * One pasture cell as it prints: a grazing cow, an ended agent's dropping, or
 * the empty grass between them.
 */
export type PastureCell = "empty" | "cow" | "dropping";

/**
 * One pasture: `pasture[row][col]` says what stands in that cell. The grid is
 * square, and an empty grid is no pasture at all.
 */
export type Pasture = readonly (readonly PastureCell[])[];

/**
 * The pasture's stock: `cows` live agents grazing, and `droppings` ended
 * agents waiting to be cleaned up.
 */
export interface PastureStock {
  readonly cows: number;
  readonly droppings: number;
}

/**
 * The pasture's edge for `occupants` head: the smallest square that is at least
 * twice the stock, so half of its cells stay empty, and never an edge below the
 * minimum. No stock needs no square, so their edge is 0.
 */
export function pastureEdge(occupants: number): number {
  if (occupants === 0) return 0;
  return Math.max(MIN_PASTURE_EDGE, Math.ceil(Math.sqrt(2 * occupants)));
}

/** An `edge`×`edge` pasture with nothing standing in it. */
function emptyPasture(edge: number): PastureCell[][] {
  return Array.from({ length: edge }, () =>
    Array.from({ length: edge }, (): PastureCell => "empty"),
  );
}

/**
 * The pasture's stock dropped at random into the square sized for all of it:
 * one roll per occupant, the cells drawn by a partial Fisher–Yates over the
 * square's slots so a cell is handed to one occupant and never a second. Cows
 * are placed before droppings.
 */
export function grazedPasture(stock: PastureStock, random: Random): Pasture {
  const edge = pastureEdge(stock.cows + stock.droppings);
  const pasture = emptyPasture(edge);
  const spots = Array.from({ length: edge * edge }, (_, index) => index);
  const occupants: PastureCell[] = [
    ...Array.from({ length: stock.cows }, (): PastureCell => "cow"),
    ...Array.from({ length: stock.droppings }, (): PastureCell => "dropping"),
  ];
  // Each occupant takes the slot the shuffle hands it, so a cell is drawn for
  // one occupant and never a second.
  for (let at = 0; at < occupants.length; at += 1) {
    const pick = at + Math.floor(random() * (spots.length - at));
    const spot = spots[pick];
    spots[pick] = spots[at];
    spots[at] = spot;
    pasture[Math.floor(spot / edge)][spot % edge] = occupants[at];
  }
  return pasture;
}

/** Where one cell stands: `row` from the pasture's top, `col` from its left. */
interface Cell {
  readonly row: number;
  readonly col: number;
}

/** Every cell of `kind`, in reading order. */
function cellsOf(pasture: Pasture, kind: PastureCell): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < pasture.length; row += 1) {
    for (let col = 0; col < pasture[row].length; col += 1) {
      if (pasture[row][col] === kind) cells.push({ row, col });
    }
  }
  return cells;
}

/** The cells a cow at `from` can step to: its orthogonal neighbours inside the pasture. */
function neighboursOf(from: Cell, edge: number): Cell[] {
  const around: Cell[] = [
    { row: from.row - 1, col: from.col },
    { row: from.row, col: from.col + 1 },
    { row: from.row + 1, col: from.col },
    { row: from.row, col: from.col - 1 },
  ];
  return around.filter(
    ({ row, col }) => row >= 0 && row < edge && col >= 0 && col < edge,
  );
}

/** The neighbours of `cow` standing in empty grass — never another cow, never a dropping. */
function openNeighboursOf(cow: Cell, pasture: Pasture): Cell[] {
  return neighboursOf(cow, pasture.length).filter(
    ({ row, col }) => pasture[row][col] === "empty",
  );
}

/**
 * One turn of grazing: one cow of the herd steps to an open neighbouring cell
 * on a roll under one twentieth — so the herd moves on one turn in twenty and
 * grazes where it stands on the rest. The cow and the cell are both drawn at
 * random, from the cows that have somewhere to go. A dropping is never a mover,
 * and no cow steps onto one; a pasture whose cows are all boxed in rolls no
 * dice at all.
 */
export function moveHerd(pasture: Pasture, random: Random): Pasture {
  const movers = cellsOf(pasture, "cow").filter(
    (cow) => openNeighboursOf(cow, pasture).length > 0,
  );
  if (movers.length === 0) return pasture;
  if (random() >= 0.05) return pasture;

  const cow = movers[Math.floor(random() * movers.length)];
  const open = openNeighboursOf(cow, pasture);
  const to = open[Math.floor(random() * open.length)];

  const next = pasture.map((row) => row.slice());
  next[cow.row][cow.col] = "empty";
  next[to.row][to.col] = "cow";
  return next;
}

/** The cells of `kind` to add, each taking a random empty cell: one roll apiece. */
function placeAtRandom(
  pasture: PastureCell[][],
  kind: PastureCell,
  count: number,
  random: Random,
): void {
  for (let placed = 0; placed < count; placed += 1) {
    const empties = cellsOf(pasture, "empty");
    const pick = empties[Math.floor(random() * empties.length)];
    pasture[pick.row][pick.col] = kind;
  }
}

/**
 * Turn a pasture's stock toward `cows` and `droppings` without ever moving a
 * cell that can stay: a settling agent's cow becomes a dropping where it
 * stands, a cleaned-up agent's dropping is cleared, and both take the last of
 * their kind in reading order so a surplus leans on the cells away from the
 * top-left. Only a deficit is placed, one roll per new occupant into a random
 * empty cell.
 */
function reconcileCounts(
  pasture: PastureCell[][],
  cows: number,
  droppings: number,
  random: Random,
): void {
  const cowCells = cellsOf(pasture, "cow");
  const dropCells = cellsOf(pasture, "dropping");
  let cowSurplus = cowCells.length - cows;
  let dropSurplus = dropCells.length - droppings;

  while (cowSurplus > 0 && dropSurplus < 0) {
    const cell = cowCells.pop()!;
    pasture[cell.row][cell.col] = "dropping";
    cowSurplus -= 1;
    dropSurplus += 1;
  }

  while (cowSurplus > 0) {
    const cell = cowCells.pop()!;
    pasture[cell.row][cell.col] = "empty";
    cowSurplus -= 1;
  }

  while (dropSurplus > 0) {
    const cell = dropCells.pop()!;
    pasture[cell.row][cell.col] = "empty";
    dropSurplus -= 1;
  }

  placeAtRandom(pasture, "cow", -cowSurplus, random);
  placeAtRandom(pasture, "dropping", -dropSurplus, random);
}

/**
 * The pasture for a stock of `cows` live agents and `droppings` ended ones,
 * grown or shrunk from `previous` — or placed fresh when there is none. The
 * square is resized to the edge the total stock asks for, keeping every cell
 * the new square can hold where it stands; the stock is then reconciled to the
 * counts. Going from one count to another costs a roll only where the placement
 * is at random: a resize itself rolls nothing, and a cow that settled keeps its
 * cell.
 */
export function reconcilePasture(
  previous: Pasture | null,
  stock: PastureStock,
  random: Random,
): Pasture {
  if (previous === null) return grazedPasture(stock, random);

  const edge = pastureEdge(stock.cows + stock.droppings);
  const pasture = emptyPasture(edge);
  for (let row = 0; row < previous.length && row < edge; row += 1) {
    for (let col = 0; col < previous[row].length && col < edge; col += 1) {
      pasture[row][col] = previous[row][col];
    }
  }
  reconcileCounts(pasture, stock.cows, stock.droppings, random);
  return pasture;
}

/**
 * The cowboy's own overlay: his two columns, pinned to the screen's top-right
 * corner and shifted left over the pasture's middle column. The shift is read
 * from the mounted marker on each frame, so the cowboy's box can stay his own
 * two columns while the pasture under him grows and shrinks. Non-capturing, so
 * the editor keeps the keyboard.
 */
const COWBOY_OVERLAY: OverlayOptions = {
  anchor: "top-right",
  width: visibleWidth(INDICATOR_MARKER),
  get offsetX(): number {
    return getIndicatorMarker()?.cowboyOffsetX ?? 0;
  },
  nonCapturing: true,
};

/**
 * The pasture's own overlay, on the row below the cowboy's. The overlay covers
 * every cell of its box, so its width is read from the mounted marker on each
 * frame: a box wider than the pasture would erase what it covers, and with no
 * pasture to draw there is no box at all.
 */
const PASTURE_OVERLAY: OverlayOptions = {
  anchor: "top-right",
  offsetY: 1,
  get width(): number {
    return getIndicatorMarker()?.pastureWidth ?? 0;
  },
  nonCapturing: true,
};

/** One cell as it prints: a cow, a dropping, or the empty grass between them. */
function cellText(cell: PastureCell): string {
  if (cell === "cow") return AGENT_MARKER;
  if (cell === "dropping") return DROPPING;
  return " ".repeat(CELL_WIDTH);
}

/**
 * The rows the pasture draws: one per row of the square, each cell padded to
 * its width and painted with `grass`. There are none for no pasture, and the
 * cowboy is not among them — he rides an overlay of his own above them.
 */
function drawnRows(pasture: Pasture, grass: BackgroundColor): string[] {
  return pasture.map((row) => grass(row.map(cellText).join("")));
}

/** Only actively executing agents graze: a queued agent has no cow in the pasture yet. */
function liveAgentCount(): number {
  return getAgentSpawns().list(["spawned"]).length;
}

/**
 * Ended spawns awaiting cleanup, each of which leaves a dropping: completed,
 * stopped, failed, or ended before it ever launched. All of them count here and
 * are shown until they are dropped from the store.
 */
function endedAgentCount(): number {
  return getAgentSpawns().list(TERMINAL_AGENT_PHASES).length;
}

/** The fleet as the marker counts it: the live agents that graze and the ended ones that lie. */
export interface AgentCounts {
  readonly live: number;
  readonly ended: number;
}

/** Both halves of the fleet read from the store, in one synchronous pass. */
function agentCounts(): AgentCounts {
  return { live: liveAgentCount(), ended: endedAgentCount() };
}

/**
 * Read per frame rather than at mount, so flipping the setting takes the
 * pasture down and brings it back without the marker itself being taken down.
 */
function grazingEnabled(): boolean {
  return getStore().agent.grazingEnabled;
}

/**
 * The herd the marker holds between counts: the counts that produced it, and
 * where its cows and droppings stand.
 */
interface Herd {
  readonly liveAgents: number;
  readonly endedAgents: number;
  readonly pasture: Pasture;
}

/**
 * The marker. It counts the fleet on a timer of its own rather than being told:
 * the spawn store publishes no changes, and a run settles wherever it ends, so
 * there is nothing here to react to. It is drawn by two overlays — the cowboy's
 * row by the marker itself, the pasture's rows by `PastureView` — and the width
 * pi hands to `render` goes unused: each overlay is sized from the accessors
 * below instead.
 */
export class PresenceMarker implements Component {
  /**
   * The herd the marker draws: set by the first frame, re-set by every poll
   * that finds a different fleet. Null until a frame has counted.
   */
  private herd: Herd | null = null;

  private cowboyHandle: OverlayHandle | null = null;

  private pastureHandle: OverlayHandle | null = null;

  private poll: ReturnType<typeof setInterval> | null = null;

  /** Whether the marker has been taken down: a taken-down marker takes no frame. */
  private disposed = false;

  /**
   * The grazing setting as of the last turn taken; null until the first frame.
   * Remembered because a flip redraws the pasture — appearing or going — and
   * only a changed pasture is repainted.
   */
  private grazing: boolean | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly countAgents: () => AgentCounts,
    private readonly isGrazing: () => boolean,
    private readonly grass: BackgroundColor,
    private readonly random: Random,
  ) {}

  /** The cowboy's footprint: his own two columns, which no pasture widens. */
  get cowboyWidth(): number {
    return visibleWidth(INDICATOR_MARKER);
  }

  /**
   * The pasture overlay's width in columns: the square's edge in cells, and
   * zero with no pasture to draw. Derived fresh, so a fleet that grows or
   * shrinks never leaves the overlay wider than the square it draws.
   */
  get pastureWidth(): number {
    return this.drawnPasture().length * CELL_WIDTH;
  }

  /**
   * How far the cowboy is shifted from the right edge: the middle cell of the
   * square starts this many columns left of the last two columns he stands in
   * when he is flush right. A shift left is negative, as the overlay's offset
   * takes it. There is nothing to stand over without a pasture, so the shift is
   * 0.
   */
  get cowboyOffsetX(): number {
    const edge = this.drawnPasture().length;
    if (edge === 0) return 0;
    const middle = Math.floor(edge / 2) * CELL_WIDTH;
    return middle - (edge * CELL_WIDTH - this.cowboyWidth);
  }

  /** The cowboy's own row: one line, and no padding around him. */
  render(): string[] {
    this.frame();
    return [INDICATOR_MARKER];
  }

  /**
   * The pasture's rows for the herd as it stands: none before the first frame,
   * and none while grazing is off.
   */
  pastureRows(): string[] {
    this.frame();
    return drawnRows(this.drawnPasture(), this.grass);
  }

  invalidate(): void {}

  /** The cowboy overlay's handle, once pi has shown it. */
  attachCowboy(handle: OverlayHandle): void {
    this.cowboyHandle = handle;
  }

  /** The pasture overlay's handle, once pi has shown it. */
  attachPasture(handle: OverlayHandle): void {
    this.pastureHandle = handle;
  }

  /** Take both overlays down, and the poll with them. */
  dispose(): void {
    this.disposed = true;
    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.cowboyHandle?.hide();
    this.cowboyHandle = null;
    this.pastureHandle?.hide();
    this.pastureHandle = null;
  }

  /**
   * The pasture to draw as the herd stands: the herd's placement while grazing
   * is on, and nothing before the first frame or while grazing is off.
   */
  private drawnPasture(): Pasture {
    return this.herd === null || !this.isGrazing() ? [] : this.herd.pasture;
  }

  /**
   * Take a frame: the first one counts the fleet and owns the poll from then on,
   * and every frame after it reads the setting, so the poll runs exactly while
   * grazing is on and the frame that finds it changed takes a turn. A marker that
   * is never drawn neither reads the fleet nor leaves a timer behind. Either half
   * being drawn takes the frame, because the cowboy and the pasture are drawn by
   * overlays with no order between them.
   */
  private frame(): void {
    if (this.disposed) return;
    const grazing = this.isGrazing();
    if (this.herd === null) {
      this.herd = this.place(this.countAgents());
      this.grazing = grazing;
    } else if (grazing !== this.grazing) {
      this.recount();
    }
    this.pollWhile(grazing);
  }

  /**
   * Run the poll exactly while grazing is on: started when the setting comes on
   * and cleared when it goes off. A repeated frame neither starts a second poll
   * nor stops the one that is already running.
   */
  private pollWhile(grazing: boolean): void {
    if (!grazing && this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    } else if (grazing && this.poll === null) {
      this.poll = setInterval(() => this.recount(), POLL_INTERVAL_MS);
    }
  }

  /**
   * Take a turn: a fleet that changed is re-placed, and a held herd that is
   * grazing takes one step. A turn that finds the setting flipped repaints with
   * both counts held, taking the pasture down or bringing it back, and takes the
   * poll down with it.
   */
  private recount(): void {
    const { live, ended } = this.countAgents();
    const grazing = this.isGrazing();
    const flipped = grazing !== this.grazing;

    if (
      this.herd === null ||
      live !== this.herd.liveAgents ||
      ended !== this.herd.endedAgents
    ) {
      this.herd = this.place({ live, ended });
    } else if (grazing && !flipped) {
      this.herd = {
        ...this.herd,
        pasture: moveHerd(this.herd.pasture, this.random),
      };
    } else if (!flipped) {
      return;
    }

    this.grazing = grazing;
    this.pollWhile(grazing);
    // With grazing off there is no pasture to draw and nothing under the cowboy
    // to shift, so a fleet that moves the herd changes nothing on screen. Only
    // the flip repaints, taking the pasture down or bringing it back.
    if (grazing || flipped) this.tui.requestRender();
  }

  /** The herd a fleet feeds, reconciled from the herd the marker is holding. */
  private place({ live, ended }: AgentCounts): Herd {
    return {
      liveAgents: live,
      endedAgents: ended,
      pasture: reconcilePasture(
        this.herd?.pasture ?? null,
        { cows: live, droppings: ended },
        this.random,
      ),
    };
  }
}

/**
 * The pasture's half of the marker, mounted as an overlay of its own on the row
 * under the cowboy's. It draws whatever marker the shell holds, so the two
 * overlays are mounted and taken down without either knowing the other.
 */
class PastureView implements Component {
  render(): string[] {
    return getIndicatorMarker()?.pastureRows() ?? [];
  }

  invalidate(): void {}
}

/**
 * Show 🤠 in the top-right corner of the screen, over a pasture of one 🐄 per
 * live agent and one 💩 per ended one, while grazing is on.
 */
export function showExtensionIndicator(ui: ExtensionUIContext): void {
  hideExtensionIndicator();
  void ui.custom<PresenceMarker>(
    (tui) => {
      const marker = new PresenceMarker(
        tui,
        agentCounts,
        grazingEnabled,
        greenBackground,
        Math.random,
      );
      setIndicatorMarker(marker);
      return marker;
    },
    {
      overlay: true,
      overlayOptions: COWBOY_OVERLAY,
      // The factory ran first, so the marker in the shell is the one this handle controls.
      onHandle: (handle) => getIndicatorMarker()?.attachCowboy(handle),
    },
  );
  void ui.custom(() => new PastureView(), {
    overlay: true,
    overlayOptions: PASTURE_OVERLAY,
    // The cowboy's factory ran first, so the shell already holds the marker this view draws.
    onHandle: (handle) => getIndicatorMarker()?.attachPasture(handle),
  });
}

/** Take the marker down: both its overlays, and the poll behind them. */
export function hideExtensionIndicator(): void {
  const marker = getIndicatorMarker();
  setIndicatorMarker(null);
  marker?.dispose();
}
