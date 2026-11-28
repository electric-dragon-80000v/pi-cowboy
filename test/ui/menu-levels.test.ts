/**
 * menu-levels.test.ts — the level stack on its own, against a host that records
 * what it is asked to show: the root it is born holding, a push on top, a pop
 * that returns to the body the user left, an empty stack handing the menu back,
 * a refresh that rebuilds the top, and the one invariant behind all of them —
 * a builder mounts only while it is still the top entry.
 */
import { describe, expect, it } from "vitest";
import type {
  Component,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  LevelStack,
  NO_LEVEL,
  type LevelHost,
  type MenuLevel,
} from "../../src/ui/menu/menu-levels.js";

/** A body recording that it rendered, so a test can tell instances apart. */
function body(name: string): Component & { name: string } {
  return {
    name,
    invalidate() {},
    render: () => [name],
  };
}

/** The stack's screen, as the session would hand it over. */
const screen = {
  tui: { requestRender() {} } as unknown as TUI,
  theme: {} as Theme,
  keybindings: {} as KeybindingsManager,
};

/** A host recording what it showed and whether it was told the menu is done. */
function host(): LevelHost & { shown: string[]; finished: number } {
  const record = {
    shown: [] as string[],
    finished: 0,
    show: (shown: Component) => {
      record.shown.push(
        (shown as unknown as { name?: string }).name ?? "(unnamed)",
      );
    },
    done: () => {
      record.finished += 1;
    },
  };
  return record;
}

/** A promise a test resolves by hand, for the builders that await. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let the stack's promise continuations run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe("level stack — the stack's own operations", () => {
  it("is born holding its root level and shows it", async () => {
    const view = host();
    const stack = new LevelStack(view, screen, () => body("list"));
    await settle();

    expect(stack.depth).toBe(1);
    expect(view.shown).toEqual(["list"]);
  });

  it("pushes a level on top and shows it", async () => {
    const view = host();
    const stack = new LevelStack(view, screen, () => body("list"));

    stack.push(() => body("actions"));
    await settle();

    expect(stack.depth).toBe(2);
    expect(view.shown).toEqual(["list", "actions"]);
  });

  it("pops back to the body the user left, without rebuilding it", async () => {
    const view = host();
    const list = body("list");
    const actions = body("actions");
    const stack = new LevelStack(view, screen, () => list);
    stack.push(() => actions);
    await settle();

    const popped = stack.pop();
    await settle();

    expect(popped).not.toBe(NO_LEVEL);
    expect(stack.depth).toBe(1);
    expect(view.shown).toEqual(["list", "actions", "list"]);
  });

  it("pops the root into an empty stack, hands the menu back, and reports NO_LEVEL after", async () => {
    const view = host();
    const stack = new LevelStack(view, screen, () => body("list"));
    await settle();

    expect(stack.pop()).not.toBe(NO_LEVEL);
    expect(stack.depth).toBe(0);
    expect(view.finished).toBe(1);
    expect(stack.pop()).toBe(NO_LEVEL);
  });

  it("rebuilds the top level on refresh, keeping the depth", async () => {
    const view = host();
    const stack = new LevelStack(view, screen, () => body("list"));
    stack.push(() => body("actions"));
    await settle();

    stack.refresh();
    await settle();

    expect(stack.depth).toBe(2);
    expect(view.shown).toEqual(["list", "actions", "actions"]);
  });

  it("empties on close after which nothing mounts and nothing is on top", async () => {
    const view = host();
    const stack = new LevelStack(view, screen, () => body("list"));
    stack.push(() => body("actions"));
    await settle();

    stack.close();
    stack.refresh();
    await settle();

    expect(stack.depth).toBe(0);
    expect(view.shown).toEqual(["list", "actions"]);
    expect(view.finished).toBe(1);
  });
});

describe("level stack — a builder mounts only while it is the top", () => {
  it("mounts when its level is still on top", async () => {
    const view = host();
    const waited = deferred();
    const stack = new LevelStack(view, screen, () => body("list"));
    stack.push(async () => {
      await waited.promise;
      return body("actions");
    });

    waited.release();
    await settle();

    expect(view.shown).toEqual(["list", "actions"]);
  });

  it("refuses to mount after its level was popped", async () => {
    const view = host();
    const waited = deferred();
    const stack = new LevelStack(view, screen, () => body("list"));
    stack.push(async () => {
      await waited.promise;
      return body("actions");
    });

    stack.pop();
    waited.release();
    await settle();

    expect(view.shown).toEqual(["list", "list"]);
  });

  it("refuses to mount after its level was refreshed away", async () => {
    const view = host();
    const runs: { release: () => void }[] = [];
    const stack = new LevelStack(view, screen, () => body("list"));
    stack.push(async () => {
      const waited = deferred();
      runs.push(waited);
      await waited.promise;
      return body("actions");
    });

    stack.refresh();
    await settle();
    runs[0]?.release();
    await settle();

    // The replaced run mounts nothing; the refresh's own run still does.
    expect(runs).toHaveLength(2);
    expect(view.shown).toEqual(["list"]);
    runs[1]?.release();
    await settle();
    expect(view.shown).toEqual(["list", "actions"]);
  });

  it("refuses to mount after the menu was closed", async () => {
    const view = host();
    const waited = deferred();
    const level: MenuLevel = async () => {
      await waited.promise;
      return body("list");
    };
    const stack = new LevelStack(view, screen, level);

    stack.close();
    waited.release();
    await settle();

    expect(view.shown).toEqual([]);
    expect(view.finished).toBe(1);
  });

  it("gives every level the navigation that acts on the stack", async () => {
    const view = host();
    let nav: import("../../src/ui/menu/menu-levels.js").MenuNavigation | null =
      null;
    new LevelStack(view, screen, ({ nav: levelNav }) => {
      nav = levelNav;
      return body("list");
    });
    await settle();

    nav!.push(() => body("actions"));
    await settle();

    expect(view.shown).toEqual(["list", "actions"]);
  });
});
