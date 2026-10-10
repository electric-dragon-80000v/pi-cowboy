/**
 * extension-switch.test.ts — the persisted on/off switch.
 * Pins: the tool-name set against the tools registration actually registers,
 * the flag read, both halves of the switch (register the agent tool's type list
 * and move the names in and out of the active set), the global-layer write, and
 * the `/cowboy` dispatch of `spawn`/`status`/`model`, `enable`/`disable` and its
 * fall-through to the main menu.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  ConfigStore,
  type ConfigIO,
  type RawConfig,
} from "../src/config/config-store.js";
import type { LoadedConfig } from "../src/config/config-io.js";
import { getStore } from "../src/shell.js";
import {
  recordOverlayMount,
  type OverlayCallOptions,
  type OverlayMount,
} from "./helpers/overlay-mounts.js";

/** The shell the switch reads: a store and a pi, replaced per test. */
const shell = vi.hoisted(() => ({
  store: null as unknown,
  active: [] as string[],
  registeredTools: [] as string[],
}));

vi.mock("../src/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/shell.js")>()),
  getStore: () => shell.store,
  getPiInstance: () => ({
    getActiveTools: () => [...shell.active],
    setActiveTools: (names: string[]) => {
      shell.active = names;
    },
    registerTool: (tool: { name: string }) => {
      shell.registeredTools.push(tool.name);
    },
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  }),
}));

const menus = vi.hoisted(() => ({
  showAgentsMainMenu: vi.fn(async () => {}),
  showAgentsActionMenu: vi.fn(async () => {}),
}));
vi.mock("../src/ui/menu/menus.js", () => menus);

const worktreeCommand = vi.hoisted(() => ({
  showWorktreeCommandMenu: vi.fn(async () => {}),
}));
vi.mock("../src/ui/menu/menu-worktree-command.js", () => worktreeCommand);

const {
  COWBOY_TOOLS,
  COWBOY_TOOL_NAMES,
  activateExtension,
  deactivateExtension,
  registerTools,
  registerCowboyCommand,
  registerUnavailableCowboyCommand,
  setExtensionEnabled,
} = await import("../src/registration.js");
const { isExtensionEnabled, setShowActiveIndicator, syncExtensionIndicator } =
  await import("../src/extension-toggle.js");
const { cowboyCompletions } = await import("../src/ui/menu/model-picker.js");

/** In-memory ConfigIO: records every save so persistence is assertable. */
function memoryIO(global: RawConfig): {
  io: ConfigIO;
  savedGlobal: RawConfig[];
} {
  const savedGlobal: RawConfig[] = [];
  return {
    savedGlobal,
    io: {
      load: (): LoadedConfig => ({
        global: structuredClone(global),
        project: null,
        projectStatus: "untrusted",
      }),
      isGlobalWritable: () => true,
      saveGlobal: (config) => {
        savedGlobal.push(structuredClone(config));
      },
      saveProject: () => {},
    },
  };
}

/** Installs a store over the given global layer. */
function install(global: RawConfig): RawConfig[] {
  const memory = memoryIO(global);
  shell.store = new ConfigStore(memory.io);
  return memory.savedGlobal;
}

