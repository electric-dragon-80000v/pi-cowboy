# Agent Templates

An agent template is a `.toml` file that defines a reusable specialist agent with its own system prompt, model, harness, and tool permissions.

Here is a minimal template that defines a read-only release notes writer for Pi:

```toml
name = "release-notes"
display_name = "Release Notes"
description = "Prepares release notes for this repository."
system_prompt = '''
You prepare release notes for this repository. Read the history and tags
(git log, git tag) and report the changes as a message.
'''

[harness.pi]
model = "anthropic/claude-sonnet-4"
tools = ["read", "bash", "grep", "find"]
```

## File locations

`pi-cowboy` scans four directories for `.toml` agent templates at session start:

- Extension built-ins: `agents/` inside the `pi-cowboy` package
- User: `<agent dir>/agents/` (`~/.pi/agent/agents/` by default, or overridden by `PI_CODING_AGENT_DIR`)
- Shared: `<project>/.agents/agents/` (loaded only when the project is trusted)
- Project: `<project>/.pi/agents/` (loaded only when the project is trusted)

Every template file must define a `name`. `pi-cowboy` skips any file that is missing `name`, contains invalid TOML, or includes an unrecognized key, and prints a one-line warning.

## Merging across layers

Templates are matched across directories by `name`, with higher layers overriding lower ones in this order:

`default` < `extension` < `user` < `shared` < `project`

When two layers define a template with the same `name`, `pi-cowboy` merges them field by field: any field set in the higher layer replaces the lower layer's value, while omitted fields are inherited from the lower layer.

For example, if the extension ships a `release-notes` template and you create `~/.pi/agent/agents/release-notes.toml` with only a new description:

```toml
# ~/.pi/agent/agents/release-notes.toml
name = "release-notes"
description = "Prepares release notes for this repository."
```

The merged template uses your `description` and keeps the extension template's `system_prompt` and `[harness]` settings. Fields are never concatenated; setting a field replaces the inherited value outright.

The only exception to field-by-field inheritance is the pair of identity fields, `display_name` and `description`. Because those two fields label the template in the UI, an override file replaces both of them at once: if your override omits `display_name`, it falls back to `name`, and if it omits `description`, the description becomes empty (`""`).

## Fields

### Top-level fields

| Field                    | Type                     | Default                        | Description                                                                                                                                                                                                 |
| ------------------------ | ------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | string (required)        | (required)                     | Template identifier used in `cowboy_agent` calls and layer merging.                                                                                                                                         |
| `display_name`           | string                   | `name`                         | Label shown in the `/cowboy` menu.                                                                                                                                                                          |
| `description`            | string                   | `""`                           | Short summary of what the agent does.                                                                                                                                                                       |
| `system_prompt`          | string                   | inherited                      | Instructions for the agent. Omit to inherit from a lower layer; set to `""` to clear an inherited prompt.                                                                                                   |
| `harness_type`           | harness ID               | `agent.harnessType`            | Harness used to launch this agent: `"pi"`, `"pig"`, `"pi-bolt"`, `"opencode"`, `"codex"`, or `"claude"`. If the machine cannot launch the template's harness, `pi-cowboy` falls back to `"pi"`.             |
| `worktree_checkout_type` | `"clean"` \| `"dirty"`   | `agent.worktreeCheckoutType`   | Whether a new worktree starts at `HEAD` (`"clean"`) or carries the parent's uncommitted work (`"dirty"`). See [`agent.worktreeCheckoutType`](Configuration.md#agentworktreecheckouttype).                   |
| `hidden`                 | boolean                  | `false`                        | Hide this template from the `agent_type` list in the UI and tool description while still allowing direct calls by `name`.                                                                                   |

### Shared harness settings (`[harness]`)

Settings placed directly under `[harness]` apply regardless of which harness launches the agent:

| Field                   | Type    | Default                      | Description                                                                                                                        |
| ----------------------- | ------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `include_context_files` | boolean | `agent.includeContextFiles`  | Whether the agent's staged system prompt includes `AGENTS.md` context files from the project and `<agent dir>`.                    |

### Harness family sections

Because each harness family has its own model catalog, CLI flags, and tool names, model and tool settings are scoped under `[harness.<family>]`. When an agent launches, it reads only the section for its own harness family:

- `[harness.pi]` applies to the Pi family (`pi`, `pig`, and `pi-bolt`).
- `[harness.opencode]` applies to `opencode`.
- `[harness.codex]` applies to `codex`.
- `[harness.claude]` applies to `claude`.

A single template can include sections for multiple families so the agent works seamlessly whichever harness launches it. For backward compatibility, `[harness.pi]` keys may also be written flat under `[harness]`; if a key is set in both places, `[harness.pi]` wins.

#### `[harness.pi]`

