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
- `api.deriveHarness(derivation: HarnessDerivation)`: Registers a derived harness — an existing harness's process, with its own environment defaults and host-side hooks. See [Deriving a Harness](#deriving-a-harness).
- `api.getHarness(id: string): RegisteredHarness | undefined`: A read-only view of one harness registered so far, or `undefined`. `deriveHarness` resolves its base by id, so the plugin registering one needs no lookup first.
- `api.registerMultiplexer(multiplexer: PluginMultiplexer)`: Registers a custom terminal multiplexer.
- `api.pi`: The active session's Pi extension API.
- `api.cwd`: The user's active project root directory (not your package root). To reference internal plugin assets, resolve paths against `import.meta.url` (for example, `new URL("./assets/template.json", import.meta.url)`).

The factory function may return a synchronous or asynchronous disposer function (`() => void | Promise<void>`), which runs when the session unloads or reloads.

## Registering a Harness

A harness defines how `pi-cowboy` starts, configures, stops, and communicates with a subagent CLI process inside a multiplexer pane.

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
    prepare: async ({ pane, paneId }) => {},
    stop: async ({ pane, paneId }) => {
      await pane.sendKeys(paneId, ["ctrl+d"]);
    },
    steer: async ({ pane, paneId, message }) => {
      if (!pane.promptAgent)
        return { kind: "not-submitted", detail: "no agent surface" };
      return pane.promptAgent(paneId, message);
    },
    teardown: async ({ paneId }) => {},
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
  });
}
```

### Harness Fields

| Field                  | Type                                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | string (required)                                                                | Unique harness identifier referenced by `agent.harnessType`, template `harness_type`, and `cowboy_agent` tool calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `displayName`          | string (required)                                                                | Human-readable label displayed in `/cowboy` menus and settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `agentMultiplexerKind` | string (required)                                                                | The process type recognized by the multiplexer (for example, `"pi"`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `availability`         | `() => HarnessAvailability`                                                      | Probes whether the harness binary and environment are ready to launch. Return `{ status: "available" }` or `{ status: "unavailable", notice?: string }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `buildArgs`            | `(launch: SubagentLaunchInputs) => string[]`                                     | Builds the argument list executed inside the pane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `prepare`              | `(request: HarnessPrepareRequest) => Promise<void>`                              | Optional hook to prepare terminal state before launching the subagent process. The request carries `pi`, `config`, `pane`, `paneId`, `cwd`, and `launch`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `stop`                 | `(request: HarnessStopRequest) => Promise<void>`                                 | Presses this TUI's own exit keys through the active pane (`request.pane`, `request.paneId`). The multiplexer carries the keys and confirms the process is gone; a harness never reaches a multiplexer's client directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `steer`                | `(request: HarnessSteerRequest) => Promise<DeliverOutcome>`                      | Required. Delivers one steering message into a live run's pane, and is the only steer route the extension calls. The request carries `pi`, `pane`, `paneId`, `message`, and `signal`, so the harness decides how its own process takes input: the built-ins forward to `pane.promptAgent`, while a TUI the multiplexer does not name as an agent submits through its own composer (for example `pane.submit`). Return `{ kind: "submitted" }` once the text and its submission reached the agent, or `{ kind: "not-submitted", detail }` when nothing was submitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `teardown`             | `(request: HarnessTeardownRequest) => Promise<void>`                             | Optional hook to clean up files or pane state after the process finishes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `reservedEnvVars`      | `() => readonly string[]`                                                        | Names this harness reserves besides the universal set, so an environment variable entry for one is dropped with a warning. See [Launch environment](#launch-environment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `inheritedEnv`         | `() => Readonly<Record<string, string>>`                                         | Variables the launch hands the child from `pi-cowboy`'s own environment, read when the launch is built — for state the child resolves itself and the extension reads back by the same names. The reserved set does not apply to these, so a harness may supply a name it reserves. See [Launch environment](#launch-environment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `defaultEnv`           | `() => Readonly<Record<string, string>>`                                         | Variables every launch of this harness carries as defaults, read when the launch is built. Configuration replaces any name it sets unless that name is reserved. See [Launch environment](#launch-environment).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `readHandoverRecords`  | `(request) => Promise<{ sessionId: string; records: Iterable<HandoverRecord> }>` | Optional handover source. Reads and classifies every complete native entry from one ended run's session; shared handover code alone decides which kinds enter the transcript and renders it, calculates loss, and applies `agent.handoverMaxExcludedRatio`. Records are yielded in native order and consumed once, as they are produced; do not collect classified records into an array first. Finish discovery, reads, and validation before returning the source: the iterable itself must only classify parsed data, because a fault raised while iterating bypasses the shared `session-export-failed` mapping. Emit exactly one record for each complete entry, tagged with what it is. What `content` holds follows the kind: `user` and `assistant` carry a turn's cleaned prose, `thinking` the model's cleaned reasoning, `compaction` the cleaned summary that replaced the history before it (a blank one is still a compaction, but starts nothing), and `tool-call` the native tool part or parts as JSON, whole, since each harness shapes a call and its result its own way. `other` is a parsed record with no canonical kind: it carries the native entry's own text and names the native type in `unmappedKind` (use `otherRecord` from the plugin API). `unparseable` is a record that cannot be parsed at all, carries its native text, and is counted as loss. A record whose `kind` the extension does not know is counted as loss too, not dropped silently, so a reader built against an older contract cannot under-export a session. An incomplete trailing write is not a complete entry and is omitted. The request carries `{ pi, subagentId, paneId, cwd, startedAt, staged }` — the run's own address. `startedAt` is stamped before any launch work, so a store that names sessions by creation time uses it as a lower bound and never as an identity on its own; `staged` names the system prompt, task, and result files the run was launched with, each a function of `subagentId`. Between them a reader locates its records after the run's process, and the plugin instance that launched it, are gone; do not read launch-time memory to find them. The hook is called while that run's process is still alive: the extension stops it only after the shared export succeeds, so a failed read leaves the run as it was. A harness without this hook cannot be a handover source: the call reports a warning and changes nothing. |
| `listModels`           | `(request) => Promise<ModelList>`                                                | Returns available models for settings menus and model resolution. `thinkingLevels` defines the model's supported thinking levels in the harness's vocabulary and specifies whether the level list is strict (`closed`) or informative (`advisory`). An empty list indicates no thinking support. See [Model lists](#model-lists).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `config`               | `HarnessConfigCodec`                                                             | Optional codec that validates the `harness.<id>` configuration section after plugins load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Model lists

`listModels` returns a `ModelList` tagged union. It must not throw: if a catalog cannot be queried, `listModels` returns a status variant rather than an exception. A reader that throws anyway is answered as that harness's `unavailable` list, and costs no other harness its models.

The extension calls `listModels` from one place — the session's model catalog. The catalog warms every runnable harness's list once, off the startup path and one harness at a time, and never awaits the pass: the session boots, and a screen opens, while a CLI is still answering. A picker that needs a list the warm has not reached awaits that harness alone, after the layer has been chosen; `/cowboy`, the spawn wizard, and the model settings screen open on the lists that have already settled. The catalog holds each answer for the session, so a second reader joins the first read instead of running the CLI again, and a plugin needs no caching of its own.

`listModels` runs on the event loop, so it must start its work and return a promise. A synchronous shell-out (`execFileSync` or the like) holds the whole session — menus, keys, the indicator — until it returns. The catalog measures the synchronous part of every call and reports a harness that holds the loop instead.

| `kind`        | Shape                 | Description                                                                 |
| ------------- | --------------------- | --------------------------------------------------------------------------- |
| `listed`      | `{ entries }`         | Standard catalog discovery succeeded.                                       |
| `fallback`    | `{ entries, notice }` | Catalog discovery failed; built-in default entries substitute.              |
| `unavailable` | `{ notice }`          | Catalog discovery failed with no available fallback; no models are offered. |

`notice` provides a diagnostic message (e.g., `Could not list the codex models (exited 1: boom); using the built-in defaults.`). The picker that awaits the list shows this notice as a UI warning; a failed list is not retained, so the next read retries.

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
- `envFile`: Path of the staged file holding this launch's environment variables, or `null` when it carries none. See [Launch environment](#launch-environment).

### Launch environment

`harness.<id>.env` in the global `config.json` and a template's `[harness.<family>.env]` table give a spawn variables beyond the pane's own environment. `pi-cowboy` merges them, drops reserved names and values containing control characters with a warning, and stages what remains in an owner-only file at `launch.envFile`. The values stay in that file: they never appear on the command line typed into the pane, so credentials are not exposed in the pane's scrollback or the shell's history file.

A harness that launches through a shell function in the pane therefore sources the file rather than rebuilding the variables itself. `pi-cowboy/plugin` exports `launchEnvBody` to source the file, and `singleQuoteShellWord` to quote command arguments safely:

```ts
import { launchEnvBody, singleQuoteShellWord } from "pi-cowboy/plugin";

async prepare({ launch }: HarnessPrepareRequest) {
  const body = launchEnvBody(
    launch.envFile,
    `command my-cli --task ${singleQuoteShellWord(launch.taskFile)} "$@"`,
  );
  // Type the launcher that runs `body` into the pane.
}
```

`launchEnvBody` returns the body unchanged when the launch carries no variables, and otherwise wraps it in a subshell that sources the file: the variables reach the launched process, and the pane's shell keeps its own environment after the agent exits. A launcher that ignores `envFile` silently drops every entry configured for its harness.

A harness can also reserve names its own launcher maintains, so a configured entry for one is refused instead of overwriting what the launcher set:

```ts
reservedEnvVars: () => ["MY_CLI_HOME", "MY_CLI_PROFILE"],
```

A harness whose process picks a store of its own — and whose runs the extension reads back from that store — declares those names as `inheritedEnv`, so the child resolves the same store the parent reads from:

```ts
reservedEnvVars: () => ["MY_CLI_HOME"],
inheritedEnv: () => ({ MY_CLI_HOME: process.env.MY_CLI_HOME ?? "/default/home" }),
```

Those variables are the launch's own, so the reserved set does not filter them; any entry whose name is invalid or whose value cannot be carried by the shell is dropped with a warning. The universal reserved names and the built-in families' own names always apply ([Configuration](Configuration.md#harnessidenv)).

Through `defaultEnv`, a harness can also declare defaults that every launch carries. A value from `harness.<id>.env` or a `[harness.<family>.env]` table replaces any of them by name, except a name the harness reserves. As with `inheritedEnv`, a reserved name is carried: reservation refuses configuration, and a default is not configuration.

```ts
reservedEnvVars: () => ["MY_CLI_HOME"],
// No configured value can replace this reserved name, so every launch carries it.
defaultEnv: () => ({ MY_CLI_HOME: "/default/home" }),
```

When one name appears in more than one of these sources, the later layer wins:

| Layer (later overrides earlier) | Source                                         | Reserved name                                                              |
| ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| 1                               | `defaultEnv()`, or a derived harness's `env()` | carried                                                                    |
| 2                               | `harness.<id>.env`                             | entry dropped with a warning                                               |
| 3                               | `[harness.<family>.env]`                       | template rejected if the family reserves it; otherwise dropped as in row 2 |
| 4                               | `inheritedEnv()`                               | carried; a derived harness's `env` value for a name here replaces it       |

### Pane Preparation and Custom Binaries

The `prepare` hook receives a request whose `pane` member is a `PaneControl` handle alongside `paneId`, while `teardown` receives `paneId` without a `pane` handle:

- `pane.run(paneId: string, command: string)`: Sends a command string to the pane.
- `pane.waitForOutput(paneId: string, text: string, timeoutMs: number)`: Waits for literal terminal output.
- `pane.launchEnvironment?.(kind)`: Returns environment variables the multiplexer needs to detect a custom launcher.
- `pane.waitForVisibleOutput?.(paneId, text, timeoutMs)`: Waits for literal text in the visible viewport.
- `pane.submit?.(paneId, text, pid, signal)`: The pane surface's one write. Types the text, then presses Enter, only after checking the expected foreground process; an escape byte may lead the text so a TUI that ignores input until its terminal has focus can be woken first. Other control characters are refused. The check is best-effort, not atomic with terminal input.

A harness can define optional `postStart(request)` to wait for readiness and submit its initial task after the multiplexer accepts startup. It receives the same inputs as `prepare` plus an abort signal. Startup acceptance alone does not establish readiness. Multiplexers that cannot offer guarded submission omit these optional methods; a harness requiring them must refuse to launch rather than type into an unverified pane.

The built-in `herdr` multiplexer directly launches only the CLI kinds it recognizes (`pi`, `claude`, `codex`, and `opencode`). To launch an unrecognized binary inside `herdr`:

1. Set `agentMultiplexerKind: "pi"`.
2. In `prepare`, create a launcher script inside the pane that forwards `pi` invocations to your target CLI.
3. In `buildArgs`, return flags formatted for your target CLI.

For reference, see `src/agents/harness/pane-launcher.ts` in the `pi-cowboy` repository for the complete install-and-verify sequence (defining the function, reading it back, and retrying until the verification marker appears).

### Child Session Marker

When a harness launches a child instance of `pi`, that child loads `pi-cowboy` as an extension. To distinguish child subagents from interactive top-level sessions, pass the following argument in `buildArgs`:

```ts
(`--append-system-prompt`, `cowboy-subagent-${launch.subagentId}`);
```

`pi-cowboy` checks for this marker at startup to prevent child agents from initializing nested multiplexer panes or secondary managers.

### Fallback and Validation

- **Config default (`agent.harnessType`)**: If the configured harness is not installed or reports `{ status: "unavailable" }`, `pi-cowboy` logs a warning and falls back to `"pi"`.
- **Explicit selection**: When an agent template (`harness_type`) or a `cowboy_agent` tool call (`harness_type`) specifies an unregistered or unavailable harness, execution fails immediately without falling back. Templates that reference an unregistered harness are skipped during the startup scan with an explanatory warning.

## Deriving a Harness

A derived harness usually differs from its base in only two things: the environment its launches carry, and host-side work around each launch — preparation before the binary starts, a hook once it starts, and cleanup at teardown. `api.deriveHarness` expresses exactly that and delegates the process itself to the base:

```ts
import type { CowboyPluginApi } from "pi-cowboy/plugin";

export default function (api: CowboyPluginApi) {
  api.deriveHarness({
    id: "claude-work",
    displayName: "Claude (work)",
    base: "claude",
    env: () => ({ CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" }),
    prepare: async ({ cwd }) => {
      // Host-side: before the base prepares the pane.
    },
  });
}
```

The derived harness is an ordinary harness id from then on: it appears in the `agent.harnessType` setting, the spawn wizard and the handover target list; accepts `harness_type: "claude-work"`; and reads its own `harness.claude-work` section, parsed by claude's codec. The other harness-keyed tables key it by its own id as well ([Configuration](Configuration.md#harness)); none of the base's entries in those tables apply to it.

| Field               | Meaning                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `displayName` | Its own identity. Its id may not be a built-in's, an id already registered in this session, or its own `base`. A refused call warns and registers nothing.                                                                                                         |
| `base`              | The harness it delegates to: a built-in, another plugin's, or another derived harness.                                                                                                                                                                             |
| `env`               | Variables its launches carry as defaults, read each time a launch is built. A configured value of the same name replaces it; a reserved name cannot be configured, so it reaches every launch. A name the base's launch inherits is the one exception (see below). |
| `reservedEnvVars`   | Names it reserves, added to the base's.                                                                                                                                                                                                                            |
| `availability`      | Its own condition. The base must also be available; both must hold.                                                                                                                                                                                                |
| `prepare`           | Runs before the base's `prepare`.                                                                                                                                                                                                                                  |
| `postStart`         | Runs after the base's `postStart`, when the base has one.                                                                                                                                                                                                          |
| `teardown`          | Runs before the base's `teardown`.                                                                                                                                                                                                                                 |

A derived harness whose base resolves to a built-in family reads that family's `[harness.<family>]` template table, so one template block configures the family and every derived harness of it; a derived harness of a plugin harness reads no template table, and no derived harness can be targeted on its own.

A name the base's launch inherits (codex's `CODEX_HOME`, pi's `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`) is the one case where the derived harness's `env` value replaces the base's inherited value instead of merging below it: the base's inherited table is the last layer to reach the child, so a value left among the defaults would never arrive.

The base is resolved when the derived harness is used, not when it is registered, so a plugin may register a derivation of a harness another plugin registers later. A base that never registers leaves the derived harness unavailable with a notice naming it, and a cycle of derivations yields the same answer. `deriveHarness` returns whether the registration was accepted.

The base's implementation is fixed: `buildArgs`, `stop`, `steer`, `listModels`, `readHandoverRecords`, `agentMultiplexerKind` and `config` all come from it. A derived harness that needs its own is a `registerHarness` harness, not a derivation.

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

| Member        | Interface         | Responsibility                                                                                                                                                                                                        |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`        | `AgentHost`       | Manages subagent placements: `hostAt` (attach to a checkout or directory), `start`, `observe`, `waitUntilGone` (registry confirmation only), `release`, `isAttached`, and `findAttempts`.                             |
| `view`        | `MultiplexerView` | Focuses panes and tabs (`focus`).                                                                                                                                                                                     |
| `pane`        | `PaneControl`     | Typing into a pane and proving what landed: `run`, `sendKeys`, `waitForOutput`, and — for what a harness steers through — `promptAgent` (the agent surface) and `submit` (text plus Enter while a pid is foreground). |
| `placements`  | `AgentPlacements` | Inspects multiplexer state: `listWorktrees`, `listPlacements`, `observePane`, and `canonicalizePath`.                                                                                                                 |
| `multiplexer` | string            | Multiplexer identifier string recorded in persisted host references.                                                                                                                                                  |

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
- **Fault isolation**: If a plugin fails to import or its factory throws an error, `pi-cowboy` logs a warning and skips the plugin without interrupting the Pi session. If an `availability()` hook throws, the harness is marked unavailable; if a `listModels()` read throws, that harness's list is reported unavailable and every other harness still lists.

## Testing a Plugin Locally

To test a plugin during development, install it using its local directory path:

```bash
pi install ./path/to/my-plugin
```

Pi creates a link to the local path, allowing code updates to take effect immediately when you restart the session or run `/reload`.
