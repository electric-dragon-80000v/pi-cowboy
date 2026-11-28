/**
 * screen-host.ts — how a screen opens.
 *
 * `ScreenHost.open` asks for a screen; the menu it belongs to mounts that as a
 * level on its own stack (see menu-session), so a screen opened from a running
 * menu is one `pop` from the view it came from. Outside a menu — a flow that
 * runs on its own — the screen is the whole menu, and opening it starts one.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMenuSession } from "../../shell.js";
import type { ScreenBuilder } from "./menu-levels.js";
import { MenuSession } from "./menu-session.js";

/** Opens screens on the menu its command context is showing. */
export class ScreenHost {
  /** The command context these screens belong to (its ui sink, cwd, model). */
  constructor(readonly ctx: ExtensionCommandContext) {}

  /** Push a screen and resolve with what it was closed with. */
  async open<T>(build: ScreenBuilder<T>): Promise<T | undefined> {
    return await this.session().open(build);
  }

  /**
   * Push a screen that reads better on top (a viewer, a confirmation). It is a
   * level like any other: one step up shows the menu it came from.
   */
  async openOverlay<T>(build: ScreenBuilder<T>): Promise<T | undefined> {
    return await this.open(build);
  }

  private session(): MenuSession {
    // Inside a running menu, a screen is a level on its stack; outside one, the
    // screen is the whole menu, so its own session hosts it.
    return getMenuSession(this.ctx) ?? new MenuSession(this.ctx);
  }
}
