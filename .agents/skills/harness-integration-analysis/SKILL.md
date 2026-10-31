---
name: harness-integration-analysis
description: How a new harness type is evaluated before it is implemented. Fixed report structure, the probe envelope, contract angles read off the harness interface, and session handover evaluation. Use when a CLI or a herdr agent kind is proposed as a new pi-cowboy harness, or when a harness evaluation report is written or reviewed.
---

# Harness integration analysis

Applies when someone proposes a CLI, or a herdr agent kind, as a new pi-cowboy harness, and when an existing evaluation report is reviewed. The output is a findings report on one harness. It is not the harness code.

The evaluation answers two primary questions:

1. For every angle in the contract, what does this CLI give a spawn, and what would the seam have to do to carry the rest?
2. Can this harness participate in **session handover** (`handover_cowboy_agent`), both as a source (exporting its session transcript and cleanly exiting its process) and as a target (resuming an ongoing task in the same worktree)?

The answer to the seam changes is the report's seam section.

## Before you start

The first action is a question to the human, before any probe. Ask whether inference may be run for this evaluation, and if so, which model or provider the launch under test should use. Most harnesses take an arbitrary API endpoint or key, so a real turn is often possible against a provider the human names, and a turn is the only evidence for the angles no `--help` output can settle.

The answer shapes the run:

- **No inference.** The evaluation stays on the probes in The probe envelope. This is the default until the human says otherwise.
- **Inference authorized, with a named model.** The evaluation runs the angles that need a turn against real turns, on that model alone. The model and provider are recorded in the report's metadata line and appendix.

The human need not have the provider ready when the evaluation starts. The no-inference probes come first and take most of the run. The human can set up the provider while those run, and the evaluation switches to real turns when the human says it is ready. Ask once at the start, and again only if the provider or the named model changes.

## The order of work

Draft the whole report once, in the fixed structure below, before revising anything. Then work the passes in order, each one across the whole report.

1. **Content and facts.** Verify every claim against the binary and against this repo's contract. A quoted product string (`--help` output, an error code, a flag) is reproduced, never paraphrased or corrected. A claim with no probe behind it is marked unverified rather than written flat.
2. **Architecture.** The report structure is fixed. A section is never invented, moved, or dropped; only its content changes. Everything the report asserts has one home among the sections.
3. **Correctness.** Grammar and word-level errors, searched deliberately.
4. **Brevity.** Delete unnecessary words, then unnecessary sentences. Table cells and command blocks stay terse by function.
5. **Style.** Voice, agency, sentence shape. The example's register is the target, not its punctuation.
6. **Consistency sweep.** One pass, owned outright: one term per thing, every cross-reference and line number current, every angle carrying its verdict.

## What the evaluation decides

Every contract angle gets a verdict:

- **Native** — the CLI provides the behaviour; the seam passes it through.
- **Workaround** — the CLI can be made to do it, through a shim, a staged file, or a config directory.
- **N/A** — the concept does not apply to this CLI, or nothing in the seam reads it.
- **Impossible** — the CLI offers no route and no workaround exists.

When the report holds more than one viable launch shape and an angle answers differently under each, the verdict names each shape, the recommended shape first — `Native (Shape B) / workaround (Shape A)`. That is one angle with one verdict per shape: stating both is what shows the reader what the shape choice buys and costs. Where the shapes agree, the verdict is stated once, with no shape named.

A verdict states the mechanism, not only the label. "Native via `-c model_instructions_file`" is usable; "Native" alone is not.

Native means the member is honoured as the contract means it, not that the CLI has a neighbouring knob. A CLI that matches only part of the member — some of its arms, some of its values — is a Workaround, and the verdict names what is missing.

A verdict describes the CLI, never a harness already written for it. The evidence is what the CLI itself offers — its flags, its config keys, its documented behaviour — so a capability the CLI has is Native even when no code reads it yet, and a capability it lacks is not rescued by a seam planned around it. Reading an existing implementation's choices as the answer is the error this rule exists to stop.

A verdict is about the CLI, not about pi. A family expressing the same feature in its own names, through its own inputs and its own `[harness.<family>]` slice, is what the contract is designed for; a spelling that differs from pi's is not a deficiency and not a verdict of its own.

The report then ends at the seam: the members and template keys this family would need, each with its first reader named. A proposed member with no reader is not a seam change, and the report says so.

## The probe envelope

- **No inference, unless authorized (see Before you start).** The default is no prompt-bearing invocation and no started turn. A probe is `--help`, `--version`, a config render, a debug subcommand, or a pane launch that cannot reach a model. A steer is verified only up to the composer unless the human authorized test inference, in which case the named model is the only one used and every real turn is recorded.
- **Evidence standard.** Mark each finding as proven (the probe ran), read from source (the code shows it), or unverified. The verdict table carries the label; the evidence section carries the proof.
- **Isolation and hygiene.** Probes run in their own scratch directory and pane, removed at the end. State the before and after. Nothing is written to the user's real configuration. If a launch shape involves copying or staging files that contain secrets (API keys, tokens, or credential stores), state what is staged and where it lands, without printing the secrets themselves.
- **Reading the binary and the source.** The binary's surface is the authority on flags; the source is the authority on defaults, hidden paths, and what a flag actually does. Read both.
- **Disclose every deviation.** A probe that leaves the envelope is authorized by the human first and named in the report's appendix.
- **Cross-angle checks.** One probe runs the whole CLI, so no angle is settled alone. A sandbox that forbids writes outside the worktree also forbids the result file (`<tmpdir>/pi-cowboy/<id>/result.md`); the report says so, and shows the allowance that fixes it, rather than marking sandbox and result file green in isolation.
- **Ambient environment and side effects.** An agent typically relies on ambient environment setup: authentication (keychains, credential files, environment variables), custom inference endpoints (third-party providers, base URLs), and tools (MCP servers, local scripts). Whatever mechanism is used to isolate or configure the spawn (CLI flags, environment variables, staged files, agent profiles, or shims), evaluate its side effects: does it preserve, override, or inadvertently disconnect any of these ambient capabilities?
- **Session storage and durability.** Inspect where the CLI writes its sessions, transcripts, and telemetry. If a temporary config directory or scratch location is used, evaluate whether session files survive teardown or whether transcripts can be directed to a durable location.

## The contract angles

The angles are read off this repo's harness contract, not invented. When a contract member or obligation has no angle, one is added; when an angle's contract member is removed, the angle goes with it. The source column names where the angle comes from, so the list can be rebuilt when the contract moves.

The angles fall into five domains and are numbered straight through them, so each domain holds consecutive numbers. This list is the definition of the report's verdict table. The report reproduces it, one row per angle, and never states the angles anywhere else.

The closing domain, **Pi-Native / Extended Capabilities**, is pi-family only. Its angles describe the pi extension mechanism, the pi session files, and the pi-native identity token, so it is evaluated only when the harness under test is a pi-family member (`pi`, `pig`, `pi-bolt`). A foreign harness has no such domain, and its report omits it outright rather than carrying rows that answer N/A.

### Lifecycle & Process

| #   | Angle                                                                                   | Contract source                                                      |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Unattended launch of the interactive agent in a herdr pane (including pane preparation) | `agentMuxKind`, `prepare`, `PaneLauncherSpec.proof`, the mux's start |
| 2   | Temp-file lifecycle / cleanup ordering                                                  | `prepare`, `teardown`, `HarnessTeardownRequest`                      |
| 3   | Settlement detection                                                                    | `resultFile`, the supervisor                                         |
| 4   | herdr argv                                                                              | `buildArgs`, the mux's start                                         |

Angle 1 is the CLI's interactive agent (its TUI), brought up without a human at the keyboard — not a one-shot batch mode. `codex exec` and `opencode run` reach no composer, so they settle no herdr pane and accept no steer; angle 9 is where that cost shows.

Unattended launch means the agent reaches ready state and can complete turns without human intervention. The evaluation must identify any first-turn blockers: authentication prompts, terms-of-service dialogs, default model selections, or onboarding flows.

