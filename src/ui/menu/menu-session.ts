/**
 * menu-session.ts — the one screen a /cowboy invocation runs its menu on.
 *
 * `MenuSession.run` opens a single `ctx.ui.custom` call and mounts a level
 * stack in it: every screen the menu can reach is a level, so the stack is the
 * whole of the navigation. The screen closes when the stack empties — the root
 * level popped — which is why a flow that reports a result and a flow the user
 * backed out of are the same one step up.
 *
 * Screens that predate the stack still ask `ScreenHost.open` for a screen of
 * their own; that call is a push now (`open`), resolving with the value the
 * level was closed with. Rows that used to host a pi-tui submenu go through
 * `pushableItems`, which turns each `submenu:` factory into a level, so the
 * library never mounts a child of its own.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  SettingsList,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { ownsUiFlow, setMenuSession } from "../../shell.js";
import {
  LevelStack,
  type LevelSteps,
  type MenuLevel,
  type MenuNavigation,
  type MenuScreen,
  type ScreenBuilder,
} from "./menu-levels.js";
import { CLOSED_SUBMENU } from "./submenu-contract.js";
import { SwappableView } from "./swappable-view.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** A body that shows nothing, mounted until the root level builds its own. */
const EMPTY_BODY = {
  invalidate() {},
  render: (): string[] => [],
  handleInput: () => {},
};

/** One /cowboy invocation's menu: one screen, one stack of levels. */
export class MenuSession {
  private stack: LevelStack | null = null;

  constructor(private readonly ctx: ExtensionCommandContext) {}

  /**
   * Run `root` and everything the user pushes above it on one screen. Resolves
   * once the stack is empty — the menu closed or popped down to nothing.
   */
  async run(root: MenuLevel): Promise<void> {
    if (!ownsUiFlow(this.ctx)) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.stack = null;
        setMenuSession(this.ctx, null);
        resolve();
      };
      void this.ctx.ui
        .custom<void>((tui, theme, keybindings, closeScreen) => {
          const view = new SwappableView(EMPTY_BODY);
          const stack = new LevelStack(
            {
              show: (body) => {
                // A level that arrives after another command took the ui must
                // not replace the screen the user is on.
                if (!ownsUiFlow(this.ctx)) return;
                view.activate(body);
                tui.requestRender();
              },
              done: () => {
                // Only the flow that owns the ui may hand it back.
                if (ownsUiFlow(this.ctx)) closeScreen();
                finish();
              },
            },
            { tui, theme, keybindings },
            root,
          );
          this.stack = stack;
          setMenuSession(this.ctx, this);
          return view;
        })
        .then(() => resolve());
    });
  }

  /** Push `build` as a level and resolve with what it was closed with. */
  async open<T>(build: ScreenBuilder<T>): Promise<T | undefined> {
    const stack = this.stack;
    // No menu running: this screen is the whole of it.
    if (stack === null) {
      let result: T | undefined;
      await this.run((steps) => {
        const body = build({
          ...screenOf(steps),
          close: (value) => {
            result = value;
            steps.nav.pop();
          },
        });
        return body;
      });
      return result;
    }
    return await new Promise<T | undefined>((resolve) => {
      let settled = false;
      const leave = (value?: T): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      stack.push(
        (steps) =>
          build({
            ...screenOf(steps),
            close: (value) => {
              leave(value);
              steps.nav.pop();
            },
          }),
        () => leave(undefined),
      );
    });
  }

  /** Put a level on top without waiting for it. */
  push(level: MenuLevel): void {
    if (this.stack) this.stack.push(level);
    else void this.run(level);
  }

  /** Leave the top level. */
  pop(): void {
    this.stack?.pop();
  }

  /** Leave the whole menu. */
  close(): void {
    if (this.stack) this.stack.close();
  }

  /** Rebuild the top level from the state it reads now. */
  refresh(): void {
    this.stack?.refresh();
  }
}

/** The screen parts of a level, without the level's own navigation. */
function screenOf(steps: LevelSteps): MenuScreen {
  return {
    tui: steps.tui,
    theme: steps.theme,
    keybindings: steps.keybindings,
  };
}

/** Marks a `submenu:` factory already turned into a level. */
const PUSHED = Symbol("pushed-submenu");

/**
 * Rows whose `submenu:` factory becomes a level: activating the row pushes the
 * child instead of the list mounting it in place, and `done` pops it. The row's
 * value still reaches the list through `done`, exactly as a hosted submenu did.
 */
export function pushableItems(
  items: SettingItem[],
  nav: MenuNavigation,
  title: string,
): SettingItem[] {
  for (const item of items) {
    const factory = item.submenu;
    if (factory === undefined) continue;
    if ((factory as { [PUSHED]?: true })[PUSHED]) continue;
    const wrapped = (
      currentValue: string,
      done: (value?: string, options?: { navigateTo?: string }) => void,
    ): ReturnType<NonNullable<SettingItem["submenu"]>> => {
      let opened = false;
      const body = factory(currentValue, (value, options) => {
        if (opened) nav.pop();
        done(value, options);
      });
      // A row that navigates itself (pushing the flow it leads to) returns the
      // closed-submenu marker; there is nothing of its own to host.
      if (body === CLOSED_SUBMENU) return CLOSED_SUBMENU;
      opened = true;
      // The child is a screen of its own now, so it gets the frame the list it
      // came from used to draw around it — unless it brings one already.
      nav.push(({ theme }) =>
        body instanceof SettingsListWrapper
          ? body
          : new SettingsListWrapper(body, {
              title,
              theme,
              // A list navigates with j/k; anything else (a field, a search
              // dialog) reads those keys as its own input.
              passthroughKeys: !(
                body instanceof SettingsList || body instanceof SelectList
              ),
            }),
      );
      return CLOSED_SUBMENU;
    };
    (wrapped as { [PUSHED]?: true })[PUSHED] = true;
    item.submenu = wrapped;
  }
  return items;
}

/** A SettingsList whose rows navigate the menu rather than hosting children. */
export function menuSettingsList(
  items: SettingItem[],
  maxVisible: number,
  theme: ConstructorParameters<typeof SettingsList>[2],
  onChange: (id: string, newValue: string) => void,
  onCancel: () => void,
  nav: MenuNavigation,
  title: string,
  options?: ConstructorParameters<typeof SettingsList>[5],
): SettingsList {
  return new SettingsList(
    pushableItems(items, nav, title),
    maxVisible,
    theme,
    onChange,
    onCancel,
    options,
  );
}
