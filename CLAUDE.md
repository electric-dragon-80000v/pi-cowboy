# CLAUDE.md

## Project Overview

`pi-cowboy` is a Pi extension that runs agents as independent `pi` processes inside background `herdr` panes with copy-on-write (CoW) git worktrees.

## Essential Commands

```bash
pnpm run typecheck              # tsc6 --noEmit (must pass cleanly)
pnpm test                       # vitest run — the FULL suite (unit + both integration projects)
pnpm run test:unit              # vitest run --project unit (fast, hermetic; the pre-commit gate)
pnpm run test:integration       # both integration projects (real git, real `pi` processes)
pnpm run test:integration-no-cow # the filesystem-independent integration tests
pnpm run test:integration-cow   # the copy-on-write tests (need a clone-capable volume)
pnpm run format:check           # prettier check
pnpm run format                 # prettier write
```

Dependencies are managed with pnpm, pinned by `packageManager` in `package.json`. pnpm runs npm's built-in lifecycle scripts (`prepare`, `prepack`, `postpack`) but not user-defined `prefoo`/`postfoo` hooks, so a script that needs a step to run first names it inline — `test` builds before `vitest run` rather than relying on a `pretest` hook.

## Core Architectural Invariants

- **Herdr Environment**: Extension operates only when `HERDR_ENV=1`. Pane IDs are durable herdr targets; custom agent names are cosmetic.
- **Copy-on-Write Worktrees**: A worktree's working tree is materialized by the `WorktreeMaterialization` strategy (`agent.worktreeMaterialization`, default `"copy-on-write"`). Copy-on-write clones the parent working tree through the Node materializer (`src/infrastructure/git/cow-clone.ts`, which calls `clonefile(2)` through an embedded `python3` snippet on macOS and `cp --reflink=always -R` on Linux); `checkout` leaves git's classic checkout in place. Copy-on-write is an optimization, not a requirement: the worktree volume is probed at launch (`src/spawn/cow-support.ts`), and where it cannot clone every spawn falls back to `checkout` and the setting offers `checkout` alone. A spawn that still meets an unclonable volume mid-run falls back again (`CowCloneMaterializer.fallbackToCheckout`), so a clone never degrades to a silent byte copy. The strategy drives both the `git worktree add` arguments and the materialization step—no other code branches on it. A separate `WorktreeCheckoutType` policy (`agent.worktreeCheckoutType`, default `"clean"`, overridable per agent template) drives the materialization's dirty-parent branch under both strategies: a clean parent is materialized as HEAD; under `"dirty"` a dirty parent's **tracked** changes are carried (`copy-on-write` also clones its untracked files whole, `checkout` applies the parent's tracked diff on top of git's checkout), while under `"clean"` copy-on-write gets tracked-files-from-HEAD plus CoW-seeded ignored state and `checkout` applies nothing (untracked and ignored state is never carried under `checkout`).
- **One Agent Per Task**: Exactly one live agent per `taskSlug` across the in-memory spawn store and the herdr pane registry.
- **Composition Root (`src/shell.ts`)**: State lives in per-session shell getters/setters. No mutable module-level globals.
- **Test Projects**: The suite is split by FILE NAME, not by a list. `vitest.config.ts` declares three projects: `unit` takes every `*.test.ts` file except the integration ones; `integration-no-cow` takes every `*.integration.test.ts` file except the `*.cow.integration.test.ts` ones and runs on any filesystem; `integration-cow` takes exactly the `*.cow.integration.test.ts` files and runs only where the volume really clones (btrfs in CI). A test that needs real git repositories, real `pi` processes/panes, or a real localhost server is named `*.integration.test.ts`; a test that additionally asserts a real copy-on-write clone must live in a `*.cow.integration.test.ts` file. A bare `vitest run` runs all three; `pnpm run test:integration` runs both integration projects.
- **Worktree Retention**: Never auto-delete a worktree that holds uncommitted changes (`dirty`) or commits that are unmerged into `HEAD`. Always state the retention reason.

## Architecture

The extension is layered, with contracts in one place and implementations behind them:

- **Infrastructure seams (`src/infrastructure/herdr-client.ts`, `src/infrastructure/git-client.ts`)** — the HOW of shelling out, exposed as canonical direct functions. `herdr-client.ts` wraps the `herdr` CLI (pane/agent/worktree commands, `findTaskAttempts`); `git-client.ts` wraps `git`/`sh` (CoW clone, worktree cleanup, branch removal, merge). Both run through `pi.exec` so children inherit the parent session's environment. `src/infrastructure/herdr/agent-stopper.ts` owns the stop-and-wait routine (`HerdrAgentStopper` / `stopAgentAndWait`): it interrupts the agent best-effort, then confirms herdr's registry no longer lists it before reporting the stop done. Structural contracts for the supervisor, IPC, and task registry live beside their surviving implementations.
- **Subagent layers (`src/subagent/ipc.ts`, `src/subagent/supervisor.ts`)** — `SubagentIPC` is the parent↔agent message plane (briefing file, deliverable, steer); `ProcessSupervisor` owns one agent process's lifecycle in a pane (start/watch/stop, settlement confirmation, outcome mapping).
- **Spawn entities (`src/spawn/`)** — `spawn-id.ts` owns the one spawn identity (8 Crockford base32 chars, minted unique against the shell-owned spawn store, never sliced for display); `herdr-launcher.ts` owns the orchestration-plane worktree create flow (`createWorktreeCheckout`); `worktree-policy.ts` owns branch/slug naming rules and the worktree materialization strategy. `sandbox.ts` provisions a spawn's environment (`AgentSandbox.allocate`: git create, then herdr adoption) from a `naming` union — generated from task slug + spawn id, or an explicit `cow-` name supplied by the spawn wizard's New-worktree flow (asked for after Spawn), which uses the same owned-worktree path as the tool. Worktree cleanup decisions live in pure `src/agents/cleanup-policy.ts`; its state-changing coordinator, `src/agents/agent-cleanup.ts`, exposes `createCleanup(...).removeWorktree` and `.cleanupAgent`. Shelling-out HOW remains in the infrastructure seams.
- **Task registry (`src/task-registry.ts`)** — the unified admission/execution-tracking layer implementing the `TaskRegistry` port: task dedup (`findTaskDedup`/`TaskDedup`/`TaskAlreadyInFlightError`) and independent concurrency level pools + FIFO queue + release. A spawn counts against every pool that applies to it — its model's, its provider's, and the global one. Admission is non-destructive: a duplicate is rejected and the live agent is never stopped, reclaimed, or otherwise terminated. It is shell-free: every external dependency (spawns, the herdr probe) is injected structurally via `TaskRegistryDeps`, so it runs against fakes in tests.
- **Spawn coordinator (`src/spawn/spawn-coordinator.ts`)** — the shell-bound spawn coordinator and nudge emitter. Delegates dedup/admission to the registry; keeps what the registry's shell-free design excludes: `TaskAlreadyInFlightError` conversion from `AdmissionResult` rejections, `spawnCtx` capture, background tracking, foreground awaiting, and completion nudging (schedule/batch/emit).
- **Agents layer (`src/agents/`)** — `agent-spawn-store.ts` is the shell-owned canonical `AgentSpawn` store (registered at creation, dropped only by explicit Clear/cleanup, and the id-uniqueness authority); `subagent-session.ts` owns one spawn's phases, completion gate, parent binding, launch, kill protocol, ledger, and settlement; `agent-manager.ts` is the fleet controller for the shared registry, launch guard, and cleanup adapters. `tool-execution.ts` is the Agent tool execute handler and directly composes worktree/cleanup infrastructure; `spawn-defaults.ts` owns the configured `defaultAgentType` / `defaultOrchestrator` resolution for omitted tool params (read at call time), degrading to the code fallbacks (`general-purpose` / `default`) when a persisted value no longer resolves.

