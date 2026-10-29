/**
 * extension-switch.test.ts — the persisted on/off switch.
 * Pins: the tool-name set against the tools registration actually registers,
 * the flag read, both halves of the switch (register the agent tool's type list
 * and move the names in and out of the active set), the global-layer write, and
 * the `/cowboy` dispatch of `spawn`/`status`/`model`, `enable`/`disable` and its
 * fall-through to the main menu, and the opencode fetch that dispatch carries
 * into the model listing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { HarnessModelOptions } from "../src/agents/harness/harness-registry.js";
import { modelKeysOf } from "../src/agents/harness/harness-registry.js";
import { probed, unprobed } from "../src/availability.js";
import {
  getStore,
  setHarnessAvailability,
  setRuntime,
  setSessionCtx,
} from "../src/shell.js";
import { NO_HOST_REASON } from "../src/host-multiplexer.js";
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
  showAgentsMainMenu: vi.fn(
    async (_ctx: unknown, _options: HarnessModelOptions) => {},
  ),
  showAgentsActionMenu: vi.fn(
    async (
      _ctx: unknown,
      _subcommand: string,
      _options: HarnessModelOptions,
    ) => {},
  ),
}));

/** The per-harness keys a menu call received, in the map's own order. */
function listedKeys(options: HarnessModelOptions): Array<[string, string[]]> {
  return [...options.keys()].map((id) => [id, [...modelKeysOf(options, id)]]);
}
vi.mock("../src/ui/menu/menus.js", () => menus);

const worktreeCommand = vi.hoisted(() => ({
  showWorktreeCommandMenu: vi.fn(async () => {}),
}));
vi.mock("../src/ui/menu/menu-worktree-command.js", () => worktreeCommand);

const {
  COWBOY_TOOLS,
  COWBOY_TOOL_NAMES,
  REGISTERED_TOOL_NAMES,
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
      paths: () => ({ global: "config.json" }),
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
    modelRegistry: {
      getAvailable: (): Array<{ provider: string; id: string }> => [],
    },
    scopedModels: [],
  };
}

