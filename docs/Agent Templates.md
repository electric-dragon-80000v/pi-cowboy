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

| Field                    | Type                   | Default                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                   | string (required)      | (required)                   | Template identifier used in `cowboy_agent` calls and layer merging.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `display_name`           | string                 | `name`                       | Label shown in the `/cowboy` menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `description`            | string                 | `""`                         | Short summary of what the agent does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `system_prompt`          | string                 | inherited                    | Instructions for the agent. Omit to inherit from a lower layer; set to `""` to clear an inherited prompt.                                                                                                                                                                                                                                                                                                                                                                                              |
| `harness_type`           | harness ID             | `agent.harnessType`          | Harness used to launch this agent: `"pi"`, `"pig"`, `"pi-bolt"`, `"opencode"`, `"codex"`, `"claude"`, or a harness ID registered by a plugin ([Plugins](Plugins.md)). Unlike the global config default, an explicit template harness never falls back to `"pi"`. If a template names an unregistered harness, pi-cowboy skips it with a warning. If it names a registered harness that the machine cannot launch, pi-cowboy retains the template and falls back to an available harness at spawn time. |
| `worktree_checkout_type` | `"clean"` \| `"dirty"` | `agent.worktreeCheckoutType` | Whether a new worktree starts at `HEAD` (`"clean"`) or carries the parent's uncommitted work (`"dirty"`). See [`agent.worktreeCheckoutType`](Configuration.md#agentworktreecheckouttype).                                                                                                                                                                                                                                                                                                              |
| `hidden`                 | boolean                | `false`                      | Hide this template from the `agent_type` list in the UI and tool description while still allowing direct calls by `name`.                                                                                                                                                                                                                                                                                                                                                                              |

### Shared harness settings (`[harness]`)

Settings placed directly under `[harness]` apply regardless of which harness launches the agent:

| Field                   | Type    | Default                     | Description                                                                                                     |
| ----------------------- | ------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `include_context_files` | boolean | `agent.includeContextFiles` | Whether the agent's staged system prompt includes `AGENTS.md` context files from the project and `<agent dir>`. |

### Harness family sections

Because each harness family has its own model catalog, CLI flags, and tool names, model and tool settings are scoped under `[harness.<family>]`. When an agent launches, it reads only the section for its own harness family:

- `[harness.pi]` applies to the Pi family (`pi`, `pig`, and `pi-bolt`).
- `[harness.opencode]` applies to `opencode`.
- `[harness.codex]` applies to `codex`.
- `[harness.claude]` applies to `claude`.

A single template can include sections for multiple families so the agent works seamlessly whichever harness launches it. For backward compatibility, `[harness.pi]` keys — `thinking` among them — may also be written flat under `[harness]`; a flat key means the Pi family's, and no other family reads it. If a key is set in both places, `[harness.pi]` wins.

Each family's `thinking` token is carried as written: nothing translates one harness's vocabulary into another's, and a level this section names sits below the per-type config layers in [Thinking levels](Configuration.md#thinking-levels).

#### `[harness.pi]`

| Field            | Type                | Default                          | Description                                                                                                                          |
| ---------------- | ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `model`          | string              | unset                            | Model from Pi's catalog as `"provider/model-id"`. See [Model keys](Configuration.md#model-keys) for precedence.                      |
| `thinking`       | thinking level      | `agent.defaultThinking`          | Reasoning effort: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`.                                        |
| `tools`          | string[]            | all tools                        | Allowlist of Pi tool names (for example, `["read", "bash", "grep", "find"]`).                                                        |
| `exclude_tools`  | string[]            | none excluded                    | Blocklist of Pi tool names. Set either `tools` or `exclude_tools`; if both are set, `tools` wins.                                    |
| `skills`         | boolean or string[] | `agent.loadSkillsImplicitly`     | `true` loads all Pi skills, `false` loads none, or a list of skill names loads only those skills (name, description, and file path). |
| `inlined_skills` | string[]            | `[]`                             | Skill names whose full Markdown contents are inlined directly into the agent's system prompt.                                        |
| `extensions`     | boolean or string[] | `agent.loadExtensionsImplicitly` | `true` loads all Pi extensions, `false` loads none, or a list of extension names loads only those extensions.                        |

#### `[harness.opencode]`

| Field           | Type     | Default                                   | Description                                                                                                                                                                                  |
| --------------- | -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | string   | unset                                     | Model from opencode's catalog as `"provider/model-id"`. See [Model keys](Configuration.md#model-keys) for precedence.                                                                        |
| `variant`       | string   | `agent.defaultThinkingByHarness.opencode` | Reasoning effort variant, joined to this agent's model as `"provider/model#variant"`. A variant names a member of one model's catalog, so a variant with no `model` here refuses the launch. |
| `tools`         | string[] | all tools                                 | Allowlist of opencode permission actions (for example, `["bash", "edit"]`).                                                                                                                  |
| `exclude_tools` | string[] | none excluded                             | Blocklist of opencode permission actions. Set either `tools` or `exclude_tools`; if both are set, `tools` wins.                                                                              |

#### `[harness.codex]`

codex accepts no tools flag, so this section carries no tool pair.

| Field      | Type   | Default                                | Description                                                                                                                                                                 |
| ---------- | ------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`    | string | unset                                  | Model from codex's catalog as `"provider/model-id"`. See [Model keys](Configuration.md#model-keys) for precedence.                                                          |
| `thinking` | string | `agent.defaultThinkingByHarness.codex` | Reasoning effort, passed as `model_reasoning_effort` in codex's own vocabulary (for example, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, or `"ultra"`). |

#### `[harness.claude]`

| Field           | Type     | Default                                 | Description                                                                                                                                                        |
| --------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`         | string   | unset                                   | Model from claude's catalog as `"anthropic/<alias>"`; the launch passes the bare alias to `--model`. See [Model keys](Configuration.md#model-keys) for precedence. |
| `thinking`      | string   | `agent.defaultThinkingByHarness.claude` | Reasoning effort, passed as `--effort`: `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`.                                                                      |
| `tools`         | string[] | all tools                               | Allowlist of claude tool names (for example, `["Bash", "Read"]`), passed to `--tools` exactly as written.                                                          |
| `exclude_tools` | string[] | none excluded                           | Blocklist of claude tool names, passed to `--disallowedTools`. Set either `tools` or `exclude_tools`; if both are set, `tools` wins.                               |