/** The registered `/cowboy` command, captured off a fake pi. */
function captureCommand() {
  let command:
    | {
        description: string;
        getArgumentCompletions: (prefix: string) => Promise<unknown>;
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    | undefined;
  const registrationPi = {
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerCommand: (_name: string, registered: unknown) => {
      command = registered as typeof command;
    },
  } as unknown as ExtensionAPI;
  registerCowboyCommand(registrationPi);
  if (!command) throw new Error("registerCowboyCommand registered no command");
  return command;
}

/** The ui the switch writes into, plus every presence-marker overlay it mounts. */
function fakeUi(notify?: ReturnType<typeof vi.fn>): {
  ui: ExtensionUIContext;
  markers: OverlayMount[];
} {
  const markers: OverlayMount[] = [];
  const ui = {
    notify: notify ?? vi.fn(),
    custom: (factory: () => Component, options?: OverlayCallOptions) => {
      markers.push(recordOverlayMount(factory, options));
      return Promise.resolve(undefined);
    },
  } as unknown as ExtensionUIContext;
  return { ui, markers };
}

/** A command context over a recording ui, for the /cowboy dispatch tests. */
function commandContext(notify: ReturnType<typeof vi.fn>) {
  const { ui, markers } = fakeUi(notify);
  return {
    ui,
    markers,
    modelRegistry: { getAvailable: () => [] },
    scopedModels: [],
  };
}

beforeEach(() => {
  menus.showAgentsMainMenu.mockClear();
  menus.showAgentsActionMenu.mockClear();
  worktreeCommand.showWorktreeCommandMenu.mockClear();
  shell.active = [];
  shell.registeredTools = [];
});

describe("COWBOY_TOOL_NAMES", () => {
  it("names exactly the tools registration registers, in order", () => {
    const names: string[] = [];
    const registrationPi = {
      registerTool: (tool: { name: string }) => {
        names.push(tool.name);
      },
      registerMessageRenderer: () => {},
      registerCommand: () => {},
    } as unknown as ExtensionAPI;

    registerTools(registrationPi);

    expect(names).toEqual([...COWBOY_TOOL_NAMES]);
  });
});

describe("isExtensionEnabled", () => {
  it("reads the switch off the resolved agent settings", () => {
    install({ agent: { extensionEnabled: false } });
    expect(isExtensionEnabled()).toBe(false);

    install({});
    expect(isExtensionEnabled()).toBe(true);
  });
});

describe("syncExtensionIndicator", () => {
  it("mounts the marker overlay while the switch is on", () => {
    install({});
    const { ui, markers } = fakeUi();

    syncExtensionIndicator(ui);

    expect(markers).toHaveLength(2);
    expect(markers[0]!.options?.overlay).toBe(true);
    expect(markers[0]!.hidden()).toBe(false);
  });

  it("takes the marker down while the switch is off", () => {
    install({});
    const { ui, markers } = fakeUi();
    syncExtensionIndicator(ui);
    install({ agent: { extensionEnabled: false } });

    syncExtensionIndicator(ui);

    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(true);
  });

  it("takes the marker down while the indicator setting is off", () => {
    install({});
    const { ui, markers } = fakeUi();
    syncExtensionIndicator(ui);
    install({ agent: { showActiveIndicator: false } });

    syncExtensionIndicator(ui);

    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(true);
  });
});

describe("setShowActiveIndicator", () => {
  it("persists the choice globally and takes the marker down", () => {
    const savedGlobal = install({});
    const { ui, markers } = fakeUi();
    syncExtensionIndicator(ui);

    setShowActiveIndicator(ui, false);

    expect(savedGlobal.at(-1)?.agent?.showActiveIndicator).toBe(false);
    expect(getStore().agent.showActiveIndicator).toBe(false);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(true);
  });

  it("mounts the marker again when turned back on", () => {
    const savedGlobal = install({ agent: { showActiveIndicator: false } });
    const { ui, markers } = fakeUi();

    setShowActiveIndicator(ui, true);

    expect(savedGlobal.at(-1)?.agent?.showActiveIndicator).toBe(true);
    expect(markers.at(-1)?.options?.overlay).toBe(true);
    expect(markers.at(-1)!.hidden()).toBe(false);
  });

  it("mounts nothing while the extension itself is off", () => {
    install({ agent: { extensionEnabled: false, showActiveIndicator: false } });
    const { ui, markers } = fakeUi();

    setShowActiveIndicator(ui, true);

    expect(markers).toEqual([]);
  });
});

describe("activateExtension", () => {
  it("re-registers the agent tool, adds each name to the active set once, and mounts the marker", () => {
    install({});
    shell.active = ["read", "cowboy_agent", "bash"];
    const { ui, markers } = fakeUi();

    activateExtension(ui);

    expect(shell.registeredTools).toEqual([COWBOY_TOOLS.agent]);
    expect(shell.active).toEqual([
      "read",
      "cowboy_agent",
      "bash",
      ...COWBOY_TOOL_NAMES.slice(1),
    ]);
    expect(new Set(shell.active).size).toBe(shell.active.length);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(false);
  });

  it("leaves a loadout that already has every name untouched", () => {
    install({});
    shell.active = ["read", ...COWBOY_TOOL_NAMES];

    activateExtension(fakeUi().ui);

    expect(shell.active).toEqual(["read", ...COWBOY_TOOL_NAMES]);
  });
});

describe("deactivateExtension", () => {
  it("removes exactly the Cowboy tools and keeps the order of the rest", () => {
    install({});
    shell.active = [
      "read",
      "merge_cowboy_branch",
      "bash",
      "cowboy_agent",
      "stop_cowboy_agent",
    ];

    deactivateExtension(fakeUi().ui);

    expect(shell.active).toEqual(["read", "bash"]);
  });

  it("takes the marker down when the switch is off", () => {
    install({});
    const { ui, markers } = fakeUi();
    syncExtensionIndicator(ui);
    install({ agent: { extensionEnabled: false } });

    deactivateExtension(ui);

    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(true);
  });

  it("is a no-op on a loadout without them", () => {
    install({});
    shell.active = ["read", "bash"];

    deactivateExtension(fakeUi().ui);

    expect(shell.active).toEqual(["read", "bash"]);
  });
});

describe("setExtensionEnabled", () => {
  it("persists the choice globally, unloads the tools, and takes the marker down when disabled", () => {
    const savedGlobal = install({});
    shell.active = ["read", "bash", ...COWBOY_TOOL_NAMES];
    const { ui, markers } = fakeUi();
    syncExtensionIndicator(ui);

    setExtensionEnabled(ui, false);

    expect(savedGlobal.at(-1)?.agent?.extensionEnabled).toBe(false);
    expect(isExtensionEnabled()).toBe(false);
    expect(shell.active).toEqual(["read", "bash"]);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(true);
  });

  it("persists the choice globally, loads the tools, and mounts the marker when enabled", () => {
    const savedGlobal = install({ agent: { extensionEnabled: false } });
    shell.active = ["read", "bash"];
    const { ui, markers } = fakeUi();

    setExtensionEnabled(ui, true);

    expect(savedGlobal.at(-1)?.agent?.extensionEnabled).toBe(true);
    expect(isExtensionEnabled()).toBe(true);
    expect(shell.registeredTools).toEqual([COWBOY_TOOLS.agent]);
    expect(shell.active).toEqual(["read", "bash", ...COWBOY_TOOL_NAMES]);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.hidden()).toBe(false);
  });
});

