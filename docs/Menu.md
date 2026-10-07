# Menu

`/cowboy` opens a menu of screens. Every row on every one of them is listed below.

The command forms are in the [README](../README.md#commands). The config keys that back most of these rows are in [Configuration](Configuration.md).

## `/cowboy` — Agents

The main screen. The screen title is `Agents`.

| Row                    | What it does                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `Model overrides`      | Opens the `Model Settings` screen.                                                  |
| `Default orchestrator` | Sets the orchestrator template that every spawn uses.                               |
| `Agent`                | Sets the agent type used when `cowboy_agent` omits `agent_type`.                    |
| `Status`               | Opens the `Status` screen. Same as `/cowboy status`.                                |
| `Spawn agent`          | Opens the spawn wizard. Same as `/cowboy spawn`.                                    |
| `Settings`             | Opens the `Settings` screen.                                                        |
| `Enabled`              | Turns the extension on or off. See [Turning pi-cowboy off](#turning-pi-cowboy-off). |

## `/cowboy` > `Settings` > `Model Settings`

Opens from the `Model overrides` row on the main screen.

| Row                            | What it does                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `Global default model`         | The model every agent uses unless a more specific rule applies. See [Model resolution](../README.md#model-resolution). |
| One row per agent type         | The model for that agent type. Select the row to set or clear its override.                                            |
| `Override another type...`     | Adds an override for an agent type that has none.                                                                      |
| `Clear all model overrides...` | Removes every override.                                                                                                |

## Turning pi-cowboy off

`/cowboy disable` unloads the tools. Agents that already run keep working.

Run `/cowboy enable`, or flip the `Enabled` row, to turn the extension back on.

## `/cowboy` > `Settings`

The screen title is `Settings`.

| Row                    | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `Concurrency Settings` | Opens the `Concurrency Settings` screen.         |
| `Agent behavior`       | Opens the `Agent settings` screen.               |
| `System prompt`        | Opens the `System Prompt` screen.                |
| `Show cowboy 🤠`       | Turns the cowboy marker in the corner on or off. |
| `Grazing 🐄`           | Turns the grazing cows on or off.                |

## `/cowboy` > `Settings` > `Concurrency Settings`

Sets the number of agents that may run at once.

Each level is a separate limit, and an agent counts against every limit that applies to it. See [`concurrency`](Configuration.md#concurrency).

| Row                               | What it does                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Default concurrency limit`       | The global limit. Every agent counts against it.                                                                       |
| `Per-provider limits`             | A heading. Each provider below it has one row.                                                                         |
| `Add per-provider limit...`       | Caps one provider.                                                                                                     |
| `Per-model limits`                | A heading. Each model below it has one row.                                                                            |
| `Add per-model limit...`          | Caps one model.                                                                                                        |
| `Clear all concurrency limits...` | Removes limits at the session, global, or project level. The row appears only when at least one level carries a limit. |

Each limit offers a level: session, global, or project. A value that comes from the project layer carries a `[project]` tag.

## `/cowboy` > `Settings` > `Agent settings`

**Spawn defaults**

| Row                      | What it does                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Default thinking level` | The thinking level used when an agent template omits one. `Inherit` leaves the key unset. See [`agent.defaultThinking`](Configuration.md#agentdefaultthinking).                                                                                    |
| `Default harness`        | The harness that launches agents whose template omits `harness_type`. Offers only the harnesses on `PATH`, and names the ones that are missing. See [`harnessType`](Configuration.md#agentharnesstype) and [`harness_type`](Agent%20Templates.md). |

**Worktrees**

| Row                        | What it does                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Worktree root`            | The directory that holds every worktree. See [`agent.worktreeRoot`](Configuration.md#agentworktreeroot).                                                                                      |
| `Worktree materialization` | How a worktree gets its files. `copy-on-write` shares files with the parent; `checkout` shares nothing. See [`agent.worktreeMaterialization`](Configuration.md#agentworktreematerialization). |
| `Worktree checkout`        | Where a new worktree starts when the parent has uncommitted work. See [`agent.worktreeCheckoutType`](Configuration.md#agentworktreecheckouttype).                                             |

**Tools**

| Row                      | What it does                                                               |
| ------------------------ | -------------------------------------------------------------------------- |
| `Disable default agents` | Skips the built-in agent types next session. Only `.pi/agents` types load. |

## `/cowboy` > `Settings` > `System Prompt`

| Row                          | What it does                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `System prompt mode`         | How the agent system prompt is built: `replace`, `inherit`, or `custom`. See [`agent.systemPromptMode`](Configuration.md#agentsystempromptmode).                  |
| `Create prompt file`         | Writes a starter file at the custom prompt path. The row appears only in `custom` mode when the file does not exist yet.                                          |
| `Include context files`      | Loads pi's context files from the project and from `~/.pi/agent` as shared context. See [`agent.includeContextFiles`](Configuration.md#agentincludecontextfiles). |
| `Load skills implicitly`     | Gives new agents every skill when their template omits the field. See [`agent.loadSkillsImplicitly`](Configuration.md#agentloadskillsimplicitly).                 |
| `Load extensions implicitly` | Gives new agents every pi extension when their template omits the field. See [`agent.loadExtensionsImplicitly`](Configuration.md#agentloadextensionsimplicitly).  |

## `/cowboy worktree`

Creates one worktree under the configured `agent.worktreeRoot`, adopts it in herdr with a workspace, tab, and pane of its own. This worktree is not tracked by pi-cowboy.

## `/cowboy status` — Status

The screen title is `Status`. It lists every spawned, queued, and settled agent.

Select an agent to open the actions available for it, which depend on the state of the agent.

| Action        | What it does                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `View shell`  | Focuses the agent's herdr pane. The screen lists this action while the agent runs and after it settles. |
| `View result` | Reads the report the agent wrote.                                                                       |
| `View error`  | Reads the error from a failed agent.                                                                    |
| `Stop`        | Stops a running agent. Its worktree and branch stay. Same work as `stop_cowboy_agent`.                  |
| `Clear`       | Removes a settled agent and its worktree from the list.                                                 |
| `Clean up`    | Closes the pane and removes the worktree and the merged branch. Same work as `cleanup_cowboy_agent`.    |

The list also carries bulk actions, which sit in a group of their own below the per-agent ones and act on every agent they name.

| Action                          | What it does                                  |
| ------------------------------- | --------------------------------------------- |
| `Stop N active agent(s)`        | Stops every running agent.                    |
| `Clean up N settled agent(s)`   | Cleans up every settled agent.                |
| `Clear done (remove worktrees)` | Clears every agent that ran to completion.    |
| `Clear all (remove worktrees)`  | Clears every agent that is no longer running. |

## `/cowboy spawn` — Spawn Options

The screen title is `Spawn Options`.

| Row              | What it does                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Spawn`          | Asks for the worktree name and the prompt, then launches the agent.                                                                                                                       |
| `Type`           | The agent type for this spawn.                                                                                                                                                            |
| `Model`          | The model for this spawn.                                                                                                                                                                 |
| `Background`     | `ON` returns at once. `OFF` waits for the result.                                                                                                                                         |
| `Fork session`   | `Yes` starts the agent from a copy of the current session context.                                                                                                                        |
| `Worktree`       | Runs the agent in a linked git worktree instead of the parent directory. The row appears only when the session sits inside a git repository.                                              |
| `Thinking level` | The thinking level for this spawn. `Inherit` follows the configured default. See [`agent.defaultThinking`](Configuration.md#agentdefaultthinking) and [`thinking`](Agent%20Templates.md). |
| `Description`    | A short label for the agents list. pi-cowboy derives one from the prompt when you leave it empty.                                                                                         |

The `Worktree` picker offers three choices, then one row per existing worktree.

| Choice                        | What it does                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `New worktree`                | Creates a worktree. pi-cowboy asks for its name after you select `Spawn`. The name becomes the branch and the directory name. |
| `Inherits parent cwd`         | Runs the agent in the current working directory.                                                                              |
| One row per existing worktree | Runs the agent in a worktree that already exists. Each row shows its branch.                                                  |
