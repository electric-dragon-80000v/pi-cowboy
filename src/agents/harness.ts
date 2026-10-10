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
 * implementation lives beside this module (harness/pig.ts, harness/pi-bolt.ts,
 * harness/opencode.ts) and is selected through harness/registry.ts.
 *
 * `HARNESS_IDS` stays the full vocabulary everywhere a value is read or written:
 * a template written where a harness exists must still load where it does not.
 * Which harnesses a machine can launch only narrows what the setting offers and
 * which harness a spawn ends up using.
 *
 * Model lists belong to the harness too (`listModels`): one interface method
 * answers "what can this harness run" for the pi family's catalog and for a
 * foreign CLI alike, so a settings menu enumerates harness rows instead of
 * knowing each family's source.
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
import { isAvailable, isProven, type Availability } from "../availability.js";

/**
 * Every selectable harness. The `harness_type` enum and `HarnessId` derive from this.
 *
 * `opencode` is detection-only: it is probed like every other harness and shows
 * up wherever its binary is on PATH, but it has no launch implementation, so
 * configuring it fails at launch rather than running an unmapped CLI.
 */
export const HARNESS_IDS = ["pi", "pig", "pi-bolt", "opencode"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/** A template that omits `harness_type` launches under pi. */
export const DEFAULT_HARNESS: HarnessId = "pi";

/**
 * The harnesses that run the pi binary behind the pane: one model catalog and
 * one default model serve the whole family, so pig and pi-bolt are configured
 * through pi's row rather than rows of their own.
 */
export const PI_FAMILY_HARNESS_IDS = ["pi", "pig", "pi-bolt"] as const;

/** Whether this harness runs the pi binary (see PI_FAMILY_HARNESS_IDS). */
export function isPiFamilyHarness(id: HarnessId): boolean {
  return PI_FAMILY_HARNESS_IDS.some((family) => family === id);
}

/** How a harness's own settings row is labeled. */
const HARNESS_DISPLAY_NAMES: Record<HarnessId, string> = {
  pi: "Pi",
  pig: "PiG",
  "pi-bolt": "Pi-Bolt",
  opencode: "OpenCode",
};

/** The display form of one harness, for the rows that configure it. */
export function harnessDisplayName(id: HarnessId): string {
  return HARNESS_DISPLAY_NAMES[id];
}

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

/**
 * The harnesses a spawn here can really use, in `HARNESS_IDS` order. pi runs the
 * pane it would launch in, so the family answers always; any other harness needs
 * the probe to have confirmed its binary, because only the binary itself can
 * list the models it runs.
 */
export function runnableHarnessIds(
  availability: Availability<HarnessId>,
): HarnessId[] {
  return HARNESS_IDS.filter(
    (id) => isPiFamilyHarness(id) || isProven(id, availability),
  );
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
 * only be redundant or wrong.
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

/**
 * One model a harness can run. `key` is the bare `"provider/model"` every layer
 * stores and every CLI flag carries; `label` is the optional display form a
 * picker shows in place of the key.
 */
export interface ModelEntry {
  readonly key: string;
  readonly label?: string;
}

/**
 * The slice of pi's model registry a harness reads to list what it can run:
 * which models are available, in the registry's own order. Structural, so the
 * harness layer never imports pi's registry type — and it is deliberately the
 * whole of what the pi family's list reads, nothing more.
 */
export interface ModelCatalog {
  getAvailable(): readonly { readonly provider: string; readonly id: string }[];
}

/**
 * What a harness's on-demand model list needs. The registry lives on the
 * extension context (`ctx.modelRegistry`) rather than on the `ExtensionAPI`, so
 * it is injected here instead of read from the shell.
 */
export interface HarnessListModelsRequest {
  readonly pi: ExtensionAPI;
  readonly modelCatalog: ModelCatalog;
}

/**
 * Lists the models one harness can run. Never throws: a list that could not be
 * produced is an empty one with a logged reason, so a menu always opens.
 */
export type HarnessListModels = (
  request: HarnessListModelsRequest,
) => Promise<readonly ModelEntry[]>;

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
  /**
   * The models this harness can run, listed on demand — when a menu opens, and
   * when the spawn wizard opens — rather than cached, because a catalog or a
   * foreign CLI can change under a live session.
   */
  listModels(request: HarnessListModelsRequest): Promise<readonly ModelEntry[]>;
}
