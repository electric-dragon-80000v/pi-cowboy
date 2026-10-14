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

The project values override the global values, which override the built-in defaults. Each file contains only its own keys. You can also set concurrency limits for the running session from the menu; no session limit is stored in either file.

pi-cowboy never writes either file back. It leaves each file exactly as you wrote it, and it never overwrites a malformed one. If a file is malformed, fix it or delete it by hand.

The project file can contain only model keys, `agent.defaultThinking`, and concurrency keys. Model keys are `agent.default`, `agent.defaultModelByHarness`, and `agent.<agent-type>`. Any other `agent` key is read as a per-type model override, and any other key is ignored. pi-cowboy never writes the file of an untrusted project.

pi-cowboy ignores an invalid value, reports a warning that names the file, the key, and the value found, and applies the built-in default.

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

Here `defaultThinking` applies. `defaultAgentType` is read as a model override, and the invalid `concurrency.default` falls back to 4.

## `agent`

| Key                        | Type                                                                                | Default             | Description                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `default`                  | string or null                                                                      | `null`              | See [`agent.default`](#agentdefault).                                                                              |
| `defaultAgentType`         | non-empty string                                                                    | `"general-purpose"` | Agent type that applies when a spawn omits `agent_type`.                                                           |
| `defaultOrchestrator`      | non-empty string                                                                    | `"default"`         | Orchestrator template that applies when a spawn omits one.                                                         |
| `systemPromptMode`         | `"replace"` \| `"inherit"` \| `"custom"`                                            | `"replace"`         | How pi-cowboy builds the agent system prompt. See [`systemPromptMode`](#agentsystempromptmode).                    |
| `includeContextFiles`      | boolean                                                                             | `true`              | When true, load pi's context files into the agent prompt.                                                          |
| `defaultThinking`          | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | unset               | Thinking level that applies when the agent template does not set one.                                              |
| `loadSkillsImplicitly`     | boolean                                                                             | `true`              | The fallback for a template that omits `skills`.                                                                   |
| `loadExtensionsImplicitly` | boolean                                                                             | `true`              | The fallback for a template that omits `extensions`.                                                               |
| `disableDefaultAgents`     | boolean                                                                             | `false`             | Skip the built-in agent types and pi-cowboy's templates.                                                           |
| `extensionEnabled`         | boolean                                                                             | `true`              | When false, pi-cowboy is inactive.                                                                                 |
| `showActiveIndicator`      | boolean                                                                             | `true`              | Show the 🤠 marker while pi-cowboy is active.                                                                      |
| `grazingEnabled`           | boolean                                                                             | `true`              | Show the pasture under the cowboy.                                                                                 |
| `worktreeRoot`             | string                                                                              | unset               | Directory for the worktrees. See [`agent.worktreeRoot`](#agentworktreeroot).                                       |
| `worktreeMaterialization`  | `"copy-on-write"` \| `"checkout"`                                                   | `"copy-on-write"`   | How a worktree is created from the parent working tree.                                                            |
| `worktreeCheckoutType`     | `"dirty"` \| `"clean"`                                                              | `"clean"`           | See [`agent.worktreeCheckoutType`](#agentworktreecheckouttype).                                                    |
| `harnessType`              | `"pi"` \| `"pig"` \| `"pi-bolt"` \| `"opencode"` \| `"codex"` \| `"claude"`         | `"pi"`              | Harness for agents whose template does not set `harness_type`. See [`agent.harnessType`](#agentharnesstype).       |
| `defaultModelByHarness`    | map from harness id to string or null                                               | unset               | Per-harness default models, keyed by harness id. See [`agent.defaultModelByHarness`](#agentdefaultmodelbyharness). |
| `agent.<agent-type>`       | string or null                                                                      | unset               | Per-type model override. `null` clears it.                                                                         |

### `agent.default`

Applies when no other rule in [Model keys](#model-keys) applies.

### The custom system prompt file

The custom system prompt file is a plain Markdown file. pi-cowboy reads it when `agent.systemPromptMode` is `custom`, and its contents open the agent's system prompt.

If the file is missing or empty, pi-cowboy reports a warning and the agent runs on the `replace` prompt.

### `agent.systemPromptMode`

The mode decides what text, if any, opens the agent's system prompt.

- `replace` (the default) opens with no inherited text, so the agent's prompt is the one pi-cowboy builds from its own sections.
- `inherit` opens with the prompt of the parent session. If that prompt cannot be read, pi-cowboy reports a warning and the agent runs on the `replace` prompt.
- `custom` opens with the contents of the custom system prompt file, `prompt.md`. See [The custom system prompt file](#the-custom-system-prompt-file).

### `agent.defaultThinking`

When this is unset, pi's own default thinking level applies.

### `agent.includeContextFiles`

pi-cowboy loads pi's context files from the agent dir and from each directory between the agent's working directory and the filesystem root. An agent template can override this key.

### `agent.loadSkillsImplicitly`

This key is the fallback for an agent template that omits `skills`. When it is true, the spawned agent loads pi's own skills; when it is false, it loads none. A template that sets `skills` wins either way.

### `agent.loadExtensionsImplicitly`

This key is the fallback for an agent template that omits `extensions`. When it is true, the spawned agent loads pi's own extensions; when it is false, it loads none. A template that sets `extensions` wins either way.

### `agent.disableDefaultAgents`

pi-cowboy loads only the agent files on disk: the files in the four directories listed in [Agent Templates](Agent%20Templates.md). This key takes effect on the next session.

### `agent.extensionEnabled`

When false, pi-cowboy is inactive. See [Turning pi-cowboy off](Menu.md#turning-pi-cowboy-off) for what the menu does while it is off.

### `agent.worktreeRoot`

An unset value uses `<agent dir>/pi-cowboy/worktrees`. A relative path resolves against the repository root.

### `agent.worktreeMaterialization`

- `copy-on-write` clones files from the parent instead of checking them out. Which files it carries depends on [`worktreeCheckoutType`](#agentworktreecheckouttype).
- `checkout` uses git's classic checkout and clones nothing from the parent.

If the filesystem cannot clone, such as ext4, `copy-on-write` falls back to `checkout` instead of failing.

### `agent.worktreeCheckoutType`

Decides whether a new worktree carries the parent's uncommitted work. `clean` starts the worktree at HEAD. `dirty` carries the parent's tracked changes, and with `copy-on-write` the untracked files too. A clean parent has nothing to carry, so both settings start the worktree at HEAD.

The per-template override is documented in [Agent Templates](Agent%20Templates.md).

### `agent.harnessType`

- `pi`: the default. Runs the pane's pi binary.
- `pig`, `pi-bolt`: pi-compatible binaries.
- `opencode`, `codex`, `claude`: their own CLIs, each with its own model catalogue and default model. opencode must be 2.x: an older binary is not offered, and the reason is shown once at session start.

If the harness is not on `PATH` — or is a version pi-cowboy does not launch — the setting falls back to `pi`.

A `cowboy_agent` call can override this per item with its `harness_type` parameter. An explicit `harness_type` does not fall back: when this machine cannot launch that harness, the call fails.

### `agent.defaultModelByHarness`

The default model per harness, keyed by harness id. Each value is that harness's own `"provider/model-id"` key or `null`. The pi family (`pi`, `pig`, `pi-bolt`) shares `agent.default`, so only other harnesses need an entry. A missing or `null` entry means that harness runs its own default model.

Merging is entry by entry: a project value for one harness overrides only that harness's global value.

### Model keys

`agent.default`, `agent.defaultModelByHarness`, and `agent.<agent-type>` contain a model as `"provider/model-id"`. A `null` value falls through to the next entry.

Model resolution order, highest precedence first:

1. The `model` in a `cowboy_agent` call.
2. Session per-type override.
3. `agent.<agent-type>` in the config.
4. The agent template's model for the launching harness's family. Keys for other families contribute nothing.
5. Session default model.
6. The launching harness's default model: `agent.default` for the pi family, `agent.defaultModelByHarness` for any other harness.
7. The parent session model, for a pi-family launch only.

## `concurrency`

| Key                            | Type   | Default | Description                                                  |
| ------------------------------ | ------ | ------- | ------------------------------------------------------------ |
| `default`                      | number | `4`     | Global concurrency limit. Every agent counts against it.     |
| `providers.<provider>`         | number | unset   | Concurrency limit for one provider, for example `anthropic`. |
| `models.<provider>/<model-id>` | number | unset   | Concurrency limit for one model.                             |
| `harnesses.<harness-id>`       | number | unset   | Concurrency limit for one harness, for example `opencode`.   |

Every level is a separate limit, and an agent counts against all the limits that apply to it at once. See [Concurrency](../README.md#concurrency).

Limits are floored at one: a `0` or a negative number means one agent at a time.

pi-cowboy applies a limit change to the running session immediately. Raising a limit starts queued agents, and removing a limit stops counting against that level alone. Lowering a limit lets running agents finish, but it stops new ones from starting until the running count drops below it.
