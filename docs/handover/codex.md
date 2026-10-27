# Handover export: codex

Verdict: exportable-with-caveats — one rollout file per session, user/assistant text in `response_item` messages, and the session's own `payload.id` is the UUID `codex resume` accepts.
Probed on Darwin arm64, 2026-10-23, against installed `codex-cli 0.163.0` (`/opt/homebrew/bin/codex`) and the codex source at tag `rust-v0.163.0`; the stored sessions on this machine were written by 0.118.0 through 0.162.1.

Evidence labels: **proven** (a command ran against this machine), **read from source** (file/symbol in `openai/codex` at `rust-v0.163.0`), **unverified** (neither).

## 1. Session store

**Location.** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local timestamp>-<id>.jsonl`, where `CODEX_HOME` defaults to `~/.codex`. `CODEX_HOME` is resolved by the CLI (`utils/home-dir/src/lib.rs::find_codex_home`), and a set value must be an existing directory. The date directories and the filename timestamp are **local** time (`recorder.rs::precompute_new_rollout_path`, `rollout_file_name.rs::RolloutFileName::render`). On this machine `~/.codex` is a symlink to `~/.codex-1`; the implementation resolves through the symlink by normal filesystem reads. **proven** (`ls -la ~/.codex`; 325 files under `~/.codex/sessions/`) **read from source**.

**Unit.** One JSONL file per thread/session. Every line is an envelope:

```json
{"timestamp":"<RFC3339>","ordinal":<n>,"type":"<record type>","payload":{…}}
```

**Format and version.** JSONL. There is no format-version field and no migration directory. Each file carries `payload.cli_version` in its first `session_meta` record; the store contains 0.118.0 through 0.162.1. The Rust enum `RolloutItem` is the schema (`protocol/src/protocol.rs`, `rollout/src/lib.rs`), so the shape is whatever the installed binary writes. A file can be compressed to `.jsonl.zst` when cold (`rollout/src/compression.rs`); the live file is plain `.jsonl`. **proven** (version census over the 325 files) **read from source**.

**Whether the file is incremental.** Yes: the recorder opens one append handle at session creation (`recorder.rs::open_log_file`, `JsonlWriter`) and the background writer flushes items as they occur. A crash can therefore leave a partial final line. **read from source**. The installed 0.163.0 process does not hold that descriptor open while a session sits idle (`lsof` on the live pane's pid listed the state/logs/goals SQLite files but no rollout), so the file is opened for writes and closed again, or written by a short-lived helper; the export never depends on an open handle. **proven**.

**What an id-bearing filename looks like.** Ordinary files end in the thread id (`rollout-2026-10-22T18-14-19-01a16464-5343-7943-a1a1-5fd71e024ffa.jsonl`). A reverted thread appends `_<rollout id>` after the stable thread id (`rollout_file_name.rs`), so the filename is **not** a reliable parse for the id. **read from source**.

**Two record eras.** Versions before roughly 0.162 wrote the conversation twice: a `response_item`/`message` record and a duplicate `event_msg` `user_message`/`agent_message` record, adjacent and with identical timestamps or timestamps differing by 1–2 ms. 0.162 and 0.163 write only the `response_item` message. 322 of the 325 files contain `response_item` records; the other three are a compacted-only file, an empty file, and a file written before the split. **proven** (counts by `jq` over the store).

Worked example, the smallest real shape that shows both turns (text replaced, paths reduced):

```json
{"timestamp":"2026-10-18T14:59:43.486Z","ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"add a hello function"}]}}
{"timestamp":"2026-10-18T14:59:45.466Z","ordinal":12,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I added it."}]}}
```

The first record of a file is the metadata:

```json
{"timestamp":"…","ordinal":0,"type":"session_meta","payload":{"session_id":"<root thread id>","id":"<this thread id>","cwd":"<absolute path>","originator":"codex-tui","cli_version":"0.162.1","source":"cli","thread_source":"user","…":…}}
```

`session_id` is the root thread's id; `id` is this thread's id (`protocol.rs::SessionMeta` doc comment). They differ for forks and reverted threads. **read from source**, and **proven** on a fork in the store (`id=019f4fa8-587f-…`, `session_id=019f4fa8-2871-…`).

## 2. Content mapping

The artifact keeps exactly two record shapes:

| Content type                 | Record field/value                                                                                                                                                                                                                       | Kept?                                                                                     | Why                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User text                    | `response_item` → `payload.type="message"`, `payload.role="user"`, `content[].type="input_text"`                                                                                                                                         | kept                                                                                      | The user's own turn. Parts that are injected envelopes are removed first (below).                                                                                                         |
| Assistant text               | `response_item` → `payload.type="message"`, `payload.role="assistant"`, `content[].type="output_text"`                                                                                                                                   | kept                                                                                      | The assistant's prose, including commentary-phase updates; they are real assistant turns, not reasoning.                                                                                  |
| Thinking                     | `response_item` → `payload.type="reasoning"`; legacy `event_msg` `agent_reasoning`                                                                                                                                                       | dropped                                                                                   | Not user-facing conversation.                                                                                                                                                             |
| Tool call                    | `response_item` → `payload.type` `function_call`, `custom_tool_call`, `web_search_call`; legacy `event_msg` `exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`, `view_image_tool_call`                                           | dropped                                                                                   | Tool traffic, including arguments.                                                                                                                                                        |
| Tool result                  | `response_item` → `payload.type` `function_call_output`, `custom_tool_call_output`                                                                                                                                                       | dropped                                                                                   | Tool output and file contents.                                                                                                                                                            |
| System / developer           | `response_item` → `payload.role="developer"` (permissions, skills, collaboration mode, multi-agent role/mode, app context, personality)                                                                                                  | dropped                                                                                   | Not a user or assistant turn.                                                                                                                                                             |
| Injected user-role envelopes | user `input_text` beginning with `<environment_context>`, `<turn_aborted>`, `<user_action>`, `<recommended_plugins>`, `<skill>`, `<user_shell_command>`, `<codex_internal_context>`, `<app-context>`, or `# AGENTS.md instructions for ` | dropped                                                                                   | Preamble, reminders, review harness text, skill/command expansion, and project-doc injection.                                                                                             |
| Attachment / image           | `content[].type="input_image"`; the `<image name=… path=…>` and `</image>` marker parts                                                                                                                                                  | image dropped; surrounding text kept                                                      | The artifact is text; an image-only turn becomes empty and is dropped.                                                                                                                    |
| Compaction summary           | top-level `type="compacted"` with `payload.replacement_history`; `event_msg` `context_compacted`                                                                                                                                         | dropped                                                                                   | A replacement-history record, not a turn; the original turns remain in the rollout.                                                                                                       |
| Inter-agent traffic          | `response_item` → `payload.type="agent_message"`; `event_msg` `sub_agent_activity`                                                                                                                                                       | dropped                                                                                   | Not the parent conversation.                                                                                                                                                              |
| Turn/state metadata          | `turn_context`, `world_state`, `token_usage_record`, `event_msg` `token_count`, `task_started`, `task_complete`, `item_completed`                                                                                                        | dropped                                                                                   | No user-facing text.                                                                                                                                                                      |
| Legacy duplicate             | `event_msg` `user_message` / `agent_message`                                                                                                                                                                                             | ignored when `response_item` messages exist; used only as a fallback when a file has none | Pre-0.163 duplicates the `response_item` record; reading both would emit every turn twice. No file in this store has only the legacy form, so the fallback is untested against real data. |

Empty parts and parts that reduce to whitespace are dropped; a message with no surviving text emits no heading.

## 3. Artifact

The implementation reproduces the handover artifact specification exactly:

- markdown, blocks introduced only by `## User` / `## Assistant` on their own line;
- blocks joined by one blank line, file ends with exactly one newline, no trailing whitespace on any line;
- record order preserved, no dedupe, no merge of consecutive same-role turns, no truncation, no summary;
- no handover marker, no timestamps, ids, model names, or record JSON;
- each surviving text part is rendered as-is (after trailing-space and edge-newline normalization); multiple surviving parts of one message are joined with one blank line;
- a message whose text survives as whitespace only contributes nothing;
- an ATX heading the message itself contains is escaped with one backslash before the `#`s, so no content line can be read as a role boundary; fenced code is left untouched, where a leading `#` is literal.

No divergence from §1 was needed. The inherited-transcript behaviour (a handover's quoted session becomes a user message in the target harness and therefore reappears in a later export) is accepted as-is and delimited by the existing marker.

## 4. Session identity

| Mechanism                                                     | Deterministic? | Available here?                                                                                                                                                                                                                                                         | Verdict                                                                        |
| ------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Query surface (`codex sessions list --json`, `codex debug …`) | —              | No machine-readable session/current-id command: `codex debug` exposes `models`, `app-server`, `prompt-input`; `codex resume --last` is interactive; `codex agents` lists agent-control agents, not sessions                                                             | not usable                                                                     |
| Caller-supplied id (`--session-id`, env, config)              | yes            | No option for a new session; `codex resume <id>` and `codex exec resume <id>` only accept an id that already exists. The harness does not choose a session id                                                                                                           | not available for a spawned run                                                |
| CLI-maintained index (`state_5.sqlite`, `threads`)            | yes            | Present: `threads(id, cwd, rollout_path, updated_at_ms, thread_source, source, …)`. But the filename is versioned (`state_5`) and the schema is an internal migration target (`state/src/sqlite.rs`, `_sqlx_migrations`); a schema bump would silently break the reader | deterministic but version-coupled; not chosen                                  |
| Record metadata (`session_meta.payload.id`)                   | qualified      | Every rollout's first line carries it; the value is the `ThreadId` and `codex resume <UUID>` looks it up through the app server (`tui/src/lib.rs::lookup_session_target_with_app_server` → `thread_read`)                                                               | **chosen**                                                                     |
| Live process correlation (`paneId` → pid → open rollout file) | qualified      | The pid is available (`herdr pane process-info`), but 0.163.0 keeps no rollout descriptor open, so `lsof` names no file; the process does hold `state_5.sqlite`, whose `threads` row names the rollout and its id                                                       | used as an independent cross-check through the DB row, not the production path |
| Pane text / scrollback                                        | no             | —                                                                                                                                                                                                                                                                       | rejected                                                                       |

**Chosen mechanism.** Walk `$CODEX_HOME/sessions`, read the first line (`session_meta`) of every `rollout-*.jsonl`, keep files whose `payload.cwd` equals the request's `cwd` exactly and whose `payload.thread_source` is not `"subagent"` and whose `payload.source` is not an object containing `subagent` (older subagent files have `thread_source: null` and `source: {"subagent":"review"}`), then take the file with the newest `mtimeMs`. Read that file's `session_meta.payload.id`; return it as `sessionId` and render that same file as `session`.

**Why it cannot drift.** The harness guarantees one live agent per task and one worktree per run, so the run's own cwd is unique to that run while it is alive; its rollout is created when the process starts and is written on every turn, so it is the newest matching file at the moment `exportForHandover` is called (the run is settled but the process is still alive). Subagent rollouts are excluded because codex subagents share the parent's cwd and can be newer. The id is read from the record, never parsed from the filename: reverted sessions append `_<rollout id>` to the name, and a fork's filename names the fork while `session_id` names the root.

**Failure modes**, each a thrown `SessionExportError` with a fault rather than an empty answer:

- `$CODEX_HOME/sessions` missing → `session-not-found` (no session store under `<path>`);
- a directory or rollout the walk cannot read → `unreadable-record`, naming it;
- no rollout whose `session_meta.cwd` equals `cwd` → `session-not-found` (no session record under `<path>` for `<cwd>`);
- only subagent rollouts match → `session-not-found` (a subagent session is not the run's conversation);
- a file with no `session_meta` or no `payload.id` is never a candidate → it cannot be selected, so it surfaces only as the `session-not-found` above;
- the chosen file has no user/assistant message text (compacted-only or empty) → yields an empty session string, which the caller rejects as an empty session;
- a malformed record before the last line → skipped and counted as an excluded record in `loss`;
- cwd reused by a second concurrent codex process → the newest file may be that process's; this is the honest limit of a store lookup by cwd, and comparing the export's id with the `threads` row for that cwd is how the verification detects it.

## 5. Live verification

**Historical sweep. Proven.** `readCodexSession` was run over every rollout under `$CODEX_HOME/sessions`, and `findCodexSession` over every cwd those rollouts name. The store held 326 files at the time of the run (325 before the live run below added one). **proven** (a temporary vitest harness, deleted afterwards; no session contents were pasted into this report).

| Measure                                                              | Result                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Files found                                                          | 326                                                                               |
| Exported                                                             | 324                                                                               |
| Refused                                                              | 2 — both `has no user or assistant messages` (a compacted-only and an empty file) |
| Exports identical to an independently computed render                | 324                                                                               |
| Structural headings other than `## User` / `## Assistant`            | 0                                                                                 |
| Files with assistant prose carrying its own `## …` heading (content) | 74                                                                                |
| Handover marker present                                              | 0                                                                                 |
| Ending not exactly one trailing newline                              | 0                                                                                 |
| Lines with trailing whitespace                                       | 0                                                                                 |
| Distinct cwds in the metadata                                        | 34                                                                                |
| cwds resolved by `findCodexSession`                                  | 34 (0 errors, 0 empty ids)                                                        |
| Files covered by `state_5.sqlite` threads rows                       | 290                                                                               |
| Ids disagreeing with the DB row                                      | 0                                                                                 |

The 74 heading-bearing files are assistant- or user-authored markdown, not structural separators; the artifact keeps them as content, as the sibling harnesses do. The DB comparison is independent of the lookup: it compares the id read from each record with the id the CLI's own index holds for that rollout.

**Live run. Proven.** The production hook was exercised against a real codex process:

- Pane `wJY:p3` in herdr tab `codex-handover-live`, cwd `/private/tmp/codex-handover-live`, started with `herdr agent start codexlive --kind codex` (bare `codex`, the same TUI a spawned run launches). **proven**.
- Prompt: "Create a file named handover-proof.txt in the current directory containing exactly the single word PLUMBUS, then reply with only: WROTE-PLUMBUS". Codex ran one shell tool (`python3 -c 'from pathlib import Path; Path("handover-proof.txt").write_text("PLUMBUS")'`), the file held `PLUMBUS`, and the reply was `WROTE-PLUMBUS`. **proven**.
- While the process was alive (pid 60448, `herdr pane process-info`), `codexHarness.exportForHandover({ cwd, paneId })` — the production hook, not a copy of it — returned sessionId `01a167ad-0e3a-7570-b7e4-8f081c241ae9` and this session, abbreviated (the block is indented under this item so its role headings are not report headings):

  ```markdown
  ## User

  Create a file named handover-proof.txt … WROTE-PLUMBUS

  ## Assistant

  I’ll create the file with the exact requested contents.

  ## Assistant

  WROTE-PLUMBUS
  ```

- No tool call, tool arguments, tool output, or reasoning survived. The commentary turn is a real assistant `output_text` message; the two assistant headings stay separate because consecutive same-role turns are never merged.
- Store agreement: `state_5.sqlite` holds one `threads` row for that cwd, with id `01a167ad-0e3a-7570-b7e4-8f081c241ae9` and rollout path `…/2026/10/23/rollout-2026-10-23T09-32-37-01a167ad-0e3a-7570-b7e4-8f081c241ae9.jsonl`; the file's `session_meta.payload.id` is the same value. `lsof -p 60448` named the SQLite files and no rollout, so the open-file form of the cross-check was unavailable and the DB row was used instead. **proven**.
- The export surfaces no pane text: the production path reads only `$CODEX_HOME/sessions`, and `paneId` is not read by this harness.

**Resume round-trip. Proven.** A fresh pane (`wJY:p4`, cwd `/private/tmp/codex-handover-resume`) was launched as `codex resume 01a167ad-0e3a-7570-b7e4-8f081c241ae9`. The TUI rendered the earlier conversation, including the original prompt and `WROTE-PLUMBUS`. Asked "What word did I ask for in the previous turn? Reply with only it.", it answered `PLUMBUS`. The id is the resume id. **proven**.

Cleanup: both panes and the scratch tab were closed, `/private/tmp/codex-handover-live` and `/private/tmp/codex-handover-resume` were removed, and the temporary probe files were deleted. The live run's rollout stays in the store, which is why the sweep above counts 326 files rather than the 325 it found earlier.

## 6. Implementation

**Files.** `src/agents/harness/codex-session.ts` holds the whole mechanism as pure functions: `codexHomeDirectory()` resolves `$CODEX_HOME` else `~/.codex`; `findCodexSession({ cwd, codexHome })` walks `sessions/**/rollout-*.jsonl`, reads each first line for `session_meta`, skips subagent rollouts and other cwds, and returns `{ file, sessionId }` for the newest match; `readCodexSession(file)` renders the artifact; `exportCodexSession` composes the two. `CodexSessionExportError` is the one failure type.

`src/agents/harness/codex.ts` adds a single `exportForHandover` hook that calls the composed function and narrows the result to `{ sessionId, session }`. No other line of the harness changed, and no registry, handover, schema, or other harness file was touched.

**Reads.** Only the rollout files: a bounded first-line read per candidate (1 MiB cap, because the first line embeds the base instructions) and a whole-file read for the chosen one. No writes, no `pi.exec` (the CLI is never asked), no dependencies.

**Refuses**, each with a sentence naming the path and the reason: missing store, no record for the cwd, only subagent records, a chosen record with no `session_meta.payload.id`, and an unreadable file or directory. Malformed lines and records without text are skipped and counted in `loss`.

**Tests.** `test/codex-export.test.ts`, 22 hermetic tests over fixture rollouts in a temporary `CODEX_HOME`: exact block shape, order, and single trailing newline; developer content, reasoning, tool calls, tool results, custom tool calls, and inter-agent messages absent by marker; injected user envelopes dropped with the rest of the message kept; image markers stripped and an image-only turn dropped; empty and whitespace-only turns emit no heading; a partial trailing record ignored without duplicating the previous turn; a malformed mid-file record is skipped and counted in loss; an empty session returns an empty string without throwing; the legacy `event_msg` fallback and the absence of duplication in dual-written files; newest cwd match wins and subagents are excluded; the id comes from the record rather than the filename and a reverted filename yields the thread id, not its suffix; a cwd matches through a symlink; missing store, no cwd match, and subagent-only refusal; and the hook wired through `CODEX_HOME` with `canExportForHandover` true.

**Gates.** `pnpm run typecheck` clean; `pnpm run test:unit` 132 files, 2578 passed plus 1 expected fail and 1 skipped; `pnpm run format:check` and `pnpm run lint` clean. The pre-commit hook runs typecheck, lint, format, and the unit project over the staged snapshot, and passed.

## 7. Gaps and risks

- **Version drift.** The reader targets the `response_item` message shape (present since at least 0.118) and tolerates the legacy `event_msg` duplicate era. A future rename of `input_text`/`output_text`, or moving messages to a different record type, would silently produce an empty export; the export throws rather than returning empty, so the failure is visible. There is no version gate.
- **Compressed cold rollouts.** `.jsonl.zst` files are not scanned or decompressed. A live session's rollout is plain `.jsonl` (`open_log_file` materializes it for append), so this does not affect the hook; it does affect a full historical sweep if cold files are compressed. None are compressed on this machine.
- **Compaction.** `compacted`/`replacement_history` is dropped and the original turns remain in the rollout. If a future codex rewrites history in place, the current file order is still what the file holds; no separate compaction handling exists. A later compaction variant would hook in where the artifact is built, before rendering.
- **Partial tail.** A final line that is not complete JSON is ignored. A partially written JSON line in the middle of a turn cannot occur because the writer appends complete lines; a mid-file malformed line is skipped and counted in the export's loss.
- **cwd reuse and mtime ties.** The store lookup is a search by cwd plus newest mtime, not an exact key. A manual codex session in the same worktree, or two files with the same mtime, can make the choice ambiguous. The production path does not consult the process, and 0.163.0 keeps no rollout descriptor open, so a live-process tie-breaker is not available without reading the state DB.
- **Live-process correlation is weaker than the source suggests.** `open_log_file` creates an append handle, but the running 0.163.0 process holds no rollout open; correlating a pane to its file needs the pid plus the DB (or cwd plus mtime, as the lookup does).
- **Injected user envelopes.** The drop list is a fixed set of observed prefixes. A new codex injection that is not listed would leak into the artifact as a user turn. The alternative — an allowlist of real user text — does not exist in the record.
- **`session_id` vs `id`.** Returning `session_id` would resume the root thread of a fork, not the run's own thread. The implementation returns `id`.
- **Archived sessions.** Only `$CODEX_HOME/sessions` is scanned; `archived_sessions` is not. A settled live run is never archived while its process is alive.
- **Where compaction would hook in later.** A later variant could collapse older turn groups into a single summary block between the surviving turns, driven by the `compacted` record's `replacement_history`; nothing in this version reads that record.

## Appendix: commands run

| Command                                                                   | Purpose                 | Output (redacted)                                                     |
| ------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `codex --version`                                                         | installed CLI           | `codex-cli 0.163.0`                                                   |
| `codex resume --help`                                                     | resume argument         | `[SESSION_ID]` — "Session id (UUID) or session name"                  |
| `codex exec resume --help`                                                | non-interactive resume  | same `[SESSION_ID]`                                                   |
| `codex debug --help`                                                      | query surface           | only `models`, `app-server`, `prompt-input`                           |
| `ls -la ~/.codex`                                                         | store location          | `~/.codex -> ~/.codex-1`                                              |
| `find ~/.codex/sessions -name 'rollout-*.jsonl' \| wc -l`                 | store size              | `325`                                                                 |
| `jq -r '[.type,.payload.type,.payload.role]…' <rollout>`                  | record census           | counts used in §1/§2                                                  |
| `jq -r 'select(.type=="response_item"…)' <rollout>`                       | message shapes          | the worked example                                                    |
| `sqlite3 ~/.codex/state_5.sqlite '.schema threads'`                       | CLI index               | `id, rollout_path, cwd, updated_at, thread_source, source, …`         |
| `sqlite3 … 'select … from threads'`                                       | id/cwd/rollout relation | rows matched the rollout metadata                                     |
| `herdr agent start codexlive --kind codex --pane wJY:p3`                  | live run                | started, `idle`                                                       |
| `herdr agent prompt codexlive "Create a file …"`                          | tool use in the run     | `done`; file held `PLUMBUS`                                           |
| `herdr pane process-info --pane wJY:p3`                                   | live pid                | `pid 60448`, `argv ["codex"]`, cwd `/private/tmp/codex-handover-live` |
| `lsof -p 60448`                                                           | open rollout?           | no `.jsonl`; `state_5.sqlite` open                                    |
| `sqlite3 … "select id, rollout_path … where cwd=…"`                       | independent id check    | `01a167ad-0e3a-7570-b7e4-8f081c241ae9`                                |
| `herdr agent start codexresume --kind codex --pane wJY:p4 -- resume <id>` | resume round-trip       | history rendered                                                      |
| `herdr agent prompt codexresume "What word …?"`                           | continuation proof      | `PLUMBUS`                                                             |
| temporary sweep over `$CODEX_HOME/sessions`                               | historical counts       | 326 files, 324 exported, 2 refused, 0 mismatches                      |
| `pnpm run typecheck` / `test:unit` / `format:check` / `lint`              | gates                   | all passed                                                            |

Source read: `rollout/src/recorder.rs`, `rollout/src/rollout_file_name.rs`, `rollout/src/compression.rs`, `rollout/src/list.rs`, `rollout/src/session_index.rs`, `protocol/src/protocol.rs` (`SessionMeta`, `RolloutItem`), `utils/home-dir/src/lib.rs`, `state/src/sqlite.rs`, `tui/src/lib.rs` (`lookup_session_target_with_app_server`).

## Comparison row

| Harness | Store                                             | Format                          | Identity method                                                              | Deterministic | Live proof | Resume proof | Gaps                                                                                              |
| ------- | ------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- | ------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `codex` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL; `response_item` messages | newest cwd-matching rollout's `session_meta.payload.id` (subagents excluded) | qualified     | yes        | yes          | 5 (version drift, cold `.zst`, cwd reuse/mtime, injected-envelope list, no open-file correlation) |