Check where and how authentication resolves, and note any platform-specific differences (such as headless Linux environments vs. desktop OS keychains, or system token stores vs. local files). State what was verified and what remains unverified across target platforms.

### Prompting & Delivery

| #   | Angle                                          | Contract source                   |
| --- | ---------------------------------------------- | --------------------------------- |
| 5   | System-prompt replacement from the staged file | `systemPromptFile`                |
| 6   | Task-prompt delivery                           | `taskFile`, `buildArgs`           |
| 7   | Result-file protocol                           | `resultFile`                      |
| 8   | Context-file suppression                       | `[harness] include_context_files` |
| 9   | Steering                                       | the host's `deliver`              |

Angle 5 is replacement. The seam compiles one `system.md` (`buildSubagentSystemPrompt`) and the CLI must use it in place of its own base prompt; append is a fallback only for a CLI with no replace path. The append the pi family uses (`--append-system-prompt`) carries the identity token, which is angle 18's concern, not angle 5's.

The evaluation must determine the scope and side effects of the replacement mechanism. Does setting the prompt leave the rest of the agent's environment untouched, or does it require overriding broader configuration layers (such as custom configuration directories, environment variables, or agent profiles)? If the mechanism requires staging or transforming configuration, document what needs to be filtered out (like personal prompts or conflicting instructions) and what needs to be retained (like custom provider definitions or credentials).

### Configuration & Environment

| #   | Angle                               | Contract source                                                                     |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| 10  | Model selection and catalogue       | `modelKey`, `Harness.listModels`, `Harness.prefetchModels`, `defaultModelByHarness` |
| 11  | Approval / sandbox                  | `projectTrusted`, family request                                                    |
| 12  | Availability probe and version gate | `Harness.availability`, `HarnessAvailability.notice`                                |
| 13  | Thinking / reasoning effort         | `SubagentLaunchInputs.thinking`                                                     |
| 14  | Tool selection                      | `SubagentLaunchInputs.toolSelection`                                                |

Angle 10's evidence states the catalogue's cold-start cost: whether enumeration spawns a child process, needs the network or a credential, or is instant and offline, and how the family warms it at startup (`prefetchModels` — a real warm-up, or a no-op — and whether the result is memoized). A catalogue that blocks the menu is as much a finding as one that cannot be listed. The evaluation must verify whether the spawn's runtime environment actually has access to the models listed in the catalogue—especially when custom endpoints, third-party providers, or non-default base URLs are defined in the user's environment.

Angle 14 is satisfied natively only by a CLI that can filter tools by name — a whitelist/blacklist flag or its equivalent. A CLI that exposes only a fixed set of on/off switches (`tools.web_search`, a feature flag) is a Workaround however well it spells them: toggles are not a filter, and the verdict says so. The evaluation must check the tool surface available to the running spawn, including MCP servers, local scripts, and built-in capabilities. If the launch configuration restricts or isolates the agent's environment, verify which tools survive into the spawn.

Angle 12's probe runs synchronously at boot, before the first menu can open, so it must answer locally and within a bounded timeout (the opencode read allows 5 s), with no network. A CLI whose `--version` dials out for an update check holds the whole boot; claude is the precedent, and its harness reads `command -v` for exactly that reason. A version command that reaches the network is itself a finding.

### Session Handover

| #   | Angle                                            | Contract source                                                                               |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 15  | Process termination & clean TUI exit             | `Harness.stop`, `HarnessStopRequest`, `PaneControl.sendKeys`                                  |
| 16  | Session store durability & environment alignment | `Harness.inheritedEnv`, `Harness.reservedEnvVars`, `Harness.teardown`, staging isolation      |
| 17  | Transcript extraction & turn classification      | `Harness.readHandoverRecords`, `HandoverRecordSource`, `HandoverRecord`, `SessionExportError` |

Handover (`handover_cowboy_agent`) transfers an in-flight task from a settled agent to another harness within the same worktree and staging directory. Rather than starting over, the extension exports the source run's session transcript, stops its process cleanly, archives the run into history, and launches the next harness with the previous transcript and provenance chain quoted in its task.

Angle 15 requires a clean, non-destructive exit of the interactive agent process. The exit must be triggered via keystrokes sent to the TUI (`pane.sendKeys`). Exiting must terminate the process, but must **never close the multiplexer pane or kill the hosting shell**. The pane and checkout must remain addressable for multi-run cleanup and subsequent runs.

The evidence is the exit and what survives it: the agent process ends, and the pane and its hosting shell are still alive and addressable. The transcript is not this angle's evidence: handover reads the session while the process is still alive and stops the run only after that read succeeds, so a stop cannot cut off a session already exported.

Angle 16 reconciles configuration staging with session durability. Spawns often require disposable staging trees (`/tmp/pi-cowboy/<id>/...`) to suppress onboarding prompts and bypass permission checks. However, `harness.teardown` deletes that tree. The evaluation must prove:

1. Session transcripts do not land inside a directory that `teardown` deletes, or the transcript subtree is symlinked out to a durable location (the bridge pattern used by Claude).
2. The child process and parent process agree on the store location. If environment variables control the store (e.g. `CODEX_HOME`, `PI_CODING_AGENT_SESSION_DIR`), the parent must export them via `inheritedEnv`, and they must be protected against user override via `reservedEnvVars`.

Angle 17 evaluates whether the CLI's native session history can be located, read, and classified into the shared handover vocabulary:

1. **Lookup & Disambiguation:** Can the session corresponding to this specific run be found unambiguously? (By pinned UUID, e.g. Claude's `--session-id`; by agent name, e.g. Pi's `--name`; or by matching CWD in metadata, e.g. Codex rollouts). Can successor sessions (from `/clear` or fork) be detected so the export refuses (`ambiguous-session`) rather than returning an abandoned transcript?
2. **Turn Extraction & Classification:** Every complete entry the reader can enumerate yields exactly one record, tagged with what it is: `user` or `assistant` (a turn's clean prose in `content`), `thinking` (the model's clean reasoning), `tool-call` (a tool call or its result, its native parts carried whole as JSON), `compaction` (the clean summary that replaced the history before it; the last one that carries prose is the transcript's boundary, a blank one is not), `other` (a parsed entry with no canonical kind — metadata, system prompts, synthetic messages — carrying the native entry's text and naming the native type in `unmappedKind`), or `unparseable` (an entry the reader cannot parse: corrupt JSON, an unreadable line, or a known record whose schema fails; its native text is carried and it is the only kind counted as loss). Shared handover code alone decides which kinds enter the transcript. A record type the reader does not know is `other`, never `unparseable`: a reader may not silently under-export a store it only partly understands. A store whose format or version is unsupported is a refusal (`unsupported-version`), not loss; an unterminated final line is a write still in progress rather than a record, so it is neither read nor reported.
3. **Scaffolding and Envelope Stripping:** Injected framework text (`<environment_context>`, `<system-reminder>`, slash-command wrappers, local bash stdout envelopes) and previous handover marker lines (`<<pi-cowboy-handover [...]>>`) must be stripped from user prose to avoid recursive context inflation.
4. **Extraction Seam:** Can records be read offline from disk, or must they be extracted via an online CLI command (e.g. `opencode session export`) while the process is alive? If online, does the command need a subshell sourcing `env.sh` to see the spawn's custom store?
5. **Loss Policy:** Only `unparseable` records count as loss against `agent.handoverMaxExcludedRatio` (default 0.5); every other kind stays in the denominator and is never loss, and a refused export is a fault the report names rather than a ratio it absorbs.

### Pi-Native / Extended Capabilities (pi-family only)

| #   | Angle                 | Contract source                  |
| --- | --------------------- | -------------------------------- |
| 18  | Identity token        | `subagentTokenFor`               |
| 19  | Extensions            | `PiLaunchInputs.extensions`      |
| 20  | Skills                | `PiLaunchInputs.skills`          |
| 21  | Session fork / resume | `PiLaunchInputs.forkSessionFile` |

