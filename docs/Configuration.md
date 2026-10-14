# Configuration

You can configure `pi-cowboy` through JSON configuration files or interactively from the [`/cowboy` menu](Menu.md). `pi-cowboy` reads a global configuration file and an optional project configuration file, merging them key by key.

## File locations

By default, `<agent dir>` is `~/.pi/agent` (override it with the `PI_CODING_AGENT_DIR` environment variable).

- Global config: `<agent dir>/pi-cowboy/config.json`
- Project config: `<project dir>/.pi/pi-cowboy/config.json` (loaded only for trusted projects)
- Custom system prompt: `<agent dir>/pi-cowboy/prompt.md`

All settings live under two top-level objects, `agent` and `concurrency`:

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

## `agent`

| Key                        | Type                                                                                | Default             | Description                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`                  | string or null                                                                      | `null`              | Default model for Pi-family agents. See [`agent.default`](#agentdefault).                                                                    |
| `defaultModelByHarness`    | map from harness ID to string or null                                               | unset               | Per-harness default models for foreign harnesses. See [`agent.defaultModelByHarness`](#agentdefaultmodelbyharness).                          |
| `agent.<agent-type>`       | string or null                                                                      | unset               | Model override for a specific agent type (`null` clears it). See [Model keys](#model-keys).                                                  |
| `defaultAgentType`         | non-empty string                                                                    | `"general-purpose"` | Agent template used when a spawn omits `agent_type`.                                                                                         |
| `defaultOrchestrator`      | non-empty string                                                                    | `"default"`         | Orchestrator template used when a spawn omits one.                                                                                           |
| `harnessType`              | `"pi"` \| `"pig"` \| `"pi-bolt"` \| `"opencode"` \| `"codex"` \| `"claude"`         | `"pi"`              | Default harness when an agent template omits `harness_type`. See [`agent.harnessType`](#agentharnesstype).                                   |
| `defaultThinking`          | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | unset               | Thinking level used when an agent template omits `thinking`. See [`agent.defaultThinking`](#agentdefaultthinking).                           |
| `systemPromptMode`         | `"replace"` \| `"inherit"` \| `"custom"`                                            | `"replace"`         | How `pi-cowboy` builds the agent system prompt. See [`agent.systemPromptMode`](#agentsystempromptmode).                                      |
| `includeContextFiles`      | boolean                                                                             | `true`              | Load `AGENTS.md` context files into the agent prompt. See [`agent.includeContextFiles`](#agentincludecontextfiles).                          |
| `loadSkillsImplicitly`     | boolean                                                                             | `true`              | Default skill loading when an agent template omits `skills`. See [`agent.loadSkillsImplicitly`](#agentloadskillsimplicitly).                 |
| `loadExtensionsImplicitly` | boolean                                                                             | `true`              | Default extension loading when an agent template omits `extensions`. See [`agent.loadExtensionsImplicitly`](#agentloadextensionsimplicitly). |
| `worktreeRoot`             | string                                                                              | unset               | Directory where worktrees are created. See [`agent.worktreeRoot`](#agentworktreeroot).                                                       |
| `worktreeMaterialization`  | `"copy-on-write"` \| `"checkout"`                                                   | `"copy-on-write"`   | How a worktree is populated from the parent working tree. See [`agent.worktreeMaterialization`](#agentworktreematerialization).              |
| `worktreeCheckoutType`     | `"dirty"` \| `"clean"`                                                              | `"clean"`           | Whether a new worktree starts at `HEAD` or carries uncommitted work. See [`agent.worktreeCheckoutType`](#agentworktreecheckouttype).         |
| `disableDefaultAgents`     | boolean                                                                             | `false`             | Skip built-in agent types and load only template files from disk. See [`agent.disableDefaultAgents`](#agentdisabledefaultagents).            |
| `extensionEnabled`         | boolean                                                                             | `true`              | Enable or disable `pi-cowboy`. See [`agent.extensionEnabled`](#agentextensionenabled).                                                       |
| `showActiveIndicator`      | boolean                                                                             | `true`              | Show the 🤠 marker while `pi-cowboy` is active.                                                                                              |
| `grazingEnabled`           | boolean                                                                             | `true`              | Show the pasture and grazing cows under the cowboy.                                                                                          |

### `agent.default`

Sets the default model (`"provider/model-id"`) for agents launched under the Pi family (`pi`, `pig`, and `pi-bolt`). Used when no higher-priority rule in [Model keys](#model-keys) applies.

### `agent.defaultModelByHarness`

Maps each foreign harness ID (`opencode`, `codex`, `claude`) to its default model (`"provider/model-id"` or `null`). Because the Pi family (`pi`, `pig`, `pi-bolt`) shares `agent.default`, only foreign harnesses need entries here. If a harness has no entry or is set to `null`, it uses its own CLI default model.

Global and project layers merge entry by entry, so setting a project default for `opencode` leaves your global defaults for `claude` and `codex` intact.

### `agent.harnessType`

Selects the default harness used when an agent template does not set `harness_type`:

- `pi` (default): runs the `pi` binary.
- `pig`, `pi-bolt`: faster, low-memory Pi-compatible binaries.
- `opencode`, `codex`, `claude`: launches each tool's interactive CLI inside the agent's Herdr pane, using that tool's own model catalog and defaults. `opencode` requires version 2.x; if an older version is installed, `pi-cowboy` hides it and warns once at session start.

If the configured `harnessType` is not on `PATH` (or is an unsupported version), `pi-cowboy` falls back to `pi`.

A `cowboy_agent` tool call can override this setting per task with its `harness_type` parameter. Unlike the config setting, an explicit `harness_type` in a tool call never falls back: if the machine cannot launch the requested harness, the call fails immediately.

### `agent.defaultThinking`

Sets the reasoning effort level when an agent template omits `thinking`. When left unset, `pi`'s own default thinking level applies.

### `agent.systemPromptMode`

Controls what opens the agent's system prompt before `pi-cowboy` appends its own sections (such as context files, skills, and orchestrator guidance):

- `replace` (default): starts with `pi-cowboy`'s own base prompt rather than inheriting from the parent session.
- `inherit`: starts with the parent session's system prompt. If the parent prompt cannot be read, `pi-cowboy` warns and falls back to `replace`.
- `custom`: starts with the contents of `<agent dir>/pi-cowboy/prompt.md`. See [The custom system prompt file](#the-custom-system-prompt-file).

### The custom system prompt file

When `agent.systemPromptMode` is set to `custom`, `pi-cowboy` reads `<agent dir>/pi-cowboy/prompt.md` (a plain Markdown file) and places its contents at the start of the agent's system prompt. You can create a starter file from `/cowboy` > `Settings` > `System prompt` > `Create prompt file`.

If `prompt.md` is missing or empty, `pi-cowboy` logs a warning and uses the `replace` prompt instead.

### `agent.includeContextFiles`

When `true`, `pi-cowboy` loads `AGENTS.md` context files from `<agent dir>` and from every directory between the repository root and the agent's working directory. Individual [agent templates](Agent%20Templates.md) can override this with `include_context_files`.

### `agent.loadSkillsImplicitly`

Fallback for agent templates that omit `skills`. When `true`, spawned Pi-family agents load all available `pi` skills; when `false`, they load none. If a template explicitly sets `skills`, the template's setting wins.

### `agent.loadExtensionsImplicitly`

Fallback for agent templates that omit `extensions`. When `true`, spawned Pi-family agents load all available `pi` extensions; when `false`, they load none. If a template explicitly sets `extensions`, the template's setting wins.

### `agent.worktreeRoot`

Directory where `pi-cowboy` creates agent worktrees. When unset, worktrees live under `<agent dir>/pi-cowboy/worktrees`. Relative paths resolve against the repository root.

### `agent.worktreeMaterialization`

Controls how a new worktree gets its files:

- `copy-on-write` (default): clones files from the parent working tree using filesystem copy-on-write (APFS, BTRFS, ZFS). Which files are carried over depends on [`agent.worktreeCheckoutType`](#agentworktreecheckouttype).
- `checkout`: runs a standard git checkout and clones nothing from the parent working tree.

If the volume does not support copy-on-write cloning (for example, `ext4` on Linux), `copy-on-write` automatically falls back to `checkout`.

### `agent.worktreeCheckoutType`

Controls what a new worktree inherits when the parent working tree has uncommitted changes:

- `clean` (default): starts the worktree at `HEAD`. Under `copy-on-write`, tracked files match `HEAD`, while ignored files such as `node_modules` and `.env` are still cloned from the parent so builds and tests work right away. Under `checkout`, git performs a plain checkout of `HEAD`.
- `dirty`: carries the parent's uncommitted work into the new worktree. Under `copy-on-write`, both tracked edits and untracked files are cloned; under `checkout`, only tracked modifications are applied on top of `HEAD`.

If the parent working tree is already clean, both modes start at `HEAD`. Individual agent templates can override this setting with `worktree_checkout_type` (see [Agent Templates](Agent%20Templates.md)).

### `agent.disableDefaultAgents`

When `true`, `pi-cowboy` skips its built-in agent types and loads only `.toml` files from the user, shared, and project directories listed in [Agent Templates](Agent%20Templates.md). Changes to this key take effect on the next session.

### `agent.extensionEnabled`

When `false`, `pi-cowboy` unloads its tools for the session while any already-running agents finish their work. See [Turning pi-cowboy off](Menu.md#turning-pi-cowboy-off).

### Model keys

`agent.default`, `agent.defaultModelByHarness`, and `agent.<agent-type>` all accept a model ID formatted as `"provider/model-id"`, or `null` to clear the entry and fall through to the next level.

When spawning an agent, `pi-cowboy` resolves the model in this order (highest precedence first):

1. The `model` parameter passed in a `cowboy_agent` call.
2. Session per-type override (set for the current session in `/cowboy` > `Model overrides`).
3. Config per-type override (`agent.<agent-type>` in project or global `config.json`).
4. The agent template's `model` for the launching harness family (model keys for other harness families are ignored).
5. Session default model (set via `/cowboy model`).
6. The launching harness's configured default: `agent.default` for the Pi family, or `agent.defaultModelByHarness.<harness>` for foreign harnesses.
7. The parent session's active model (Pi-family launches only).

## `concurrency`

| Key                            | Type             | Default | Description                                                                                                                                                               |
| ------------------------------ | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`                      | positive integer | `4`     | Global concurrency limit. Every running agent counts against it.                                                                                                          |
| `harnesses.<harness-id>`       | positive integer | unset   | Concurrency limit for one harness (for example, `opencode` or `claude`).                                                                                                  |
| `providers.<provider>`         | positive integer | unset   | Concurrency limit for one provider. Prefix with `<harness>:` for foreign harnesses (for example, `opencode:anthropic`); a bare key applies to the Pi family.              |
| `models.<provider>/<model-id>` | positive integer | unset   | Concurrency limit for one model. Prefix with `<harness>:` for foreign harnesses (for example, `opencode:anthropic/claude-sonnet-4`); a bare key applies to the Pi family. |

