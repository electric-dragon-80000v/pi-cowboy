# Step integration tests — a real `pi` process against the fake-openai stub

The suite in this folder is written as **step integration tests**: a tiny HTTP
stub lets a **real `pi` process** talk to a **fake model** over localhost. No
real LLM, no API keys, no network beyond `127.0.0.1`. The methodology lives in
[WRITING-TESTS.md](WRITING-TESTS.md) — the authority on how a step integration
test is written; the `step-integration-tests` repo skill is its short form.

- `fake-openai-server.ts` — the reusable stub (`startFakeOpenAI`, per-route
  FIFO queues, `origin`/`baseUrl`).
- `pi-headless.ts` — shared harness for spawning the real `pi` binary
  (`runPiHeadless`, `writeModelsJson`, the isolated-env recipe).
- `scenario-steps.ts` — the factored application steps a step integration test
  is allowed to reuse (`initialize`, `installLocalExtension`,
  `engageOrchestrator`).
- `herdr-fake.ts` — the herdr world a delegating test runs in: a herdr session
  of that test's own (`startFakeHerdr`), its server, its socket, its teardown,
  plus the one question a test asks ABOUT that world
  (`herdrAgentProcessId`). Not a step: a delegation needs a herdr environment,
  not an action — and nothing outside the delegation paths touches herdr at
  all.
- `pi-cowboy.integration.test.ts` — the path where THIS repo's extension is
  the subject: the delegated agent's first inference, failed by the model, and
  the outcome that then reaches the orchestrator.
- `extension-loadout.integration.test.ts` — the path where THIS repo's
  extension is the subject AT BOOT: with no config file the run's first model
  request offers the cowboy tools, and with `extensionEnabled: false` in the
  isolated agent dir's config the same request carries none of them. A plain
  `--print` run in no herdr world, because a boot loads tools and shells out to
  nothing.
- `WRITING-TESTS.md` — the methodology (three kinds, tree shape, teardown).

## One tree per starting point

The delegation path's starting point is not a plain-`pi` one: it needs a herdr
session of the test's own, because the extension only acts inside a herdr pane
and the developer's session must stay out of it, and it needs a LIVE
orchestrator process, because a delegation's launch runs in the background of
its parent. That is `pi-cowboy.integration.test.ts` — and the boot-loadout path
beside it gets a tree of its own for the same reason: a `--print` boot is a
different starting point still, and neither path re-derives the other's spine.

Inside the file the tree rule holds as it does everywhere
(see _Growing the tree_ below): blocks that share a prefix hoist that prefix,
and a path that opens the way a sibling opens is a sibling inside the same
block. With one path there is nothing to hoist — its whole prefix is that body
— and the shape to copy when a second path appears beside it is the plain-`pi`
pair drawn in _Growing the tree_ below.

## The Pi↔stub contract (read this before extending the stub)

Reverse-engineered from Pi's client,
`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`
(`stream` → `client.chat.completions.create(params, …)` via the OpenAI SDK).
Every item below was verified against a live `pi` run:

1. **Endpoint**: `POST {baseUrl}/chat/completions`. The SDK appends
   `/chat/completions` to the model's `baseUrl`, so with
   `baseUrl: http://127.0.0.1:PORT/v1` the wire path is
   `/v1/chat/completions`. The stub accepts any POST path ending in
   `/chat/completions` and routes on the full path (see "Test isolation"
   below).
2. **Streaming is mandatory**: Pi always sends `stream: true` with
   `stream_options: { include_usage: true }`. The stub MUST answer
   `Content-Type: text/event-stream` with `data: <ChatCompletionChunk JSON>`
   frames followed by `data: [DONE]`. A non-SSE response breaks the OpenAI
   SDK parser.
3. **Terminal `finish_reason` is required**: the last choice MUST carry
   `finish_reason: "stop"` (text) or `"tool_calls"` (tool calls). A stream
   that ends without one fails with
   `Stream ended without finish_reason`. Unknown finish reasons
   (`content_filter`, `network_error`, anything else) surface as provider
   errors — only `stop` / `end` / `length` / `function_call` / `tool_calls`
   (and `null` mid-stream) are safe.
