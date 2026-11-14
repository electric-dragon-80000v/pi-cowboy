/**
 * spawn-record.ts — the JSON-safe projection of an AgentSpawn, and the codec
 * that reads it back.
 *
 * A record is everything a spawn holds except the three fields of `execution`
 * that only mean something inside a live process: the completion promise, the
 * abort controller, and the spawning session's context. Every other member of
 * AgentSpawn is plain data — a tagged lifecycle union of numbers and strings,
 * worktree coordinates, a host address, run history — so the projection is
 * total and `spawnFromRecord` is its inverse.
 *
 * A record is untrusted input. Session files are hand-editable and may come
 * from another version, so `decodeJournalEntry` takes `unknown` and answers
 * `null` for anything it does not recognise instead of throwing.
 */

import * as path from "node:path";
import { z } from "zod";
import type { OrchestratorConfig } from "../orchestrators/types.js";
import type {
  AgentLifecycleState,
  AgentSpawn,
  AgentWorktree,
} from "../types.js";
import { SPAWN_ID_ALPHABET, SPAWN_ID_LENGTH } from "../spawn/spawn-id.js";
import type { AgentInvocation } from "./types.js";

/** One spawn as the session last saw it. Pure agent state: the clock is on the entry. */
export interface SpawnRecord {
  readonly v: 1;
  readonly id: string;
  readonly lifecycle: AgentLifecycleState;
  readonly display: SpawnRecordDisplay;
  readonly execution: SpawnRecordExecution;
}

/**
 * The spawn's display info as it travels: everything `AgentDisplayInfo` holds
 * except `toolCallId`, which is stamped after registration for the parent
 * transcript's call renderer and belongs to that session's rendering rather
 * than to the agent's state.
 */
export interface SpawnRecordDisplay {
  readonly type: string;
  readonly description: string;
  readonly taskSlug?: string;
  readonly orchestration: OrchestratorConfig;
  readonly invocation?: AgentInvocation;
  readonly worktree?: AgentWorktree;
}

/** A host address as it travels (`AgentHostRef`, with the open multiplexer id narrowed to a string). */
export interface SpawnRecordHostRef {
  readonly multiplexer: string;
  readonly name: string;
  readonly paneId: string;
  readonly tabId?: string;
  readonly workspaceId: string;
  readonly paneCreated: boolean;
}

