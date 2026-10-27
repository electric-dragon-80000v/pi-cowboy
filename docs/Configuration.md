# Configuration

You can configure `pi-cowboy` through JSON configuration files or interactively from the [`/cowboy` menu](Menu.md). `pi-cowboy` reads a global configuration file and an optional project configuration file, merging them key by key.

## File locations

By default, `<agent dir>` is `~/.pi/agent` (override it with the `PI_CODING_AGENT_DIR` environment variable).

- Global config: `<agent dir>/pi-cowboy/config.json`
- Project config: `<project dir>/.pi/pi-cowboy/config.json` (loaded only for trusted projects)
- Custom system prompt: `<agent dir>/pi-cowboy/prompt.md`

Settings live under the `agent`, `concurrency`, and `harness` objects, plus the machine-level `multiplexer` key:

```json
{
  "multiplexer": "herdr",
  "agent": {
    "default": "anthropic/claude-sonnet-4",
    "defaultThinking": "medium",
    "worktreeMaterialization": "copy-on-write"
  },
  "harness": {
    "opencode": {
      "configInclude": []
    }
  },
  "concurrency": {
    "default": 4
  }
}
```

## `agent`

| Key                           | Type                                                                                               | Default             | Description                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`                     | string or null                                                                                     | `null`              | Default model for Pi-family agents. See [`agent.default`](#agentdefault).                                                                    |
| `defaultModelByHarness`       | map from harness ID to string or null                                                              | unset               | Per-harness default models for foreign harnesses. See [`agent.defaultModelByHarness`](#agentdefaultmodelbyharness).                          |
| `defaultThinkingByHarness`    | map from harness ID to string or null                                                              | unset               | Per-harness default thinking tokens for foreign harnesses. See [`agent.defaultThinkingByHarness`](#agentdefaultthinkingbyharness).           |
| `agent.<agent-type>`          | string or null                                                                                     | unset               | Model override for a specific agent type (`null` clears it). See [Model keys](#model-keys).                                                  |
| `agent.thinking.<agent-type>` | string or null                                                                                     | unset               | Thinking token for a specific agent type (`null` clears it). See [Thinking levels](#thinking-levels).                                        |
| `defaultAgentType`            | non-empty string                                                                                   | `"general-purpose"` | Agent template used when a spawn omits `agent_type`.                                                                                         |
| `defaultOrchestrator`         | non-empty string                                                                                   | `"default"`         | Orchestrator template used when a spawn omits one.                                                                                           |
| `harnessType`                 | `"pi"` \| `"pig"` \| `"pi-bolt"` \| `"opencode"` \| `"codex"` \| `"claude"` \| a plugin harness ID | `"pi"`              | Default harness when an agent template omits `harness_type`. See [`agent.harnessType`](#agentharnesstype).                                   |
| `defaultThinking`             | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                | unset               | Default thinking level for Pi-family agents. See [`agent.defaultThinking`](#agentdefaultthinking).                                           |
| `systemPromptMode`            | `"replace"` \| `"inherit"` \| `"custom"`                                                           | `"replace"`         | How `pi-cowboy` builds the agent system prompt. See [`agent.systemPromptMode`](#agentsystempromptmode).                                      |
| `includeContextFiles`         | boolean                                                                                            | `true`              | Load `AGENTS.md` context files into the agent prompt. See [`agent.includeContextFiles`](#agentincludecontextfiles).                          |
| `loadSkillsImplicitly`        | boolean                                                                                            | `true`              | Default skill loading when an agent template omits `skills`. See [`agent.loadSkillsImplicitly`](#agentloadskillsimplicitly).                 |
| `loadExtensionsImplicitly`    | boolean                                                                                            | `true`              | Default extension loading when an agent template omits `extensions`. See [`agent.loadExtensionsImplicitly`](#agentloadextensionsimplicitly). |
| `worktreeRoot`                | string                                                                                             | unset               | Directory where worktrees are created. See [`agent.worktreeRoot`](#agentworktreeroot).                                                       |
| `worktreeMaterialization`     | `"copy-on-write"` \| `"checkout"`                                                                  | `"copy-on-write"`   | How a worktree is populated from the parent working tree. See [`agent.worktreeMaterialization`](#agentworktreematerialization).              |
| `worktreeCheckoutType`        | `"dirty"` \| `"clean"`                                                                             | `"clean"`           | Whether a new worktree starts at `HEAD` or carries uncommitted work. See [`agent.worktreeCheckoutType`](#agentworktreecheckouttype).         |
| `disableDefaultAgents`        | boolean                                                                                            | `false`             | Skip built-in agent types and load only template files from disk. See [`agent.disableDefaultAgents`](#agentdisabledefaultagents).            |
| `extensionEnabled`            | boolean                                                                                            | `true`              | Enable or disable `pi-cowboy`. See [`agent.extensionEnabled`](#agentextensionenabled).                                                       |
| `showActiveIndicator`         | boolean                                                                                            | `true`              | Show the 🤠 marker while `pi-cowboy` is active.                                                                                              |
| `grazingEnabled`              | boolean                                                                                            | `true`              | Show the pasture and grazing cows under the cowboy.                                                                                          |

### `agent.default`

Sets the default model (`"provider/model-id"`) for agents launched under the Pi family (`pi`, `pig`, and `pi-bolt`). Used when no higher-priority rule in [Model keys](#model-keys) applies.

### `agent.defaultModelByHarness`

Maps each foreign harness ID (`opencode`, `codex`, `claude`) to its default model (`"provider/model-id"` or `null`). Because the Pi family (`pi`, `pig`, `pi-bolt`) shares `agent.default`, only foreign harnesses need entries here. If a harness has no entry or is set to `null`, it uses its own CLI default model.

Global and project layers merge entry by entry, so setting a project default for `opencode` leaves your global defaults for `claude` and `codex` intact.

### `agent.harnessType`

Selects the default harness used when an agent template does not set `harness_type`:

- `pi` (default): runs the `pi` binary.
- `pig`, `pi-bolt`: faster, low-memory Pi-compatible binaries.
- `opencode`, `codex`, `claude`: launches each tool's interactive CLI inside the agent's multiplexer pane, using that tool's own model catalog and defaults. `opencode` requires version 2.x; if an older version is installed, `pi-cowboy` hides it and warns once at session start.

If the configured `harnessType` is not found on `PATH` (or is an unsupported version), `pi-cowboy` falls back to `pi`.

The value may also name a plugin harness registered by a Pi package through the `pi-cowboy/plugin` contract (see [Plugins](Plugins.md)). An installed and available plugin harness behaves like a built-in harness; if unavailable or missing, `pi-cowboy` falls back to `pi`.

A `cowboy_agent` tool call can override this setting per task with its `harness_type` parameter, the [`/cowboy spawn`](Menu.md#cowboy-spawn---spawn-options) wizard with its `Harness` row, and an agent template can set `harness_type` directly. All three accept any built-in or registered plugin harness ID, though the wizard's picker offers only harnesses this machine can launch. Unlike the configuration default, an explicit `harness_type` never falls back: if the harness is not registered or the machine cannot launch it, the tool call fails immediately. If a template names an unregistered harness, pi-cowboy skips it with a warning. If it names a registered harness that the machine cannot launch, pi-cowboy retains the template and falls back to an available harness at spawn time.

### `agent.defaultThinking`

Sets the default thinking level for agents launched under the Pi family (`pi`, `pig`, and `pi-bolt`). Used when no higher-priority rule in [Thinking levels](#thinking-levels) applies. When left unset, `pi`'s own default thinking level applies.

### `agent.defaultThinkingByHarness`

Maps each non-Pi harness ID (`opencode`, `codex`, `claude`, or plugin IDs) to its default thinking token, or `null` for none. Pi-family harnesses (`pi`, `pig`, `pi-bolt`) use `agent.defaultThinking` instead. If a harness entry is omitted or set to `null`, no thinking flag is passed at launch, allowing the harness binary's internal default to apply.

The token is forwarded without validation or translation (see [Agent Templates](Agent%20Templates.md#harness-family-sections)).

Global and project layers merge per entry: defining a project-level default for `codex` preserves global defaults for `claude` and `opencode`.

### `agent.thinking`

Sets the thinking token for a specific agent type in the vocabulary of its launching harness. Setting the value to `null` clears the override.

This setting applies regardless of whether the agent type defines an explicit model. If the agent type's configured harness changes, the token is interpreted in the new harness's vocabulary. To configure this override for the current session only, use `/cowboy` > `Model overrides`.

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

Controls how a new worktree is populated:

- `copy-on-write` (default): clones files from the parent working tree using filesystem copy-on-write (APFS, BTRFS, ZFS). Which files are carried over depends on [`agent.worktreeCheckoutType`](#agentworktreecheckouttype).
- `checkout`: runs a standard git checkout and clones nothing from the parent working tree.

If the volume does not support copy-on-write cloning (for example, `ext4` on Linux), `copy-on-write` automatically falls back to `checkout`.

### `agent.worktreeCheckoutType`

Controls what a new worktree inherits when the parent working tree has uncommitted changes:

- `clean` (default): starts the worktree at `HEAD`. Under `copy-on-write`, tracked files match `HEAD`, while ignored files such as `node_modules` and `.env` are still cloned from the parent so builds and tests work right away. Under `checkout`, git performs a plain checkout of `HEAD`.
- `dirty`: carries the parent's uncommitted work into the new worktree. Under `copy-on-write`, both tracked edits and untracked files are cloned; under `checkout`, only tracked modifications are applied on top of `HEAD`.

If the parent working tree is already clean, both modes start at `HEAD`. Individual agent templates can override this setting with `worktree_checkout_type` (see [Agent Templates](Agent%20Templates.md)).

### `agent.handoverMaxExcludedRatio`

The maximum fraction of a handover session's countable records that may be unparseable before the handover is refused. A source harness classifies its native conversation records; shared handover logic omits unparseable records, reports their count once, and compares their share with this key:

- `0.5` (default): an export that loses more than half its records is refused as a failure, leaving the run unchanged.
- `1`: an export that loses records is still handed over, regardless of the number lost.
- `0`: an export that loses any record is refused as a failure, leaving the run unchanged.

Known irrelevant store traffic is not a handover record and cannot dilute the ratio. A valid conversation record deliberately omitted from the transcript is not lost. A handover that remains within the limit reports one loss summary with warning severity. Project configuration files cannot set this key, and no menu row carries it.

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
5. The Pi-family session default model (set via `/cowboy model`, which picks from Pi's catalog).
6. The launching harness's configured default: `agent.default` for the Pi family, or `agent.defaultModelByHarness.<harness>` for foreign harnesses.
7. The parent session's active model (Pi-family launches only).

### Thinking levels

`agent.defaultThinking`, `agent.defaultThinkingByHarness`, and `agent.thinking.<agent-type>` all accept a thinking token, or `null` to clear the entry and fall through to the next level. The token is in the vocabulary of the harness that reads it: pi's levels are `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, and `"max"`, while each foreign harness names its own.