beforeEach(() => {
  menus.showAgentsMainMenu.mockClear();
  menus.showAgentsActionMenu.mockClear();
  worktreeCommand.showWorktreeCommandMenu.mockClear();
  shell.active = [];
  shell.registeredTools = [];
  // A live session has a runtime; the cases about a session nothing hosts clear it.
  setRuntime({} as never);
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

    expect(names).toEqual([...REGISTERED_TOOL_NAMES]);
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
      ...REGISTERED_TOOL_NAMES.slice(1),
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
    expect(shell.active).toEqual(["read", "bash", ...REGISTERED_TOOL_NAMES]);
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
    expect(shell.active).toEqual(["read", "bash", ...REGISTERED_TOOL_NAMES]);
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
    "opens `/cowboy %s` without the main menu, on the models the harnesses offer",
    async (subcommand) => {
      install({});
      const notify = vi.fn();
      const ctx = {
        ...commandContext(notify),
        modelRegistry: {
          getAvailable: (): Array<{ provider: string; id: string }> => [
            { provider: "anthropic", id: "claude" },
          ],
        },
      };

      await captureCommand().handler(subcommand, ctx);

      expect(menus.showAgentsActionMenu).toHaveBeenCalledTimes(1);
      const [ctxArg, subcommandArg, received] =
        menus.showAgentsActionMenu.mock.calls[0]!;
      expect(ctxArg).toBe(ctx);
      expect(subcommandArg).toBe(subcommand);
      expect(listedKeys(received)).toEqual([
        ["pi", ["anthropic/claude"]],
        ["pig", ["anthropic/claude"]],
        ["pi-bolt", ["anthropic/claude"]],
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
      "Subagent model override cleared (session) — the configured chain decides",
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

  it.each([
    ["sp", "spawn"],
    ["st", "status"],
  ] as const)(
    "maps the `%s` shorthand onto the `%s` screen",
    async (shorthand, subcommand) => {
      install({});
      const notify = vi.fn();
      const ctx = {
        ...commandContext(notify),
        modelRegistry: {
          getAvailable: () => [{ provider: "openai", id: "gpt" }],
        },
      };

      await captureCommand().handler(shorthand, ctx);

      expect(menus.showAgentsActionMenu).toHaveBeenCalledTimes(1);
      expect(menus.showAgentsActionMenu.mock.calls[0]![1]).toBe(subcommand);
      expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("maps the `wt` shorthand onto the worktree command, inline name and all", async () => {
    install({ agent: { extensionEnabled: false } });
    const ctx = commandContext(vi.fn());

    await captureCommand().handler("wt my-branch", ctx);

    expect(worktreeCommand.showWorktreeCommandMenu).toHaveBeenCalledWith(
      ctx,
      "my-branch",
    );
  });

  it.each(["sp", "st"] as const)(
    "refuses `/cowboy %s` while the extension is off",
    async (shorthand) => {
      install({ agent: { extensionEnabled: false } });
      const notify = vi.fn();

      await captureCommand().handler(shorthand, commandContext(notify));

      expect(notify).toHaveBeenCalledWith(
        "pi-cowboy is disabled. Run /cowboy enable first.",
        "warning",
      );
      expect(menus.showAgentsActionMenu).not.toHaveBeenCalled();
    },
  );

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

    expect(menus.showAgentsMainMenu).toHaveBeenCalledTimes(1);
    const [mainCtx, mainOptions] = menus.showAgentsMainMenu.mock.calls[0]!;
    expect(mainCtx).toBe(ctx);
    expect(listedKeys(mainOptions)).toEqual([
      ["pi", ["openai/gpt"]],
      ["pig", ["openai/gpt"]],
      ["pi-bolt", ["openai/gpt"]],
    ]);
    expect(menus.showAgentsActionMenu).not.toHaveBeenCalled();
  });

  it("offers status, spawn, worktree, model, enable and disable as completions", async () => {
    expect((await cowboyCompletions(""))?.map((item) => item.value)).toEqual([
      "status",
      "spawn",
      "worktree",
      "model",
      "enable",
      "disable",
    ]);
  });

  it("offers the pi catalog's models as `model` completions", async () => {
    const ctx = commandContext(vi.fn());
    ctx.modelRegistry = {
      getAvailable: () => [
        { provider: "openai", id: "gpt" },
        { provider: "anthropic", id: "claude-3" },
      ],
    };
    setSessionCtx(ctx as never);

    expect(
      (await cowboyCompletions("model "))?.map((item) => item.value),
    ).toEqual(["model clear", "model openai/gpt", "model anthropic/claude-3"]);
  });
});

describe("/cowboy with no multiplexer hosting the session", () => {
  it.each(["spawn", "status", "model", "worktree", ""] as const)(
    "refuses `%s`, which needs a pane, and says why",
    async (subcommand) => {
      install({});
      setRuntime(null);
      const notify = vi.fn();

      await captureCommand().handler(subcommand, commandContext(notify));

      expect(notify).toHaveBeenCalledWith(NO_HOST_REASON, "warning");
      expect(menus.showAgentsActionMenu).not.toHaveBeenCalled();
      expect(menus.showAgentsMainMenu).not.toHaveBeenCalled();
      expect(worktreeCommand.showWorktreeCommandMenu).not.toHaveBeenCalled();
    },
  );

  it("refuses enable, so no tool goes active without a pane to run in", async () => {
    install({ agent: { extensionEnabled: false } });
    setRuntime(null);
    const notify = vi.fn();

    await captureCommand().handler("enable", commandContext(notify));

    expect(notify).toHaveBeenCalledWith(NO_HOST_REASON, "warning");
    expect(isExtensionEnabled()).toBe(false);
    expect(shell.active).toEqual([]);
  });

  it("still disables, which needs no pane", async () => {
    install({});
    setRuntime(null);
    shell.active = ["read", ...COWBOY_TOOL_NAMES];
    const notify = vi.fn();

    await captureCommand().handler("disable", commandContext(notify));

    expect(isExtensionEnabled()).toBe(false);
    expect(shell.active).toEqual(["read"]);
    expect(notify).toHaveBeenCalledWith("pi-cowboy disabled", "info");
  });
});

/**
 * The main menu's model listing: `/cowboy` is what carries the shell's opencode
 * fetch into the harness request, so this pins the wiring the launch module's
 * own test and the harness's own test each hold one end of.
 */
describe("the /cowboy model listing", () => {
  interface CowboyCommand {
    handler: (args: string, ctx: unknown) => Promise<void>;
  }

  /** The `/cowboy` command as registered on a pi that answers the opencode model API. */
  function handlerWithOpencode(exec: unknown): CowboyCommand {
    let command: CowboyCommand | undefined;
    const pi = {
      registerTool: () => {},
      registerMessageRenderer: () => {},
      registerCommand: (
        _name: string,
        registered: { handler: CowboyCommand["handler"] },
      ) => {
        command = registered;
      },
      exec,
    } as unknown as ExtensionAPI;
    registerCowboyCommand(pi);
    if (!command)
      throw new Error("registerCowboyCommand registered no command");
    return command;
  }

  afterEach(() => {
    // The probe answer is shell state this file otherwise never touches: hand
    // it back at its default so no case outlives itself. The opencode fetch
    // needs no reset — the harness memoizes by pi instance, and every case
    // news up its own.
    setHarnessAvailability(unprobed());
  });

  it("joins the boot warm, so two menu opens run the opencode model API once", async () => {
    install({});
    setHarnessAvailability(probed(["pi", "opencode"]));
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        data: [{ providerID: "anthropic", id: "claude-opus-4" }],
      }),
      stderr: "",
    }));
    const { handler } = handlerWithOpencode(exec);
    const ctx = {
      ...commandContext(vi.fn()),
      modelRegistry: {
        getAvailable: () => [{ provider: "openai", id: "gpt" }],
      },
    };
    await handler("", ctx);
    // The second open reads the fetch the first one started, not a new run.
    await handler("", ctx);

    expect(exec).toHaveBeenCalledTimes(1);
    const expected: Array<[string, string[]]> = [
      ["pi", ["openai/gpt"]],
      ["pig", ["openai/gpt"]],
      ["pi-bolt", ["openai/gpt"]],
      ["opencode", ["anthropic/claude-opus-4"]],
    ];
    const calls = menus.showAgentsMainMenu.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe(ctx);
    expect(listedKeys(calls[0]![1])).toEqual(expected);
    expect(calls[1]![0]).toBe(ctx);
    expect(listedKeys(calls[1]![1])).toEqual(expected);
  });

  it("shows a failed opencode list as a warning on the command's UI", async () => {
    install({});
    setHarnessAvailability(probed(["pi", "opencode"]));
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const { handler } = handlerWithOpencode(exec);
    const notify = vi.fn();
    const ctx = {
      ...commandContext(notify),
      modelRegistry: {
        getAvailable: () => [{ provider: "openai", id: "gpt" }],
      },
    };

    await handler("", ctx);

    // The reason the row is empty reaches the human, not only the log.
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not list the opencode models"),
      "warning",
    );
  });
});
