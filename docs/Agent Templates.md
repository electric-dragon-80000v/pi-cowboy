# Agent Templates

An agent template is a `.toml` file in one of these directories:

- Extension built-ins: `agents/` in the extension package.
- User: `<agent dir>/agents/`, where the agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.
- Shared: `<project>/.agents/agents/`.
- Project: `<project>/.pi/agents/`.

pi-cowboy loads the shared and project directories only when the project is trusted.

Precedence is `default` < `extension` < `user` < `shared` < `project`, and pi-cowboy matches an override by `name`.

Merging is per field: a set field wins, and an unset field falls through to the next lower layer. `display_name` and `description` identify the file, so the highest layer that carries the name replaces both of them.

pi-cowboy skips a file without a `name`. It also skips a file with invalid TOML or an unknown key, and reports a one-line warning.

## Merging across layers

Two files named `release-notes`, one in the extension package and one in `~/.pi/agent/agents/`, merge rather than collide:

```toml
# ~/.pi/agent/agents/release-notes.toml
name = "release-notes"
description = "Prepares release notes for this repository."
```

The result carries the user's `description`, because the higher layer sets that field, and the extension's `system_prompt`, because the user's file leaves it unset and it falls through. Nothing is concatenated: a field the user sets replaces the lower layer's value outright.

## Fields

Every field appears below.

```toml
# (required) Template identity. pi-cowboy does not register a file without a name.
name = "release-notes"

# (optional) Name shown in the UI. Defaults to `name`.
display_name = "Release Notes"

# (optional) Short description. default = ""
description = "Prepares release notes for this repository."

# (optional) Hide this agent from the `agent_type` list. The name still resolves a call. default = false
hidden = false

# (optional) "clean" or "dirty". Sets what this agent's worktree takes over from a dirty parent working tree: "dirty" carries the parent's tracked changes (plus its untracked files under copy-on-write), "clean" starts the worktree at HEAD. default = the global `agent.worktreeCheckoutType`
worktree_checkout_type = "clean"

# (optional) The agent's system prompt. If omitted, the agent inherits an earlier layer's prompt. An empty string clears it.
system_prompt = '''
You prepare release notes for this repository. Read the history and tags
(git log, git tag) and report the changes as a message.
'''

# (optional) Harness launching this agent: "pi", "pig", "pi-bolt", or "opencode". "opencode" launches opencode instead of pi; its model catalogue and default model are its own. A `cowboy_agent` call's `harness_type` overrides this. An explicit value has no fallback: a harness this machine cannot launch fails the call instead of falling back to pi. default = the configured `agent.harnessType`
harness_type = "pi"

# (optional) Family-neutral settings for the harness that launches this agent, whichever family it is. These shape the shared system prompt the launch stages, not one family's CLI.
[harness]

# (optional) Whether the agent's system prompt carries the context files from the project and from the agent dir. default = the global `agent.includeContextFiles`
include_context_files = true

# (optional) The pi family's own settings, canonical spelling. `pig` and `pi-bolt` run the pi binary, so this table covers them too. Each family's tool list is written in that harness's own names — pi's names here, opencode's permission keys under `[harness.opencode]` below — and a launch reads only its own family's slice. A family the template does not name launches with every tool. The flat `[harness]` spellings of these same keys are also accepted and mean exactly this table; when a key is written both ways, the `[harness.pi]` one wins.
[harness.pi]

# (optional) `tools`: only these tools are available, given as a list of pi tool names. default = every tool
tools = ["read", "bash", "grep", "find"]

# (optional) `exclude_tools`: every tool except these is available. default = none excluded
# Set only one of `tools` and `exclude_tools`. When you set both, `tools` wins.
# exclude_tools = ["write"]

# (optional) Model for this agent as "provider/model-id", a key in pi's catalogue. The flat `[harness] model` spelling sets this same pi-family key. default = this entry unless a higher-precedence entry in [Model keys](Configuration.md#model-keys) (the session or config per-type override) sets one; below it sit the session default, the launching harness's default, and — for a pi-family launch only — the parent session's model.
model = "anthropic/claude-sonnet-4"

# (optional) Thinking level: "off", "minimal", "low", "medium", "high", "xhigh", or "max". default = the global `agent.defaultThinking`
thinking = "medium"

# (optional) Extensions: true uses pi's own set, false loads none, or a list of names loads only those. default = the global `agent.loadExtensionsImplicitly`
extensions = true

# (optional) Skills: true uses pi's own set, false loads none, or a list of names. A skill in the list contributes its name, description, and file path. default = the global `agent.loadSkillsImplicitly`
skills = ["release-notes"]

# (optional) Skills whose full text is inlined into the system prompt: a list of names. default = [].
inlined_skills = []

# (optional) Fork the parent session into the agent (`pi --fork <sessionFile>`). default = false
fork = false

# (optional) Settings only opencode reads. Its tool lists are opencode's permission keys.
[harness.opencode]

# (optional) Model for this agent as "provider/model-id", a key in opencode's catalogue. An opencode launch reads this key; a pi launch never does.
# model = "anthropic/claude-sonnet-4"

# (optional) `tools`: only these tools are available, given as opencode's permission keys. default = every tool
# tools = ["read", "grep", "glob"]

# (optional) `exclude_tools`: every tool except these is available. default = none excluded
# Set only one of `tools` and `exclude_tools`. When you set both, `tools` wins.
# exclude_tools = ["write"]

# (optional) Reasoning-effort variant the staged agent definition carries: the `--variant` of `opencode run`, a flag the top-level command pi-cowboy launches does not take. opencode applies it only when the selected model declares that variant name. Example values: "minimal", "high", "max". default = none
# variant = "high"
```

A pi-family key written flat under `[harness]` means the same slice as `[harness.pi]`, and `[harness.pi]` wins when a template sets the same key both ways. A family table's keys are read only by that family: `[harness.opencode]` keys never reach a pi launch, and pi's keys never reach an opencode launch, which falls through to opencode's default instead — the parent session's model is pi's key, so an opencode launch never inherits it either.
