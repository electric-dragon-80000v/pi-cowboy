<p align="center">
  <img src="https://raw.githubusercontent.com/electric-dragon-80000v/pi-cowboy/main/docs/assets/logo-labeled-readme.png" alt="pi-cowboy">
</p>

[![demo](https://github.com/user-attachments/assets/4e54f1de-dfee-47fd-90af-d1eb851dd950)](https://github.com/user-attachments/assets/a063b266-9079-4e3a-adcf-8ca78711bba1)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**License:** MIT

`pi-cowboy` is a multi-agent orchestrator for [pi](https://pi.dev). Break a large job into focused subtasks, hand them off to background agents running in parallel, and consolidate them when they finish.

Each agent runs in its own terminal pane inside [Herdr](https://github.com/electric-dragon-80000v/herdr) and works in an isolated copy-on-write Git worktree. You can watch agents work in real time, jump into any pane to steer them, or mix and match harnesses like Pi, Claude Code, OpenCode, and Codex in the same session. When the work is finished, `pi-cowboy` cleans up the leftovers for you.

Check out the [demo](https://electric-dragon-80000v.github.io/pi-cowboy/).

## Why should I use it?

### Focused tasks produce better code

Give each agent a smaller, isolated subtask. A single task with clear instructions leaves little room for error, whereas a long list of expectations invites drift and over-engineering. Because each agent commits to its own branch, you can review and merge each subtask on its own.

### Foreign harness support

`pi-cowboy` can orchestrate Claude Code, Codex, OpenCode, and more: start work on Pi, continue on Claude Code, finish on OpenCode. Do you need support for something else? Create an issue on [GitHub](https://github.com/electric-dragon-80000v/pi-cowboy/issues/new).

### Parallel work with minimal disk overhead

Multiple agents can edit, build, and run tests at the same time without interfering with each other. Copy-on-write worktrees make high parallelism practical by keeping disk usage small even when your repository is in the magnitude of gigabytes.

The numbers below come from a Git repository on macOS with 153,607 files in total (479 MiB tracked, 27 GiB total including untracked files):

| Method                                         | Including untracked | Size on disk |
| ---------------------------------------------- | ------------------- | ------------ |
| Pi-cowboy's copy-on-write                      | yes ✅              | 75 MiB       |
| Classic `git worktree add`                     | no ❌               | 479 MiB      |
| Classic `git worktree add` + copy of untracked | yes ✅              | 27 GiB       |

### Live visibility in Herdr

Each task gets its own shell, a visible terminal pane you can open at any time, and notifications when an agent needs your attention.

### Custom workflows

Define reusable [agent templates](#agent-templates) for specialist roles and [orchestrator templates](#orchestrator-templates) to adapt how agents work and report back.

### Grazing cows and a cowboy on your screen

![image-20260930022747492](https://raw.githubusercontent.com/electric-dragon-80000v/pi-cowboy/main/docs/assets/grazing.png)

Who wouldn’t want their agents visualized as cow emojis? Go on… guess. That's exactly right. No one.

## Requirements

- Linux or macOS
- `herdr` 0.8 or later, with the `herdr` pi integration enabled
- `python3` on macOS (used for copy-on-write worktrees; macOS has not shipped `python3` since 12.3, so install the Xcode Command Line Tools with `xcode-select --install`)
- Copy-on-write capable filesystem (APFS on macOS; BTRFS or ZFS on Linux)
  - `ext4` does not support copy-on-write. On `ext4`, `agent.worktreeMaterialization` falls back to `checkout`.

## Install

Install from npm:

<code>pi install npm:pi-cowboy</code>

## Usage

`pi-cowboy` activates automatically whenever you run `pi` inside a Git repository.

##### 1. Delegating a task

<hr>
<code>Based on the security audit, group the relevant files into 10 groups, and launch parallel cowboy agents to address their audit results.</code>
<hr>

`pi-cowboy` spawns background agents for the subtasks right away:

<code>✓ Spawned agent b7g2nspx (general-purpose)</code><br>
<code>✓ Spawned agent 5m1xx7fa (general-purpose)</code><br>
<code>...</code>

If you spawn more agents than your concurrency limit allows, the extras wait in a queue. With the default global limit of 4, the first 4 agents start immediately and the remaining 6 start as slots open up.

##### 2. Agent isolation

![herdr-containers](https://raw.githubusercontent.com/electric-dragon-80000v/pi-cowboy/main/docs/assets/herdr-containers.png)

Each agent runs as a separate process in its own Herdr workspace, inside its own tab and terminal pane. You can switch to an agent's workspace at any time to watch its progress or steer it directly.

On disk, each agent works in a dedicated Git worktree under `<agent dir>/pi-cowboy/worktrees/` (`~/.pi/agent` by default).

##### 3. Agent completion

When an agent finishes its turn (settles), its report arrives as a message in the parent session:

<code>✓ [Cowboy agent "general-purpose" b7g2nspx completed]</code><br>
<br>
<code>Addressed all the points raised in the security audit for the given set of files.</code><br>
<br>
<code>(Worktree: $HOME/.pi/agent/pi-cowboy/worktrees/cow-audit-perms-b7g2nspx (branch cow-audit-perms-b7g2nspx). The agent process and its herdr pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process. The worktree stays until you call cleanup_cowboy_agent to remove it — call it once the branch is merged or rejected.)</code>

The parent session can then review the report, steer the agent if something needs another pass, or merge the branch.

##### 4. Merging

To bring the changes in, the orchestrator calls `merge_cowboy_branch`, which merges the agent's branch into your repository's main working tree:

<code>✓ Merged "cow-audit-perms-b7g2nspx" into "main" in pi-mono.</code>

##### 5. Cleanup

Once the work is merged, the orchestrator cleans up the agent's resources (or you can ask it to):

<hr>
<code>Clean up perms audit agent.</code>
<hr>

`cleanup_cowboy_agent` closes the Herdr pane and tab, removes the worktree, and deletes the branch:

<code>✓ Cleaned up agent b7g2nspx:</code><br>
<code>agent status: completed</code><br>
<code>panes: w1:p2 closed</code><br>
<code>worktree: removed ($HOME/.pi/agent/pi-cowboy/worktrees/cow-audit-perms-b7g2nspx)</code><br>
<code>branch: deleted (cow-audit-perms-b7g2nspx)</code>

Cleanup is safe by default: it refuses to touch an agent that is still running, keeps any worktree that still has uncommitted changes, and deletes the branch only if it has already been merged. If one step cannot be completed, `pi-cowboy` reports the reason and finishes the rest.

When the `/cowboy status` menu refuses to remove a worktree because of uncommitted changes or an unreadable state, it offers to `Force` the removal. Force deletes the worktree and discards anything uncommitted in it, so it asks for a confirmation that names the checkout and what will be lost. Forced removals are reported as `forced — <reason>`. This override lives in the menu only — the `cleanup_cowboy_agent` tool never forces, and the menu only offers it for a settled agent, never one it still lists as running.

## Customizing your workflow

### Agent templates

If you find yourself repeating the same instructions for recurring jobs, you can package them into an agent template with its own system prompt, model, harness, and tool permissions.

For example, a `release-notes` template looks like this:

```toml
name = "release-notes"
description = "Prepares release notes."
system_prompt = '''
You prepare release notes for this repository. Read the history and tags
(git log, git tag) and report the changes as a message.
'''
```

You can then ask for it by name in the parent session:

<hr>
<code>> Spawn a cowboy agent using release notes template to prepare the release notes for the most recent changes.</code>
<hr>

See [Agent Templates](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Agent%20Templates.md) for all template fields and directory locations.

### Orchestrator templates

While agent templates specialize individual workers, orchestrator templates apply rules across every agent you spawn. They also let you customize the status messages ("cues") sent to the parent session when agents spawn, queue, or settle.

For instance, if you use an adversarial review tool, you can define an orchestrator template that requires every agent to run it before committing:

```toml
name = "adversarial-review"
guidance = '''
Run the adversarial-review tool before you commit, and fix any glaring mistakes that the review finds and then commit.
'''
```

You can switch the active orchestrator at any time from `/cowboy` > `Default orchestrator`. See [Orchestrator Templates](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Orchestrator%20Templates.md) for details.

### Foreign harnesses

`pi-cowboy` auto-detects Codex, Claude Code, OpenCode, PiG, and Pi-Bolt when they are installed on your `PATH`. You can request a specific harness directly in your prompt (for example, "Launch an OpenCode agent for this task") or set defaults in your [configuration](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Configuration.md#agentharnesstype) and [agent templates](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Agent%20Templates.md).

## Concurrency

You can cap how many agents run at the same time across four independent levels:

- Global: `concurrency.default` (default `4`), which applies to every agent
- Per harness: `concurrency.harnesses.<harness-id>`
- Per provider: `concurrency.providers.<provider>`
- Per model: `concurrency.models["<provider>/<model-id>"]`

A running agent occupies a slot in every limit that applies to it. When the agent settles, it releases those slots and `pi-cowboy` starts the next queued agent that has room at all of its levels. An agent waiting on a busy model limit will not block a queued agent behind it that uses a different model.

If you steer a settled agent, it wakes up in its existing pane and runs immediately, even if that temporarily puts a limit over capacity.

Configure these limits in `config.json` or live in your session via `/cowboy` > `Settings` > `Concurrency Settings`. See [Configuration](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Configuration.md#concurrency) for details.

## Model resolution

When `pi-cowboy` spawns an agent, it picks the model using the first match in this order:

1. The `model` parameter passed to the `cowboy_agent` tool call
2. The session per-type model override (`/cowboy` > `Model overrides`)
3. The config per-type override (`agent.<agent-type>`)
4. The model set in the [agent template](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Agent%20Templates.md) for the launching harness family
5. The Pi-family session default model (`/cowboy model`, which picks from Pi's catalogue)
6. The launching harness's configured default (`agent.default` for the Pi family, or `agent.defaultModelByHarness` for foreign harnesses)
7. For Pi-family launches, the parent session's active model

See [Configuration](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Configuration.md#model-keys) for the full rules.

## Commands

Run `/cowboy` to open the interactive menu, or pass a subcommand directly. See [Menu](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Menu.md) for a guide to every screen.

```text
/cowboy                         # Open the pi-cowboy menu
/cowboy status                  # List spawned, queued, and settled agents
/cowboy spawn                   # Spawn an agent manually
/cowboy worktree                # Create a git worktree with no agent attached
/cowboy model                   # Pick the default agent model for this session
/cowboy model provider/model-id # Set the default agent model for this session
/cowboy model clear             # Clear the session model override
/cowboy enable                  # Enable pi-cowboy
/cowboy disable                 # Disable pi-cowboy
```

`/cowboy wt`, `/cowboy sp` and `/cowboy st` are shorthands for `/cowboy worktree`, `/cowboy spawn` and `/cowboy status`.

## Tools

Every tool result is marked by how the call ended: `✓` success, `!` refused (nothing failed and nothing changed), `✗` failure. A batch shows the worst outcome among its items. A `cowboy_agent` run sent to the background or waiting in the queue is an acknowledgement and reads as a success; a foreground run (`run_in_background: false`) reads as a success when completed and as a refusal when stopped.

### `cowboy_agent`

Delegates one or more tasks to cowboy agents. By default, the call returns immediately with an agent ID for each task, and results arrive in the parent session as each agent settles.

| Parameter           | Required | Description                                                                                      |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `agents[]`          | yes      | One object per task.                                                                             |
| `run_in_background` | no       | Set to `false` to wait for the result in the same turn. Only allowed when `agents` has one task. |

Each item in `agents[]` takes:

| Field          | Required | Description                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | yes      | Task instructions for the cowboy agent.                                                                                                                                                                                                                                                                                                |
| `task_name`    | yes      | Short 2-3-word name (e.g. `"fix login flow"`) used to name the agent's branch, worktree, and tab.                                                                                                                                                                                                                                      |
| `agent_type`   | no       | Agent template to use. Defaults to the type selected at `/cowboy` > `Agent`.                                                                                                                                                                                                                                                           |
| `model`        | no       | Model for this agent as `"provider/model-id"`. Resolved according to [Model resolution](#model-resolution).                                                                                                                                                                                                                            |
| `harness_type` | no       | Harness that launches this agent: `pi`, `pig`, `pi-bolt`, `opencode`, `codex`, `claude`, or a harness a plugin registered in this session. Overrides the agent template's `harness_type` and the `agent.harnessType` setting. If the harness is not registered here, or this machine cannot launch it, the call fails before spawning. |

### `steer_cowboy_agent`

Sends a follow-up message to one or more agents. If an agent is running, it receives the message before its next model call. If an agent has already settled, steering revives it in the same pane for another turn and delivers a new completion message when it settles again.

Queued agents cannot be steered because they do not have a pane yet. Agents that have already been cleaned up (or are currently being cleaned up) cannot be steered either.

| Parameter     | Required | Description                           |
| ------------- | -------- | ------------------------------------- |
| `agent_ids[]` | yes      | Agent IDs to send the message to.     |
| `message`     | yes      | The message to deliver to each agent. |

### `handover_cowboy_agent`

Hands one settled agent over to another harness without starting over: the ended run is stopped, its session is exported by the source harness, the run is archived, and the next run launches in the same checkout with that session and its ID quoted in its task. Earlier panes and harness state remain until `cleanup_cowboy_agent`, which removes all runs.

A live agent is refused, never stopped — stop it with `stop_cowboy_agent` first. `harness_type` is required and never falls back to the configured default. The **source** harness must be able to export its own session; a harness that cannot is reported in the result, and nothing is stopped or changed.

| Parameter      | Required | Description                                                 |
| -------------- | -------- | ----------------------------------------------------------- |
| `agent_id`     | yes      | The settled agent to hand over.                             |
| `harness_type` | yes      | Harness that executes the next run.                         |
| `model`        | no       | Model for the next run, in the target harness's vocabulary. |
| `thinking`     | no       | Thinking level for the next run.                            |

### `stop_cowboy_agent`

Interrupts one or more running agents and marks them as stopped. Their worktrees, branches, and panes are preserved so you can inspect or clean them up afterward.

| Parameter     | Required | Description        |
| ------------- | -------- | ------------------ |
| `agent_ids[]` | yes      | Agent IDs to stop. |

### `merge_cowboy_branch`

Merges one or more settled agent branches into a target branch in your repository's main working tree. Your main working tree must already be on the target branch with no uncommitted changes. If a merge conflict occurs, `pi-cowboy` leaves the conflict in place so you can resolve it.

| Parameter    | Required | Description                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------------- |
| `branches[]` | yes      | The `cow-<task>-<id>` branch names from the agent completion reports.           |
| `target`     | no       | Branch to merge into. Defaults to `main`.                                       |
| `repo`       | no       | Path inside the repository. Defaults to the parent session's working directory. |

### `cleanup_cowboy_agent`

Closes the Herdr pane and tab, removes the worktree, and deletes the branch for one or more settled agents. The tool reports the result for each agent.

Cleanup never throws on partial failures: it deletes a branch only after it has been merged, and it keeps any worktree that still has uncommitted changes (reporting why it was kept).

| Parameter     | Required | Description                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| `agent_ids[]` | yes      | Agent IDs to clean up. `cleanup_cowboy_agent` refuses an agent that is still running. |

## FAQ

### Why is my agent queued, not running?

Every running agent occupies a slot in each concurrency limit that applies to it: model, provider, harness, and global (model and provider keys can also be scoped to a harness, like `opencode:provider/model`). `pi-cowboy` queues new agents until all of their applicable limits have room. You can raise limits in `/cowboy` > `Settings` > `Concurrency Settings` or in your config file. See [Concurrency](#concurrency).

### Why did my worktree survive cleanup?

`cleanup_cowboy_agent` refuses to delete a worktree that still has uncommitted changes or whose git status cannot be verified. Commit or discard the leftover changes, make sure the agent is stopped, and run cleanup again. See [`cleanup_cowboy_agent`](#cleanup_cowboy_agent).

### Isn't one pi process per agent too much overhead?

For a single tiny change, spinning up a fresh process can take longer than making the edit directly. `pi-cowboy` is built for running several tasks in parallel, where that startup cost is paid once across all concurrent agents.

If you want faster startup and lower memory usage, `pi-cowboy` also supports [pig](https://github.com/MichaelKinsy/PiG) (a drop-in Pi replacement written in Go) and [pi-bolt](https://github.com/opensec-git/Pi-Bolt) (an ahead-of-time compiled Pi variant). Set `agent.harnessType` in [Configuration](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Configuration.md) to use them.

### I don't like the emojis, can I turn them off?

Yes. You can disable both the cowboy indicator and the grazing cows in `/cowboy` > `Settings` or in your config file. See [Configuration](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Configuration.md).

## References

- [Configuration](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Configuration.md)
- [Menu](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Menu.md)
- [Agent Templates](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Agent%20Templates.md)
- [Orchestrator Templates](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Orchestrator%20Templates.md)
- [Plugins](https://github.com/electric-dragon-80000v/pi-cowboy/blob/main/docs/Plugins.md)
