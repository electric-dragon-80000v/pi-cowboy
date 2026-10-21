# Plugins

A plugin is a standard [pi package](https://github.com/earendil-works/pi-coding-agent) that adds a custom harness or a custom terminal multiplexer to `pi-cowboy`.

- **Harness**: A CLI runner for subagents. Built-in harnesses include `pi`, `pig`, `pi-bolt`, `opencode`, `codex`, and `claude`. The default harness is set by [`agent.harnessType`](Configuration.md#agentharnesstype).
- **Multiplexer**: The terminal host that manages panes, tabs, and workspaces for subagents. The built-in multiplexer is `herdr`. The active multiplexer is set by [`multiplexer`](Configuration.md#multiplexer).

Plugins install directly through Pi's package manager with no external registry or additional tooling:

```bash
pi install <source>
```

`pi-cowboy` scans the Pi package directory and loads installed plugins at every session start.

## Package Structure

### Manifest (`package.json`)

Declare the plugin entry point under the `"pi-cowboy"` key in `package.json`:

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

> **Important**: The package name must start with `pi-cowboy-` as a prefix, otherwise `pi-cowboy` will not detect it.
>
> **Important**: Do not declare the entry point under `"pi.extensions"`. Extensions receive Pi's extension API, whereas `pi-cowboy` plugins expect `CowboyPluginApi`. Declaring a plugin under `"pi.extensions"` causes Pi to invoke the factory with the wrong interface, halting session startup with an error.

### Entry Module

The entry module must be an ES module whose default export is a factory function:

```ts
import type { CowboyPluginApi } from "pi-cowboy/plugin";

export default function (api: CowboyPluginApi) {
  // Register harnesses and multiplexers
}
```

Import contract types exclusively from the `pi-cowboy/plugin` export. Do not import internal `pi-cowboy` module paths.

The `CowboyPluginApi` instance provides:

- `api.registerHarness(harness: PluginHarness)`: Registers a custom subagent harness.
- `api.registerMultiplexer(multiplexer: PluginMultiplexer)`: Registers a custom terminal multiplexer.
- `api.pi`: The active session's Pi extension API.
- `api.cwd`: The user's active project root directory (not your package root). To reference internal plugin assets, resolve paths against `import.meta.url` (for example, `new URL("./assets/template.json", import.meta.url)`).

The factory function may return a synchronous or asynchronous disposer function (`() => void | Promise<void>`), which runs when the session unloads or reloads.

## Registering a Harness

A harness defines how `pi-cowboy` starts, configures, and communicates with a subagent CLI process inside a multiplexer pane.

```ts
import type { CowboyPluginApi } from "pi-cowboy/plugin";

export default function (api: CowboyPluginApi) {
  api.registerHarness({
    id: "custom-agent",
    displayName: "Custom Agent",
    agentMultiplexerKind: "pi",
    availability: () => ({ status: "available" }),
    buildArgs: (launch) => [
      "--system-prompt",
      launch.systemPromptFile,
      "--append-system-prompt",
      `cowboy-subagent-${launch.subagentId}`,
      `@${launch.taskFile}`,
    ],
    prepare: async (paneId, pane) => {},
    teardown: async (paneId, pane) => {},
    listModels: async () => ({
      kind: "listed",
      entries: [
        {
          key: "provider/model",
          label: "Model",
          thinkingLevels: { kind: "closed", levels: ["low", "high"] },
        },
      ],
    }),
    prefetchModels: () => {},
  });
}
```

### Harness Fields

| Field                  | Type                                                   | Description                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | string (required)                                      | Unique harness identifier referenced by `agent.harnessType`, template `harness_type`, and `cowboy_agent` tool calls.                                                                                                                                                                                                              |
| `displayName`          | string (required)                                      | Human-readable label displayed in `/cowboy` menus and settings.                                                                                                                                                                                                                                                                   |
| `agentMultiplexerKind` | string (required)                                      | The process type recognized by the multiplexer (for example, `"pi"`).                                                                                                                                                                                                                                                             |
| `availability`         | `() => HarnessAvailability`                            | Probes whether the harness binary and environment are ready to launch. Return `{ status: "available" }` or `{ status: "unavailable", notice?: string }`.                                                                                                                                                                          |
| `buildArgs`            | `(launch: SubagentLaunchInputs) => string[]`           | Builds the argument list executed inside the pane.                                                                                                                                                                                                                                                                                |
| `prepare`              | `(paneId: string, pane: PaneControl) => Promise<void>` | Optional hook to prepare terminal state before launching the subagent process.                                                                                                                                                                                                                                                    |
| `teardown`             | `(paneId: string, pane: PaneControl) => Promise<void>` | Optional hook to clean up files or pane state after the process finishes.                                                                                                                                                                                                                                                         |
| `listModels`           | `(request) => Promise<ModelList>`                      | Returns available models for settings menus and model resolution. `thinkingLevels` defines the model's supported thinking levels in the harness's vocabulary and specifies whether the level list is strict (`closed`) or informative (`advisory`). An empty list indicates no thinking support. See [Model lists](#model-lists). |
| `prefetchModels`       | `() => void \| Promise<void>`                          | Optional hook to pre-warm slow model catalogs in the background at session boot.                                                                                                                                                                                                                                                  |
| `config`               | `HarnessConfigCodec`                                   | Optional codec that validates the `harness.<id>` configuration section after plugins load.                                                                                                                                                                                                                                        |

### Model lists

`listModels` returns a `ModelList` tagged union. It must not throw: if a catalog cannot be queried, `listModels` returns a status variant rather than an exception, as model discovery runs during session startup.

| `kind`        | Shape                 | Description                                                                 |
| ------------- | --------------------- | --------------------------------------------------------------------------- |
| `listed`      | `{ entries }`         | Standard catalog discovery succeeded.                                       |
| `fallback`    | `{ entries, notice }` | Catalog discovery failed; built-in default entries substitute.              |
| `unavailable` | `{ notice }`          | Catalog discovery failed with no available fallback; no models are offered. |

`notice` provides a diagnostic message (e.g., `Could not list the codex models (exited 1: boom); using the built-in defaults.`). The calling menu or command displays this notice as a UI warning.

Each entry defines `thinkingLevels` as `{ kind, levels }` (`ThinkingLevels`, exported from `pi-cowboy/plugin`):

- `closed`: The harness strictly restricts reasoning levels to this list. Requesting an unlisted level emits a spawn-time warning, though the token passes to the harness unchanged.
- `advisory`: The list is purely informative (such as user-extensible variants in OpenCode). Unlisted levels trigger no warning and pass through directly.

Plugins adhering to the legacy contract that returned a bare string array of levels are automatically interpreted as `closed`.

A harness configuration codec defines the schema, validation rules, and default values for its `harness.<id>` section. Its `parse` function returns the validated configuration and reports each rejected value through its `report` callback. The registry validates every registered harness after plugins load and passes the result to `prepare` as `config`:

```ts
async prepare({ config }: HarnessPrepareRequest<SubagentLaunchInputs, MyConfig>) {
  // config is MyConfig
}
```

Codecs use plain data and callback functions, avoiding shared schema library dependencies. The raw configuration is stored under `harness.<id>` in `config.json`. If an entry does not match any registered harness, `pi-cowboy` preserves the raw data until a matching plugin registers. A codec that throws takes its harness out of the session — the failure is logged and the harness is no longer offered, resolved, or launched — rather than ending session startup.

By default, harness configuration is read only from the global `config.json` to prevent repository project files from altering machine-level behavior. If a harness's settings can be safely configured per project, set `scope: "project"` on the codec. The codec's `parse` function then receives both `global` and `project` layers to determine how they merge; without this setting, `project` is always `undefined`.

### Launch Inputs (`SubagentLaunchInputs`)

The `buildArgs` function receives a `SubagentLaunchInputs` object containing:

- `subagentId`: Unique ID assigned to this subagent instance.
- `systemPromptFile`: Path to the staged system prompt file.
- `taskFile`: Path to the file containing the subagent's task description.
- `resultFile`: Path where the subagent writes its final output report.
- `modelKey`: Resolved model ID string (`"provider/model"`), or `undefined` if unset.
- `toolSelection`: Allowed and excluded tool lists resolved for this run.

### Pane Preparation and Custom Binaries

The `prepare` and `teardown` hooks receive the pane ID and a `PaneControl` handle:

- `pane.run(paneId: string, command: string)`: Sends a command string to the pane.
- `pane.waitForOutput(paneId: string, pattern: string \| RegExp, timeoutMs: number)`: Waits for matching terminal output.

The built-in `herdr` multiplexer directly launches only the CLI kinds it recognizes (`pi`, `claude`, `codex`, and `opencode`). To launch an unrecognized binary inside `herdr`:

1. Set `agentMultiplexerKind: "pi"`.
2. In `prepare`, create a launcher script inside the pane that forwards `pi` invocations to your target CLI.
3. In `buildArgs`, return flags formatted for your target CLI.

See `src/agents/harness/pane-launcher.ts` in the `pi-cowboy` repository for a complete implementation.

### Child Session Marker

When a harness launches a child instance of `pi`, that child loads `pi-cowboy` as an extension. To distinguish child subagents from interactive top-level sessions, pass the following argument in `buildArgs`:

```ts
(`--append-system-prompt`, `cowboy-subagent-${launch.subagentId}`);
```

`pi-cowboy` checks for this marker at startup to prevent child agents from initializing nested multiplexer panes or secondary managers.

### Fallback and Validation

- **Config default (`agent.harnessType`)**: If the configured harness is not installed or reports `{ status: "unavailable" }`, `pi-cowboy` logs a warning and falls back to `"pi"`.
- **Explicit selection**: When an agent template (`harness_type`) or a `cowboy_agent` tool call (`harness_type`) specifies an unregistered or unavailable harness, execution fails immediately without falling back. Templates that reference an unregistered harness are skipped during the startup scan with an explanatory warning.

## Registering a Multiplexer

A multiplexer manages terminal workspaces, tabs, and panes. Registering a multiplexer enables `pi-cowboy` to run inside environments other than Herdr.

```ts
import type { CowboyPluginApi } from "pi-cowboy/plugin";

export default function (api: CowboyPluginApi) {
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
}
```

### Multiplexer Fields

| Field    | Type                                       | Description                                                                                        |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `id`     | string (required)                          | Unique multiplexer identifier referenced by the `multiplexer` configuration key.                   |
| `hosts`  | `() => boolean`                            | Detection predicate. Must return `true` if the current process is running inside this multiplexer. |
| `create` | `(pi: ExtensionApi) => MultiplexerRuntime` | Factory function returning the runtime implementation for the session.                             |

### Multiplexer Runtime (`MultiplexerRuntime`)

The object returned by `create` supplies the entire terminal and process hosting layer:

| Member        | Interface         | Responsibility                                                                                                                                                 |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `AgentHost`       | Manages subagent placements: `hostAt` (attach to a checkout or directory), `start`, `observe`, `stop`, `release`, `isAttached`, `findAttempts`, and `deliver`. |
| `view`        | `MultiplexerView` | Focuses panes and tabs (`focus`).                                                                                                                              |
| `pane`        | `PaneControl`     | Sends commands to panes and waits for output (`run`, `waitForOutput`).                                                                                         |
| `placements`  | `AgentPlacements` | Inspects multiplexer state: `listWorktrees`, `listPlacements`, `observePane`, and `canonicalizePath`.                                                          |
| `multiplexer` | string            | Multiplexer identifier string recorded in persisted host references.                                                                                           |

### Environment Detection and Fallback

A multiplexer can only host a session if its `hosts()` hook returns `true`. Detection relies on environment variables (for example, the built-in `herdr` multiplexer inspects `process.env.HERDR_ENV`).

At session start, `pi-cowboy` selects a multiplexer using the following order:

1. **Configured multiplexer**: Uses the multiplexer named by the `multiplexer` key in `config.json` if registered and its `hosts()` returns `true`.
2. **First matching host**: Falls back to the first registered multiplexer whose `hosts()` returns `true` (evaluating `herdr` first, followed by plugin multiplexers in package-name order).
3. **No host detected**: If no registered multiplexer detects the environment, `pi-cowboy` still loads plugins, but disables pane-dependent tools and `/cowboy` menu items. A warning explains that no supported multiplexer was detected. Non-pane commands (such as `/cowboy disable`) remain accessible.

### Worktrees and Host References

- **Git worktree management**: `pi-cowboy` creates and removes Git worktrees directly using `git`. A multiplexer adopts a worktree checkout via `host.hostAt({ checkout })` and releases it via `host.release(ref, "worktree-association")`.

- **Path canonicalization**: `placements.canonicalizePath(path: string)` must normalize filesystem paths to match the multiplexer's internal representation.

- **Persisted references (`AgentHostRef`)**: State files record subagent pane locations as:

  ```ts
  interface AgentHostRef {
    multiplexer: string;
    agentName: string;
    paneId: string;
    tabId?: string;
    workspaceId?: string;
    created: boolean;
  }
  ```

  Plugin multiplexers must generate and accept references matching this structure.

## Lifecycle and Rules

- **Reserved IDs**: The IDs `pi`, `pig`, `pi-bolt`, `opencode`, `codex`, and `claude` are reserved for built-in harnesses. The ID `herdr` is reserved for the built-in multiplexer. Registering a reserved ID is rejected with a warning.
- **Collision resolution**: If two plugins register the same identifier, the first registered plugin is kept. Plugins load in alphabetical order by package name.
- **Execution order**: Plugin factories run after `config.json` has loaded and before the first agent spawns. Running `/reload` unloads existing plugins and re-executes factories.
- **Teardown**: If a factory returns a disposer function, `pi-cowboy` runs and awaits that function when the session terminates or unloads.
- **Fault isolation**: If a plugin fails to import or its factory throws an error, `pi-cowboy` logs a warning and skips the plugin without interrupting the Pi session. If an `availability()` hook throws, the harness is marked unavailable; if a `prefetchModels()` hook throws, prefetching is skipped.

## Testing a Plugin Locally

To test a plugin during development, install it using its local directory path:

```bash
pi install ./path/to/my-plugin
```

Pi creates a link to the local path, allowing code updates to take effect immediately when you restart the session or run `/reload`.
