/**
 * harness/codex-session-schema.ts — the shapes of codex's own session store,
 * one zod schema per thing a reader has to tell apart.
 *
 * This module is the only authority on what a rollout line is. A line that
 * validates as a turn carries the prose the handover exports; a `compacted`
 * line carries the summary codex wrote when it condensed the session; a
 * reasoning payload is the model's thinking and a tool payload a tool call or
 * its result; a line that validates as store traffic — session metadata, token
 * counts, turn state — has no canonical kind and is `other`, named by its
 * native type; a line no arm accepts is a record the reader could not read,
 * which the shared handover layer counts as loss.
 *
 * A rollout's first line is read through its own schema, because the cwd lookup
 * must not refuse a whole file over a mark it does not know.
 *
 * Which names are enumerated and which are left open follows the store rather
 * than the CLI's source. Record types, payload types and part types are codex's
 * to add, so an unread one is `other`, never a loss — while the shapes this
 * reader interprets for itself are pinned: the `compacted` record, the roles
 * whose message is the conversation, and the part types a turn's prose is
 * written as.
 *
 * The arms of the line union exclude one another, so a record of an interpreted
 * shape that does not hold up — a message whose content is not parts, a turn
 * whose prose is not a string, a line that is not a record at all — is accepted
 * by no arm and surfaces as loss. `otherThan` writes that exclusion, and
 * without it a damaged turn would validate as traffic and vanish from the count.
 */

import { z } from "zod";

/**
 * The roles whose message is the conversation. Every other role codex writes —
 * `developer` and `system` today, whatever it adds later — is the harness's own
 * content or material on the user's behalf, never a turn: traffic rather than a
 * record the reader failed to read.
 */
const TURN_ROLES = ["user", "assistant"] as const;

/** The part types a turn's prose is written as. */
const PROSE_PART_TYPES = ["input_text", "output_text"] as const;

/** The payload type of the `response_item` that is a message. */
const MESSAGE_PAYLOAD = "message";

/** The payload type of the `response_item` that carries the model's reasoning. */
const REASONING_PAYLOAD = "reasoning";

/** The payload types of codex's tool calls and their results. */
const TOOL_PAYLOAD_TYPES = [
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "local_shell_call_output",
] as const;

/** Every payload type an arm below interprets for itself. */
const CLAIMED_PAYLOAD_TYPES = [
  MESSAGE_PAYLOAD,
  REASONING_PAYLOAD,
  ...TOOL_PAYLOAD_TYPES,
] as const;

/** The `response_item` record type whose payloads this reader interprets. */
const RESPONSE_ITEM_RECORD_TYPE = "response_item";

/**
 * The record codex writes when it replaces the history so far with a summary.
 * Its payload's `message` is that summary. The `context_compacted` event is a
 * notification that a compaction happened, not the compaction itself.
 */
const COMPACTED_RECORD_TYPE = "compacted";

/**
 * A string that is not one of the values an arm above already claims.
 *
 * zod tries the arms of a union in order, so every arm that reads codex's own
 * traffic has to stand aside from the shapes this reader interprets for itself.
 * Without that, a damaged turn — a message whose content is not parts — would
 * be accepted as traffic and disappear, and the shared layer would hand the
 * next run a session that lost a turn it never reported.
 */
function otherThan(claimed: readonly string[]) {
  return z
    .string()
    .refine(
      (value) => !claimed.includes(value),
      `not one of: ${claimed.join(", ")}`,
    );
}

/**
 * The first line of a rollout, as the lookup reads it. Only `session_meta` is
 * a candidate: every file starts with one. `id` must survive trimming, and a
 * file without it cannot name a session to resume, so it is no candidate.
 * `thread_source` is the mark a subagent rollout carries, and the lookup reads
 * it as the raw value codex wrote: a mark this schema does not know leaves the
 * file a candidate rather than refusing to read it.
 */
export const SessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().trim().min(1),
    cwd: z.string().min(1),
    thread_source: z.unknown().optional(),
  }),
});

/**
 * A content part that carries prose: one of the two part types a turn's text is
 * written as, holding its text as a string. A part of that type whose text did
 * not survive is not a readable part, so the message holding it cannot be read.
 */
const ProsePartSchema = z
  .object({ type: z.enum(PROSE_PART_TYPES), text: z.string() })
  .transform((part) => ({
    kind: "prose" as const,
    type: part.type,
    text: part.text,
  }));

