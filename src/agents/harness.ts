/**
 * harness.ts — the harness contract: which process launches a subagent, and how.
 *
 * A harness owns three things: bringing its host pane into the state it
 * launches in (`prepare`), the argv the pane runs (`buildArgs`), and undoing
 * any state it left on the filesystem (`teardown`). What every harness family
 * has in common lives here as `SubagentLaunchInputs`; what one family alone
 * uses (today, pi's CLI flags) lives beside it as that family's inputs, so a
 * second family adds a request member — never an optional field, a passthrough
 * schema, or a raw config record on a shared type. Each harness's
 * implementation lives beside this module (harness/pig.ts, harness/pi-bolt.ts)
 * and is selected through harness/registry.ts.
 *
 * `HARNESS_IDS` stays the full vocabulary everywhere a value is read or written:
 * a template written where a harness exists must still load where it does not.
 * Which harnesses a machine can launch only narrows what the setting offers and
 * which harness a spawn ends up using.
 *
 * Evolution rule: a new harness family is added by growing `HARNESS_IDS`, one
 * harness implementation, and — where that family needs them — a member on
 * `HarnessLaunchRequest` and a strict schema for its slice of the template's
 * `[harness]` table (a plain union of strict per-harness schemas, never
 * passthrough; parsed options are typed and merged per field like every other
 * template field). A family whose `prepare` needs launch context (a harness
 * that stages files before launch) widens `HarnessPrepareRequest` in the same
 * change — the fields arrive with their first reader, never before.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAvailable, type Availability } from "../availability.js";

/** Every selectable harness. The `harness_type` enum and `HarnessId` derive from this. */
export const HARNESS_IDS = ["pi", "pig", "pi-bolt"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/** A template that omits `harness_type` launches under pi. */
export const DEFAULT_HARNESS: HarnessId = "pi";

/** Narrow untrusted input (config, menu) to a canonical harness; invalid values fall back at the config boundary. */
export function parseHarnessId(value: unknown): HarnessId | undefined {
  return HARNESS_IDS.find((id): id is HarnessId => id === value);
}

/**
 * Which harness a spawn launches under. A harness this machine cannot launch
 * falls back to pi whatever the setting or the template says — the same answer
 * the setting itself is narrowed to, so the menu can never offer a harness a
 * spawn would not use, and an unavailable value never fails a spawn.
 */
export function resolveHarness(
  configured: HarnessId,
  availability: Availability<HarnessId>,
): HarnessId {
  return isAvailable(configured, availability) ? configured : DEFAULT_HARNESS;
}

/** How the child's tool set is chosen; `default` leaves the binary's own discovery untouched. */
export type ToolSelection =
  | { kind: "default" }
  | { kind: "none" }
  | { kind: "include"; names: string[] }
  | { kind: "exclude"; names: string[] };

/**
 * How extensions reach the child process. `default` leaves the child's own
 * discovery alone; an explicit list is resolved to sources and carried as
 * `paths`, because the child cannot re-resolve names itself.
 */
export type ExtensionLaunchMode =
  { kind: "default" } | { kind: "none" } | { kind: "paths"; paths: string[] };

/**
 * How the child gets its skills. `default` leaves the child's own discovery
 * alone; `none` suppresses it because the extension decided the agent's skills
 * itself (an explicit or inlined list rendered into the system prompt).
 */
export type SkillLaunchMode = { kind: "default" } | { kind: "none" };

/**
 * Launch inputs every harness family shares. All fields are required;
 * a value the run does not carry is a real state (`null` or a union member),
 * never an absent field. The subagent token is not among them: it is a pure
 * function of the subagent id (`subagentTokenFor`), so a harness derives it
 * rather than receives it — two fields where one derives from the other can
 * only ever be redundant or wrong.
 */
export interface SubagentLaunchInputs {
  readonly subagentId: string;
  /** Absolute path of the staged system prompt (multi-line text never crosses herdr's single-line shell encoder). */
  readonly systemPromptFile: string;
  /** Absolute path of the staged task; the harness decides how it rides the argv. */
  readonly taskFile: string;
  /** Absolute path of the file the child reports through. */
  readonly resultFile: string;
  /** `null` = no model override was requested. */
  readonly modelKey: string | null;
  readonly toolSelection: ToolSelection;
}

/** pi CLI specifics; no other harness family reads these. */
export interface PiLaunchInputs {
  /** `null` = no thinking override was requested. */
  readonly thinkingLevel: string | null;
  /** `null` = no fork — not requested, or requested with no parent session file (the orchestrator warns there). */
  readonly forkSessionFile: string | null;
  readonly skills: SkillLaunchMode;
  readonly extensions: ExtensionLaunchMode;
  readonly projectTrusted: boolean;
}

/**
 * The argv-building request. Today it has exactly one shape — the pi family's
 * — because every harness is pi-compatible; a second family adds a member
 * (a family-keyed union), never an optional field on this one.
 */
export type HarnessLaunchRequest = SubagentLaunchInputs & PiLaunchInputs;

/** What a harness needs to bring its host pane into the state it launches in. */
export interface HarnessPrepareRequest {
  readonly pi: ExtensionAPI;
  readonly paneId: string;
  readonly cwd: string;
}

/**
 * The run identity and address half of a teardown request. `paneId` is
 * `null` when the pane is already gone; `cwd` is `null` when no directory
 * address is known to the caller (a recovered run with no worktree).
 */
export interface HarnessTeardownContext {
  readonly paneId: string | null;
  readonly cwd: string | null;
  readonly subagentId: string;
}

/** The full teardown request: the context plus the pi instance a harness shells out through. */
export interface HarnessTeardownRequest extends HarnessTeardownContext {
  readonly pi: ExtensionAPI;
}

/** One harness implementation. */
export interface Harness {
  readonly id: HarnessId;
  /**
   * Whether this machine can launch the harness, read at probe time. False keeps
   * the harness out of the setting, and a template that still names it falls back
   * to pi instead of opening a pane that could never run it.
   */
  available(): boolean;
  /**
   * Bring the pane into the state this harness launches in. Idempotent;
   * throws when the state could not be established.
   */
  prepare(request: HarnessPrepareRequest): Promise<void>;
  /**
   * The complete argv the pane runs, including how the task rides (the pi
   * family ends with `@<taskFile>`). Pure: no shellouts, no filesystem writes.
   */
  buildArgs(request: HarnessLaunchRequest): string[];
  /**
   * Undo filesystem state this harness's prepare left behind. Best-effort and
   * idempotent: callers wrap it so a failure is logged and never masks the
   * error that led to it, and it must succeed when there is nothing to remove
   * (a launch that failed before prepare, or a run that never prepared).
   * Owned by the async cleanup plane, ordered before any worktree dirty
   * probe — never invoked from synchronous code.
   */
  teardown(request: HarnessTeardownRequest): Promise<void>;
}
