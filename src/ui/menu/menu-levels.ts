/**
 * menu-levels.ts — the levels one /cowboy menu shows, as a stack.
 *
 * The whole menu is a single `ui.custom` call: every screen it can reach — an
 * agent's actions, a pick-list, a confirmation, the spawn wizard's next step —
 * is a level on this stack, never a screen of its own. Entering is `push`,
 * going back is `pop`, and the stack empties only when the menu is done, so
 * "one level up" is the same gesture wherever the user is.
 *
 * A level is a builder rather than a built body: the body it mounted is kept
 * while it sits below the top (pushing and popping shows exactly the view the
 * user left), and `refresh` is the explicit way to read its state again. A
 * builder that awaits is only allowed to mount while it is still the top
 * entry, which is what `stillHere` asks — so a probe that lands after the user
 * moved on mounts nothing, with no flag or token to keep in step.
 */

import type {
  Component,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** The parts of the screen a level draws into. */
export interface MenuScreen {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
}

/** One screen: the ui.custom arguments, plus the callback that ends it. */
export interface Screen<T> extends MenuScreen {
  /** Leave this screen with a result; leaving with none is a cancel. */
  close: (result?: T) => void;
}

/** Builds the component one screen renders until it closes. */
export type ScreenBuilder<T> = (screen: Screen<T>) => Component;

/** What a level can do while it is the top of the menu. */
export interface MenuNavigation {
  /** Enter `level`: it becomes the view, the one below it is kept as it is. */
  push(level: MenuLevel): void;
  /** Leave this level: the one below shows, and the menu closes at the root. */
  pop(): void;
  /** Show this level again, rebuilt from the state it reads now. */
  refresh(): void;
  /** Leave the whole menu, whatever is below. */
  close(): void;
}

/** What a level is handed when it is built. */
export interface LevelSteps extends MenuScreen {
  /** Whether this level is still the top of the stack: false once it was left or replaced. */
  stillHere: () => boolean;
  nav: MenuNavigation;
}

/** One level of the menu: a builder, so `refresh` reads its state again. */
export type MenuLevel = (steps: LevelSteps) => Component | Promise<Component>;

/** What `pop` finds when there is nothing below — the menu is already gone. */
export const NO_LEVEL = Symbol("no-level");
export type NoLevel = typeof NO_LEVEL;

/** What the stack needs from the one screen that renders its top level. */
export interface LevelHost {
  /** Render `body` as the menu. */
  show(body: Component): void;
  /** The stack emptied: the menu is finished. */
  done(): void;
}

interface Entry {
  readonly build: MenuLevel;
  /** The body this level mounted, kept for the way back. */
  body: Component | undefined;
  /** Ends whatever awaits this level (a pushed `open`). */
  readonly onLeave: () => void;
}

/** A menu's levels, deepest last, the root level always at the bottom. */
export class LevelStack {
  private entries: Entry[] = [];
  private readonly navigation: MenuNavigation;

  constructor(
    private readonly host: LevelHost,
    private readonly screen: MenuScreen,
    root: MenuLevel,
  ) {
    this.navigation = {
      push: (level) => this.push(level),
      pop: () => this.pop(),
      refresh: () => this.refresh(),
      close: () => this.close(),
    };
    this.push(root);
  }

  /** How many levels are on the stack; the menu is open exactly while this is not zero. */
  get depth(): number {
    return this.entries.length;
  }

  /** The navigation handed to every level built from here on. */
  get nav(): MenuNavigation {
    return this.navigation;
  }

  /** Put `level` on top and show it. */
  push(level: MenuLevel, onLeave: () => void = () => {}): void {
    const entry: Entry = { build: level, body: undefined, onLeave };
    this.entries.push(entry);
    this.run(entry);
  }

  /**
   * Take the top level off and show the one below it, as the user left it.
   * Returns `NoLevel` when there was nothing to pop.
   */
  pop(): MenuLevel | NoLevel {
    const popped = this.entries.pop();
    if (popped === undefined) return NO_LEVEL;
    popped.onLeave();
    const below = this.entries.at(-1);
    if (below === undefined) {
      this.host.done();
      return popped.build;
    }
    // A level whose builder has not returned yet has no body to show; building
    // it now is the only way back to it.
    if (below.body === undefined) this.run(below);
    else this.host.show(below.body);
    return popped.build;
  }

  /** Show the top level again, rebuilt from the current state. */
  refresh(): void {
    const top = this.entries.at(-1);
    if (top === undefined) return;
    // A fresh entry, so the run it replaces can no longer mount over this one.
    const fresh: Entry = {
      build: top.build,
      body: undefined,
      onLeave: top.onLeave,
    };
    this.entries[this.entries.length - 1] = fresh;
    this.run(fresh);
  }

  /** Leave the whole menu: every level is dropped and the screen closes. */
  close(): void {
    const dropped = this.entries;
    this.entries = [];
    for (const entry of dropped) entry.onLeave();
    this.host.done();
  }

  private run(entry: Entry): void {
    const steps: LevelSteps = {
      ...this.screen,
      stillHere: () => this.entries.at(-1) === entry,
      nav: this.navigation,
    };
    const mount = (body: Component): void => {
      // A level replaced by `refresh`, popped, or dropped by `close` must not
      // take the frame from the one showing now.
      if (this.entries.at(-1) !== entry) return;
      entry.body = body;
      this.host.show(body);
    };
    // A synchronous builder mounts now: an in-place submenu used to appear on
    // the keypress that opened it, and a level does the same.
    const built = entry.build(steps);
    if (built instanceof Promise) void built.then(mount);
    else mount(built);
  }
}
