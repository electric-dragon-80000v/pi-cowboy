/**
 * harness.ts — the harness contract: which process launches a subagent, and how.
 *
 * A harness owns five things: the mux agent kind its process launches as
 * (`agentMuxKind`), bringing its host pane into the state it launches in
 * (`prepare`), the argv the pane runs (`buildArgs`), undoing any state it
 * left on the filesystem (`teardown`), and warming a slow model list at boot
 * (`prefetchModels`). What every harness family has in common
 * lives here as `SubagentLaunchInputs`; what one family alone uses (pi's CLI
 * flags, opencode's variant) lives beside it as that family's inputs, so a
 * second family adds a request member — never an optional field, a passthrough
 * schema, or a raw config record on a shared type. One request carries one
 * family's launch, and both `buildArgs` and `prepare` read it, so nothing a
 * harness is handed belongs to a family it does not launch. The listing request
 * below (`HarnessListModelsRequest`) is the one shared request that breaks that
 * shape, because one call answers for every runnable harness at once: a
 * family's own input rides it as a field named after that family, never as a
 * member a caller has to pick. Each harness's
 * implementation lives beside this module (harness/pig.ts,
 * harness/pi-bolt.ts, harness/opencode/index.ts) and is selected through
 * harness/registry.ts.
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
 * `HarnessLaunchRequest` and a strict `[harness.<family>]` table for its own
 * slice of the template (never passthrough; parsed options are typed and merged
 * per field like every other template field). That member is the whole of what
 * the family's `buildArgs` and `prepare` read, so the fields arrive with their
 * first reader, never before.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAvailable, isProven, type Availability } from "../availability.js";
import type { AgentMuxKind } from "./agent-host.js";

/**
 * Every selectable harness. The `harness_type` enum and `HarnessId` derive from this.
 *
 * `opencode` runs a binary of its own rather than pi: it is probed like every
 * other harness and shows up wherever its binary is on PATH, and its own
 * implementation stages the agent definition its launch reads.
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

/** One of the pi family's ids (see PI_FAMILY_HARNESS_IDS). */
export type PiFamilyHarnessId = (typeof PI_FAMILY_HARNESS_IDS)[number];

/**
 * A harness that runs a binary of its own rather than pi: its model keys name
 * its own catalogue, so this session's pi catalog can never answer for one.
 */
export type ForeignHarnessId = Exclude<HarnessId, PiFamilyHarnessId>;

/**
 * Whether this harness runs the pi binary (see PI_FAMILY_HARNESS_IDS). Narrowing,
 * so the branch that builds the pi family's launch request is typed against a
 * pi-family harness.
 */
export function isPiFamilyHarness(id: HarnessId): id is PiFamilyHarnessId {
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

/** opencode CLI specifics; no other harness family reads these. */
export interface OpencodeLaunchInputs {
  /**
   * `null` = no variant was requested. `--variant` exists on `opencode run`,
   * which pi-cowboy does not launch, so the variant reaches the CLI only through
   * the agent definition this harness prepares.
   */
  readonly variant: string | null;
}

/**
 * The launch-request families: the pi family (pi, pig, pi-bolt) and opencode.
 * Filtered from the mux's kinds rather than re-declared, so the two vocabularies
 * cannot drift apart; each member of `HarnessLaunchRequest` carries one as its
 * `family` tag.
 */
export type HarnessFamily = Extract<AgentMuxKind, "pi" | "opencode">;

/** The family tag one launch request carries; the tag alone selects the member. */
interface HarnessFamilyTag<F extends HarnessFamily> {
  readonly family: F;
}

/** pi's argv request: the shared launch inputs plus pi's own CLI flags. */
export type PiFamilyLaunchRequest = HarnessFamilyTag<"pi"> &
  SubagentLaunchInputs &
  PiLaunchInputs;

/**
 * opencode's argv request: the shared launch inputs plus opencode's own CLI
 * specifics.
 */
export type OpencodeLaunchRequest = HarnessFamilyTag<"opencode"> &
  SubagentLaunchInputs &
  OpencodeLaunchInputs;

/**
 * The launch request, keyed by family: pi's flags are what a `"pi"` request is,
 * so they cannot ride to a harness that never mapped them. One is built per
 * launch, and both `buildArgs` and `prepare` read that same object. A new family
 * adds a member — never an optional field on an existing member.
 */
export type HarnessLaunchRequest =
  PiFamilyLaunchRequest | OpencodeLaunchRequest;

/**
 * The launch request one harness id reads: the argv it builds and the pane
 * state it prepares. Keyed by id, so a harness added to `HARNESS_IDS` without a
 * request fails to compile; the pi family shares one member because they all
 * run the pi binary.
 */
export type LaunchRequestFor<K extends HarnessId> = {
  pi: PiFamilyLaunchRequest;
  pig: PiFamilyLaunchRequest;
  "pi-bolt": PiFamilyLaunchRequest;
  opencode: OpencodeLaunchRequest;
}[K];

/** What a harness needs to bring its host pane into the state it launches in. */
export interface HarnessPrepareRequest<K extends HarnessId = HarnessId> {
  readonly pi: ExtensionAPI;
  readonly paneId: string;
  readonly cwd: string;
  /**
   * The launch this pane is prepared for: the task file the pane must read, the
   * system prompt file, the subagent id a launcher names itself after — the same
   * request `buildArgs` was given, so this family's own inputs reach this
   * family's harness and no other's.
   */
  readonly launch: LaunchRequestFor<K>;
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
export interface Harness<K extends HarnessId = HarnessId> {
  readonly id: HarnessId;
  /**
   * The agent kind this harness launches as, in the mux's vocabulary; the only
   * place a kind appears as a literal. A harness whose binary is not pi's can
   * only launch under its own kind, because the mux matches the detected process
   * against it.
   */
  readonly agentMuxKind: AgentMuxKind;
  /**
   * Whether this machine can launch the harness, read at probe time. False keeps
   * the harness out of the setting, and a template that still names it falls back
   * to pi instead of opening a pane that could never run it.
   */
  available(): boolean;
  /**
   * Bring the pane into the state this harness launches in, for the launch this
   * family's own request describes. Idempotent; throws when the state could not
   * be established.
   */
  prepare(request: HarnessPrepareRequest<K>): Promise<void>;
  /**
   * The complete argv the pane runs, including how the task rides (the pi
   * family ends with `@<taskFile>`). Pure: no shellouts, no filesystem writes.
   * Typed to this harness's own family, so one family's flags cannot reach
   * another's buildArgs.
   */
  buildArgs(request: LaunchRequestFor<K>): string[];
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
   * when the spawn wizard opens. The pi family reads its catalog live on every
   * call. opencode answers from its memoized fetch, so the boot warm and every
   * menu select share one CLI run; an empty answer is never retained, so a
   * failed list retries on the next read instead of pinning an empty row.
   */
  listModels(request: HarnessListModelsRequest): Promise<readonly ModelEntry[]>;
  /**
   * Warm the model list in the background at boot. Required, with an explicit
   * no-op for a harness whose list is cheap — a harness that needs warming
   * but forgets this compiles loudly missing, never silently cold.
   * Fire-and-forget, so a slow channel never blocks the launch.
   */
  prefetchModels(pi: ExtensionAPI): void;
}