Data flow for a `cowboy_agent` call: tool-execution validates → direct git/herdr functions resolve the worktree → spawn-coordinator admits through the registry (dedup + concurrency; a duplicate slug is rejected without touching the live agent) and returns the spawn → the manager creates a per-spawn `SubagentSession`, which provisions a pane and binds its `ProcessSupervisorEngine` → its terminal outcome settles the spawn and fires `onComplete`, which the coordinator turns into a nudge message.

## TypeScript Standards

### 1. State Representation

- **Represent valid states only**: Never model mutually dependent state with independent optional fields (`result?: string; error?: string`).
- **Use discriminated unions**: Use tagged unions with explicit `kind` or `status` tags for lifecycles, deduplication results, and spawn lifecycles.
- **Enforce mutual exclusivity in types**: Do not rely on runtime comments for mutually exclusive properties (e.g., `tools` vs `excludeTools`); use XOR or separate union variants.

### 2. Type Boundaries & `any`

- **Zero `any` returns**: Tool handlers and API boundaries must return typed results (`Promise<ToolResult>`), never `Promise<any>`.
- **Use `unknown` for untrusted inputs**: CLI outputs, JSON parsing, and external parameters start as `unknown` and narrow via type guards.
- **Avoid imprecise downcasts**: Do not cast domain types down to `string` (e.g., keep `AgentStatus` and `StopInitiator` instead of widening to `string`).

### 3. Sentinels & Distinct Types

- **No in-band magic values**: Do not use `0` to mean `"auto"` or `"disabled"`. Use explicit union types (`number | 'auto'`, `number | null`).
- **No magic string sentinels**: Avoid strings like `"(inherits parent)"` where `null` or a dedicated union member accurately models intent.

### 4. Pragmatism & Maintenance

- **Sever external dependencies structurally**: Use minimal structural interfaces (`SessionLike`, `NavigableList<T>`) instead of importing large external types or using `any`.

## Make invalid states unrepresentable

Make sure invalid states are always unrepresentable. A caller should not have to remember which combinations are legal, and a reader should not have to check whether they were respected. The representation itself should make the illegal combinations impossible to write.

Each of the following is a defect to fix, not an example to follow. In every case, give each legal case its own shape so the compiler rejects the rest.

**Optional parameters.** A parameter is only valid when another parameter is present.

```ts
// Defect — the signature lets a caller pass cc with any kind of email.
sendEmail(to, body, cc?)
// cc is only valid for certain kinds of emails
```

```ts
// Fix — each kind of email carries exactly the fields it needs.
type Email =
  | { kind: "plain"; to: string; body: string }
  | { kind: "copied"; to: string; body: string; cc: string };

sendEmail(email: Email)
```

**Boolean / mode flags.** A flag changes which other arguments are meaningful.

```ts
// Defect — isHtml changes the meaning of body, and the call site
// cannot say what "true" means.
sendEmail(to, body, isHtml);
// Different states now have different semantics.
```

```ts
// Fix — each mode is its own shape.
type Email =
  | { kind: "plain"; to: string; body: string }
  | { kind: "html"; to: string; body: string };

sendEmail(email: Email)
```

**Nullable fields.** `null` represents a state that shouldn't exist.

```ts
// Defect — null claims a User might have no email, but the domain
// has no such state.
type User = { email: string | null };
// Can a User without an email actually exist?
```

```ts
// Fix — the email is required, and the case that had none gets a name.
type User =
  | { kind: "registered"; email: string }
  | { kind: "guest"; reason: "anonymous" | "pending" };
```

## Commenting

Write comments about the code as it is now. They are not a record of what you did. Do not describe the change you are making, the step you are taking, the file you moved something out of, or why the code is arranged this way because of an edit you performed — that is your work, not the code's meaning, and it belongs in the commit message. If a comment only makes sense to someone who watched the change happen, delete it.

Keep a comment only when it tells a reader who never saw the change something they cannot read from the code itself: a constraint, a hack and what it works around, or the reason a decision is not the obvious one. Restating what a name or a signature already says, describing what the next line does, and narrating a step are all the same mistake, and they are what makes the comments that matter hard to find. When you trim, change nothing but comments, and read the diff to confirm it. If you cannot tell what a comment is for, leave it and ask.