describe("registerUnavailableCowboyCommand", () => {
  it("registers /cowboy that reports the reason instead of opening a menu", async () => {
    let name: string | undefined;
    let registered:
      | {
          description: string;
          handler: (args: string, ctx: unknown) => Promise<void>;
        }
      | undefined;
    const registrationPi = {
      registerCommand: (_name: string, options: unknown) => {
        name = _name;
        registered = options as typeof registered;
      },
    } as unknown as ExtensionAPI;

    registerUnavailableCowboyCommand(registrationPi, "not inside a git repo");
    if (!registered) {
      throw new Error("registerUnavailableCowboyCommand registered no command");
    }

    const notify = vi.fn();
    await registered.handler("status", commandContext(notify));

    expect(name).toBe("cowboy");
    expect(registered.description).toBe("not inside a git repo");
    expect(notify).toHaveBeenCalledWith("not inside a git repo", "warning");
    expect(menus.showAgentsActionMenu).not.toHaveBeenCalled();
    expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
  });
});

describe("/cowboy dispatch", () => {
  it("disables the extension, unloads the tools, takes the marker down, and never opens the menu", async () => {
    install({});
    shell.active = ["read", "bash", ...COWBOY_TOOL_NAMES];
    const notify = vi.fn();
    const ctx = commandContext(notify);
    syncExtensionIndicator(ctx.ui);

    await captureCommand().handler("disable", ctx);

    expect(isExtensionEnabled()).toBe(false);
    expect(shell.active).toEqual(["read", "bash"]);
    expect(notify).toHaveBeenCalledWith("pi-cowboy disabled", "info");
    expect(ctx.markers).toHaveLength(2);
    expect(ctx.markers[0]!.hidden()).toBe(true);
    expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
  });

  it("enables the extension, loads the tools, mounts the marker, and never opens the menu", async () => {
    install({ agent: { extensionEnabled: false } });
    shell.active = ["read", "bash"];
    const notify = vi.fn();
    const ctx = commandContext(notify);

    await captureCommand().handler("enable", ctx);

    expect(isExtensionEnabled()).toBe(true);
    expect(shell.active).toEqual(["read", "bash", ...COWBOY_TOOL_NAMES]);
    expect(notify).toHaveBeenCalledWith("pi-cowboy enabled", "info");
    expect(ctx.markers).toHaveLength(2);
    expect(ctx.markers[0]!.options?.overlay).toBe(true);
    expect(ctx.markers[0]!.hidden()).toBe(false);
    expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
  });

  it("reports an already disabled extension without touching the tools", async () => {
    const savedGlobal = install({ agent: { extensionEnabled: false } });
    const notify = vi.fn();

    await captureCommand().handler("disable", commandContext(notify));

    expect(notify).toHaveBeenCalledWith(
      "pi-cowboy is already disabled",
      "info",
    );
    expect(savedGlobal).toHaveLength(0);
    expect(shell.active).toEqual([]);
  });

  it("reports an already enabled extension without touching the tools", async () => {
    const savedGlobal = install({});
    const notify = vi.fn();

    await captureCommand().handler("enable", commandContext(notify));

    expect(notify).toHaveBeenCalledWith("pi-cowboy is already enabled", "info");
    expect(savedGlobal).toHaveLength(0);
    expect(shell.active).toEqual([]);
  });

  it("warns with the updated usage for an unknown argument and stops there", async () => {
    install({});
    const notify = vi.fn();

    await captureCommand().handler("bogus", commandContext(notify));

    expect(notify).toHaveBeenCalledWith(
      'Unknown option "bogus". Usage: /cowboy [status | spawn | worktree [<name>] | model [<provider/model-id>|clear] | enable | disable]',
      "warning",
    );
    expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
  });

  it.each(["spawn", "status"] as const)(
    "opens `/cowboy %s` without the main menu, on the session's model options",
    async (subcommand) => {
      install({});
      const notify = vi.fn();
      const ctx = {
        ...commandContext(notify),
        scopedModels: [{ model: { provider: "anthropic", id: "claude" } }],
      };

      await captureCommand().handler(subcommand, ctx);

      expect(menus.showAgentsActionMenu).toHaveBeenCalledWith(ctx, subcommand, [
        "anthropic/claude",
      ]);
      expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it.each(["spawn", "status", "model"] as const)(
    "refuses `/cowboy %s` while the extension is off",
    async (subcommand) => {
      install({ agent: { extensionEnabled: false } });
      const notify = vi.fn();

      await captureCommand().handler(subcommand, commandContext(notify));

      expect(notify).toHaveBeenCalledWith(
        "pi-cowboy is disabled. Run /cowboy enable first.",
        "warning",
      );
      expect(menus.showAgentsActionMenu).not.toHaveBeenCalled();
    },
  );

  it("runs `/cowboy model` while the extension is on", async () => {
    install({});
    const notify = vi.fn();

    await captureCommand().handler("model clear", commandContext(notify));

    expect(notify).toHaveBeenCalledWith(
      "Subagent model override cleared (session) — inherits parent/configured default",
      "info",
    );
  });

  it("runs `/cowboy worktree` while the extension is off, on the inline name", async () => {
    install({ agent: { extensionEnabled: false } });
    const notify = vi.fn();
    const ctx = commandContext(notify);

    await captureCommand().handler("worktree my-branch", ctx);

    expect(worktreeCommand.showWorktreeCommandMenu).toHaveBeenCalledWith(
      ctx,
      "my-branch",
    );
    // A worktree needs none of the cowboy tools, so the switch refuses nothing.
    expect(notify).not.toHaveBeenCalled();
    expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
  });

  it("opens the name field empty for a bare `/cowboy worktree`", async () => {
    install({ agent: { extensionEnabled: false } });
    const ctx = commandContext(vi.fn());

    await captureCommand().handler("worktree", ctx);

    expect(worktreeCommand.showWorktreeCommandMenu).toHaveBeenCalledWith(
      ctx,
      "",
    );
  });

  it("treats a tab or a run of spaces as the separator before the inline name", async () => {
    install({ agent: { extensionEnabled: false } });
    const ctx = commandContext(vi.fn());
    const { handler } = captureCommand();

    await handler("worktree\tmy-branch", ctx);
    await handler("worktree   my-branch", ctx);

    expect(worktreeCommand.showWorktreeCommandMenu).toHaveBeenNthCalledWith(
      1,
      ctx,
      "my-branch",
    );
    expect(worktreeCommand.showWorktreeCommandMenu).toHaveBeenNthCalledWith(
      2,
      ctx,
      "my-branch",
    );
  });

  it("names only the first word of an unrecognized argument", async () => {
    install({});
    const notify = vi.fn();

    await captureCommand().handler("bogus\tthing", commandContext(notify));

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Unknown option "bogus". Usage: /cowboy'),
      "warning",
    );
  });

  it("opens the main menu on the registry's models when no argument is given", async () => {
    install({});
    const notify = vi.fn();
    const ctx = {
      ...commandContext(notify),
      modelRegistry: {
        getAvailable: () => [{ provider: "openai", id: "gpt" }],
      },
    };

    await captureCommand().handler("", ctx);

    expect(menus.showAgentsMainMenu).toHaveBeenCalledWith(ctx, ["openai/gpt"]);
    expect(menus.showAgentsActionMenu).not.toHaveBeenCalled();
  });

  it("offers status, spawn, worktree, model, enable and disable as completions", () => {
    expect(cowboyCompletions("")?.map((item) => item.value)).toEqual([
      "status",
      "spawn",
      "worktree",
      "model",
      "enable",
      "disable",
    ]);
  });
});