Each level acts as an independent cap, and a running agent occupies a slot in every limit that applies to it. All concurrency limits must be positive integers (`1` or greater). See [Concurrency](../README.md#concurrency) for how queuing works.

Changes to concurrency limits apply to the running session immediately:

- Raising a limit starts waiting agents as soon as all of their applicable pools have room.
- Removing a limit stops enforcing that pool while keeping other limits active.
- Lowering a limit lets currently running agents finish, but prevents new ones from starting in that pool until the active count drops below the new cap.

## Layers

`pi-cowboy` layers settings in this order:

`session` > `project` (`.pi/pi-cowboy/config.json`) > `global` (`~/.pi/agent/pi-cowboy/config.json`) > built-in defaults

Each file stores only the keys set at that layer; `pi-cowboy` never writes the merged result back into a single file. Session overrides live only in memory for the current session. If a config file on disk contains invalid JSON, `pi-cowboy` warns and refuses to overwrite it so you can fix or delete the file manually.

### Project config restrictions

To keep project configs safe to share in version control, `.pi/pi-cowboy/config.json` is only loaded for trusted projects and may only configure:

- Model keys (`agent.default`, `agent.defaultModelByHarness`, and per-type overrides `agent.<agent-type>`)
- `agent.defaultThinking`
- `concurrency` limits

Any other recognized `agent` key (such as `defaultAgentType` or `worktreeRoot`) placed in a project file is ignored during merging. Any unrecognized key inside `agent` is treated as an `agent.<agent-type>` model override.

### Invalid values

If a key has an invalid type or value, `pi-cowboy` ignores that key, prints a warning naming the file, key, and invalid value, and falls back to the lower layer or built-in default.

For example, given this global config:

```json
{
  "agent": {
    "defaultThinking": "high",
    "defaultAgentType": 123
  },
  "concurrency": {
    "default": "four"
  }
}
```

`defaultThinking` applies normally, while `defaultAgentType` and `concurrency.default` trigger warnings and fall back to `"general-purpose"` and `4`.
