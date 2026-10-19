# Orchestrator Templates

An orchestrator template is a `.toml` file that customizes two things across every agent you spawn:

1. `guidance`: Universal instructions appended verbatim to the end of every spawned agent's system prompt (for example, requiring a code review tool or test suite to run before committing).
2. `[cues]`: Mustache templates that format the status messages rendered back into the parent session when an agent is `spawned`, `queued`, or `settled`.

Here is a minimal orchestrator template that overrides only the `settled` cue:

```toml
name = "review gate"

[cues]
settled = "Code review passed; the changes are ready to merge."
```

## File locations

`pi-cowboy` scans these four directories for `.toml` orchestrator templates once at session start:

- Extension built-ins: `orchestrators/` inside the `pi-cowboy` package
- User: `<agent dir>/orchestrators/` (`~/.pi/agent/orchestrators/` by default, or overridden by `PI_CODING_AGENT_DIR`)
- Shared: `<project>/.agents/orchestrators/` (loaded only when the project is trusted)
- Project: `<project>/.pi/orchestrators/` (loaded only when the project is trusted)

Because directories are scanned at session start, a new template file appears in the picker on your next `pi` session. Once loaded, select it at `/cowboy` > `Default orchestrator` or set `agent.defaultOrchestrator` in `config.json`.

Every file must define a `name`. `pi-cowboy` skips any file that is missing `name`, contains invalid TOML, or fails cue validation, and prints a one-line warning.

## Merging across layers

Templates are matched across directories by `name`, with higher layers overriding lower ones in this order:

`default` < `extension` < `user` < `shared` < `project`

Every custom orchestrator template starts from the built-in `default` template, so you only need to write the fields you want to change:

- `display_name` and `guidance` are replaced whole by the highest layer that sets them. If a layer omits `guidance`, it inherits the lower layer's `guidance`; setting `guidance = ""` clears it.
- `[cues]` merge one event at a time (`spawned`, `queued`, `settled`). In the `"review gate"` example above, only `settled` is replaced, while the base template's `spawned` and `queued` cues stay intact.

## Fields

| Field          | Type              | Default                  | Description                                                                                                                      |
| -------------- | ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | string (required) | (required)               | Template identifier used in configuration and layer merging.                                                                     |
| `display_name` | string            | `name` (or inherited)    | Label shown in `/cowboy` > `Default orchestrator`.                                                                               |
| `guidance`     | string            | inherited from `default` | Instructions appended verbatim as the final section of every spawned agent's system prompt. Set to `""` to clear inherited text. |
| `[cues]`       | table             | inherited per event      | Mustache templates for the `spawned`, `queued`, and `settled` events.                                                            |

## Cues

Each cue (`spawned`, `queued`, and `settled`) is a Mustache template rendered without HTML escaping.

Every cue event provides its own set of allowed variables. Referencing a variable that does not belong to that event (or using Mustache partials like `{{> name}}` or custom delimiters like `{{=<% %>=}}`) causes `pi-cowboy` to reject and skip the file at load time with a warning.

### Worktree variables (all events)

All three cue events provide these worktree variables when the agent runs in a worktree. When an agent runs without a worktree, these variables are omitted (rather than set to empty strings), so you can branch on `{{#has_worktree}}...{{/has_worktree}}`:

| Variable          | Description                                     |
| ----------------- | ----------------------------------------------- |
| `has_worktree`    | `true` when the agent has a dedicated worktree. |
| `worktree_path`   | Filesystem path to the worktree.                |
| `worktree_branch` | Git branch checked out in the worktree.         |

### `spawned` variables

Rendered when a delegation starts immediately:

| Variable   | Description              |
| ---------- | ------------------------ |
| `agent_id` | ID of the spawned agent. |

### `queued` variables

Rendered when a delegation waits for a concurrency slot to open:

| Variable              | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `agent_id`            | ID of the queued agent.                                         |
| `queue_running`       | Number of agents currently running.                             |
| `queue_running_label` | `"agent"` when `queue_running` is `1`, or `"agents"` otherwise. |

### `settled` variables

Rendered when an agent finishes, fails, or is stopped. Because the completion header already identifies the agent, `agent_id` is not part of the `settled` context:

| Variable        | Description                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `result`        | Final report from a completed agent (omitted if empty or if the agent failed/stopped).                                 |
| `error`         | Error message from a failed agent (omitted unless the agent failed).                                                   |
| `status_note`   | Note appended when an agent was stopped, naming who stopped it and whether it had started.                             |
| `retention`     | Reason the worktree was kept on disk (present only when the agent has a worktree that holds unmerged/dirty work).      |
| `process_alive` | `true` when the agent process and its multiplexer pane are still running (present only when the agent has a worktree). |

## Complete example

```toml
name = "with code review"
display_name = "with code review"
guidance = "If you make changes to the code: before committing them, launch the code review tool. Once the code is approved by the user, commit the changes to your branch. Never make any commits without user approval."

[cues]
spawned = '''
Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.){{/has_worktree}}

Agent ID: {{agent_id}}'''

queued = '''
Agent QUEUED — the concurrency limit is reached ({{queue_running}} {{queue_running_label}} already spawned), so this task is waiting for a slot. It is NOT spawned yet: the process has not started. It will start automatically when another agent settles; you'll get a message when it starts and when it settles. Do NOT re-delegate — this task IS in flight.{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}) — the agent's commits land on that branch, never on main. Merge it with the merge_cowboy_branch tool when done, then remove the worktree with cleanup_cowboy_agent.){{/has_worktree}}

Agent ID: {{agent_id}}'''

settled = '''
{{result}}{{#error}}

Error: {{error}}{{/error}}{{#has_worktree}}
(Worktree: {{worktree_path}} (branch {{worktree_branch}}){{#retention}} — KEPT: {{retention}}{{/retention}}.{{#process_alive}} The agent process and its multiplexer pane stay until you call cleanup_cowboy_agent — its pane is closed, which ends that process.{{/process_alive}} {{#retention}}Clean the worktree up, then call cleanup_cowboy_agent to remove it.{{/retention}}{{^retention}}The worktree stays until you call cleanup_cowboy_agent to remove it — call it once the branch is merged or rejected.{{/retention}}){{/has_worktree}}{{status_note}}'''
```
