# Orchestrator Templates

An orchestrator template is a `.toml` file that sets the text pi-cowboy renders into the orchestrator's session when an agent is spawned, queues, or settles. Templates live in one of these directories:

- Extension built-ins: `orchestrators/` in the extension package.
- User: `<agent dir>/orchestrators/`, where the agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it.
- Shared: `<project>/.agents/orchestrators/`.
- Project: `<project>/.pi/orchestrators/`.

The shared and project directories load only when the project is trusted.

Precedence is `default` < `extension` < `user` < `shared` < `project`, and pi-cowboy matches an override by `name`.

Every template starts from the built-in `default` template. pi-cowboy skips a file without a `name`. `display_name` and `guidance` are never merged, because the highest layer that sets it replaces it entirely. Cues merge one at a time: a template that loads replaces only the cues it defines.

The two merging rules differ, so here is one example. A file in `~/.pi/agent/orchestrators/` that sets only `settled`:

```toml
name = "with code review"

[cues]
settled = "Code review passed; the changes are ready to merge."
```

The base template's `spawned` and `queued` cues still fire; only `settled` is replaced, because cues merge one at a time. Had the same file set `guidance`, the base template's guidance would be replaced outright rather than appended to or merged field by field.

`guidance` is copied verbatim into the agent's prompt as the final section. When you omit `guidance`, the base template's guidance applies.

The template appears in the template list at the start of the next pi session that scans the directory. In the session you are working in, turn it on at `/cowboy` > `Default orchestrator`.

## Cues

Cues set how the agents talk to the orchestrator. A cue is one named template in the `[cues]` table. A cue event is what renders it: `spawned`, `queued`, or `settled`.

Each cue event supplies its own variables, and a cue can use only the variables of that event.

pi-cowboy rejects a file at load time and reports a warning when a cue uses a variable that its event does not supply, when a cue includes a Mustache partial such as `{{> name}}`, or when a cue changes the template delimiters with `{{=<% %>=}}`.

Every event supplies these four:

- `agent_id`: The id of the agent behind the delegation.
- `has_worktree`: Whether the spawn has a worktree.
- `worktree_path`: The path of that worktree.
- `worktree_branch`: The branch checked out in that worktree.

The events add their own on top of those.

### `spawned`

Rendered when the orchestrator acknowledges a delegation. No variables beyond the four above.

### `queued`

Rendered when a delegation waits for a concurrency slot.

- `queue_running`: How many agents are running right now.
- `queue_running_label`: `agent` or `agents`, so the count reads correctly in a sentence.

### `settled`

Rendered when an agent settles.

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

# (optional) Name shown in the UI. When you omit it, pi-cowboy uses `name`.
display_name = "with code review"

# (optional) Instructions for the agent, copied verbatim into the agent prompt. When you omit it, the key inherits the base template's guidance; an empty string clears it.
guidance = "If you make changes to the code: before committing them, launch the code review tool. Once the code is approved by the user, commit the changes to your branch. (This applies even if the task prompt says not to commit — commits stay on that branch and are needed for merging.)"

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

The three cue events above are the only notifications a spawned agent sends the orchestrator, and a template that omits one inherits the built-in text for that event. `guidance` behaves the same way: omit it and the base template's guidance applies.