## The feasibility squares

The headline opens with one line per domain: the domain name, then one square per angle in the same order as the list above. A glance shows where the work is.

The square answers one question: what does supporting this angle cost the API? A family spelling a feature in its own names, through its own inputs and its own `[harness.<family>]` slice, is what the contract is built for; that is green however different the spelling looks beside pi's.

- 🟩 green — completely feasible. The CLI provides the behaviour, or the family expresses it through its own inputs and slice, or the angle is N/A to this CLI. The shared flow does not change.
- 🟨 yellow — feasible, but the existing API must change to carry it: a new launch step, a different order of operations, new shared flexibility. A minimal change still counts.
- 🟧 orange — possible, but it needs a new subsystem or a large rework.
- 🟥 red — impossible; no route and no workaround exists.

A verdict split by launch shape squares as the recommended shape resolves it — both its verdict and its cost. If carrying that shape needs the existing API to change (a new launch step, a different order of operations, a widened seam), the angle squares yellow even though the CLI itself supplies the behaviour. The same square opens the Verdict cell of every row in the verdict table and the evidence heading that proves that row, so a row, its square, and its proof read together.

## The report structure

The structure is fixed. The verdict table reproduces The contract angles in the same domains and the same order, adding the Pi-Native / Extended Capabilities domain only when the harness is a pi-family member; nothing about the shape moves. Reproduce the headings, the section order, the table shapes, and the appendix exactly.

```
# <Name> as a pi-cowboy harness — findings report

**Branch:** `<branch>` (<scope: report only, or the change>)
**Verified against:** `<binary> <version>`, `herdr <version>`, and the source at `<tag or commit>`.
**<Envelope sentence>:** what was and was not run, any authorized test inference and the model it used, and the hygiene state.

## 1. Headline: <one sentence stating what the hypothesis got right and wrong>

<the feasibility squares: one line per domain, the domain name then one square per angle>

<A table of the hypothesis split into its parts, one row each>

<The two or three facts that decide the integration>

## 2. The <one|two> viable launch shape(s)

### Shape A — <name> (<native kind | pane shim | ...>)

<The launch command, argv, rationale, and environmental interaction: what ambient state this shape relies on (credentials, provider settings, tools), what it suppresses or isolates, how any missing capabilities are supplied or bridged, and how session transcripts are preserved across teardown.>

### Shape B — <name>   (only when a second shape is real)

### Which one

<The choice and its cost, in seam terms>

## 3. Verdict table (<N> contract items)

<The domain headings, each followed by one table: | # | Item | Verdict | Detail |, the Verdict cell opening with the angle's square and naming each shape's verdict where the shapes differ. A pi-family harness's report adds the Pi-Native / Extended Capabilities domain; a foreign harness's stops after Session Handover.>

## 4. Item-by-item evidence

### <domain>

#### <square> 1. <angle>

<The proof, quoted where it is a product string>

#### <square> 2. <angle>

…

## 5. Seam changes this family needs (per the contract's own evolution rule)

<A numbered list derived from the contract as it stands: each item names the change, the member it touches, and its first reader, and says whether it is a decision for a reviewer rather than a mechanical addition. Read the evolution rule in the header of `src/agents/harness.ts` and the surrounding contract before writing this list; do not carry a copy of it here. If a launch shape requires transforming or staging configuration, specify the filtering rules (what to preserve vs what to strip) before proposing the staging code.>

## 6. Open questions, risks, and product decisions

### Awaiting evidence

<A numbered list. Each item: the gap, the probe or turn that would settle it, and whether settling it needs the authorized model.>

### Decisions and risks

<A numbered list. Each item: a choice no probe settles — a product policy or an inherent limitation — and who decides it.>

## 7. Appendix — exact commands, sources, pane hygiene

<The commands, the source read, the pane and tab hygiene, any authorized test inference and the model it used, and any steering or handover operations exercised>
```

The headline opens with the feasibility squares, states the verdict before the evidence, and closes with the facts that decide it. The verdict table is the index a reader scans, grouped into the domains; the evidence section repeats that grouping, keeps the angles in numeric order, and opens each item heading with the angle's square, so a row's number is the way to reach its proof. Section 6 separates the questions evidence would settle from the choices only a human settles, so a product decision is never filed as an inference gap. The seam section is the only place implementation is discussed, and the appendix is the only place commands are listed.

## End-of-run checklist

- [ ] The test-inference question was asked before the first probe, and the answer is reflected in the run.
- [ ] The metadata line names the branch, the binary versions, the source tag or commit, the envelope statement, and any authorized test inference with the model it used.
- [ ] The headline opens with the feasibility squares, one line per domain labelled with the domain name, every verdict row opens with its matching square, and each evidence heading opens with that square too.
- [ ] Every contract angle is present, grouped into the domains and numbered straight through, each carrying its verdict (one per viable shape where the shapes differ); the Pi-Native / Extended Capabilities domain is present only when the harness is `pi`, `pig`, or `pi-bolt`.
- [ ] Each verdict names its mechanism, and the evidence section backs it or marks it unverified.
- [ ] Each launch shape describes its environmental interactions: what ambient configuration/credentials it relies on, what it isolates, how session transcripts are preserved against staging teardown, and how required capabilities are maintained.
- [ ] Where a shape isolates configuration or environment, the evidence proves credentials, providers, tools, and session stores still resolve there, with a command that reaches no model, on the platform named.
- [ ] Process termination (`Harness.stop`) is verified to stop the agent process cleanly via keystrokes while leaving the host pane and shell open.
- [ ] Session storage format, location, and turn classification rules for handover export (`readHandoverRecords`) are verified against real sample transcripts or code schemas.
- [ ] The headline, the launch-shape section, the seam changes, the open questions and product decisions, and the appendix are all present.
- [ ] Any real turn ran on the authorized model alone and is recorded; absent an authorization, no prompt-bearing invocation happened. The pane and directory hygiene is recorded either way.
- [ ] The appendix lists the exact commands and the source read.
- [ ] The consistency sweep is done: one term per thing, line references current, and every angle carrying its verdict.

## The worked example

The example below is the Codex report. Codex is a foreign harness, so its report carries fourteen angles — the original twelve except the pi-native identity token, plus availability, thinking, and tool selection — with pane preparation folded into launch and the model catalogue into model selection; the Pi-Native domain is absent.

It is the model for structure, ordering, table shape, evidence style, and appendix contents, and it is a snapshot of everything it read: this repo's API, herdr, and the CLI as they stood when it was written, not as they stand now. Two members are the clearest cases: the report squares angle 1 yellow because `AgentHost.start` then took only `{name, piArgs}` and hard-coded `--kind pi`, while the contract now carries `agentMuxKind` end to end, so that angle squares green today; and its angle 10 predates `Harness.prefetchModels`, so it is silent on catalogue warm-up, which a report today must weigh. It also predates the addition of the **Session Handover** domain (angles 15–17: process termination, store durability, and transcript extraction), which was introduced with `handover_cowboy_agent`. An angle marked unverified there stays unverified until a probe settles it. Read the example for its form, and check every API and version claim against the current source before repeating it.

The Codex report illustrates one end of the configuration spectrum: because Codex exposes granular command-line overrides (`-c model_instructions_file`, `-c project_doc_max_bytes`), it can replace the base prompt and suppress project context while running directly against the user's ambient configuration. This preserves credentials and provider settings without custom staging, but leaves user settings (such as notification hooks) active unless explicitly neutralized. Other harnesses may use different mechanisms (such as dedicated config directories, profiles, or environment variables), which introduce different trade-offs between prompt isolation and credential/capability retention.

# Codex as a pi-cowboy harness — findings report

