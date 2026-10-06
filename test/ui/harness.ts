/**
 * harness.ts — headless driver for the /cowboy menus.
 * Supplies ctx.ui.custom, captures each Component, and drives only
 * render(width)/handleInput(data) — no private fields or helper imports, so
 * internal refactors keep these tests compiling. Frames are ANSI-stripped;
 * the active row reads the library's own cursor glyph.
 */
import {
  KeybindingsManager,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  initTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  recordOverlayMount,
  type OverlayCallOptions,
  type OverlayMount,
} from "../helpers/overlay-mounts.js";

// Searchable pick-lists need pi's module-global theme initialized, as the real TUI does.
initTheme("dark");

/** Raw key encodings, as a terminal would deliver them. */
export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  space: " ",
  backspace: "\x7f",
  delete: "\x1b[3~",
  newline: "\n",
  j: "j",
  k: "k",
  ctrlC: "\x03",
} as const;

/** Identity-color theme: frames read as the user sees them, minus color. */
const flatTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

/** Rendered row: label column and value column. */
interface Row {
  label: string;
  value: string;
}

interface Notification {
  message: string;
  kind: "info" | "warning" | "error" | undefined;
}

/** The library's cursor glyph, used by both SettingsList and SelectList. */
const ACTIVE_ROW = /^\s*→\s*(.*)$/;

/** Split a rendered row into label + value on the library's column gap. */
function splitRow(body: string): Row {
  const parts = body.split(/\s{2,}/);
  return {
    label: (parts[0] ?? "").trim(),
    value: parts.slice(1).join(" ").trim(),
  };
}

type MenuRunner = (ctx: ExtensionCommandContext) => Promise<unknown>;

/** Nobody's keyboard: the badge kind of overlay, which no test presses keys on. */
function isNonCapturingOverlay(
  options: OverlayCallOptions | undefined,
): boolean {
  const overlayOptions = options?.overlayOptions;
  return (
    options?.overlay === true &&
    typeof overlayOptions !== "function" &&
    overlayOptions?.nonCapturing === true
  );
}

export class MenuSession {
  readonly notifications: Notification[] = [];
  /**
   * Non-capturing overlay mounts, in order. They never take the keyboard, so
   * no key a test presses could reach one: they are badges, not screens.
   */
  readonly overlays: OverlayMount[] = [];
  /** Entered screens, one per ctx.ui.custom call that is not a badge. */
  private readonly screens: Component[] = [];
  private readonly closed: number[] = [];
  private readonly ctx: ExtensionCommandContext;
  readonly finished: Promise<unknown>;

  constructor(
    runner: MenuRunner,
    private readonly width = 80,
  ) {
    let finish: (value: unknown) => void = () => {};
    this.finished = new Promise((resolve) => {
      finish = resolve;
    });
    this.ctx = {
      cwd: "/repo",
      model: undefined,
      modelRegistry: undefined,
      ui: {
        theme: flatTheme,
        notify: (message: string, kind?: Notification["kind"]) => {
          this.notifications.push({ message, kind });
        },
        custom: (
          factory: (...args: unknown[]) => Component,
          options?: OverlayCallOptions,
        ) => {
          if (isNonCapturingOverlay(options)) {
            const mount = recordOverlayMount(
              () => factory(fakeTui, flatTheme, keybindings, () => {}),
              options,
            );
            this.overlays.push(mount);
            return Promise.resolve(undefined);
          }
          return new Promise((resolve) => {
            const index = this.screens.length;
            const close = (value?: unknown) => {
              this.closed.push(index);
              resolve(value);
            };
            this.screens.push(factory(fakeTui, flatTheme, keybindings, close));
          });
        },
      },
    } as unknown as ExtensionCommandContext;
    void runner(this.ctx).then(finish, finish);
  }

  get context(): ExtensionCommandContext {
    return this.ctx;
  }

  get screenCount(): number {
    return this.screens.length;
  }

  get closedScreens(): number[] {
    return [...this.closed];
  }

  /** The last screen entered. */
  get screen(): Component {
    const screen = this.screens.at(-1);
    if (!screen) throw new Error("menu never opened a screen");
    return screen;
  }

  /** Current frame: ANSI-free, right-trimmed lines. */
  frame(): string[] {
    return this.screen
      .render(this.width)
      .map((line) => stripTerminalSequences(line).trimEnd());
  }

  text(): string {
    return this.frame().join("\n");
  }

  /** Framed heading of the current screen. */
  title(): string {
    return (
      this.frame()
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !/^[─\s]+$/.test(line)) ?? ""
    );
  }

  press(key: string): void {
    this.screen.handleInput?.(key);
  }

  /** Cursor-glyph row, or null (e.g. a text input). */
  activeRow(): Row | null {
    for (const line of this.frame()) {
      const match = ACTIVE_ROW.exec(line);
      if (match) return splitRow(match.at(1) ?? "");
    }
    return null;
  }

  rows(): Row[] {
    const rows: Row[] = [];
    for (const line of this.frame()) {
      const match = ACTIVE_ROW.exec(line);
      if (match) {
        rows.push(splitRow(match.at(1) ?? ""));
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === "" || /^[─\s]+$/.test(trimmed)) continue;
      rows.push(splitRow(trimmed));
    }
    return rows;
  }

  /** Move the cursor to `label` via handleInput (real key handling). */
  focus(label: string | RegExp, limit = 60): void {
    const matches = (candidate: string) =>
      typeof label === "string" ? candidate === label : label.test(candidate);
    for (let i = 0; i < limit; i += 1) {
      const row = this.activeRow();
      if (row && matches(row.label)) return;
      this.press(KEY.down);
    }
    throw new Error(`row never became active: ${String(label)}`);
  }

  open(label: string | RegExp, limit = 60): void {
    this.focus(label, limit);
    this.press(KEY.enter);
  }

  /** Replace a text field's contents: clear both ways, then type per keystroke. */
  fillField(text: string, clears = 16): void {
    for (let i = 0; i < clears; i += 1) this.press(KEY.delete);
    for (let i = 0; i < clears; i += 1) this.press(KEY.backspace);
    this.typeText(text);
  }

  /** Type at the cursor without clearing (multi-line fields keep earlier lines). */
  typeText(text: string): void {
    for (const char of text) this.press(char);
  }

  /**
   * Rows in cursor order from the top, frames alone. Stops on wrap (repeat
   * label) or a stuck cursor; includes the starting row (may be a header).
   */
  walkRows(limit = 60): Row[] {
    const seen: Row[] = [];
    for (let i = 0; i < limit; i += 1) {
      const row = this.activeRow();
      if (!row) break;
      if (seen.some((candidate) => candidate.label === row.label)) break;
      seen.push(row);
      this.press(KEY.down);
    }
    return seen;
  }

  downMoved(): boolean {
    const before = this.activeRow()?.label;
    this.press(KEY.down);
    return this.activeRow()?.label !== before;
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async whenScreens(count: number): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (this.screens.length >= count) return;
      await this.settle();
    }
    throw new Error(
      `menu only reached ${this.screens.length} of ${count} screens`,
    );
  }
}

export function openMenu(runner: MenuRunner, width = 80): MenuSession {
  return new MenuSession(runner, width);
}

/** pi injects a keybindings manager into every ctx.ui.custom factory. */
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

/** TUI stand-in; the text viewer sizes its viewport from terminal.rows. */
const fakeTui = {
  terminal: { rows: 24, columns: 80 },
} as unknown as TUI;
