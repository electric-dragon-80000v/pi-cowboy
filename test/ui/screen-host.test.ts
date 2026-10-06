/**
 * screen-host.test.ts — the screen host's own contract: one ctx.ui.custom call
 * per screen, a close value reaching its caller, a cancel ending a flow before
 * its next screen opens, and an in-place child that owns the keys.
 *
 * The menus' frames and rows are the characterization suite's subject; these
 * tests drive the host directly, through the same harness the menus use.
 */
import { describe, expect, it } from "vitest";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ScreenHost,
  SwappableView,
  asListFields,
  asSubmenuComponent,
} from "../../src/ui/menu/screen-host.js";
import { KEY, openMenu } from "./harness.js";

/** What a probe component remembers about the screen it stood in. */
interface Probe extends Component {
  inputs: string[];
  widths: number[];
  invalidated: number;
}

/** A screen body recording what the host rendered and handed it. */
function probe(): Probe {
  const body: Probe = {
    inputs: [],
    widths: [],
    invalidated: 0,
    invalidate() {
      body.invalidated += 1;
    },
    render(width: number) {
      body.widths.push(width);
      return [`probe ${width}`];
    },
    handleInput(data: string) {
      body.inputs.push(data);
    },
  };
  return body;
}

/** A screen body that records it opened and closes with `result` on `key`. */
function step<T>(
  opened: string[],
  name: string,
  key: string,
  close: (result?: T) => void,
  result?: T,
): Probe {
  const body = probe();
  opened.push(name);
  body.handleInput = (data) => {
    if (data === key) close(result);
  };
  return body;
}

describe("screen host — one screen per custom call", () => {
  it("opens a screen and resolves with the value it was closed with", async () => {
    const session = openMenu((ctx: ExtensionCommandContext) =>
      new ScreenHost(ctx).open<number>(({ close }) =>
        step([], "only", KEY.enter, close, 7),
      ),
    );
    await session.whenScreens(1);

    session.press(KEY.enter);
    await session.settle();

    expect(session.screenCount).toBe(1);
    expect(session.closedScreens).toEqual([0]);
    expect(await session.finished).toBe(7);
  });

  it("resolves undefined when the screen is closed with no result", async () => {
    const session = openMenu((ctx: ExtensionCommandContext) =>
      new ScreenHost(ctx).open<string>(({ close }) =>
        step([], "only", KEY.escape, close),
      ),
    );
    await session.whenScreens(1);

    session.press(KEY.escape);
    await session.settle();

    expect(session.closedScreens).toEqual([0]);
    expect(await session.finished).toBeUndefined();
  });

  it("renders the builder's component and passes keys to it", async () => {
    const body = probe();
    const session = openMenu((ctx: ExtensionCommandContext) =>
      new ScreenHost(ctx).open<void>(() => body),
    );
    await session.whenScreens(1);

    session.press("x");

    expect(session.frame()).toEqual(["probe 80"]);
    expect(body.widths).toEqual([80]);
    expect(body.inputs).toEqual(["x"]);
    expect(body.invalidated).toBe(0);
  });

  it("marks an overlay screen as an overlay", async () => {
    const options: unknown[] = [];
    const ctx = {
      ui: {
        custom: (_build: unknown, opts?: unknown) => {
          options.push(opts);
          return Promise.resolve(undefined);
        },
      },
    } as unknown as ExtensionCommandContext;
    const host = new ScreenHost(ctx);

    await host.openOverlay<void>(() => probe());
    await host.open<void>(() => probe());

    expect(options).toEqual([{ overlay: true }, undefined]);
  });
});

describe("screen host — a flow of screens", () => {
  it("stops at the step the user cancelled and never opens the next", async () => {
    const opened: string[] = [];
    const session = openMenu(async (ctx: ExtensionCommandContext) => {
      const host = new ScreenHost(ctx);
      // No result is a cancel: Escape on a real menu, close() here.
      const first = await host.open<string>(({ close }) =>
        step(opened, "first", KEY.escape, close),
      );
      if (first === undefined) return;
      await host.open<string>(() =>
        step(opened, "second", KEY.enter, () => {}),
      );
    });
    await session.whenScreens(1);

    session.press(KEY.escape);
    await session.settle();

    expect(opened).toEqual(["first"]);
    expect(session.screenCount).toBe(1);
    expect(await session.finished).toBeUndefined();
  });

  it("hands each step's result to the next and to the caller", async () => {
    const opened: string[] = [];
    const session = openMenu(async (ctx: ExtensionCommandContext) => {
      const host = new ScreenHost(ctx);
      const type = await host.open<string>(({ close }) =>
        step(opened, "first", KEY.enter, close, "general-purpose"),
      );
      if (type === undefined) return;
      return await host.open<string>(({ close }) =>
        step(opened, "second", KEY.enter, close, `run as ${type}`),
      );
    });
    await session.whenScreens(1);

    session.press(KEY.enter);
    await session.settle();
    await session.whenScreens(2);

    expect(opened).toEqual(["first", "second"]);
    expect(session.title()).toBe("probe 80");

    session.press(KEY.enter);
    await session.settle();

    expect(session.screenCount).toBe(2);
    expect(await session.finished).toBe("run as general-purpose");
  });
});

describe("screen host — in-place children", () => {
  it("routes every read, key and render to the body showing now", () => {
    const first = probe();
    const second = probe();
    const view = new SwappableView(first);

    view.focused = true;
    expect(view.render(40)).toEqual(["probe 40"]);
    view.handleInput("j");

    view.activate(second);
    expect(view.render(40)).toEqual(["probe 40"]);
    view.handleInput("k");
    view.invalidate();

    expect(first.inputs).toEqual(["j"]);
    expect(second.inputs).toEqual(["k"]);
    expect(first.invalidated).toBe(0);
    expect(second.invalidated).toBe(1);
  });

  it("keeps the body's focus reachable through the view", () => {
    const focusable: Probe & Focusable = { ...probe(), focused: false };
    const view = new SwappableView(focusable);

    expect(view.focused).toBe(false);
    view.focused = true;
    expect(focusable.focused).toBe(true);

    // A body with no focus of its own is not a focusable child.
    view.activate(probe());
    expect(view.focused).toBe(false);
    view.focused = true;
    expect(view.focused).toBe(false);
  });

  it("marks a hosted screen as the key owner for our frame's focusable probe", () => {
    const screen = probe();
    expect("focused" in screen).toBe(false);

    const hosted = asSubmenuComponent(screen);
    expect("focused" in hosted).toBe(true);
  });

  it("reads pi-tui's private list fields through one accessor", () => {
    const list = { ...probe(), items: [1, 2], selectedIndex: 1 };
    const fields = asListFields<number>(list);

    expect(fields.items).toEqual([1, 2]);
    expect(fields.selectedIndex).toBe(1);

    fields.items = [3];
    expect(list.items).toEqual([3]);
  });
});