When spawning an agent, `pi-cowboy` resolves the thinking level in this order (highest precedence first):

1. Session per-type override (set for the current session in `/cowboy` > `Model overrides`).
2. Config per-type override (`agent.thinking.<agent-type>` in project or global `config.json`).
3. The agent template's `thinking` for the launching harness family (tokens for other harness families are ignored).
4. The launching harness's configured default: `agent.defaultThinking` for the Pi family, or `agent.defaultThinkingByHarness.<harness>` for foreign harnesses.
5. The parent session's current level (Pi-family launches only). Foreign harnesses never inherit it because the parent's level is in Pi's vocabulary.
6. No level resolves: the launch asks for no level, and the harness's own default applies.

The parent session's level is the final fallback before asking for no level, matching the precedence in [model resolution](#model-keys): a configured default still wins. The resolved thinking level passes to the launch process without alteration, and `pi-cowboy` never rewrites a token to suit the child's model. Because thinking levels resolve independently of models, an agent spawning without an explicit model override still applies the configured thinking level.

## `multiplexer`

Sets the terminal multiplexer used to host subagent panes, specified by ID. This is a machine-level setting and cannot be configured in project files.

- `herdr` (default): The built-in multiplexer running over the multiplexer CLI.
- Any other ID: A custom multiplexer registered by a Pi package through the `pi-cowboy/plugin` contract (see [Plugins](Plugins.md)).