/** One ended run as it travels (see `EndedRun`). */
export interface SpawnRecordEndedRun {
  readonly harness: string;
  readonly host: SpawnRecordHostRef;
  readonly cwd: string | null;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * The execution state that survives a process: where the run lives, where its
 * predecessors lived, and the pools it was charged.
 */
export interface SpawnRecordExecution {
  readonly host?: SpawnRecordHostRef;
  readonly harness?: string;
  /**
   * The "<provider>/<modelId>" key the run's model pool was taken from — the one
   * launch parameter that is not recoverable from the spawn, and the difference
   * between an attached run charging its real model pool and charging only the
   * harness and global ones.
   */
  readonly modelKey?: string;
  readonly history: readonly SpawnRecordEndedRun[];
}

/**
 * What one journal append carries. `at` rides the envelope for both kinds, so a
 * record is only ever agent state and nothing has to strip a clock before comparing
 * two records for equality.
 */
export type SpawnJournalEntry =
  | {
      readonly v: 1;
      readonly kind: "spawn";
      readonly at: number;
      readonly record: SpawnRecord;
    }
  | {
      readonly v: 1;
      readonly kind: "forgotten";
      readonly spawnId: string;
      readonly at: number;
    };

/** One lifecycle, copied: its `launch` is the only nested object an arm carries. */
function copyLifecycle(lifecycle: AgentLifecycleState): AgentLifecycleState {
  return "launch" in lifecycle && lifecycle.launch !== undefined
    ? { ...lifecycle, launch: { ...lifecycle.launch } }
    : { ...lifecycle };
}

/**
 * The projection of one spawn, as of `at`.
 *
 * Every value is copied, never referenced: the entry handed to `appendEntry` is
 * serialised by pi later (synchronously today, `appendFileSync(JSON.stringify(…))`),
 * and a spawn is mutated in place between polls. Copying means a record states what
 * the spawn was when it was taken, whether or not the writer still holds the same
 * objects — and does not depend on pi serialising before the next mutation.
 */
export function encodeSpawnRecord(spawn: AgentSpawn): SpawnRecord {
  const display: SpawnRecordDisplay = {
    type: spawn.display.type,
    description: spawn.display.description,
    ...(spawn.display.taskSlug === undefined
      ? {}
      : { taskSlug: spawn.display.taskSlug }),
    orchestration: copyOrchestration(spawn.display.orchestration),
    ...(spawn.display.invocation === undefined
      ? {}
      : { invocation: { ...spawn.display.invocation } }),
    ...(spawn.display.worktree === undefined
      ? {}
      : { worktree: { ...spawn.display.worktree } }),
  };
  const host = spawn.execution.host;
  return {
    v: 1,
    id: spawn.id,
    lifecycle: copyLifecycle(spawn.lifecycle),
    display,
    execution: {
      ...(host === undefined ? {} : { host: { ...host } }),
      ...(spawn.execution.harness === undefined
        ? {}
        : { harness: spawn.execution.harness }),
      ...(spawn.execution.modelKey === undefined
        ? {}
        : { modelKey: spawn.execution.modelKey }),
      history: spawn.execution.history.map((run) => ({
        harness: run.harness,
        host: { ...run.host },
        cwd: run.cwd,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      })),
    },
  };
}

/** One orchestration template, copied: its cue map is the only nested object a record holds. */
function copyOrchestration(
  orchestration: OrchestratorConfig,
): OrchestratorConfig {
  return {
    name: orchestration.name,
    ...(orchestration.displayName === undefined
      ? {}
      : { displayName: orchestration.displayName }),
    cues: {
      spawned: orchestration.cues.spawned,
      queued: orchestration.cues.queued,
      settled: orchestration.cues.settled,
    },
    guidance: orchestration.guidance,
  };
}

/** The tombstone one drop leaves behind, so a reload does not resurrect the spawn. */
export function encodeForget(spawnId: string, at: number): SpawnJournalEntry {
  return { v: 1, kind: "forgotten", spawnId, at };
}

/**
 * Rebuild a live spawn from its record. The three fields that cannot travel
 * are minted here: the promise is already settled (a restored run has no
 * waiter), the controller is fresh and un-aborted, and the spawning context is
 * absent so a nudge falls back to its primary delivery.
 */
export function spawnFromRecord(record: SpawnRecord): AgentSpawn {
  const host = record.execution.host;
  return {
    id: record.id,
    lifecycle: record.lifecycle,
    display: {
      type: record.display.type,
      description: record.display.description,
      orchestration: record.display.orchestration,
      ...(record.display.taskSlug === undefined
        ? {}
        : { taskSlug: record.display.taskSlug }),
      ...(record.display.invocation === undefined
        ? {}
        : { invocation: record.display.invocation }),
      ...(record.display.worktree === undefined
        ? {}
        : { worktree: record.display.worktree }),
    },
    execution: {
      promise: Promise.resolve(""),
      abortController: new AbortController(),
      history: record.execution.history.map((run) => ({
        ...run,
        host: { ...run.host },
      })),
      ...(host === undefined ? {} : { host: { ...host } }),
      ...(record.execution.harness === undefined
        ? {}
        : { harness: record.execution.harness }),
      ...(record.execution.modelKey === undefined
        ? {}
        : { modelKey: record.execution.modelKey }),
    },
  };
}

/* ── Decoding ──────────────────────────────────────────────────────────── */

/**
 * A spawn id as the journal will accept one. The same alphabet and length
 * `spawn-id.ts` mints, so an id read back from a hand-edited file can never name
 * something the minting rules would not produce — it reaches a pane address, a
 * branch name, and a directory path.
 */
const SpawnIdSchema = z
  .string()
  .regex(
    new RegExp(`^[${SPAWN_ID_ALPHABET}]{${SPAWN_ID_LENGTH}}$`),
    "not a spawn id",
  );

/**
 * A path a record may hand back to the extension. An absolute path is required —
 * every path the extension produces is absolute — and `..` segments are refused,
 * so an edited record cannot walk out of the directory it claims to be in. A
 * local attacker who can edit the session file already runs as this user; this
 * keeps a mistaken or malicious record from aiming the extension's own reads and
 * removals somewhere it was never pointed.
 */
const SafePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "not an absolute path")
  .refine(
    (value) => !value.split(path.sep).includes(".."),
    "a path may not traverse upwards",
  );