/** A part that carries no prose — an attached image — and is dropped. */
const AttachmentPartSchema = z
  .object({ type: otherThan(PROSE_PART_TYPES) })
  .transform(() => ({ kind: "attachment" as const }));

/** A message's content: its parts in order, or a record this reader refuses. */
const MessageContentSchema = z.array(
  z.union([ProsePartSchema, AttachmentPartSchema]),
);

/** A `response_item` message in a role this reader exports: a turn. */
const ResponseItemTurnSchema = z
  .object({
    type: z.literal("response_item"),
    payload: z.object({
      type: z.literal(MESSAGE_PAYLOAD),
      role: z.enum(TURN_ROLES),
      content: MessageContentSchema,
    }),
  })
  .transform((record) => ({
    kind: "turn" as const,
    role: record.payload.role,
    parts: record.payload.content,
  }));

/**
 * A `response_item` carrying the model's own reasoning. The text lives in
 * `summary` (and, when it survives, `content`), which the reader understands
 * in either the plaintext or the block form codex writes.
 */
const ReasoningSchema = z
  .object({
    type: z.literal("response_item"),
    payload: z
      .object({
        type: z.literal(REASONING_PAYLOAD),
        summary: z.unknown().optional(),
        content: z.unknown().optional(),
      })
      .passthrough(),
  })
  .transform((record) => ({
    kind: "reasoning" as const,
    payload: record.payload,
  }));

/**
 * A `response_item` carrying a tool call or its result. The payload is kept
 * whole: its fields are the tool exchange itself, not prose this reader can
 * pick apart.
 */
const ToolCallSchema = z
  .object({
    type: z.literal("response_item"),
    payload: z.object({ type: z.enum(TOOL_PAYLOAD_TYPES) }).passthrough(),
  })
  .transform((record) => ({
    kind: "tool" as const,
    nativeType: record.payload.type,
    payload: record.payload,
  }));

/**
 * A `response_item` this reader does not read as a turn: codex's own payload —
 * inter-agent messages, task state — or a message in a role it leaves to
 * codex. Payload types are codex's to add, so any type no arm above claims is
 * `other`, named by that native type.
 */
const ResponseItemOtherSchema = z
  .object({
    type: z.literal("response_item"),
    payload: z.union([
      z.object({
        type: z.literal(MESSAGE_PAYLOAD),
        role: otherThan(TURN_ROLES),
      }),
      z.object({ type: otherThan(CLAIMED_PAYLOAD_TYPES) }),
    ]),
  })
  .transform((record) => ({
    kind: "other" as const,
    nativeType: record.payload.type,
  }));

/**
 * A `compacted` record: the summary codex wrote in place of the history it
 * condensed. `message` is the summary text; a compaction codex performed
 * without a plaintext summary (the model-backed form stores it encrypted)
 * still carries the field, empty.
 */
const CompactedSchema = z
  .object({
    type: z.literal(COMPACTED_RECORD_TYPE),
    payload: z.object({ message: z.string() }),
  })
  .transform((record) => ({
    kind: "compacted" as const,
    summary: record.payload.message,
  }));

/**
 * Any other record codex writes: session metadata, turn context, world state,
 * the `event_msg` traffic of token counts and task state.
 */
const OtherLineSchema = z
  .object({
    type: otherThan([RESPONSE_ITEM_RECORD_TYPE, COMPACTED_RECORD_TYPE]),
  })
  .transform((record) => ({
    kind: "other" as const,
    nativeType: record.type,
  }));

/**
 * One rollout line, as this reader reads it: a turn, a compaction summary,
 * reasoning, a tool payload, or another native record.
 *
 * The arms claim the shapes this reader interprets, so a record of one of those
 * shapes that does not hold up — a compaction whose summary is not a string, a
 * message whose content is not parts, a turn whose prose is not a string, a
 * line that is not a record at all — is accepted by no arm, and the shared
 * layer counts it as loss rather than reading it as another native record. The
 * record types and payload types this reader does not claim are codex's own,
 * added over time: none of them is conversation, so an unread one is `other`
 * rather than a record the reader failed to read.
 */
export const RolloutLineSchema = z.union([
  ResponseItemTurnSchema,
  ReasoningSchema,
  ToolCallSchema,
  ResponseItemOtherSchema,
  CompactedSchema,
  OtherLineSchema,
]);

/** What one rollout line turned out to be. */
export type RolloutRecord = z.infer<typeof RolloutLineSchema>;

/** A turn: a `response_item` message in a role this reader exports. */
export type Turn = Extract<RolloutRecord, { kind: "turn" }>;