`pi-cowboy` requires a registered multiplexer that detects the current environment. If the configured `multiplexer` is unregistered or fails to detect the environment, `pi-cowboy` falls back to the first registered multiplexer whose environment check succeeds (`herdr` first, followed by plugin multiplexers in package-name order). If no registered multiplexer detects the environment, the extension loads its plugins but remains inactive, reporting that it cannot launch panes. Registering a plugin multiplexer allows `pi-cowboy` to operate inside terminal multiplexers other than herdr.

## `harness`

The `harness` object configures individual harnesses, keyed by harness ID. Each harness defines the schema, validation rules, and defaults for its configuration section. Unrecognized IDs retain their raw configuration until a matching plugin registers. Harnesses without custom configuration require no entry.

### `harness.<id>.env`

Defines environment variables that every spawn of a harness carries, in addition to the pane's own environment:

```json
{
  "harness": {
    "codex": { "env": { "MY_FLAG": "1" } }
  }
}
```

The section is keyed by harness ID, so `harness.pi.env` applies to `pi` alone; `pig` and `pi-bolt` read their own sections. An agent template's `[harness.<family>.env]` table (see [Agent Templates](Agent%20Templates.md#env-overrides)) is layered over this map per variable, so a template can replace what the machine set without restating the rest.

Each spawn receives its variables in an owner-only file (`env.sh`) inside its staging directory. The launcher sources this file for the launched process only, preserving the pane shell's environment afterward. The values never appear on the command line typed into the pane, so they do not land in that pane's scrollback or in the shell's history file. A variable is dropped with a warning when its name is not a valid identifier, when it is reserved, or when its value contains a control character (which would end the shell statement that carries it). Reserved names are `PATH`, `HOME`, `SHELL`, `PWD`, `OLDPWD`, `IFS`, `CDPATH`, `GLOBIGNORE`, the `PS` prompts, `BASH_ENV`, `ENV`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_AUDIT`, every `DYLD_*`, `HERDR_*`, and `COWBOY_*` name, and the names set by each harness's launcher (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and others). A harness registered by a plugin contributes its own reserved names through `reservedEnvVars` ([Plugins](Plugins.md#launch-environment)).

This is a machine-level setting configured only in the global `config.json`; project configuration files cannot set it.

### `harness.opencode`

Configures the settings an `opencode` subagent inherits from the user's OpenCode configuration (`opencode.json` or `opencode.jsonc`). A file named by `OPENCODE_CONFIG` is filtered and staged alongside them. Because each subagent runs with an isolated `OPENCODE_CONFIG_DIR`, staging this configuration supplies the parent session's providers and models.

By default, the staged configuration copies general settings (including providers, models, and unreserved top-level keys) while excluding `$schema` and the root keys listed below. Excluded roots are omitted unless explicitly included using `configInclude`:

`agent`, `agents`, `autoupdate`, `experimental`, `instructions`, `mode`, `permission`, `permissions`, `plugin`, `plugins`, `policies`, `reference`, `references`, `skills`, `tools`, `update`

MCP servers are copied as a general setting, so a subagent keeps the parent session's MCP tools without any configuration.

| Key                              | Type             | Default | Description                                                                                               |
| -------------------------------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `harness.opencode.configInclude` | array of strings | `[]`    | Excluded root keys to copy whole from the parent session's configuration (for example, `"instructions"`). |

Entries in `configInclude` must name one of the excluded keys above; a root is copied whole, with no way to copy part of one. Keys outside the excluded set are rejected as invalid because unexcluded settings are already copied. The `$schema` key is never copied.

To prevent subagents from checking for CLI updates, every spawn launches with `OPENCODE_DISABLE_AUTOUPDATE=1`.

Relative `{file:...}` paths in copied configurations resolve against the directory of the file that contains them.

This is a machine-level setting configured only in the global `config.json`; project configuration files cannot set it. It has no `/cowboy` menu row.

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
- Thinking keys (`agent.defaultThinking`, `agent.defaultThinkingByHarness`, and per-type overrides `agent.thinking.<agent-type>`)
- `concurrency` limits

All other settings in a project file are ignored during merging: any other recognized `agent` key (such as `defaultAgentType` or `worktreeRoot`), the machine-level `multiplexer` key, and `harness.<id>` sections. Harness sections are never merged into the effective configuration layer: because harness settings configure the local machine rather than the repository (for example, `harness.opencode.configInclude` selects local OpenCode configuration to stage), they are read only from the global configuration file. A harness whose codec declares `scope: "project"` receives the project slice directly and decides how the layers combine; built-in harnesses do not opt in. Any unrecognized key inside `agent` is treated as an `agent.<agent-type>` model override.

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