**Branch:** `cow-codex-harness-tkczjtv9` (report only; no `src/` change, no commit)
**Verified against:** `codex-cli 0.162.1` (`/opt/homebrew/bin/codex` → `/opt/homebrew/Caskroom/codex/0.162.1/bin/codex`), `herdr 0.9.3`, and the codex source at tag `rust-v0.162.1` (codeload tarball, read locally).
**No inference was run:** every probe was `--help`, `--version`, a debug/config-render subcommand, or a pane launch of a non-model codex subcommand (`app-server`). No prompt-bearing invocation happened. All pane probes ran in scratch tabs in this spawn's own herdr workspace and were closed afterwards; no file under `~/.codex` was written (the only codex reads used the real config read-only).

## 1. Headline: the hypothesis is mostly right in shape and wrong in detail

Lifecycle & Process 🟨🟩🟩🟩
Prompting & Delivery 🟩🟨🟩🟩🟩
Configuration & Environment 🟩🟩🟩🟩🟩

| Hypothesis                                                                     | Verdict                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "codex has no prompt flags"                                                    | **Half true.** No `--system-prompt`/`--name` on `codex`/`codex exec`. But there _is_ a positional `[PROMPT]` (arg or stdin), and `-c model_instructions_file=<abs path>` **replaces** the base instructions from a file.                                                                                                   |
| "`-c developer_instructions=…` **appends** and cannot replace the base prompt" | **True for append, false for the conclusion.** `developer_instructions` is inserted as a `developer`-role message (verified in a rendered prompt). Base-instruction _replacement_ is a different key: `model_instructions_file` (or `instructions`), which has priority over the model's built-in `instructions_template`. |
| "there is no `--name`"                                                         | **True**, and irrelevant: the worktree/branch identity is already the herdr `agent start <NAME>` and the pane label, as for pi.                                                                                                                                                                                            |
| "`--yolo`"                                                                     | **True** — it is a hidden clap alias of `--dangerously-bypass-approvals-and-sandbox` (`utils/cli/src/shared_options.rs:56`), and it also implies `--skip-git-repo-check`. `--full-auto` does **not** exist in 0.162.1 (zero hits in the whole source tree).                                                                |
| "the Responses API is enforced"                                                | Not enforced by the CLI: `model_providers` + `wire_api` are configurable and `--oss` selects local providers. The default OpenAI provider does use Responses (`instructions` field carries the base instructions — asserted by codex's own test).                                                                          |
| `--output-last-message`, `--skip-git-repo-check`, `--cd`                       | All real and documented in `codex exec --help`; `-o/--output-last-message <FILE>` writes the final agent message to a file at shutdown, which maps 1:1 onto pi-cowboy's result-file protocol.                                                                                                                              |

Two squares are yellow and the rest green. The greens are codex's own spelling of a capability, carried through the family's own inputs and slice, so the shared API does not change — the tool toggles and the `-c` keys look unlike pi's but cost nothing. The two yellows are the price of the recommended Shape B: the host must carry the harness's launch kind to `herdr agent start --kind` (angle 1), and the task must be submitted after start rather than at launch (angle 6). Both are the API's shape, not codex's: the CLI supplies the behaviour, and the seam has to change to carry it.

## 2. The two viable launch shapes

There are exactly two shapes, and they differ in whether **steering** is possible.

### Shape A — `codex exec` behind the pane's `pi()` shim (non-interactive; existing `--kind pi` path)

The pane launcher, defined by `prepare` via `herdr pane run` (verbatim; the task file path is baked in at prepare time — see §2):

```sh
pi() { : "cowboy-codex-harness"; export HERDR_AGENT=pi; codex "$@" - < '/tmp/pi-cowboy/<spawnId>/prompt.md'; }
```

`buildArgs` (the argv herdr types after `pi`):

```
exec
--yolo                                   # = --dangerously-bypass-approvals-and-sandbox (approval never + danger-full-access; implies --skip-git-repo-check)
-m <provider>/<slug>                     # only when a model override was requested
-c model_instructions_file="<abs system.md>"
-c project_doc_max_bytes=0               # no AGENTS.md / AGENTS.override.md
[-c developer_instructions="<single-line marker, optional>"]
[-c notify=[]]                           # optional hygiene: do not fire the user's turn-ended notifier
-o <abs result.md>                       # deliverable, written by codex at shutdown
```

Observed equivalence for the pieces (§11, §8, §10): all of `--yolo`, `-m`, `-c model_instructions_file`, `-c project_doc_max_bytes=0`, `-c developer_instructions=""`, `-c notify=[]`, `-c sandbox_mode="danger-full-access"`, `-c approval_policy="never"`, `-c ephemeral=true` parse cleanly against a real config (`codex debug prompt-input` exit 0, rendered list as expected).

### Shape B — the interactive TUI, natively, via `herdr agent start --kind codex`

```sh
herdr agent start <agentName> --kind codex --pane <paneId> --timeout <ms> -- \
  -m <provider>/<slug> \
  -c 'model_instructions_file="<abs system.md>"' \
  -c 'project_doc_max_bytes=0' \
  [--no-daemon] [--no-alt-screen]
```

`argv` echoed back by herdr: `["codex", ...]`; herdr's codex kind runs **the canonical interactive `codex`**, not `exec` (docs: "The kind selects Herdr's canonical interactive executable"; `herdr agent start --help`: "Start a supported interactive agent"). The task prompt is then typed in by the parent:

```sh
herdr agent prompt <paneId> "$(cat /tmp/pi-cowboy/<spawnId>/prompt.md)"
```

Settlement stays report-only (result.md), so no `-o` is needed; the child writes the file because the prompt says where (harness-independent, §7).

### Which one

- **Shape A** maps onto the existing seam with the fewest moves: launch is argv + staged files, settlement is unchanged, and the deliverable is `-o`. Its one fatal gap is item 9: `codex exec` is one-shot, so **steering/follow-ups are impossible** (and, worse, herdr will happily type a steer into a pane whose foreground `codex exec` is no longer reading the tty — see §9).
- **Shape B** is the only shape that supports pi-cowboy's steering/follow-up contract, and it is the shape herdr natively supports for codex. It costs a host-seam change (the launch kind is hardcoded `--kind pi`) plus a post-start task submission step.

Recommendation: implement **Shape B** as the codex harness's launch (steering is part of the `ProcessSupervisor` contract), and keep **Shape A** as the documented non-interactive variant to fall back to if the post-start prompt step is rejected in review. Do not ship Shape A's steering: the harness capability must say "not steerable".

## 3. Verdict table (14 contract items)

### Lifecycle & Process

| #   | Item                                                       | Verdict                                        | Detail                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Unattended launch of the interactive agent in a herdr pane | 🟨 **Native (Shape B) / workaround (Shape A)** | herdr has `--kind codex`; the seam pins `--kind pi`, so Shape A needs a pane shim, Shape B needs the kind plumbed through `AgentHost.start` — that host change is the yellow. Pane preparation rides here: `prepare` installs the launcher, and there is nothing to prove because the TUI reaches its composer on argv alone (no onboarding or trust gate, and a missing instructions file fails loudly). |
| 2   | Temp-file lifecycle / cleanup ordering                     | 🟩 **Native (nothing new to remove)**          | Keep config in `-c` flags and the design needs no new files: `system.md`/`prompt.md` (existing staging) in, `result.md` out. If a per-spawn `CODEX_HOME` were staged it would have to be removed in `harness.teardown`, which already runs before the dirty probe.                                                                                                                                        |
| 3   | Settlement detection                                       | 🟩 **Native (unchanged)**                      | Report-only result-file poll, exactly as today. `-o` under Shape A makes the file appear precisely at shutdown. herdr state must not be used for codex.                                                                                                                                                                                                                                                   |
| 4   | herdr argv                                                 | 🟩 **Native (Shape B) / shim (Shape A)**       | `agent start <name> --kind codex --pane <id> --timeout <ms> -- <args…>`; args are shell-single-quoted into the pane, control characters are rejected.                                                                                                                                                                                                                                                     |

### Prompting & Delivery

| #   | Item                                           | Verdict                                             | Detail                                                                                                                                                                                             |
| --- | ---------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | System-prompt replacement from the staged file | 🟩 **Native (`-c model_instructions_file`)**        | codex replaces its base instructions from the staged file: `-c model_instructions_file=<abs file>`. Append (`developer_instructions`) exists as a fallback, but a foreign harness never needs one. |
| 6   | Task-prompt delivery                           | 🟨 **Workaround (Shape A) / native-pane (Shape B)** | Shape A: stdin redirect from `prompt.md` in the shim (multi-line argv is rejected by herdr). Shape B: `herdr agent prompt`, multi-line-safe — a new post-start step, which is the yellow.          |
| 7   | Result-file protocol                           | 🟩 **Native / harness-independent**                 | The protocol is a file the prompt names and the parent polls. Confirmed independent of harness. `-o` can write it for `exec` (Shape A); Shape B uses the prompt instruction as today.              |
| 8   | Context-file suppression                       | 🟩 **Native**                                       | `-c project_doc_max_bytes=0` drops the AGENTS.md user item (verified in a rendered prompt).                                                                                                        |
| 9   | Steering                                       | 🟩 **Impossible (Shape A) / native (Shape B)**      | Shape B: `herdr agent prompt` reaches the TUI composer (transport proven against a codex process). Shape A: no reader on the tty; a steer is not delivered and can leak into the shell afterwards. |

### Configuration & Environment

| #   | Item                                | Verdict                                        | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | Model selection and catalogue       | 🟩 **Native**                                  | `-m <slug>`; a `provider/slug` key round-trips (namespaced-suffix matching). `codex debug models --bundled` is offline and auth-free and lists the catalogue codex owns (8 of 11 entries, the `visibility: "list"` ones). With no `-m`, codex resolves its own `model` and otherwise picks from the catalog in priority order, so a harness default is optional.                                                                                                                                                                                                           |
| 11  | Approval / sandbox                  | 🟩 **Native**                                  | `--yolo` (= approval `never` + sandbox `danger-full-access` + skip git check), or `-a never -s danger-full-access`, or `-s workspace-write --add-dir <resultDir>`. `--full-auto` is gone.                                                                                                                                                                                                                                                                                                                                                                                  |
| 12  | Availability probe and version gate | 🟩 **Native**                                  | `codex --version` prints a stable, parseable line — `codex-cli 0.162.1` — so an availability check can confirm the installed major, not merely presence, and carry the reason through `HarnessAvailability.notice` when the major is unsupported. Whether a gate is worth keeping is the open question, not whether one is possible.                                                                                                                                                                                                                                       |
| 13  | Thinking / reasoning effort         | 🟩 **Native**                                  | codex's reasoning effort is a config key: `-c model_reasoning_effort=<level>` (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`), with `plan_mode_reasoning_effort`, `model_reasoning_summary`, and `model_verbosity` beside it. Each model declares its `supported_reasoning_levels`, so a pi `thinkingLevel` maps straight across.                                                                                                                                                                                                                                       |
| 14  | Tool selection                      | 🟩 **Workaround (its own toggles, no filter)** | codex can switch a few named tools off through config (`tools.web_search`, `tools.update_plan`, `tools.experimental_request_user_input`, the `web_search` mode, feature flags like `view_image`/`shell_tool`/`unified_exec`), but it has no include/exclude filter — the rest of the set is fixed by the model (`tool_mode`, `experimental_supported_tools`). The toggles ride codex's own slice, so the API needs no change; but toggles are not a filter, so `default`/`none`/`include`/`exclude` is only partly honourable and the verdict is a Workaround, not Native. |

## 4. Item-by-item evidence

### Lifecycle & Process

#### 🟨 1. Unattended launch of the interactive agent in a herdr pane

`herdr agent start --help`:

```
Usage: herdr agent start <NAME> --kind <KIND> --pane <ID> [OPTIONS] [-- [AGENT_ARG]...]
      --kind <KIND>   Supported agent kind and canonical executable
                      [possible values: pi, claude, codex, gemini, cursor, devin, agy, cline, omp,
                       mastracode, opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo,
                       qodercli, qwen, letta, maki, muse]
```

Live proof that `--kind codex` spawns codex and passes args through unchanged (scratch pane, non-model subcommand):

```
$ herdr agent start probe3 --kind codex --pane wBH:p2 --timeout 8000 -- app-server
{"id":"cli:agent:start","result":{"agent":{"agent":"codex","agent_status":"idle", ..., "interactive_ready":true,
 "name":"probe3","pane_id":"wBH:p2", ... "terminal_title":"codex app-server", ...},
 "argv":["codex","app-server"],"type":"agent_started"}}
```

A non-interactive `codex exec` never becomes "ready" (no composer):

```
$ herdr agent start codexprobe2 --kind codex --pane wBH:p2 --timeout 6000 -- exec --skip-git-repo-check
{"error":{"code":"timeout","message":"timed out waiting for agent startup"},"id":"cli:agent:start"}
$ herdr pane read wBH:p2 --lines 30
❯ codex exec --skip-git-repo-check
No prompt provided. Either specify one as an argument or pipe the prompt into stdin.
```

That timeout is already treated as success by pi-cowboy (`isNonFatalStartError`, `src/infrastructure/herdr/agents.ts`) — the same tolerance pig/pi-bolt rely on.

Under the existing seam, the pane command is `pi <args>` (hard-coded kind, `src/infrastructure/herdr/agents.ts`):

```
["agent","start",options.name,"--kind","pi","--pane",options.paneId,"--timeout",…,"--",...options.piArgs]
```

and the pane's `pi()` function is what reaches codex (`prepare` → `herdr pane run`). Verified live with a `pi()` shim that execs codex:

```
$ herdr pane run wBH:p3 'pi() { : "cowboy-probe-sig"; export HERDR_AGENT=pi; codex app-server; }'
$ herdr agent start probepi --kind pi --pane wBH:p3 --timeout 6000
{"result":{"agent":{"agent":"pi","agent_status":"idle","interactive_ready":true,"name":"probepi",...},
 "argv":["pi"],"type":"agent_started"}}
```

So: under the seam today, **the pane that runs codex is registered as a herdr agent** (as `pi` when the shim sets `HERDR_AGENT=pi`, which every pi-compatible harness does). That registration is what makes item 9 (Shape B) work at all, and what makes Shape A's steer dangerous.

Pane preparation rides on the same launch. `prepare` installs the launcher, and there is nothing to prove: codex's TUI reaches its composer on argv alone, with no onboarding wizard or trust dialog to clear — the one prerequisite is login, which the real `CODEX_HOME` carries — and a launch whose instructions file is missing or empty fails loudly rather than parking quietly. `--no-alt-screen` runs the TUI in inline mode. So the composer appearing is the readiness, and there is no silent mislaunch to prove against.

#### 🟩 2. Temp-file lifecycle / cleanup ordering

What a codex launch needs on disk: only the files pi-cowboy already stages for every spawn — `system.md` (referenced by `-c model_instructions_file`, absolute path required) and `prompt.md` (consumed by the shim's stdin redirect in Shape A, or read by the parent for `agent prompt` in Shape B) — plus the pre-derived `result.md`. No `CODEX_HOME` staging and no codex config file should be added: a fresh `CODEX_HOME` has no `auth.json` and codex would stop at a login screen, so the process must keep the real home and take all overrides from `-c` flags.

Consequently `harness.teardown` for codex is a no-op like the pi family's, and the existing ordering already covers any future staging:

```ts
// src/agents/agent-cleanup.ts
// Ordered before the dirty probe — see Harness.teardown.
const runs = teardownRuns(hint, located); … await assets.teardownEnvironment({subagentId, runs});
```

Two small Shape A wrinkles to keep out of the worktree: the shim's redirect path is under `$TMPDIR/pi-cowboy/<id>/` (never inside the worktree), and `-o` writes there too, so nothing codex does adds worktree dirt that would confuse the retention probe beyond what the child itself does.

#### 🟩 3. Settlement detection

Unchanged. `ProcessSupervisorEngine` is explicitly report-only ("SETTLEMENT IS REPORT-ONLY: only the subagent's own report settles a run … Herdr state never settles"), and that remains correct for codex — indeed it is _required_, because codex state detection is weak by design:

- herdr's codex manifest is a remote manifest at `~/.local/state/herdr/agent-detection/remote/codex.toml` (`version = "2026.10.01.1"`); its only `idle` rule is `osc_title_idle` — "the OSC title region is non-empty and has no spinner and no `Action Required`". `working` is a spinner in the title (`osc_title_working`) or an elapsed-timer line.
- herdr's own docs: "Codex falls back to `unknown` because its title and composer can look the same during an active turn and after a response."

Live confirmation on a real codex process in a pane:

```
$ herdr agent explain wBH:p2 --json
agent = "codex" | state = "idle" | matched_rule = {"id":"osc_title_idle","priority":100,"region":"osc_title"}
```

For Shape A, `-o` gives a sharper settlement signal than any pane reading: the result file appears exactly once, at shutdown. For Shape B, settlement is the child writing result.md, as today. If ever needed, `--json` emits machine-readable lifecycle events (`thread.started`, `turn.completed`, `turn.failed`, `item.completed`, `error`) on stdout, but the parent does not read the pane's stdout today and should not start for codex.

#### 🟩 4. herdr integration / argv

- herdr 0.9.3 supports codex natively: `--kind codex`, screen-manifest detection, and an integration (`herdr integration install codex`, already installed here as v8) that "reports session identity through the same local socket API"; codex **state** still comes from the screen manifest. The integration writes `~/.codex/hooks.json` and ensures `[features] hooks = true` — a user-level install, not something the harness should do, and irrelevant when a spawn keeps the real `CODEX_HOME`.
- What herdr actually sends: the kind's canonical executable plus the args after `--`, typed into the pane's shell with each arg single-quoted, control characters rejected (`invalid_agent_argument`), readiness waited for with `--timeout` (3000 < ms ≤ 300000), and the start result echoing `argv` and the agent record (`agent`, `agent_status`, `interactive_ready`, `name`, `pane_id`, `terminal_title`).
- For Shape A the argv herdr must send is unchanged from today: `agent start <name> --kind pi --pane <id> --timeout <ms> -- <codex exec args…>`, with the pane's `pi()` shim exec'ing codex. For Shape B it is `--kind codex` with the codex flags, and a subsequent `agent prompt <paneId> <task text>`.

### Prompting & Delivery

#### 🟩 5. System-prompt replacement

CLI surface (`codex --help` / `codex exec --help`): **no** `--system-prompt`. The knobs are `-c/--config key=value` overrides, whose values are parsed as TOML (falling back to a literal string).

Replace, from codex's own config struct:

```rust
// codex-rs/config/src/config_toml.rs
/// Optional path to a file containing model instructions that will override
/// the built-in instructions for the selected model. Users are STRONGLY
/// DISCOURAGED from using this field, …
pub model_instructions_file: Option<AbsolutePathBuf>,
```

Priority at session start (`core/src/config/mod.rs:4014-4026`, `core/src/session/mod.rs:750`): `config.base_instructions` (i.e. `model_instructions_file`, else `instructions`) wins over the model's rendered `instructions_template`. The base instructions travel in the request's `instructions` field (`core/src/client.rs:931`), and codex's own integration test asserts the replacement against a mock endpoint:

```rust
// core/tests/suite/cli_stream.rs:296
/// Verify that passing `-c model_instructions_file=...` to the CLI overrides the built-in base
/// instructions by inspecting the request body received by a mock OpenAI Responses endpoint.
… .arg("-c").arg(format!("model_instructions_file=\"{custom_path_str}\"")) …
assert!(instructions.contains(marker));
```

Failure modes are loud, unlike pi's silent fallback: `try_read_non_empty_file` returns a hard error when the file is missing or empty (`core/src/config/mod.rs:4611`), and the type is `AbsolutePathBuf`, so a relative path is rejected at parse time.

**Append fallback.** A CLI without a replace path would append instead; codex's is `developer_instructions` = "Developer instructions inserted as a `developer` role message", real but inline-only. Rendered proof (`codex debug prompt-input -c 'developer_instructions="cowboy-subagent-probe123"'`):

```
[0] developer: parts=4
    - cowboy-subagent-probe123
    - <skills_instructions>…
    - <permissions instructions>…
    - <collaboration_mode>…
```

**What the fallback costs.** A `developer_instructions` override also _replaces_ any value the user's `config.toml` set (verified: a config-level `USER_CONFIG_MARKER` disappeared under `-c 'developer_instructions=""'`). That is the lever to clear a user's personal developer instructions for a spawn — and the reason not to use it casually as a token carrier.

And note what a codex child's prompt _still_ contains, whether or not we replace the base: skills, multi-agent role/mode, permissions, collaboration-mode developer blocks, plus a user-role `environment_context` and the `AGENTS.md` item (rendered list above, 5 items / 4 parts). pi's `--no-context-files` equivalent only reaches AGENTS.md (§8); the rest is codex-internal guidance that cannot be switched off except for the documented `include_*` keys and `skills.include_instructions`.

#### 🟨 6. Task-prompt delivery

`codex exec --help`:

```
Arguments:
  [PROMPT]
      Initial instructions for the agent. If not provided as an argument (or if `-` is used),
      instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin
      is appended as a `<stdin>` block
```

Stdin behavior is explicit in source (`exec/src/lib.rs:2312`): `RequiredIfPiped` ⇒ a TTY stdin with no positional prompt **fails immediately** (observed above), so `codex exec` cannot idle waiting for a typed prompt. Multi-line content **cannot** ride the argv: herdr rejects it before anything is typed:

```
$ herdr agent start probenl --kind codex --pane wBH:p3 --timeout 3000 -- debug models --bundled "$(printf 'line1\nline2')"
{"error":{"code":"invalid_agent_argument","message":"agent arguments cannot be encoded safely for the target shell"},"id":"cli:agent:start"}
```

and herdr's args are _quoted_, not passed to a shell, so neither a redirect nor `$(cat …)` can be smuggled in:

```
$ herdr agent start probeq --kind codex --pane wBH:p2 -- debug models --bundled "<" /etc/hostname
$ herdr pane read wBH:p2
❯ codex debug models --bundled '<' /etc/hostname
error: unexpected argument '<' found
```

`@file` mentions do **not** help: CLI prompts become `UserInput::Text` verbatim (`exec/src/lib.rs`), mentions are built only by the TUI composer (`tui/src/chatwidget/input_submission.rs`).

So the task must arrive as a **file**: stdin redirect in the pane shim (Shape A, e.g. `codex "$@" - < prompt.md`) or `herdr agent prompt` (Shape B, which writes text + Enter honouring bracketed paste and therefore handles multi-line).

#### 🟩 7. Result-file protocol

Unchanged and harness-independent: `buildResultInstruction` puts the absolute result path in the system prompt (`src/prompt/subagent-system-prompt.ts:225`), the child writes it, and `FileDeliverable` polls content+mtime (`src/subagent/deliverable.ts`). Nothing in the protocol is pi-specific.

`-o/--output-last-message <FILE>` can write the deliverable for Shape A: it writes the final agent message at shutdown (`exec/src/event_processor.rs` → `handle_last_message`, called from both human and JSONL processors' `print_final_output`). Two consequences worth stating:

- Under Shape A, `-o` makes settlement robust even when the child's own write is blocked by a sandbox — the file is written by the codex process itself, not by a sandboxed tool call.
- If the turn ends with no final agent message, codex writes an **empty** file and warns on stderr (`"no last agent message; wrote empty content to …"`). `FileDeliverable` treats blank content as no report, so the run stays unsettled — the same behaviour as an unsettled pi run, but worth knowing.
- Shape B has no `-o` (TUI-only flag set), so the deliverable relies on the prompt instruction, and the child needs write access outside the worktree (§11).

#### 🟩 8. Context files (AGENTS.md)

Suppressible, and directly: `-c project_doc_max_bytes=0`. Source: `core/src/agents_md.rs:68` (`let mut remaining = config.project_doc_max_bytes; if remaining == 0 { break; }`). Rendered proof, in a directory containing `AGENTS.md`:

```
### baseline                      [3] user: # AGENTS.md instructions for /private/tmp/cdx-promptprobe …
### -c project_doc_max_bytes=0    the AGENTS.md item is gone (item count 5 → 4, user item is just "T")
```

`AGENTS.override.md` is the same mechanism and is suppressed with it; `project_doc_fallback_filenames` already defaults to empty. One nuance: when the project is _untrusted_, codex returns early and never reads project docs at all, so the setting only matters for trusted worktrees — it is sufficient either way.

What is lost: nothing pi-cowboy needs, because pi's family passes `--no-context-files` for the same reason (the subagent system prompt is the compiled `system.md`). Extra codex blocks that are _not_ covered by this flag (skills, multi-agent role/mode, collaboration mode, environment context, permissions instructions) can each be silenced with `-c skills.include_instructions=false`, `-c include_environment_context=false`, `-c include_apps_instructions=false`, `-c include_collaboration_mode_instructions=false`, `-c include_permissions_instructions=false` — all accepted (verified). `developer_instructions` from the user's config is silenced with `-c 'developer_instructions=""'`.

#### 🟩 9. Steering

- **Shape B (TUI): feasible.** pi-cowboy's `deliver` already goes through `herdr agent prompt <paneId> <text>` (`src/infrastructure/herdr-host.ts`), and the transport demonstrably reaches a codex process's terminal input. Proof against a live codex process (non-model subcommand):

  ```
  $ herdr agent prompt wBH:p2 "steering-probe-mechanics"
  {"result":{"type":"agent_prompted", …}}
  $ herdr pane read wBH:p2
  ❯ codex app-server
  steering-probe-mechanics
  … ERROR codex_app_server_transport::transport: Failed to deserialize JSONRPCMessage: expected value at line 1 …
  ```

  For the TUI that same write lands in the composer, and codex queues a follow-up while a turn is running. Steering is also the reason herdr's codex kind is interesting: herdr refuses a target that hosts no agent (`agent_not_found`) or an approval dialog (`agent_blocked`), so a refused steer is a clean `not-submitted`.

- **Shape A (`codex exec`): impossible.** An exec run reads its prompt once (argv or piped stdin) and then exits; it never reads the tty again. A steer would be typed into a pty nobody reads. I did not prove the follow-on hazard (pending bytes being read as shell input when the pane's shell regains the foreground) — treat it as a risk, not a fact — but the feature is unavailable either way. So Shape A must declare itself unsteerable; today the harness contract has no such capability and `deliver` lives on the host, so this is a real design decision to make, not a detail.

- Alternative CLI steering (out of pi-cowboy's current shape, worth recording): `codex queue --thread <UUID|session name> --message <TEXT>` queues a message for an existing session through the shared app-server daemon, and `codex exec resume <id> "<follow-up>"` starts a _new_ process continuing a session. Neither is a substitute for typing into a live TUI (the former needs the daemon and the thread id — which herdr does have, via the installed codex integration: `herdr integration status` → `codex: current (v8)`).

### Configuration & Environment

#### 🟩 10. Model selection and catalogue

codex's catalogue is its own, and it hands it over offline. `-m/--model <MODEL>` exists on both the TUI and `exec`. A namespaced key is accepted and matched by suffix (`models-manager/src/manager_tests.rs`: `get_model_info_matches_namespaced_suffix`, `…_hyphenated_provider_namespace_suffix`; `construct_model_info_from_candidates` tries longest-prefix then single-segment namespaced suffix). So a pi-cowboy `provider/model` key can be passed to `-m` unchanged, but the provider segment is only a matching convenience — the actual provider is `model_provider` (default `openai`).

Enumeration, offline and auth-free:

```
$ CODEX_HOME=<empty dir> codex debug models --bundled | jq -r '.models[].slug'
gpt-6-astra gpt-6.1-sol gpt-6-sol gpt-6-luna gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna
gpt-daybreak-blue-latest gpt-daybreak-red-latest gpt-5.5 codex-auto-review      # 11 total
```

8 have `visibility: "list"` (the three `hide`d ones — daybreak blue/red, codex-auto-review — are not offered). `--bundled` exists precisely to skip the refresh ("Skip refresh and dump only the bundled catalog shipped with this binary"), which is what `Harness.listModels` should pass; the opencode harness's defensive parse (empty list + `[subagents]` warning, never a throw) is the pattern to copy, mapping `{ key: \`openai/${slug}\`, label: display_name }`.

Default model: if `-m` is absent, codex resolves `config.model` (the user's `~/.codex/config.toml`, currently `gpt-5.6-terra` here) and otherwise picks from the available catalog in priority order (`models-manager/src/manager.rs:get_default_model`). A `defaultModelByHarness["codex"]` entry is therefore optional, not required for correctness.

#### 🟩 11. Approval / permissions / sandbox

Flags that exist (0.162.1): `-s/--sandbox read-only|workspace-write|danger-full-access`, `-a/--ask-for-approval on-request|never`, `--approve-for-me` (alias `--not-so-yolo`; conflicts with `-s` and the bypass flag), `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), `--dangerously-bypass-hook-trust`, `--add-dir <DIR>`, `--search`, `-C/--cd`, `--worktree`.

Source shows exactly what `--yolo` means (`exec/src/lib.rs:343`, `:1011`): sandbox = `DangerFullAccess`, and the git-repo check is skipped. `--full-auto` is absent from this version. `-c sandbox_mode="danger-full-access"` / `-c approval_policy="never"` are equivalent and accepted (verified) if config-style is preferred over flags.

For parity with pi's `--approve`, `--yolo` is the direct analogue. If the subagent is to be sandboxed, `-s workspace-write --add-dir <resultDir>` is the narrower shape — the result file lives under `$TMPDIR/pi-cowboy/<id>/`, outside the worktree, so a workspace-write run needs that directory added (Shape B, where the child writes result.md itself). Reading `system.md` is fine under any policy; the codex process reads it before the sandbox applies.

Hygiene note: the user's `~/.codex/config.toml` here carries `notify = [... SkyComputerUseClient … "turn-ended"]`, so every subagent turn would fire the user's turn-ended notifier. `-c notify=[]` parses (verified) if a spawn should be silent. Related: `--ephemeral` / `-c ephemeral=true` avoids persisting session rollouts into the real `CODEX_HOME` (no `--ephemeral` flag on the TUI, but the override parses), and it costs `resume`/`queue` and the herdr codex hook's session identity.

#### 🟩 12. Availability probe and version gate

codex reports its version on a stable, parseable line: `codex --version` → `codex-cli 0.162.1`. An availability check can therefore read the installed major and refuse a codex it does not speak, rather than only confirming the binary is on `PATH`; the `notice` arm of `HarnessAvailability` carries the reason to the human when the major does not match. The open question is whether a gate is worth maintaining, not whether one is possible.

#### 🟩 13. Thinking / reasoning effort

codex's reasoning effort is a config key, so a pi `thinkingLevel` maps cleanly. The field is `model_reasoning_effort` (values `low`, `medium`, `high`, `xhigh`, `max`, `ultra`), with `plan_mode_reasoning_effort`, `model_reasoning_summary`, and `model_verbosity` beside it. Each model declares the levels it accepts: `codex debug models --bundled` lists `supported_reasoning_levels` per model (for example `gpt-6-astra` offers low through ultra, `gpt-5.5` stops at xhigh) plus a `default_reasoning_level`. A launch passes `-c model_reasoning_effort=<level>`, and `-c model_reasoning_effort="high"` parses.

#### 🟩 14. Tool selection

codex has no include/exclude-by-name tool selector; its tool set is largely fixed by the model. What a launch can do is flip the tools codex itself exposes as config (`[tools]` in `config.toml`): `tools.web_search`, `tools.update_plan`, `tools.experimental_request_user_input`, the top-level `web_search` mode (`disabled`/`cached`/`indexed`/`live`), and a set of feature flags (`view_image`, `shell_tool`, `unified_exec`, …) via `--enable`/`--disable`. The rest of the set comes from the model's `tool_mode` (`code_mode_only` in the current catalog) and `experimental_supported_tools`. So the contract's `default`/`none`/`include`/`exclude` cannot be stated as a selection; only the named few can be toggled. Those toggles ride codex's own slice, so the API needs no change — but toggles are not a filter, so the member is only partly honoured and the verdict is a Workaround, not Native.

## 5. Seam changes this family needs (per the contract's own evolution rule)

Nothing here is generalized plumbing; each item has codex as its first reader.

1. `HARNESS_IDS` += `"codex"`, plus one implementation file (`harness/codex.ts`) and its `registry.ts` entry (`z.enum(HARNESS_IDS)` in `agent-template.ts` picks it up, and a template written where codex is absent still loads).
2. **Shape B**: the launch kind must reach herdr. Today `AgentHost.start(ref, {name, piArgs})` → `startPiAgent` hard-codes `--kind pi`. The minimal honest widening is a harness-owned launch attribute carried on `SubagentLaunchPlan` and through `AgentHost.start` to `herdr agent start --kind`. If review prefers no host widening, Shape A keeps `--kind pi` and needs no kind plumbing at all.
3. **Shape A**: `HarnessPrepareRequest` gains the staged task file (prepare creates the `pi()` shim that redirects stdin from it). This is exactly the case the `harness.ts` header already anticipates ("A family whose `prepare` needs launch context (a harness that stages files before launch) widens `HarnessPrepareRequest` in the same change"). A `/codex` shim whose redirect path arrives as a sentinel argv element is the alternative if that widening is rejected.
4. **Shape B**: the task must be submitted after start. Either the plan carries the task text and the supervisor delivers it via the existing `host.deliver`, or the session reads `prompt.md` and delivers it. This is a new launch step, not a new contract.
5. `Harness.listModels` for codex: `pi.exec("codex", ["debug", "models", "--bundled"])` with the opencode-style defensive parse, offering the `visibility: "list"` entries.
6. **Availability gate (angle 12).** `available()` reads `codex --version` (`codex-cli <major>.<minor>.<patch>`) and gates on the supported major, the shape opencode already uses; the `notice` arm carries the reason when the installed major does not match.
7. `[harness.codex]` slice: `model` maps to `-m`, and `reasoning_effort` maps to `-c model_reasoning_effort` (angle 13); tool selection (angle 14) rides codex's own `tools.*`/feature toggles. The catalogue and its default need no key (angle 10).

## 6. Open questions, risks, and product decisions

### Awaiting evidence

1. **Does `herdr agent start --kind codex` reach ready for the real TUI here?** I proved the _mechanics_ (kind accepted, argv passed, a codex process is detected and classified `idle` from the title) but never launched the authenticated TUI: doing that would write session state under the real `~/.codex` (rule 2) and a temp `CODEX_HOME` needs a copy of `auth.json` (credential copy I declined to make). Managed startup "uses the initial composer only to determine when it can accept a prompt", so this is expected to work, but it is unverified.
2. **Does `herdr agent prompt` reliably land the _first_ (task) prompt in a fresh codex TUI**, and does `--wait` observe `working` for codex? The transport is proven; the state transition under the title-based manifest is not. Recommend submitting without `--wait` (settlement is report-only anyway).
3. **Does a live `codex exec` run register as a herdr agent for its whole life?** Expected yes (the `codex app-server` probe registered as `codex`/`idle`), but I could not keep an `exec` process alive without giving it a prompt, i.e. without inference. This matters only because it decides whether a Shape A steer is refused (`not-submitted`) or silently swallowed by the tty.
4. **Leftover-pty-input hazard (Shape A steering):** unverified. If `deliver` is reachable while an exec run owns the pane, typed bytes are unread until the shell returns; whether the shell then executes them must be checked before shipping Shape A with steering enabled.
5. **`codex queue`/`exec resume` steering** as an alternative to keystrokes is theory-verified only (help text + docs), never exercised.

### Decisions and risks

6. **Session pollution:** a TUI spawn under the shared app-server daemon will appear in the user's `codex agents`/session list unless `--no-daemon` or `-c ephemeral=true` is used (both untested against the TUI). Which one a pi-cowboy subagent should use is a product decision.
7. **User config bleed-through:** a spawn inherits the user's `~/.codex/config.toml` (model default, personality, `notify`, MCP servers, hooks, skills). I listed the `-c` keys that neutralize each block, but whether the codex harness should neutralize them by default — as opposed to matching pi's behaviour of loading user config — is a product decision, not a technical unknown.
8. **Model catalog drift:** `--bundled` is offline and deterministic but frozen at the installed binary; the repo's own `model_catalog_json`/remote refresh paths mean the enumerated list can differ from what codex will actually run after a refresh. The list is a menu, not a contract.
9. **Is a version gate worth maintaining (angle 12)?** codex reports a parseable version, so the gate is a few lines; unverified whether codex ever speaks a breaking major, and whether to keep the gate current is the question.

## 7. Appendix — exact commands used (all non-inference)

```sh
codex --version; codex --help; codex exec --help; codex exec -h; codex debug --help
codex debug models --help; codex debug prompt-input --help; codex debug app-server --help
codex app-server --help; codex queue --help; codex resume --help; codex exec resume --help
codex features --help; codex doctor --help; codex completion --help
codex --yolo --version
CODEX_HOME=<temp> codex debug models            # catalog (may refresh)
CODEX_HOME=<temp|empty> codex debug models --bundled
CODEX_HOME=<temp> codex debug models --bundled -c '<key>=<val>'   # config-key acceptance: model_reasoning_effort, tools.*
CODEX_HOME=<temp> codex debug prompt-input [-c …] "probe prompt"        # renders the model-visible input list
herdr --version; herdr --skill; herdr agent --help; herdr agent start --help
herdr agent explain --help; herdr agent explain --file <fixture> --agent codex --json
herdr integration status; herdr tab list; herdr tab create …; herdr tab close <id>
herdr agent start <probe> --kind codex --pane <scratch> --timeout … -- <non-model codex args>
herdr agent start <probe> --kind pi    --pane <scratch> --timeout … (pane pi() shim → codex app-server)
herdr agent prompt <scratch> "…"; herdr agent send-keys <scratch> ctrl+c
herdr pane run/read; herdr agent list/get/explain
```

Source reads: `openai/codex` @ `rust-v0.162.1` (`codex-rs/config/src/config_toml.rs`, `config/src/loader/*`, `core/src/config/mod.rs`, `core/src/session/mod.rs`, `core/src/client.rs`, `core/src/project_doc*` → `core/src/agents_md.rs`, `core/src/context/world_state/agents_md.rs`, `core/src/terminal_title.rs`, `exec/src/{cli,lib,event_processor,event_processor_with_human_output,event_processor_with_jsonl_output,exec_events}.rs`, `models-manager/src/{manager,manager_tests}.rs`, `utils/cli/src/{shared_options,approval_mode_cli_arg}.rs`, `tui/src/cli.rs`) and herdr 0.9.3 docs (`llms.txt`, `agents.mdx`, `agent-automation.mdx`, `cli-reference.mdx`, `integrations.mdx`) plus the live remote manifest `~/.local/state/herdr/agent-detection/remote/{codex,pi}.toml`.

Pane probes were confined to three scratch tabs (`wBH:t2`, `wBH:t3`, `wBH:t4`) in this spawn's own workspace, all closed at the end (`herdr tab close`), with only `wBH:t1` (this session) left in the workspace. No codex config directory was written.

**Steering/direction changes received during this run:** none. No instruction arrived that changed, narrowed, or abandoned any part of the task; the whole report is the original scope (REPORT ONLY, no `src/` changes, no commits).