const LaunchSchema = z.object({ resultFile: SafePathSchema });

const RetentionSchema = z.union([
  z.object({ kind: z.literal("dirty") }),
  z.object({ kind: z.literal("unverifiable"), detail: z.string() }),
]);

const StopSchema = z.object({ initiator: z.enum(["user", "agent"]) });

const LifecycleSchema: z.ZodType<AgentLifecycleState> = z.union([
  z.object({ phase: z.literal("queued"), queuedAt: z.number() }),
  z.object({
    phase: z.literal("spawned"),
    startedAt: z.number(),
    launch: LaunchSchema.optional(),
  }),
  z.object({
    phase: z.literal("settled"),
    startedAt: z.number(),
    launch: LaunchSchema.optional(),
    worktreeRetentionReason: RetentionSchema.optional(),
    status: z.literal("completed"),
    result: z.string(),
    completedAt: z.number(),
  }),
  z.object({
    phase: z.literal("settled"),
    startedAt: z.number(),
    launch: LaunchSchema.optional(),
    worktreeRetentionReason: RetentionSchema.optional(),
    status: z.literal("error"),
    error: z.string(),
    completedAt: z.number(),
  }),
  z.object({
    phase: z.literal("settled"),
    startedAt: z.number(),
    launch: LaunchSchema.optional(),
    worktreeRetentionReason: RetentionSchema.optional(),
    status: z.literal("stopped"),
    completedAt: z.number(),
    stop: StopSchema,
  }),
  z.object({
    phase: z.literal("never-started"),
    queuedAt: z.number(),
    worktreeRetentionReason: RetentionSchema.optional(),
    status: z.literal("error"),
    error: z.string(),
    completedAt: z.number(),
  }),
  z.object({
    phase: z.literal("never-started"),
    queuedAt: z.number(),
    worktreeRetentionReason: RetentionSchema.optional(),
    status: z.literal("stopped"),
    completedAt: z.number(),
    stop: StopSchema,
  }),
]);

const HostRefSchema = z.object({
  multiplexer: z.string().min(1),
  name: z.string(),
  paneId: z.string().min(1),
  tabId: z.string().optional(),
  workspaceId: z.string(),
  paneCreated: z.boolean(),
});

const EndedRunSchema = z.object({
  harness: z.string().min(1),
  host: HostRefSchema,
  cwd: z.string().nullable(),
  sessionId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
});

const WorktreeSchema = z.object({
  kind: z.enum(["owned", "picked"]),
  path: SafePathSchema,
  branch: z.string(),
});

const InvocationSchema = z.object({
  modelName: z.string().optional(),
  thinkingLevel: z.string().optional(),
  runInBackground: z.boolean().optional(),
  fork: z.boolean().optional(),
});

const CuesSchema = z.object({
  spawned: z.string(),
  queued: z.string(),
  settled: z.string(),
});

const OrchestrationSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  cues: CuesSchema,
  guidance: z.string(),
});

const RecordSchema: z.ZodType<SpawnRecord> = z.object({
  v: z.literal(1),
  id: SpawnIdSchema,
  lifecycle: LifecycleSchema,
  display: z.object({
    type: z.string(),
    description: z.string(),
    taskSlug: z.string().optional(),
    orchestration: OrchestrationSchema,
    invocation: InvocationSchema.optional(),
    worktree: WorktreeSchema.optional(),
  }),
  execution: z.object({
    host: HostRefSchema.optional(),
    harness: z.string().min(1).optional(),
    modelKey: z.string().min(1).optional(),
    history: z.array(EndedRunSchema),
  }),
});

const JournalEntrySchema: z.ZodType<SpawnJournalEntry> = z.union([
  z.object({
    v: z.literal(1),
    kind: z.literal("spawn"),
    at: z.number(),
    record: RecordSchema,
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("forgotten"),
    spawnId: SpawnIdSchema,
    at: z.number(),
  }),
]);

/**
 * One journal entry from untrusted data, or `null` when it is not one — a
 * different version, another extension's custom entry, or a corrupted line.
 */
export function decodeJournalEntry(data: unknown): SpawnJournalEntry | null {
  const parsed = JournalEntrySchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