4. **Usage payload**: because Pi sends `include_usage: true`, the final chunk
   SHOULD carry `usage: { prompt_tokens, completion_tokens, total_tokens }`.
   Counts here are fabricated (`⌈chars/4⌉`); only the shape matters. Extra
   `prompt_tokens_details` / `completion_tokens_details` fields are parsed but
   optional.
5. **Auth**: the SDK sends `Authorization: Bearer <apiKey>` where the key is
   the provider's resolved `apiKey` (models.json literal, `$ENV_VAR`
   interpolation, or `--api-key`). Pass `expectedApiKey` to make the stub
   enforce it (401 otherwise); otherwise it records whatever arrives.
6. **Request body**: `model` (echoed back in chunks), `messages` (system +
   history; content may be a string or a parts array), plus `tools`,
   `max_completion_tokens`, `store: false`, `prompt_cache_key`, etc. The stub
   ignores everything except `model`/`messages`/`stream` but keeps the raw
   body on `RecordedRequest.rawBody` for assertions.
7. **Compat defaults for a localhost custom provider** (no special-casing in
   Pi's `detectCompat` matches `127.0.0.1`): `supportsStore: true`,
   `supportsDeveloperRole: true`, `supportsFinishReason: true`,
   `maxTokensField: "max_completion_tokens"`, `thinkingFormat: "openai"`.
   With `reasoning: false` (the default) the system prompt arrives as
   `role: "system"`.
8. **Tool calls**: stream `delta.tool_calls[]` entries shaped
   `{ index, id, type: "function", function: { name, arguments } }`
   (`arguments` may arrive split across deltas — Pi concatenates them), then
   terminate with `finish_reason: "tool_calls"`. Tool results come back as
   `role: "tool"` messages with `tool_call_id`.
9. **Non-streaming** (`stream: false`) is never sent by Pi; the stub answers
   it with a plain Chat Completion JSON object anyway, for direct-fetch
   debugging.

## Scripting API (per-route FIFO queues)

The routing key is **method + exact path** (query string stripped). Replies
are a discriminated union: `{ kind: "text", text }`,
`{ kind: "tool-call", text, calls }`, or
`{ kind: "error", status, message, code }` — the last one FAILS the request
with that HTTP status instead of answering it, which is how a scripted model
failure reaches pi (the status decides whether pi's client retries it:
408/409/429/5xx are retried, so a 4xx is the terminator). All three may carry
an optional `delayMs`, or `hold: "until-released"`; the former is **held**
unwritten for that long, while the latter stays parked until the test calls
`release`. Either keeps its request in flight — what a cancel-during-inference
test needs, and what a held-then-failed reply needs to be observably in flight
at all. Either hold is dropped, and nothing is written, when the client
disconnects first (a cancelled run).

```ts
const stub = await startFakeOpenAI({ expectedApiKey: KEY });

// Append to a route's FIFO queue. One request consumes exactly one reply,
// in order. Routes are created implicitly.
stub.enqueue({
  method: "POST",
  path: "/my-test/chat/completions",
  reply: { kind: "text", text: "pong" },
});

// Set a route's default reply, served whenever its queue is empty.
// Replaces any previous default for the route.
stub.on({
  method: "POST",
  path: "/my-test/chat/completions",
  reply: { kind: "text", text: "pong" },
});

// Recorded requests, filtered. `path` narrows to one route.
stub.requests({ method: "POST", path: "/my-test/chat/completions" });

// Requests still in flight on one route: recorded on arrival, reply not yet
// written. A held reply keeps its request here until its timer fires or the
// test releases it, so this is how a test asserts an inference was still in
// flight when observed.
stub.pendingRequests({ method: "POST", path: "/my-test/chat/completions" });

// Release one parked reply in arrival order; returns 1, or 0 when none is held.
stub.release({ method: "POST", path: "/my-test/chat/completions" });

// Clear all queues, route defaults (back to the constructor default), and
// recordings.
stub.reset();
```

Resolution order per request: **route queue → route default → constructor
`defaultReply`** (passed to `startFakeOpenAI`; unset by default), and a held
reply waits its `delayMs` before any of it is written, or waits for
`release` when scripted with `hold: "until-released"`.

**Queue semantics are one-shot and loud.** Each enqueued reply is served
exactly once, in order. When a request arrives with an empty queue and no
route or server default, the test under-enqueued — a test bug. The stub
**destroys the socket without sending any HTTP response** and then throws,
crashing the test process. This is deliberate: any HTTP response (even a 500) is indistinguishable from a real server response to the `pi` process
under test, so an empty queue must be impossible to mistake for one.

`startFakeOpenAI` exposes both `origin` (`http://127.0.0.1:PORT`, for
building per-test URLs) and `baseUrl` (`{origin}/v1`). The server is
localhost-only on an ephemeral port, owns its SSE framing, serves
`GET /models`, records requests (`RecordedRequest` with `rawBody` intact),
and enforces `expectedApiKey` only when the caller passes one.

## Test isolation via path prefixes

Each test registers routes under its own path prefix — its URL-encoded id —
and points its `models.json` baseUrl at `${stub.origin}${prefix}`:

```ts
const prefix = `/${encodeURIComponent("my-test")}`;
stub.enqueue({
  method: "POST",
  path: `${prefix}/chat/completions`,
  reply: { kind: "text", text: "pong" },
});
writeModelsJson(agentDir, stub.origin + prefix); // SDK appends /chat/completions
```

The stub routes on the full path, so no test can see another's queue or
request recordings. The server itself starts once per file (`beforeAll` /
`afterAll` — vitest isolates files in separate workers, so suite-lifetime
means file-lifetime), while the agent dir, `models.json`, cwd, and session
dir stay per-test (cheap, hermetic).

## Writing a step integration test: the three kinds

A step integration test is written in exactly three kinds, and only the first
is factored into `scenario-steps.ts` (see [WRITING-TESTS.md](WRITING-TESTS.md)):

1. **Application steps** — functions with the minimal parameters the caller
   cannot derive. The criterion is _hide what's derivable, show what's
   arbitrary_:

   ```ts
   const ctx = initialize(stub, testId);
   // → { agentDir, workDir, baseUrl, chatPath, runEnv }
   installLocalExtension(ctx); // → the run loads THIS repo's extension

   await startFakeHerdr(ctx); // a herdr session of this test's own
   const orchestrator = engageOrchestrator(ctx, prompt);
   // → { handle, result }, a LIVE pi process (rpc mode)
   orchestrator.handle.endInput(); // shut it down; result resolves
   ```

   `initialize` hides the temp dirs (plus the `sessions` dir), the
   `models.json` whose baseUrl is `${stub.origin}/${encodeURIComponent(testId)}`,
   and the `chatPath` (`${prefix}/chat/completions`). Visible at the call
   site: the stub handle and the test id. A block whose paths share the prefix
   calls it from that block's `beforeEach` with the running test's fully
   qualified name (`root > block > test`) as the id — the full test path is
   the route prefix the methodology names — so each path below still gets its
   own isolated world and its own teardown. `installLocalExtension` hides where
   pi discovers extensions (the agent dir's `extensions/`, keyed by the
   `pi.extensions` manifest) and how this repo's extension is activated
   (`HERDR_ENV=1`, its own herdr gate); loadability is still asserted inline —
   the extension's tools ride on the first model request the run makes.
   `engageOrchestrator`
   hides the rpc recipe a live parent process needs (its prompt is a stdin
   command, not an argv tail; the process stays up until its stdin closes) and
   returns that process plus the run it will end with, because keeping a
   parent process ALIVE is what a delegation needs — see _Delegating for real_
   below. A delegation also needs a herdr WORLD, and that half of the harness
   is not a step at all: `herdr-fake.ts` (`startFakeHerdr`) hides an entire
   herdr session — a named server with its own socket, a workspace for the run,
   and teardown that stops the session — and adds its coordinates to
   `ctx.runEnv`, so the run's herdr work lands in the test's session and never
   in the developer's. See _The herdr world of a delegating test_ below.

2. **Verification steps** — the assertions and the waits, never factored.
   They stay inline in the test body, fully visible and deliberately
   duplicated rather than extracted: **every `expect`** (exit code, output
   contains, request counts, tool-message assertions, cross-path isolation
   counts). Decoder helpers already exported here (`messageText`,
   `lastUserText`) may be _used_ inline — using a decoder is not abstracting
   an expectation.
3. **Script** — this is not a step. The setup of the run, also never factored,
   with every parameter visible in the test: `stub.enqueue` calls with their
   full reply payloads, fixture file writes, and directory preparation. What
   every path in a block shares is not one test's script — it is the block's
   setup (see _Growing the tree_ below).

Future application steps — names only, no code until the harness exists:
`awaitAgentSettled`, `mergeBranch`, and `cleanupAgent` all need a parent-`pi`
harness that does not exist yet.

**Teardown is the step's job.** `initialize` registers its own
`onTestFinished(() => removeTempDirs(ctx))` (vitest's per-test hook), which
fires on pass _and_ on failure, is scoped to exactly the calling test, and
has zero effect on tests that never call it. That replaces the test's
`try`/`finally` — the body reads straight through: `initialize` → inline
fixtures/`enqueue`s → running the prompt → inline `expect`s, no `afterEach`
and no module-global dir registry.

## Growing the tree: a new path is a branch, not a new test

The suite is one tree per FILE. A new scenario that opens the way an existing
one opens branches off it — it does not repeat the spine. Today's real shape:

```text
pi-cowboy.integration.test.ts
step integration: a real pi process against the fake-openai stub
└── a scripted cowboy_agent call against an installed extension
    └── fails the delegated agent's first inference and reports the outcome
        to the orchestrator
        body: initialize + installLocalExtension + startFakeHerdr
              the delegated agent's own stub route; its first reply HELD
              and then FAILED (a scripted 400)
              the scripted cowboy_agent call
              engageOrchestrator + the spawn acknowledgement (agent id)
              the in-flight assertions, the arrival assertions
```

With one path per file there is nothing to hoist. The pair below is the shape
to copy when a second path opens the way this one does:

```text
step-integration.integration.test.ts
step integration: a real pi process against the fake-openai stub
├── answers ping with pong                                  (uses no steps)
└── a scripted read call against an installed extension     ← the shared prefix
    │   beforeEach: initialize(stub, currentTestId())
    │               installLocalExtension(ctx)
    │               hello.txt fixture written at helloPath
    ├── sends hello > replies                               (the existing path)
    └── cancels the first inference while the model reply is still in flight
```

A delegation path CANNOT split that way at its fork, and the reason is worth
knowing before someone tries: there the fork is the delegated agent's reply
script, and a spawn asks the model the moment it has booted — before any body
runs. A hold installed in a body would race the request it is meant to hold,
and losing that race would not fail loudly: the delegated agent would take a
free reply, its turn would end, and the cancel would kill an idle agent while
the arrival still read like a cancelled run. So a body-level fork must either
not exist, or be pinned by an assertion that the reply was still unwritten.

- **The prefix is hoisted.** Everything both paths receive — the isolated
  world, the installed extension, the fixture and its path — lives in the
  block's `beforeEach`, at the block's level. Each path below it still gets
  its own world, its own route prefix (the running test's fully qualified
  name) and its own teardown.
- **The existing path moves with its prefix.** Hoisting edits the existing
  test: its shared setup lines leave the body for the block while its
  assertions move verbatim and keep passing. That edit is expected; what is
  wrong is duplicating the prefix in the new test instead.
- **Only the fork stays inline.** In the paired example above, what differs is
  the reply each test scripts — the round trip's two replies, or the same first
  reply held with `delayMs` — plus each test's own verification steps: the
  wait, the failure, the assertions. Duplicate the fork, never the prefix.
  Where the fork cannot be inline — a delegation path, where the agent asks
  before a body runs — the fork belongs to the block both paths run in.
- **The new test is a sibling of the existing path**, inside the shared block.
  A path that needs a name gets its own block (`sends hello`); a block holding
  only the new test earns nothing, and neither does a second copy of the
  spine — a block with a single path is flattened, its setup going into that
  body (which is the shape today's file has).
- **Slow paths time out at the block**, the level that owns their setup
  (`describe(name, fn, 120_000)` covers every path under it).

## Scripting multi-turn tool-call sequences

Multi-turn scripts are just ordered enqueues — nothing counts turns. Enqueue
one reply per model turn; the follow-up request after real tool execution
consumes the next one:

```ts
stub.enqueue({
  method: "POST",
  path: chatPath,
  reply: {
    kind: "tool-call",
    text: "",
    calls: [{ id: "call_1", name: "read", arguments: { path: helloPath } }],
  },
});
stub.enqueue({
  method: "POST",
  path: chatPath,
  reply: { kind: "text", text: "done" },
});
```

The second request's `messages` will contain the assistant's `tool_calls`
plus a `role: "tool"` result with the matching `tool_call_id` — assert on
`stub.requests({ method: "POST", path: chatPath })`. Use `messageText` /
`lastUserText` from the server module to decode message content (string or
parts array) in assertions. Inspect cross-test leakage by filtering on the
other test's path.

## Delegating for real: the `cowboy_agent` path

The one path where this repo's extension is the subject rather than a loaded
bystander. The script is an ordinary tool-call script — only the tool it names
changes:

```ts
stub.enqueue({
  method: "POST",
  path: ctx.chatPath,
  reply: {
    kind: "tool-call",
    text: "",
    calls: [
      {
        id: "call_1",
        name: "cowboy_agent",
        arguments: { prompt: DELEGATED_TASK, task_name: "verify spawn" },
      },
    ],
  },
});
stub.on({
  method: "POST",
  path: ctx.chatPath,
  reply: { kind: "text", text: "done" },
});
```

What the extension does with that call is real, and two properties of its
launch decide how such a test must be built:

- **The parent process has to stay alive.** `cowboy_agent` is non-blocking: the
  tool returns as soon as the spawn is admitted, and the launch (pane,
  `herdr agent start`, `pi` boot) continues in the background of the _parent_
  `pi` process. A `--print` run exits at the end of its turn and takes that
  background launch with it — measured: `[Agent spawned]` comes back with an
  agent id, while no pane, no agent, and no subagent process ever appear.
  `engageOrchestrator` (rpc mode, see below) is the headless shape of a parent
  that does not exit on turn end.
- **The subagent's environment is the herdr SERVER's, not the run's.** herdr
  starts the pane's shell itself, so `PI_CODING_AGENT_DIR` must be set on the
  server for the subagent to read this test's `models.json` — which is also
  what makes the subagent's own model calls land on the stub
  (`startFakeHerdr`, herdr-fake.ts, spawns that server from the same isolated
  recipe). The
  same fact is why the session has to be the test's own: a pane of the
  developer's session would inherit the developer's agent dir, and the
  subagent's `--model step-integration-fake/pong-model` would not resolve
  there — no stub, no second half of the test.

What the test asserts, in the order the evidence appears:

1. the extension EXECUTED the call — a `role: "tool"` message carrying the call
   id holds the spawn acknowledgement (`[Agent spawned]`, `Agent ID: <id>`);
2. the delegated agent's first inference is in flight and is that agent's — a
   request on the delegated agent's own route whose system prompt carries the
   subagent spawn marker (`cowboy-subagent-<id>`, appended to the subagent
   prompt by `agent-runner`) with the same id the parent was told to address,
   and the delegated task as its user message;
3. its outcome REACHES the orchestrator — see the section below.

The marker is what makes claim 2 honest: only a process the extension launched
with `--append-system-prompt 'cowboy-subagent-<id>'` can send it, and that id
is the one in the parent's own conversation. The pane, the `herdr agent list`
entry, and the subagent's own status directory are consequences of the same
launch — evidence to read while debugging, not the assertion.
Teardown: the isolated session step stops the session, which kills the
subagent process in its pane; the test removes the spawn's status directory
(`<tmpdir>/pi-cowboy/<agent id>/`), which the extension keeps until
`cleanup_cowboy_agent` runs — or until a settlement of its own removes it, as the
path below measures.

## The delegated agent's first inference fails: nothing reports it

This path is the file's only one, so its whole prefix is inline in the body:
the world, the delegated agent's own stub route, the scripted call, the
orchestrator, the spawn acknowledgement — and the delegated agent's first
reply HELD and then FAILED. Before the delegation, not in a later step of it: a
spawn asks the model the moment it has booted (see _Growing the tree_ above).
What the body then adds is what it reads while that inference is in flight,
and the absence it reads afterwards. `pi-cowboy.integration.test.ts`:

```ts
await expect
  .poll(() => delegatedRequests().length, { timeout: 20_000 })
  .toBe(1);
// ...release the parked reply, so the turn ends in a failure...
await new Promise((resolve) => setTimeout(resolve, 8_000)); // four poll ticks
expect(outcomeMessages()).toEqual([]);
expect(await herdrAgentProcessId(ctx, agentId)).toBeGreaterThan(0);
```

Four things make that possible, and each one is a measurement, not an
assumption:

- **The delegated agent gets a stub route of its own.** A subagent inherits the
  orchestrator's provider, and the scenario needs the subagent's first reply
  HELD (and failed) while the orchestrator's own turns keep answering — so this
  test's `models.json` gains a second provider whose baseUrl carries a
  `/delegated` segment, and the configured default model (`agent.default`, the
  only layer a spawn with no `model` parameter reads) points the spawn at it.
  No call parameter is involved. It is declared before the delegation because
  that delegation cannot run before it: the extension launches the subagent in
  the background and that `pi` reads `models.json` at boot.
- **The reply is held until released, then failed.**
  `hold: "until-released"` keeps the first inference on the wire by
  construction while the test reads it — and the test pins that it was still
  unanswered (`pendingRequests`) before releasing exactly one parked reply —
  so the in-flight half of the claim is asserted, not assumed. The scripted
  `{ kind: "error", status: 400 }` ends it as a model failure. The status is
  load-bearing: the OpenAI client pi asks through retries 408/409/429/5xx and
  does not retry a 4xx, so the failure is the turn's LAST word — the delegated
  agent asks the model exactly once, which is what makes the assertion about
  the FIRST inference an assertion about the whole run.
- **The one place a settlement could be seen is read anyway.** Every completion
  message — `pi.sendMessage` in `spawn-coordinator.ts` — lands in the
  orchestrator's session as a user message and rides its next model request, so
  THIS test's stub route is where such a message would appear. The supervisor's
  state, the result files and the onComplete payload all live inside the
  orchestrator's process and are not readable from a test, so reading the
  conversation is the assertion that no settlement happened.
- **The run stays live, measured on the process.** `herdrAgentProcessId` is read
  again after the failure window: the subagent's own `pi` still holds its pane,
  which is what "nothing settled this run" means from outside the extension. An
  error outcome would report that same process as a settled failure instead.

**Nothing arrives, and that is the asserted behavior.** The extension does not
track turn outcomes: there is no subagent-side reporter, no outcome artifact and
no error settlement. A run settles on the agent's own report (a deliverable held
one confirm poll) or on an explicit stop, and this run produces neither — so the
orchestrator's conversation gains no `[Subagent …]` message, its model is never
asked about one, and the spawn stays live in its pane.

The window is four supervisor poll ticks (2000 ms each, the production cadence;
nothing configures it in this test). The delegated agent's failure needs no help
either: the 4xx ends the turn, so the absence begins the moment the stub
releases the parked reply.

That wait is REAL time, not fake timers: the clock it waits on (the supervisor's
poll) runs inside the orchestrator's OWN process, a real child of this test, and
no fake timer in the test process can reach it.

**The paths this one is NOT**, kept because each is a real shape a reader will
try to pin next. An inference the USER cancels from the pane — the Escape pi's
TUI advertises (`escape interrupt · ctrl+c/ctrl+d clear/exit`) and handles
itself — ends with stopReason `"aborted"` and prints "Operation aborted" in that
pane: no outcome exists for it now, exactly as for a failure. A
SIGINT-killed `pi` is a third shape, further out still: pi does not handle that
signal, the process dies mid-turn, and the supervisor reports nothing (a
vanished process is not evidence of anything; only a report or an explicit stop
settles a run) — a statement about a killed process, not about a turn that
ended.

## The herdr world of a delegating test (`herdr-fake.ts`)

Everything above about the delegation path needs a herdr session the test owns.
It lives in `herdr-fake.ts`, beside the steps and deliberately NOT one of them
— a step is an action that drives the session forward, while this is the
environment a delegation acts in (nothing else in the suite touches herdr, and
no other path needs it).

```ts
await startFakeHerdr(ctx); // beforeEach, next to initialize + installLocalExtension
```

`startFakeHerdr(ctx)` starts a real `herdr server` in a named session of its
own (`pi-cowboy-step-<random>`), creates the workspace the run is addressed
as, and writes the session's coordinates into `ctx.runEnv` (`HERDR_ENV`,
`HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`) —
which is all a run needs to make its herdr calls land there instead of in the
developer's session. Teardown is registered by the module: `herdr session
stop|delete`, so the session's panes and the subagent processes inside them are
killed with it, and the server child is signalled last.

"Fake" is about the world, not the binary: the panes and the subagent are
real, and the developer's session stays untouched. The two herdr facts the
module is built on — a pane inherits the SERVER's environment, and a named
session keeps its own socket — are recorded in its header and in the headless
notes below.

Beside building that world, the module is how a delegating test asks about it,
all over this session's own socket:

- `herdrAgentProcessId(ctx, agentId)` — the pid of the process herdr hosts as
  that agent, i.e. the subagent's own `pi`: the pane's foreground process,
  found through the session's agent record, because pi rewrites its process
  title and the id cannot be searched for in the process table. It is how a
  test says the process the model is answering is a real one.

It narrows what it reads at the edge and answers `undefined` for an unreadable
session — a delegated agent that cannot be found then fails the step loudly
instead of being asserted about blind.

## Driving `pi` headlessly (notes for step integration tests)

All verified against the real binary
(`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`,
invoked via `process.execPath`; see `pi-headless.ts`):

- **Env var for the agent dir is `PI_CODING_AGENT_DIR`** (not `PI_AGENT_DIR`):
  `getAgentDir()` reads `${APP_NAME}_CODING_AGENT_DIR` with `APP_NAME=pi`.
  `models.json` is loaded from `<that dir>/models.json`. Point it at a temp
  dir; the real `~/.pi/agent` is never touched.
- **Session isolation**: `PI_CODING_AGENT_SESSION_DIR` redirects session
  storage; `--no-session` makes the run ephemeral (do both in tests).
  Run with a temp `cwd` too, so project-trust prompts and context-file
  discovery have nothing to find.
- **models.json for a fake provider** (minimal working shape):
  ```json
  {
    "providers": {
      "step-integration-fake": {
        "baseUrl": "http://127.0.0.1:PORT/v1",
        "apiKey": "step-integration-test-key",
        "api": "openai-completions",
        "models": [{ "id": "pong-model" }]
      }
    }
  }
  ```
  New provider ids need `baseUrl` + `api` + `apiKey` (literal or `$ENV_VAR`;
  `$VAR`/`${VAR}` interpolate, `$$` escapes) — without auth material Pi
  refuses with `no authentication method configured`. Model-level `id` is the
  only required model field; `reasoning`/`input`/`cost`/`contextWindow`/
  `maxTokens` all have defaults.
- **Model selection**: `--provider <id> --model <id>` (or
  `--model <provider>/<id>`). The tests pass both explicitly so no saved
  default or catalog refresh can interfere.
- **Print mode**: `--print` (aka `-p`) processes the prompt argv and exits;
  assistant text goes to stdout, exit code 0 on success. `--mode json` /
  `--mode rpc` exist for structured output if scenarios need to parse tool
  calls or usage. Non-TTY stdout also implies print mode.
- **Offline**: `PI_OFFLINE=1` (or `--offline`) disables startup network
  operations (version check, dynamic model refresh). Static models.json
  providers are unaffected. Always set it — the suite must not depend on the
  network.
- **stdin must be `"ignore"`, not a pipe**: pi `--print` reads piped stdin as
  extra prompt input, so an always-open stdin pipe hangs the child forever.
  `runPiHeadless` uses `stdio: ["ignore", "pipe", "pipe"]`.
- **Rpc mode (`--mode rpc`) for a process that must stay up**: its commands
  are JSON lines on stdin (`{ id, type: "prompt", message }`, and the
  responses are JSON lines back), and closing stdin shuts the run down with
  exit code 0. `--print` is right for a run whose single turn IS the scenario;
  rpc mode is right whenever the process must outlive its turn — a delegation
  whose launch runs in the background (above), or a cancel that has to be
  delivered to a live session.
- **Tools**: default tool set is enabled in print mode, so scripted tool
  calls execute for real (the `read` tool takes `{ path }`); use
  `--no-tools` / `--tools` / `--exclude-tools` to control the allowlist.
  A scripted `cowboy_agent` call executes the real extension (above).
- **herdr panes inherit the SERVER's environment**, not the calling process's:
  a herdr server started by a test with `PI_CODING_AGENT_DIR` set gives every
  pane — and therefore every subagent `pi` — that agent dir, and herdr itself
  adds the pane's `HERDR_*` (`HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`,
  `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`). Verification inside this folder:
  `herdr-fake.ts` (`startFakeHerdr`) is built on exactly that, and the pane's
  `printenv` output is what pins it.
- **A named herdr session is a whole server**: `herdr --session <name> server`
  runs one headless (its socket under `~/.config/herdr/sessions/<name>/`; the
  startup banner goes to STDERR), `HERDR_SOCKET_PATH` aims a CLI call at it,
  `herdr workspace create` gives it the workspace a run is addressed as, and
  `herdr session stop|delete <name>` tears it — panes and subagent processes
  included — down again.
- **Cancelling an in-flight inference**: the TUI's Escape is the
  `app.interrupt` binding, whose handler aborts the streaming turn
  (`onEscape` → `restoreQueuedMessagesToEditor({ abort: true })` →
  `agent.abort()`, `dist/modes/interactive/interactive-mode.js`), and pi's own
  interactive mode stamps an aborted turn `"Operation aborted"` — the shape a
  user presses in a pane, and a shape the extension reports NO error for
  (nothing wrote an outcome; see the section above). A `--print` run has no
  keys, and **no signal gives that abort**: print mode registers
  SIGTERM/SIGHUP only, which dispose the runtime and exit 143/129
  (`dist/modes/print-mode.js`), and SIGINT is unhandled, so the process is
  killed by the signal with its turn still open — that killed-mid-turn shape
  is the process-level meaning of
  the ctrl+c the extension's own stop path injects into a pane
  (`herdr agent send-keys <agent> ctrl+c`). In that shape nothing reaches
  extension turn hooks and nothing is printed: no `turn_end`, no
  `stopReason` message, no stderr error, no orchestrator-facing report. A FAILED
  inference ends the same way as far as the parent is concerned: pi ends the turn
  with `stopReason: "error"` and the extension reports nothing — see
  _The delegated agent's first inference fails_ above.