| Field            | Type                         | Default                          | Description                                                                                                                                               |
| ---------------- | ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`          | string                       | unset                            | Model from Pi's catalog as `"provider/model-id"`. See [Model keys](Configuration.md#model-keys) for precedence.                                           |
| `thinking`       | thinking level               | `agent.defaultThinking`          | Reasoning effort: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`.                                                             |
| `tools`          | string[]                     | all tools                        | Allowlist of Pi tool names (for example, `["read", "bash", "grep", "find"]`).                                                                             |
| `exclude_tools`  | string[]                     | none excluded                    | Blocklist of Pi tool names. Set either `tools` or `exclude_tools`; if both are set, `tools` wins.                                                         |
| `skills`         | boolean or string[]          | `agent.loadSkillsImplicitly`     | `true` loads all Pi skills, `false` loads none, or a list of skill names loads only those skills (name, description, and file path).                      |
| `inlined_skills` | string[]                     | `[]`                             | Skill names whose full Markdown contents are inlined directly into the agent's system prompt.                                                             |
| `extensions`     | boolean or string[]          | `agent.loadExtensionsImplicitly` | `true` loads all Pi extensions, `false` loads none, or a list of extension names loads only those.                                                        |
| `fork`           | boolean                      | `false`                          | Fork the parent session context into the spawned agent (`pi --fork <sessionFile>`).                                                                       |

#### `[harness.opencode]`

| Field           | Type     | Default       | Description                                                                                                                                                              |
| --------------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`         | string   | unset         | Model from OpenCode's catalog as `"provider/model-id"`.                                                                                                                  |
| `variant`       | string   | none          | Reasoning-effort variant appended as `"provider/model#variant"` (for example, `"minimal"`, `"high"`, `"max"`). Requires `model` to be set and to support that variant.   |
| `tools`         | string[] | all tools     | Allowlist of OpenCode permission actions (`"read"`, `"glob"`, `"grep"`, `"edit"`, `"shell"`, `"webfetch"`, etc.).                                                        |
| `exclude_tools` | string[] | none excluded | Blocklist of OpenCode permission actions. If both `tools` and `exclude_tools` are set, `tools` wins.                                                                     |

#### `[harness.codex]`

`codex` does not expose a CLI flag for filtering tools, so `[harness.codex]` configures only the model:

| Field   | Type   | Default | Description                                                                                                                       |
| ------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `model` | string | unset   | Model from Codex's catalog as `"provider/model-id"` (for example, `"openai/gpt-6-sol"`). `pi-cowboy` strips `openai/` for `-m`.   |

#### `[harness.claude]`

| Field           | Type     | Default       | Description                                                                                                                                          |
| --------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | string   | unset         | Model from Claude Code's catalog as `"anthropic/<alias>"` (for example, `"anthropic/sonnet"`). `pi-cowboy` strips `anthropic/` for the CLI.          |
| `tools`         | string[] | all tools     | Allowlist of Claude Code tool names (`"Bash"`, `"Read"`, `"Write"`, `"Edit"`, `"Glob"`, `"Grep"`, `"Task"`, etc.), passed to `--tools`.              |
| `exclude_tools` | string[] | none excluded | Blocklist of Claude Code tool names, passed to `--disallowedTools`. If both `tools` and `exclude_tools` are set, `tools` wins.                       |

##### Claude Code API key handling

When launching `claude`, `pi-cowboy` renames `ANTHROPIC_API_KEY` in the pane's environment to `COWBOY_API_KEY` and reads it through a staged `apiKeyHelper`. This prevents Claude Code from halting on its interactive environment-key consent prompt. If `ANTHROPIC_API_KEY` is not set in your environment, `pi-cowboy` omits `apiKeyHelper` so normal OAuth and keychain logins work unchanged.

## Complete example

```toml
name = "release-notes"
display_name = "Release Notes"
description = "Prepares release notes for this repository."
hidden = false
worktree_checkout_type = "clean"
harness_type = "pi"

system_prompt = '''
You prepare release notes for this repository. Read the history and tags
(git log, git tag) and report the changes as a message.
'''

[harness]
include_context_files = true

[harness.pi]
model = "anthropic/claude-sonnet-4"
thinking = "medium"
tools = ["read", "bash", "grep", "find"]
# exclude_tools = ["write"]
extensions = true
skills = ["release-notes"]
inlined_skills = []
fork = false

[harness.opencode]
model = "anthropic/claude-sonnet-4"
variant = "high"
tools = ["read", "grep", "glob"]
# exclude_tools = ["edit"]

[harness.codex]
model = "openai/gpt-6-sol"

[harness.claude]
model = "anthropic/sonnet"
tools = ["Bash", "Read", "Glob"]
# exclude_tools = ["Bash"]
```
