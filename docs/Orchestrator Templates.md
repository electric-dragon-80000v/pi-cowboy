# Orchestrator Templates

An orchestrator template is a `.toml` file that sets the text pi-cowboy renders into the orchestrator's session when an agent is spawned, queues, or settles. Templates live in one of these directories:

- Extension built-ins: `orchestrators/` in the extension package.
- User: `<agent dir>/orchestrators/`, where the agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.
- Shared: `<project>/.agents/orchestrators/`.
- Project: `<project>/.pi/orchestrators/`.

The shared and project directories load only when the project is trusted.

Precedence is `default` < `extension` < `user` < `shared` < `project`, and pi-cowboy matches an override by `name`.

Every template starts from the `default` template. pi-cowboy skips a file without a `name`. `display_name` and `guidance` each come whole from the highest layer that sets them; a layer that leaves one unset keeps the value it inherits. Cues merge one event at a time: a template that loads replaces only the cues it defines.

The two merging rules differ, so here is one example. A file in `~/.pi/agent/orchestrators/` that sets only `settled`:

```toml
name = "review gate"

[cues]
settled = "Code review passed; the changes are ready to merge."
```

The base template's `spawned` and `queued` cues still fire; only `settled` is replaced, because cues merge one at a time. Had the same file set `guidance`, its guidance would replace the base template's guidance outright, not merge with it.

`guidance` is copied verbatim into the agent's prompt as the final section. When you omit `guidance`, the base template's guidance applies.

The directories are scanned once, at session start, so a file you add now appears in the template list in your next pi session, not this one. Once it is listed, make it the active template at `/cowboy` > `Default orchestrator`.

## Cues

Cues set what the orchestrator is told when one of its delegations starts or ends. A cue is one named template in the `[cues]` table. A cue event is what renders it: `spawned`, `queued`, or `settled`.

Each cue event supplies its own variables, and a cue can use only the variables of that event. A variable the event does not supply fails the file, and so do a Mustache partial such as `{{> name}}` and a delimiter change with `{{=<% %>=}}`; pi-cowboy skips such a file with a warning.

Every event supplies the three worktree facts. They are absent, not empty, when the spawn has no worktree, which is what `{{#has_worktree}}` branches on.

- `has_worktree`: Whether the spawn has a worktree.
- `worktree_path`: The path of that worktree.
- `worktree_branch`: The branch checked out in that worktree.

### `spawned`

Rendered when the orchestrator acknowledges a delegation.

- `agent_id`: The id of the agent behind the delegation.

### `queued`

Rendered when a delegation waits for a concurrency slot.

- `agent_id`: The id of the agent behind the delegation.
- `queue_running`: How many agents are running right now.
- `queue_running_label`: `agent` or `agents`, so the count reads correctly in a sentence.

### `settled`

Rendered when an agent settles. It is the run's own report and names no id, so `agent_id` is not a variable here.

- `result`: The report from a settled agent.
- `error`: The error message from a failed agent.
- `status_note`: A note appended to a stopped agent. It names who stopped it and says whether it ever started.
- `retention`: The reason the worktree was kept instead of removed.
- `process_alive`: Whether the agent process and its herdr pane are still running.

## Example

The example below shows every field.

```toml
# (required) Template identity. pi-cowboy does not register a file without a name.
name = "with code review"

# (optional) Name shown in the UI. A new template without it shows `name`; an override without it keeps the display name it inherits.
display_name = "with code review"

# (optional) Instructions for the agent, copied verbatim into the agent prompt. When you omit it, the key inherits the base template's guidance; an empty string clears it.
guidance = "If you make changes to the code: before committing them, launch the code review tool. Once the code is approved by the user, commit the changes to your branch. Never make any commits without user approval"

# (optional) The [cues] table. An event that you leave out falls through to the base template's cue.
[cues]

# (optional) Rendered when a delegation is acknowledged.
spawned = '''
Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.){{/has_worktree}}

Agent ID: {{agent_id}}'''

# (optional) Rendered when a delegation waits for a concurrency slot.
queued = '''
Agent QUEUED — the concurrency limit is reached ({{queue_running}} {{queue_running_label}} already spawned), so this task is waiting for a slot. It is NOT spawned yet: the process has not started. It will start automatically when another agent settles; you'll get a message when it starts and when it settles. Do NOT re-delegate — this task IS in flight.{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.){{/has_worktree}}

Agent ID: {{agent_id}}'''

# (optional) Rendered when an agent settles.
settled = '''
{{result}}{{#error}}

Error: {{error}}{{/error}}{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}){{#retention}} — KEPT: {{retention}}{{/retention}}.{{#process_alive}} The agent process and its herdr pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process.{{/process_alive}} {{#retention}}Clean the worktree up, then call cleanup_cowboy_agent to remove it.{{/retention}}{{^retention}}The worktree stays until you call cleanup_cowboy_agent to remove it — call it once the branch is merged or rejected.{{/retention}}){{/has_worktree}}{{status_note}}'''
```
