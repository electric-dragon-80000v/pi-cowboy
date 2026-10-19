# Plugins

A plugin is a plain [pi package](https://github.com/earendil-works/pi-coding-agent) that adds a harness or a multiplexer to `pi-cowboy`.

A harness is a CLI that can run a subagent. `pi-cowboy` names each one by an id, and config's `agent.harnessType` selects one. The built-in harnesses are `pi`, `pig`, `pi-bolt`, `opencode`, `codex`, and `claude`.

A multiplexer hosts the panes a subagent runs in. The `multiplexer` key in config selects one, and the built-in multiplexer is `herdr`.

Plugins are installed with pi's own package manager. There is no separate registry, lockfile, or install command:

```
pi install <source>
```

`pi-cowboy` discovers its plugins from the pi installation at each session start.

## Package shape

A plugin package declares a `pi-cowboy` key in its `package.json`, and its package name must start with `pi-cowboy-`:

```json
{
  "name": "pi-cowboy-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "pi-cowboy": {
    "plugin": "./dist/plugin.js"
  }
}
```

Use `pi-cowboy` rather than `pi.extensions`: an entry under `pi.extensions` is loaded by pi as an extension as well, where the factory runs against pi's API instead of this contract's — it fails, and the session does not start.

`plugin` is the entry module, relative to the package root. It must be an ES module whose default export is a factory:

```ts
import type { CowboyPluginApi } from "pi-cowboy/plugin";

export default function (api: CowboyPluginApi) {
  api.registerHarness({
    id: "my-harness",
    displayName: "My Harness",
    agentMultiplexerKind: "pi",
    availability: () => ({ status: "available" }),
    buildArgs: (launch) => [
      "--system-prompt",
      launch.systemPromptFile,
      "--append-system-prompt",
      `cowboy-subagent-${launch.subagentId}`,
      `@${launch.taskFile}`,
    ],
    prepare: async () => {},
    teardown: async () => {},
    listModels: async () => [{ key: "provider/model", label: "Model" }],
    prefetchModels: () => {},
  });
}
```

`agentMultiplexerKind` is the kind the multiplexer starts the process as, in the multiplexer's own vocabulary, and `buildArgs` supplies that command's arguments, so the argv lists flags alone. The built-in multiplexer starts the kinds herdr knows (`pi`, `claude`, `codex`, `opencode`, and the other CLIs herdr supports), so a harness whose own CLI herdr cannot name launches under `pi`: `prepare` installs a launcher in the pane that forwards the pane's `pi` to that CLI, and `buildArgs` supplies that CLI's argv. `src/agents/harness/pane-launcher.ts` is the worked example.

The `cowboy-subagent-<id>` marker in `--append-system-prompt` is the subagent id with that prefix. It is how a child that is itself `pi`, and therefore loads `pi-cowboy`, knows it is a subagent rather than a session of its own.

Import the contract's types from the `pi-cowboy/plugin` subpath. Internal pi-cowboy paths are not part of the contract.

The api carries `pi`, the session's own extension api, and `cwd`, the project root the session loaded. `cwd` is the user's workspace, not your package's directory: resolve your own files against your module (`new URL("./assets/thing.json", import.meta.url)`) and use `cwd` only for paths that belong to the user's project.

## Registering a harness

`registerHarness` takes a `PluginHarness`: the same harness contract a built-in implements, over the shared launch inputs, plus the `id` and `displayName` a plugin supplies for itself.

| Field                  | Meaning                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`                   | The harness ID. `agent.harnessType`, a template's `harness_type`, and the tool's `harness_type` name it by this ID. |
| `displayName`          | The label shown in settings rows.                                                                                   |
| `agentMultiplexerKind` | The kind the multiplexer starts the process as, in its own vocabulary.                                              |
| `availability()`       | Whether this machine can launch the harness now, with an optional `notice` line for the human.                      |
| `buildArgs()`          | The argv the pane runs. Read the shared `SubagentLaunchInputs` (see below).                                         |
| `prepare()`            | Bring the pane into the state the launch needs.                                                                     |
| `teardown()`           | Undo any filesystem state `prepare` left.                                                                           |
| `listModels()`         | The models this harness can run, for the settings menus.                                                            |
| `prefetchModels()`     | Warm a slow model list in the background at boot; use a no-op when the list is cheap.                               |

A plugin harness receives only the shared launch inputs: `subagentId`, `systemPromptFile`, `taskFile`, `resultFile`, `modelKey`, and `toolSelection`.

`prepare` receives the session's pane surface (`PaneControl`), which offers `run(paneId, command)` and `waitForOutput(paneId, output, timeoutMs)`.

Once registered, a plugin harness is offered exactly like a built-in. It is probed for availability at session start, it appears in the harness settings rows, and `agent.harnessType`, an agent template's `harness_type`, and the `cowboy_agent` tool's `harness_type` can all select it by ID.

A plugin harness exists only in a session that loaded it. An agent template naming one is therefore a template that machine can only use with the plugin installed: where nothing registered that ID, the template is skipped at scan with a warning naming the ID and the harnesses that session does run. A tool call naming an unregistered harness fails before anything spawns, like any other unknown `harness_type`.

## Registering a multiplexer

`registerMultiplexer` takes an ID, the multiplexer's own environment detection, and a factory that builds the runtime for one session:

```ts
api.registerMultiplexer({
  id: "my-multiplexer",
  hosts: () => process.env.MY_MULTIPLEXER === "1",
  create: (pi) => ({
    host,
    view,
    pane,
    placements,
    multiplexer: "my-multiplexer",
  }),
});
```

`hosts()` answers whether this process runs inside your multiplexer. Detection is environment-only, exactly as it is for the built-in `herdr` (which reads `HERDR_ENV`), and it is the only thing that can make your multiplexer a host: a session runs only inside a multiplexer that detects itself, and runs the first one that does — the built-in first, then plugins in package-name order.

The runtime a multiplexer returns is the whole of what a session runs on:

| Member        | What it owns                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | Placement: `hostAt` (adopt a checkout or create a placement), `start`, `observe`, `stop`, `release`, `isAttached`, `findAttempts`, `deliver`. |
| `view`        | Presentation: `focus`.                                                                                                                        |
| `pane`        | The pane surface a harness types into (`run`, `waitForOutput`).                                                                               |
| `placements`  | The multiplexer's own view of what it owns: `listWorktrees`, `listPlacements`, `observePane`, and `canonicalizePath`.                         |
| `multiplexer` | The multiplexer ID; it is what a persisted spawn address records.                                                                             |

`pi-cowboy` reads `placements` when it cleans up and reports on runs. `canonicalizePath` normalizes a path the way your multiplexer spells it.

`pi-cowboy` creates and removes worktrees with git. A multiplexer adopts a checkout with `host.hostAt({ checkout })` and releases it with `host.release(ref, "worktree-association")`.

Select a multiplexer with the `multiplexer` key to prefer one among the hosts. An ID that no installed package registered — or one that is registered but does not detect this process — falls back to the first multiplexer that does, or to the built-in `herdr` when nothing does.

A plugin multiplexer is how `pi-cowboy` runs outside herdr: run pi inside your multiplexer, and the session detects it once plugins have loaded, so it runs your runtime even though the built-in cannot host here. When no registered multiplexer detects the process, the extension still registers and loads its plugins, then reports that it cannot launch panes and stays inactive.

A persisted spawn address (`AgentHostRef`) has this shape: a multiplexer ID, an agent name, a pane ID, an optional tab ID, a workspace ID, and whether the pane was created. A plugin multiplexer's addresses must fit it.

## Rules and lifecycle

- Registering the ID `pi`, `pig`, `pi-bolt`, `opencode`, `codex`, or `claude` as a harness, or `herdr` as a multiplexer, is refused with a warning. Two plugins claiming one ID do not race: plugins load in package-name order, and the first registration for an ID is kept.
- A plugin's factory runs before the session's first spawn and after the config has loaded. A `/reload` reloads the plugins.
- A session nothing hosts has no pane to launch into: its tools stay inactive, the `/cowboy` rows that need a pane are refused with the reason, and `/cowboy disable` still works.
- A plugin that fails to import, or that throws in its factory, is skipped with a warning. A harness whose `availability` hook throws is reported as unavailable; a harness whose `prefetchModels` hook throws is left cold. The session still starts.
- The factory may return a disposer, which runs when the session unloads. It may be `async`, in which case its setup is awaited before the session's first spawn. You do not need to unregister anything yourself.

## Testing a plugin locally

Point `pi install` at the package directory:

```
pi install ./path/to/my-plugin
```

`pi-cowboy` resolves it through pi's package manager exactly as it resolves a published package.
