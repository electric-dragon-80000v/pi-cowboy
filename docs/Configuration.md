# Configuration

pi-cowboy merges two files, a global config and a project config, key by key.

## File locations

The agent dir is `~/.pi/agent`, and `PI_CODING_AGENT_DIR` overrides it.

- Global file: `<agent dir>/pi-cowboy/config.json`.
- Project file: `<project dir>/.pi/pi-cowboy/config.json`. pi-cowboy loads it only for a trusted project.
- Custom system prompt file: `<agent dir>/pi-cowboy/prompt.md`.

Keys nest inside the two top-level objects, `agent` and `concurrency`. A minimal global file looks like this:

```json
{
  "agent": {
    "default": "anthropic/claude-sonnet-4",
    "defaultThinking": "medium",
    "worktreeMaterialization": "copy-on-write"
  },
  "concurrency": {
    "default": 4
  }
}
```

## Layers

The project values override the global values. The global values override the built-in defaults. Each file contains only its own keys. You can also set concurrency limits for the running session from the menu. No session limit is stored in either file. Both files stay exactly as you wrote them: pi-cowboy never writes the merged result back, and it never overwrites a malformed one. If a file is malformed, fix it or delete it by hand.

The project file can contain only model keys and concurrency keys. Model keys are `agent.default`, `agent.defaultThinking`, and the per-type overrides `agent.<agent-type>`. Outside the table below, pi-cowboy reads any agent key as a per-type model override and ignores every other key in the project file. pi-cowboy never writes the file of an untrusted project.

pi-cowboy ignores an invalid value and reports a warning. The warning names the file, the key, the value found, and the value expected. The built-in default then applies.

Two rules are easier to check against a file than to hold in the head: which keys the project file may contain, and what happens to a value that is not valid. Given this project file:

```json
{
  "agent": {
    "defaultThinking": "high",
    "defaultAgentType": "reviewer"
  },
  "concurrency": {
    "default": "four"
  }
}
```

`defaultThinking` applies. `defaultAgentType` does not set the spawn default: by the rule above pi-cowboy reads it as the per-type model override for a type named `defaultAgentType`. pi-cowboy ignores `concurrency.default` as invalid, and the built-in global limit of 4 applies.

## `agent`

