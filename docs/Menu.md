# Menu

Running `/cowboy` opens an interactive menu for inspecting agents, spawning tasks manually, and changing settings. You can also jump straight to specific screens with the CLI subcommands listed in [Commands](../README.md#commands). Most settings in the menu write to the keys documented in [Configuration](Configuration.md).

## `/cowboy` - Agents (main screen)

The main menu opens with the title `Agents`.

| Row                    | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `Model overrides`      | Opens the `Model Settings` screen.                                                |
| `Default orchestrator` | Sets the orchestrator template used when a spawn does not specify one.            |
| `Agent`                | Sets the default agent template used when `cowboy_agent` omits `agent_type`.      |
| `Status`               | Opens the `Status` screen (same as `/cowboy status`).                             |
| `Spawn agent`          | Opens the manual spawn wizard (same as `/cowboy spawn`).                          |
| `Settings`             | Opens the `Settings` screen.                                                      |
| `Enabled`              | Turns `pi-cowboy` on or off. See [Turning pi-cowboy off](#turning-pi-cowboy-off). |

The `Agent` row on this screen sets the default template for tool calls that omit `agent_type`. To pick a template for a single manual run, use the `Type` row in `Spawn Options` (`/cowboy spawn`).

### Turning pi-cowboy off

Running `/cowboy disable` (or flipping `Enabled` to `OFF`) unloads the cowboy tools for the session and collapses the main menu to the `Enabled` switch alone. Agents that are already running continue working in the background, and `/cowboy worktree` remains available.

Run `/cowboy enable` or flip `Enabled` back to `ON` to restore the tools and menu.

## `/cowboy` > `Model overrides`

Opens the `Model Settings` screen. Each override can be saved at the `session`, `global`, or `project` level, and values from non-global layers display a `[session]` or `[project]` tag.

| Row                            | What it does                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `Pi Default Model`             | Default model for Pi-family launches (`pi`, `pig`, and `pi-bolt`). See [Model resolution](../README.md#model-resolution).      |
| `OpenCode Default Model`       | Default model for agents launched under `opencode`.                                                                            |
| `Claude Default Model`         | Default model for agents launched under `claude` (`anthropic/<alias>`). See [Model resolution](../README.md#model-resolution). |
| `Codex Default Model`          | Default model for agents launched under `codex`.                                                                               |
| Per-type override rows         | Grouped by resolved model ID. Select an agent type to change or clear its model override.                                      |
| `Override another type...`     | Adds a model override for an agent type that currently inherits its model.                                                     |
| `Clear all model overrides...` | Clears model overrides at the `session`, `global`, `project`, or `all` level. Shown only when at least one override is set.    |

Default model rows for OpenCode, Claude, and Codex appear only when that harness's binary is installed on `PATH` in a supported version (`opencode` requires 2.x; older versions trigger a one-time notice at session start).

## `/cowboy` > `Settings`

Opens the `Settings` screen.

| Row                    | What it does                                   |
| ---------------------- | ---------------------------------------------- |
| `Concurrency Settings` | Opens the `Concurrency Settings` screen.       |
| `Agent behavior`       | Opens the `Agent settings` screen.             |
| `System prompt`        | Opens the `System Prompt` screen.              |
| `Show cowboy 🤠`       | Toggles the cowboy status indicator on or off. |
| `Grazing 🐄`           | Toggles the grazing cows indicator on or off.  |

## `/cowboy` > `Settings` > `Concurrency Settings`

Caps how many agents can run at the same time. Every level is enforced independently, and a running agent occupies a slot in each limit that applies to it. See [`concurrency`](Configuration.md#concurrency).

| Row                               | What it does                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Default concurrency limit`       | Global limit applied to every running agent across all harnesses, providers, and models.                                                       |
| `Per-harness limits`              | Opens a list of harnesses to cap how many agents can run at once under each harness.                                                           |
| `Per-provider limits`             | Opens a harness picker, then lists that harness's providers so you can cap concurrent agents per provider.                                     |
| `Per-model limits`                | Opens a harness picker, then lists that harness's models so you can cap concurrent agents per model.                                           |
| `Clear all concurrency limits...` | Removes concurrency limits at the `session`, `global`, `project`, or `all` level. Shown only when at least one concurrency override is active. |

Each limit can be saved at the `session`, `global`, or `project` scope, and active overrides from the session or project layers display a `[session]` or `[project]` tag.

## `/cowboy` > `Settings` > `Agent behavior`

Opens the `Agent settings` screen, organized into three sections:

### Spawn defaults

| Row                      | What it does                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Default thinking level` | Thinking level used when an agent template omits `thinking`. Selecting `inherit` clears the setting. See [`agent.defaultThinking`](Configuration.md#agentdefaultthinking).                                                             |
| `Default harness`        | Harness used when an agent template omits `harness_type`. Lists installed harnesses on `PATH` and notes any that are missing. See [`agent.harnessType`](Configuration.md#agentharnesstype) and [`harness_type`](Agent%20Templates.md). |

### Worktrees

| Row                        | What it does                                                                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Worktree root`            | Directory where agent worktrees are created. Leave blank to use the default. See [`agent.worktreeRoot`](Configuration.md#agentworktreeroot).                                                                                     |
| `Worktree materialization` | How new worktrees are populated: `copy-on-write` clones files from the parent working tree, while `checkout` runs a standard git checkout. See [`agent.worktreeMaterialization`](Configuration.md#agentworktreematerialization). |
| `Worktree checkout`        | Whether a new worktree starts clean at `HEAD` (`clean`) or carries uncommitted changes from the parent (`dirty`). See [`agent.worktreeCheckoutType`](Configuration.md#agentworktreecheckouttype).                                |

### Tools

| Row                      | What it does                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Disable default agents` | Skips the built-in agent types on the next session so only `.toml` templates from the user, shared, and project directories are loaded. |

## `/cowboy` > `Settings` > `System prompt`

Opens the `System Prompt` screen.

| Row                          | What it does                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `System prompt mode`         | How the agent system prompt is built: `replace`, `inherit`, or `custom`. See [`agent.systemPromptMode`](Configuration.md#agentsystempromptmode).                                |
| `Create prompt file`         | Creates a starter `prompt.md` file. Shown only when `System prompt mode` is `custom` and the file does not exist yet.                                                           |
| `Include context files`      | Loads `AGENTS.md` context files from the project and `~/.pi/agent` into the agent prompt. See [`agent.includeContextFiles`](Configuration.md#agentincludecontextfiles).         |
| `Load skills implicitly`     | Gives Pi-family agents all available skills when their template omits `skills`. See [`agent.loadSkillsImplicitly`](Configuration.md#agentloadskillsimplicitly).                 |
| `Load extensions implicitly` | Gives Pi-family agents all available extensions when their template omits `extensions`. See [`agent.loadExtensionsImplicitly`](Configuration.md#agentloadextensionsimplicitly). |

## `/cowboy status` - Status

Lists every spawned, queued, and settled agent from the session. Selecting an agent opens the actions available for its current state:

| Action        | What it does                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `View shell`  | Focuses the agent's Herdr terminal pane (available while the agent is running and after it settles).                                                                                                                                                   |
| `View result` | Opens a scrollable viewer showing the report from a completed agent.                                                                                                                                                                                   |
| `View error`  | Opens a scrollable viewer showing the error message from a failed agent.                                                                                                                                                                               |
| `Stop`        | Interrupts a running agent while keeping its pane, worktree, and branch intact (same as `stop_cowboy_agent`).                                                                                                                                          |
| `Clean up`    | Closes the pane, removes the worktree, and deletes the branch once merged (same as `cleanup_cowboy_agent`). Worktrees with uncommitted changes are kept and reported with why; when the menu keeps one it offers to force removal instead (see below). |

Below the individual agents, the list displays bulk actions when applicable:

| Bulk action                     | What it does                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Stop N active agent(s)`        | Stops all currently running agents.                                                                      |
| `Clean up N settled agent(s)`   | Cleans up all settled agents (completed, failed, and stopped). Running agents are never touched.         |
| `Clean up N completed agent(s)` | Cleans up only agents that completed without errors. Shown when at least one completed agent is present. |

If a cleanup keeps a worktree (for example, because of uncommitted changes), the reason is recorded on that agent's entry in the status list.

### Forcing cleanup

Cleanup normally refuses to remove a worktree it cannot prove is safe to remove: one with uncommitted changes, or one whose state it could not verify. The status menu is the only place you can override that refusal — the `cleanup_cowboy_agent` tool never forces.

The menu runs the normal cleanup first. When it refuses for a reason that force can address, the menu offers to force the removal. Backing out reports the reasons it would have overridden. A bulk cleanup runs inside the menu and can take a while; the menu is unresponsive until it finishes.

## `/cowboy spawn` - Spawn Options

Opens the manual spawn wizard (`Spawn Options`).

| Row              | What it does                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Spawn`          | Prompts for the worktree name (if `New worktree` is selected) and the task prompt, then launches the agent.                                                                                      |
| `Type`           | Agent template to use for this spawn.                                                                                                                                                            |
| `Model`          | Model override for this spawn.                                                                                                                                                                   |
| `Background`     | `ON` returns immediately and runs in the background; `OFF` waits for the result in the current turn.                                                                                             |
| `Fork session`   | `Yes` forks the parent session's conversation context into the spawned agent.                                                                                                                    |
| `Worktree`       | Chooses where the agent works (shown only when inside a Git repository).                                                                                                                         |
| `Thinking level` | Reasoning effort for this spawn. `Inherit` uses the template or configured default. See [`agent.defaultThinking`](Configuration.md#agentdefaultthinking) and [`thinking`](Agent%20Templates.md). |
| `Description`    | Short label shown in the status list. If left blank, `pi-cowboy` derives one from the first line of the prompt.                                                                                  |

The `Worktree` row offers:

| Choice                 | What it does                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `New worktree`         | Creates a dedicated worktree and branch using the name you enter after selecting `Spawn`.                                           |
| `Inherits parent cwd`  | Runs the agent directly in the parent session's working directory.                                                                  |
| Existing worktree rows | Runs the agent inside an existing linked worktree without taking ownership of it. Each row shows the worktree's checked-out branch. |

## `/cowboy worktree`

Creates a standalone Git worktree under `agent.worktreeRoot` and opens a dedicated Herdr workspace, tab, and shell pane for it without launching an agent.

You can pass the name inline (`/cowboy worktree my-branch`) or enter it when prompted, then pick a checkout mode (`clean` or `dirty`). Because no agent is attached, this worktree does not appear in `/cowboy status` and is not removed by `cleanup_cowboy_agent`.
