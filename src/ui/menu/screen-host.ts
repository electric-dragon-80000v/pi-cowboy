/**
 * screen-host.ts — how the /cowboy screens open and close, and the submenu
 * boundary a screen shares with the list that hosts it.
 *
 * `ScreenHost.open` is one `ctx.ui.custom` call per screen: the builder is handed
 * the theme, the keybindings and the close callback, and the call resolves with
 * what the screen closed with (no value = the user cancelled). pi-tui's custom is
 * modal, so a flow that continues opens its next screen once the previous one
 * resolves; nothing here keeps a stack of screens inside one call.
 *
 * A `SettingItem.submenu` factory returns a Component pi-tui renders in place of
 * the list's rows until the factory's `done` runs, so that boundary needs three
 * shapes of its own: a marker for a factory that completes instead of hosting
 * (`CLOSED_SUBMENU`), a flag marking a hosted screen as the owner of every key
 * (`asSubmenuComponent`), and a view whose body swaps while the frame around it
 * stays put (`SwappableView`).
 */

import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  isFocusable,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

/** One screen: the ui.custom arguments, plus the callback that ends it. */
export interface Screen<T> {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  /** Close this screen with a result; closing with no result is a cancel. */
  close: (result?: T) => void;
}

/** Builds the component one screen renders until it closes. */
export type ScreenBuilder<T> = (screen: Screen<T>) => Component;

/** Opens screens through `ctx.ui.custom`, one call each. */
export class ScreenHost {
  /** The command context these screens belong to (its ui sink, cwd, model). */
  constructor(readonly ctx: ExtensionCommandContext) {}

  /** Open a screen on its own; resolves undefined when the user cancelled. */
  async open<T>(build: ScreenBuilder<T>): Promise<T | undefined> {
    return await this.show(build, false);
  }

  /** Open a screen over the one below, for content that reads better on top. */
  async openOverlay<T>(build: ScreenBuilder<T>): Promise<T | undefined> {
    return await this.show(build, true);
  }

  private async show<T>(
    build: ScreenBuilder<T>,
    overlay: boolean,
  ): Promise<T | undefined> {
    return await this.ctx.ui.custom<T | undefined>(
      (tui, theme, keybindings, done) =>
        build({ tui, theme, keybindings, close: (result) => done(result) }),
      overlay ? { overlay: true } : undefined,
    );
  }
}

/**
 * Close the submenu a factory is building. pi-tui stores the factory's return
 * value as the row's open submenu and only a falsy one leaves it closed, while
 * `SettingItem.submenu` promises a Component — the cast marks that boundary.
 */
export const CLOSED_SUBMENU = undefined as unknown as Component;

/**
 * Host a screen as a submenu, where it owns every key. Our frame asks
 * `isFocusable` before it remaps j/k or the horizontal arrows, so the child has
 * to carry a `focused` field to claim them; pi-tui's own lists declare none.
 */
export function asSubmenuComponent<T extends Component>(
  screen: T,
): T & Focusable {
  return Object.assign(screen, { focused: true });
}

/**
 * One in-place view whose body swaps: the agent list → a per-agent actions list,
 * a search dialog → the field it opens. The frame around it keeps talking to the
 * same object while reads, writes, rendering and keys follow the body showing.
 */
export class SwappableView implements Component {
  private active: Component;

  constructor(initial: Component) {
    this.active = initial;
  }

  /** Show `body` in place of the body showing now. */
  activate(body: Component): void {
    this.active = body;
  }

  invalidate(): void {
    this.active.invalidate();
  }

  render(width: number): string[] {
    return this.active.render(width);
  }

  handleInput(data: string): void {
    this.active.handleInput?.(data);
  }

  /** Key ownership follows the body, and is what marks this view as a leaf. */
  get focused(): boolean {
    return isFocusable(this.active) ? this.active.focused : false;
  }

  set focused(value: boolean) {
    if (isFocusable(this.active)) this.active.focused = value;
  }
}

/** The list shape the separator skip navigates: pi-tui's private rows and cursor. */
export interface NavigableList<T = unknown> {
  items: T[];
  selectedIndex: number | null;
}

/**
 * pi-tui's private list fields, which the frame, a rebuild and the separator
 * skip read and write. The library keeps them on the instance but out of its
 * types, so `asListFields` is the single cast marking that boundary.
 */
export interface ListFields<T = unknown> extends NavigableList<T> {
  /** Rows a search-enabled SettingsList filters to; a rebuild writes it too. */
  filteredItems: T[];
  /** The in-place child view showing in place of the rows, or null. */
  submenuComponent: Component | null;
  onCancel?: () => void;
}

/** Read pi-tui's private list fields from the list instance. */
export function asListFields<T = unknown>(list: Component): ListFields<T> {
  return list as unknown as ListFields<T>;
}