| Key                        | Type                                                                                | Default             | Description                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `default`                  | string or null                                                                      | `null`              | See [`agent.default`](#agentdefault).                                                                        |
| `defaultAgentType`         | non-empty string                                                                    | `"general-purpose"` | Agent type that applies when a spawn omits `agent_type`.                                                     |
| `defaultOrchestrator`      | non-empty string                                                                    | `"default"`         | Orchestrator template that applies when a spawn omits one.                                                   |
| `systemPromptMode`         | `"replace"` \| `"inherit"` \| `"custom"`                                            | `"replace"`         | How pi-cowboy builds the agent system prompt. See [`systemPromptMode`](#agentsystempromptmode).              |
| `includeContextFiles`      | boolean                                                                             | `true`              | When true, load pi's context files into the agent prompt.                                                    |
| `defaultThinking`          | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | unset               | Thinking level that applies when the agent template does not set one.                                        |
| `loadSkillsImplicitly`     | boolean                                                                             | `true`              | The fallback for a template that omits `skills`.                                                             |
| `loadExtensionsImplicitly` | boolean                                                                             | `true`              | The fallback for a template that omits `extensions`.                                                         |
| `disableDefaultAgents`     | boolean                                                                             | `false`             | Skip the built-in agent types and pi-cowboy's templates.                                                     |
| `extensionEnabled`         | boolean                                                                             | `true`              | When false, pi-cowboy is inactive.                                                                           |
| `showActiveIndicator`      | boolean                                                                             | `true`              | Show the 🤠 marker while pi-cowboy is active.                                                                |
| `grazingEnabled`           | boolean                                                                             | `true`              | Show the pasture under the cowboy.                                                                           |
| `worktreeRoot`             | string                                                                              | unset               | Directory for the worktrees. See [`agent.worktreeRoot`](#agentworktreeroot).                                 |
| `worktreeMaterialization`  | `"copy-on-write"` \| `"checkout"`                                                   | `"copy-on-write"`   | How a worktree is created from the parent working tree.                                                      |
| `worktreeCheckoutType`     | `"dirty"` \| `"clean"`                                                              | `"clean"`           | See [`agent.worktreeCheckoutType`](#agentworktreecheckouttype).                                              |
| `harnessType`              | `"pi"` \| `"pig"` \| `"pi-bolt"`                                                    | `"pi"`              | Harness for agents whose template does not set `harness_type`. See [`agent.harnessType`](#agentharnesstype). |
| `agent.<agent-type>`       | string or null                                                                      | unset               | Per-type model override. `null` clears it.                                                                   |

### `agent.default`

Applies when no other rule in [Model keys](#model-keys) applies.

### The custom system prompt file

The custom system prompt file is a plain Markdown file. pi-cowboy reads it when `agent.systemPromptMode` is `custom`, and its contents become the opening section of the agent's system prompt. The environment block, the context files, the agent instructions, and the skills and guidance sections are appended after them.

If the file is missing or empty, pi-cowboy reports a warning and the agent runs on the `replace` prompt.

### `agent.systemPromptMode`

The mode decides what text, if any, opens the agent's system prompt. It does not affect the rest of the prompt: the environment block, the context files, the agent instructions, the skills, and the worktree and orchestrator sections are the same in all three modes.

- `replace` (the default) opens with no inherited text, so the agent's prompt is the one pi-cowboy builds from its own sections.
- `inherit` opens with the prompt of the parent session. If that prompt cannot be read, pi-cowboy reports a warning and the agent runs on the `replace` prompt.
- `custom` opens with the contents of the custom system prompt file, `prompt.md`. See [The custom system prompt file](#the-custom-system-prompt-file).

### `agent.defaultThinking`

When this is unset, pi's own default thinking level applies.

### `agent.includeContextFiles`

pi-cowboy loads pi's context files as shared project context. It loads the agent dir's file first, then one file per directory from the agent's working directory up to the filesystem root, and in each directory the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` wins. An agent template can override this key.

For an agent started in `src/` of a repository that has `AGENTS.md` at its root and `CLAUDE.md` in `src/`, that climb loads the agent dir's file, then `src/CLAUDE.md`, then the root `AGENTS.md`, and stops as soon as the root is reached.

### `agent.loadSkillsImplicitly`

This key is the fallback for an agent template that omits `skills`. When it is true, the spawned agent loads pi's own skills; when it is false, it loads none. A template that sets `skills` wins either way.

### `agent.loadExtensionsImplicitly`

This key is the fallback for an agent template that omits `extensions`. When it is true, the spawned agent loads pi's own extensions; when it is false, it loads none. A template that sets `extensions` wins either way.

### `agent.disableDefaultAgents`

pi-cowboy loads only the agent files on disk — the files in the four directories listed in [Agent Templates](Agent%20Templates.md). This key takes effect on the next session.

### `agent.extensionEnabled`

When false, pi-cowboy is inactive. See [Turning pi-cowboy off](Menu.md#turning-pi-cowboy-off) for what the menu does while it is off.

### `agent.worktreeRoot`

An unset value uses `<agent dir>/pi-cowboy/worktrees`. A relative path resolves against the repository root.

### `agent.worktreeMaterialization`

- `copy-on-write` clones the parent working tree and shares the ignored files.
- `checkout` keeps git's classic checkout. It shares no files with the parent.

When `copy-on-write` is selected, pi-cowboy first probes the target filesystem. A filesystem without copy-on-write support, such as ext4, falls back to `checkout` instead of failing. Both at session start and whenever you change `agent.worktreeRoot`, the probe runs.

### `agent.worktreeCheckoutType`

Sets whether a new worktree carries over the uncommitted work of a dirty parent working tree, and applies only when `worktreeMaterialization` is `copy-on-write`.

- With `clean`, pi-cowboy checks out the tracked files from HEAD and copies only the ignored files.
- With `dirty`, pi-cowboy clones the whole parent working tree, including the edits and the untracked files.

A clean parent is cloned whole in both cases.

### `agent.harnessType`

- `pi` is the binary that already runs the pane.
- `pig` and `pi-bolt` are pi-compatible binaries launched through a shell function in the agent's own pane, so only their startup differs.

pi-cowboy scans `PATH` once at session start. A `harnessType` setting that is not found on `PATH` falls back to `pi`. The key accepts all three values on every machine, so a config file or template written where a harness exists still loads where it does not.

### Model keys

`agent.default` and `agent.<agent-type>` contain a model as `"provider/model-id"`. With a value of `null`, pi-cowboy uses the model of the parent session.

Model resolution order, highest precedence first:

1. The `model` in a `cowboy_agent` call.
2. Session per-type override.
3. `agent.<agent-type>` in the config.
4. `[harness] model` in the agent template.
5. Session default model.
6. `agent.default` in the config.
7. The parent session model.

Run one case through the order: a `reviewer` whose template sets `model = "anthropic/claude-sonnet-4"` uses that model, unless `/cowboy` holds a model override for `reviewer` or the config sets `agent.reviewer`.

Without a template model, the same `reviewer` falls through to the session default set by `/cowboy model`, and then to `agent.default`.

## `concurrency`

| Key                            | Type   | Default | Description                                                  |
| ------------------------------ | ------ | ------- | ------------------------------------------------------------ |
| `default`                      | number | `4`     | Global concurrency limit. Every agent counts against it.     |
| `providers.<provider>`         | number | unset   | Concurrency limit for one provider, for example `anthropic`. |
| `models.<provider>/<model-id>` | number | unset   | Concurrency limit for one model.                             |

Every level is a separate limit, and an agent counts against all the limits that apply to it at once. See [Concurrency](../README.md#concurrency).

Limits are floored at one. pi-cowboy treats a `0` or a negative number as one at a time, not as "no limit".

pi-cowboy applies a limit change to the running session immediately. Raising a limit starts queued agents, and removing a limit stops counting against that level alone. Lowering a limit lets running agents finish, but it stops new ones from starting until the running count drops below it.
