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

# (optional) "clean" or "dirty". Sets if this agent's worktree carries the uncommitted work of a dirty parent working tree. default = the global `agent.worktreeCheckoutType`. The field applies only when the materialization is "copy-on-write".
worktree_checkout_type = "clean"

# (optional) The agent's system prompt. If omitted, the agent inherits an earlier layer's prompt. An empty string clears it.
system_prompt = '''
You prepare release notes for this repository. Read the history and tags
(git log, git tag) and report the changes as a message.
'''

# (optional) Harness launching this agent: "pi", "pig", or "pi-bolt". default = the configured `agent.harnessType`
harness_type = "pi"

# (optional) Per-agent settings for the harness named by `harness_type`. Every field below belongs to this table.
[harness]

# (optional) Model for this agent as "provider/model-id". default = the first model that is set, falling back to the parent session's model.
model = "anthropic/claude-sonnet-4"

# (optional) Thinking level: "off", "minimal", "low", "medium", "high", "xhigh", or "max". default = the global `agent.defaultThinking`
thinking = "medium"

# (optional) `tools`: only these tools are available, given as a list of pi tool names. default = every tool
tools = ["read", "bash", "grep", "find"]

# (optional) `exclude_tools`: every tool except these is available. default = none excluded
# Set only one of `tools` and `exclude_tools`. When you set both, `tools` wins.
# exclude_tools = ["write"]

# (optional) Extensions: true uses pi's own set, false loads none, or a list of names loads only those. default = the global `agent.loadExtensionsImplicitly`
extensions = true

# (optional) Skills: true uses pi's own set, false loads none, or a list of names. A skill in the list contributes its name, description, and file path. default = the global `agent.loadSkillsImplicitly`
skills = ["release-notes"]

# (optional) Skills whose full text is inlined into the system prompt: a list of names. default = [].
inlined_skills = []

# (optional) Fork the parent session into the agent (`pi --fork <sessionFile>`). default = false
fork = false

# (optional) Sets if the agent's system prompt carries pi's context files from the project and from the agent dir. default = the global `agent.includeContextFiles`
include_context_files = true
```
