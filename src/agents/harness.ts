/**
 * harness.ts — the harness contract: which process launches a subagent, and how.
 *
 * A harness owns six things: the multiplexer agent kind its process launches as
 * (`agentMultiplexerKind`), bringing its host pane into the state it launches in
 * (`prepare`), the argv the pane runs (`buildArgs`), asking its process to exit
 * (`stop`), undoing any state it left on the filesystem (`teardown`), and
 * warming a slow model list at boot (`prefetchModels`). One `Harness<L>`
 * contract serves a built-in and a plugin; `L` is the launch type the
 * implementation reads. What every harness has in
 * common lives here as `SubagentLaunchInputs`; what one built-in family alone
 * uses (pi's fork, codex's project trust) lives beside it as that family's
 * inputs, so a second family adds a request member — never an optional field, a
 * passthrough schema, or a raw config record on a shared type. One request
 * carries one launch, and both `buildArgs` and `prepare` read it, so a built-in
 * is handed its family's request and a plugin is handed the shared inputs
 * alone. The listing request below (`HarnessListModelsRequest`) is
 * the one shared request that breaks that shape, because one call answers for
 * every runnable harness at once: a family's own input rides it as a field
 * named after that family, never as a member a caller has to pick. Each
 * harness's implementation lives beside this module (harness/pig.ts,
 * harness/pi-bolt.ts, harness/opencode/index.ts, harness/codex.ts,
 * harness/claude/index.ts) and is selected through harness/harness-registry.ts.
 *
 * `HARNESS_IDS` is the built-in vocabulary, and it stays whole wherever a value
 * is read or written: a template written for a built-in harness must still load
 * on a machine that cannot launch it — only its launch falls back to pi. A value
 * naming a plugin harness is a different case: it is legal because this
 * session's registry has that id, so an id no harness registered is reported
 * rather than downgraded (see agent-types.ts). Which harnesses a machine can
 * launch only narrows what the setting offers and which harness a spawn ends up
 * using.
 *
 * Model lists belong to the harness too (`listModels`): one interface method
 * answers "what can this harness run" for the pi family's catalog and for a
 * foreign CLI alike, so a settings menu enumerates harness rows instead of
 * knowing each family's source. Each entry carries the thinking levels that
 * model accepts, in the harness's own vocabulary, so a picker never has to
 * know how a family names its reasoning effort.
 *
 * Evolution rule: a new *built-in* harness family is added by growing
 * `HARNESS_IDS`, one harness implementation, and — where that family needs them
 * — a member on `BuiltinLaunchRequest` and a strict `[harness.<family>]` table
 * for its own slice of the template (never passthrough; parsed options are typed
 * and merged per field like every other template field). That member is the
 * whole of what the family's `buildArgs` and `prepare` read, so the fields
 * arrive with their first reader, never before.
 *
 * A *plugin* harness grows none of that: it registers a `PluginHarness` under
 * its own id (see harness/harness-registry.ts and plugin/contract.ts), so its id
 * is not in `HARNESS_IDS` and its CLI is not a built-in family's. A
 * `harness_type` may still name it — the session's registry is what makes the id
 * real. It is the same `Harness` contract with `SubagentLaunchInputs` as its
 * launch type — its own options live in its own code — so a plugin can never
 * claim a built-in family's request member.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMultiplexerKind, PaneControl } from "./agent-host.js";

/**
 * Every built-in harness. `HarnessId` derives from this; a `harness_type` may
 * also name a plugin harness's id, which is not one.
 *
 * `opencode` runs a binary of its own rather than pi: it is probed like every
 * other harness and shows up wherever its binary is on PATH, and its own
 * implementation stages the agent definition its launch reads. `codex` is the
 * same kind of harness: probed by its binary, with its launch reading the
 * staged system prompt file through a config override. `claude` is the same
 * shape with a staged config directory instead of a staged definition.
 */
export const HARNESS_IDS = [
  "pi",
  "pig",
  "pi-bolt",
  "opencode",
  "codex",
  "claude",
] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * A harness id a value names: one of the built-ins (`HarnessId`) or a plugin
 * harness's own id. Every id that is read, written, or passed around is this
 * type — `HarnessId` alone would say a plugin harness cannot be named, and a
 * bare `string` would say nothing about the built-ins, which are the ids that
 * autocomplete here. A closed vocabulary is still `HarnessId`: the ids a
 * built-in implementation is keyed by, and the built-in set a menu offers.
 */
export type AnyHarnessId = HarnessId | (string & {});

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
 * Whether this harness runs the pi binary (see PI_FAMILY_HARNESS_IDS). Narrowing,
 * so the branch that builds the pi family's launch request is typed against a
 * pi-family harness; a plugin harness id is never one. "Foreign" is this
 * predicate's complement and nothing more: the set of harness ids that are not
 * pi-family is not a closed vocabulary, so it has no type of its own — the ids
 * that carry one are plain `string` and this is the gate.
 */
export function isPiFamilyHarness(id: string): id is PiFamilyHarnessId {
  return PI_FAMILY_HARNESS_IDS.some((family) => family === id);
}

/**
 * Narrow untrusted input (config, menu) to a canonical built-in harness; a
 * plugin harness id is not in `HARNESS_IDS`, so it is not what this returns.
 * Callers that must accept a plugin id use the registry's own parse.
 */
export function parseHarnessId(value: unknown): HarnessId | undefined {
  return HARNESS_IDS.find((id): id is HarnessId => id === value);
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
 * Environment variable names that no spawn may override, regardless of source:
 * the shell's own state, the runtime's startup hooks, and the multiplexer's
 * vocabulary. A launcher that rewrote any of these would alter how the pane shell
 * runs or hide the process from the multiplexer that started it.
 */
const UNIVERSAL_RESERVED_ENV_VAR_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_AUDIT",
];

/**
 * Env namespaces no spawn may override, matched by prefix: a platform's dynamic
 * loader family and the multiplexer's own vocabulary grow members this list
 * does not track, and every member of each is off limits.
 */
const UNIVERSAL_RESERVED_ENV_VAR_PREFIXES: readonly string[] = [
  "DYLD_",
  "HERDR_",
  "COWBOY_",
];

/** The empty answer, shared so a caller cannot mutate one harness's "none". */
const NO_RESERVED_ENV_NAMES: readonly string[] = Object.freeze([]);

/** What an env var's name must be: a POSIX identifier, so the shell reads it as one. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether a name can be carried as an overridable variable at all. */
export function isEnvVarName(name: string): boolean {
  return ENV_VAR_NAME.test(name);
}

/**
 * Whether a value contains a control character. Values are staged in shell
 * assignment statements (`export NAME='value'`), so a newline would prematurely
 * end the assignment and execute the remainder as a separate command when sourced.
 */
export function hasControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/** Whether no spawn may override this name, whatever harness it names. */
export function isUniversalReservedEnvVar(name: string): boolean {
  return (
    UNIVERSAL_RESERVED_ENV_VAR_NAMES.includes(name) ||
    UNIVERSAL_RESERVED_ENV_VAR_PREFIXES.some((prefix) =>
      name.startsWith(prefix),
    )
  );
}

/**
 * Whether a name is reserved for a harness, given that harness's own names.
 * `reserved` is the answer `reservedEnvVarsOf` gives, so an absent declaration
 * never reaches this check as `undefined`.
 */
export function isReservedEnvVar(
  name: string,
  reserved: readonly string[] = NO_RESERVED_ENV_NAMES,
): boolean {
  return isUniversalReservedEnvVar(name) || reserved.includes(name);
}

/**
 * The part of a harness that declares its own reserved env names. Structural, so
 * a plugin harness declares them without importing this as a type.
 */
export interface HarnessEnvReservations {
  /**
   * Names this harness reserves besides the universal set. Absent when it
   * reserves none of its own; read through `reservedEnvVarsOf`, never directly.
   */
  readonly reservedEnvVars?: () => readonly string[];
}

/** The names one harness reserves besides the universal set; empty when it declares none. */
export function reservedEnvVarsOf(
  harness: HarnessEnvReservations,
): readonly string[] {
  return harness.reservedEnvVars?.() ?? NO_RESERVED_ENV_NAMES;
}

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
  /**
   * Thinking level for this launch in the harness's native vocabulary
   * (Pi thinking level, OpenCode variant, or Codex reasoning effort).
   * `null` indicates no level was requested, delegating to the harness default.
   * Argument formatting is handled by the specific harness implementation.
   */
  readonly thinking: string | null;
  readonly toolSelection: ToolSelection;
  /**
   * Absolute path of the staged file holding the variables this launch carries
   * beyond the pane's environment, filtered to exclude reserved names and
   * control characters; `null` when the spawn overrides nothing. A launcher
   * sources this file so values are never interpolated into the command typed
   * into the pane.
   */
  readonly envFile: string | null;
}

/** pi CLI specifics; no other harness family reads these. */
export interface PiLaunchInputs {
  /** `null` = no fork — not requested, or requested with no parent session file (the orchestrator warns there). */
  readonly forkSessionFile: string | null;
  readonly skills: SkillLaunchMode;
  readonly extensions: ExtensionLaunchMode;
  readonly projectTrusted: boolean;
}

/** codex CLI specifics; no other harness family reads these. */
export interface CodexLaunchInputs {
  /**
   * Whether the project is trusted: where pi passes `--approve`, codex asks
   * never; where pi passes `--no-approve`, codex asks on request. The sandbox
   * is not here — the child's report file lives outside the workspace, so it
   * stays `workspace-write` whatever the trust.
   */
  readonly projectTrusted: boolean;
}

/**
 * The launch-request families: the pi family (pi, pig, pi-bolt), opencode, codex
 * and claude. Filtered from the multiplexer's kinds rather than re-declared, so
 * the two vocabularies cannot drift apart; each member of `BuiltinLaunchRequest`
 * carries one as its `family` tag, and a template's family-keyed tables are keyed
 * by them. A harness id is mapped to its family by the registry; a plugin
 * harness's id is not one.
 */
export type HarnessFamily = Extract<
  AgentMultiplexerKind,
  "pi" | "opencode" | "codex" | "claude"
>;

/**
 * The env names each built-in family's launch owns, keyed by family: a template
 * table names a family rather than an id, and every id in a family launches
 * through the same pane state, so the family is the widest scope that can answer
 * for all of them. A name here is refused before it reaches a launcher.
 */
export const RESERVED_ENV_VARS_BY_FAMILY: Record<
  HarnessFamily,
  readonly string[]
> = {
  pi: ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "HERDR_AGENT"],
  opencode: [
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_AUTOUPDATE",
  ],
  codex: ["CODEX_HOME"],
  claude: [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
    "ANTHROPIC_API_KEY",
    "COWBOY_API_KEY",
  ],
};

/** The family tag one launch request carries; the tag alone selects the member. */
interface HarnessFamilyTag<F extends HarnessFamily> {
  readonly family: F;
}

/** pi's argv request: the shared launch inputs plus pi's own CLI flags. */
export type PiFamilyLaunchRequest = HarnessFamilyTag<"pi"> &
  SubagentLaunchInputs &
  PiLaunchInputs;

/**
 * opencode's argv request: the shared launch inputs alone. opencode reads the
 * launch's level as the variant it joins to the model reference, and its model
 * key, tool selection and task already ride the shared inputs — so the member is
 * the tag plus the shared shape, with no family-specific field to grow stale.
 */
export type OpencodeLaunchRequest = HarnessFamilyTag<"opencode"> &
  SubagentLaunchInputs;

/**
 * codex's argv request: the shared launch inputs plus codex's own CLI
 * specifics.
 */
export type CodexLaunchRequest = HarnessFamilyTag<"codex"> &
  SubagentLaunchInputs &
  CodexLaunchInputs;

/**
 * claude's argv request: the shared launch inputs alone. claude reads no
 * family-specific inputs — its model key and tool selection already ride the
 * shared inputs, the system prompt rides a staged file the argv names, and the
 * task rides the pane launcher — so the member is the tag plus the shared
 * shape, with no third conjunct to grow stale.
 */
export type ClaudeLaunchRequest = HarnessFamilyTag<"claude"> &
  SubagentLaunchInputs;

/**
 * The launch request a built-in harness reads, keyed by family: pi's flags are
 * what a `"pi"` request is, so they cannot ride to a harness that never mapped
 * them. One is built per launch, and both `buildArgs` and `prepare` read that
 * same object. A new family adds a member — never an optional field on an
 * existing member.
 */
export type BuiltinLaunchRequest =
  | PiFamilyLaunchRequest
  | OpencodeLaunchRequest
  | CodexLaunchRequest
  | ClaudeLaunchRequest;

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
  codex: CodexLaunchRequest;
  claude: ClaudeLaunchRequest;
}[K];

/**
 * Represents an incompatible value rejected during harness configuration
 * validation. `keyPath` is relative to the harness's section (for example,
 * `configInclude[0]`), and `layer` indicates whether the value originated from
 * the global or project file.
 */
export interface HarnessConfigIssue {
  readonly layer: "global" | "project";
  readonly keyPath: string;
  readonly got: unknown;
  readonly expected: string;
}

/** Callback a codec calls to report each value it rejected. */
export type HarnessConfigReport = (issue: HarnessConfigIssue) => void;

/**
 * The configuration slices a codec validates, as the file loader kept them:
 * absent when a file has no section for this harness, else a JSON object.
 * `project` is absent unless the codec declared `scope: "project"`.
 */
export interface HarnessConfigLayers {
  readonly global?: Readonly<Record<string, unknown>>;
  readonly project?: Readonly<Record<string, unknown>>;
}

/**
 * Configuration codec for a harness. Defines the schema, validation rules, and
 * defaults for a harness's configuration section. When `scope` is omitted,
 * validation is global-only and ignores project configuration files. When set
 * to `"project"`, `parse` receives both global and project layers. `parse`
 * always returns a usable value, reporting each rejected value instead of
 * failing the whole section.
 */
export interface HarnessConfigCodec<T = unknown> {
  readonly scope?: "global" | "project";
  parse(layers: HarnessConfigLayers, report: HarnessConfigReport): T;
}

/** What a harness needs to bring its host pane into the state it launches in. */
export interface HarnessPrepareRequest<
  L extends SubagentLaunchInputs = HarnessLaunch,
  C = unknown,
> {
  readonly pi: ExtensionAPI;
  /** The validated config for this harness, as its codec produced it. */
  readonly config: C;
  /**
   * The pane surface the session's multiplexer offers. A harness types into its
   * pane through this, never through a multiplexer's own client, so one launch runs
   * under any multiplexer that offers the surface.
   */
  readonly pane: PaneControl;
  readonly paneId: string;
  readonly cwd: string;
  /**
   * The launch this pane is prepared for: the task file the pane must read, the
   * system prompt file, the subagent id a launcher names itself after — the same
   * request `buildArgs` was given, so a built-in family's own inputs reach its
   * own harness and no other's, and a plugin reads the shared inputs alone.
   */
  readonly launch: L;
}

/** What a harness is handed to ask its process to exit. */
export interface HarnessStopRequest {
  readonly pi: ExtensionAPI;
  /**
   * The pane surface the session's multiplexer offers. A harness presses its
   * TUI's own stop keys through this, never through a multiplexer's client, so
   * one stop runs under any multiplexer that offers the surface.
   */
  readonly pane: PaneControl;
  readonly paneId: string;
}

/** Asks one run's process to exit; the harness owns the key sequence. */
export type HarnessStop = (request: HarnessStopRequest) => Promise<void>;

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
 * What a harness is asked for when one run is handed over. The address is the
 * run's own, not the spawn's: a handover's earlier run sits in a pane the next
 * run never occupies.
 */
export interface HarnessExportRequest {
  readonly pi: ExtensionAPI;
  readonly subagentId: string;
  readonly paneId: string;
  /** The tree the run ran in; a harness that keys sessions by directory reads it. */
  readonly cwd: string;
}

/**
 * One complete native session record after a harness has read its store. A
 * reader emits exactly one for every complete entry it can enumerate: readable
 * entries with no transferable prose are `dont-export`, and entries it cannot
 * classify are `unparseable`. `content` is retained only where no turn
 * survives, for reader diagnostics and tests; shared handover code never puts
 * it in the task it gives the next run.
 *
 * `compaction` is a native summary the harness wrote as it condensed the
 * session so far. It is not a turn of either role, and the records before it
 * are the history it replaces: shared handover code starts the transcript at
 * the last one, so an earlier compaction's summary and the turns it covered
 * never reach the next run.
 */
export type HandoverRecord =
  | { readonly kind: "export"; readonly turn: SessionExportTurn }
  | { readonly kind: "dont-export"; readonly content: string }
  | { readonly kind: "unparseable"; readonly content: string }
  | { readonly kind: "compaction"; readonly summary: string };

/**
 * What a harness finds at one run's session address. The harness owns native
 * discovery and per-record classification; shared handover code owns counting,
 * rendering, loss policy, and the completed export.
 */
export interface HandoverRecordSource {
  /** The source harness's resume id for this run, not a display id. */
  readonly sessionId: string;
  /**
   * Classified records in native order, produced as they are consumed. A
   * reader yields them lazily; shared handover code reads the iterable once,
   * rendering each record before the next is produced. Discovery, file reads,
   * and validation belong before the source is returned: a fault raised while
   * iterating would bypass the shared export's fault mapping.
   */
  readonly records: Iterable<HandoverRecord>;
}

/** What shared handover code had to omit from a record source. */
export interface HarnessExportLoss {
  readonly excluded: number;
  readonly total: number;
}

/**
 * One completed handover export. This is constructed by shared handover code,
 * after it renders the source records and applies the configured loss policy.
 */
export interface HarnessExport {
  readonly sessionId: string;
  readonly session: string;
  readonly loss?: HarnessExportLoss;
}

/** One harness's native-record read at one run's handover address. */
export type ReadHandoverRecords = (
  request: HarnessExportRequest,
) => Promise<HandoverRecordSource>;

/**
 * Why a run's session could not be exported, in one vocabulary every harness's
 * exporter shares so a caller reports the failure without knowing which
 * harness produced it. `export-command-failed` is the arm for a harness that
 * exports through its CLI: the read itself was refused, rather than the store
 * being missing or unreadable.
 */
export type SessionExportFault =
  | "session-not-found"
  | "ambiguous-session"
  | "unreadable-record"
  | "malformed-record"
  | "unsupported-version"
  | "missing-session-id"
  | "export-command-failed";

/** A refused export: the shared fault a caller reports, with the sentence it shows. */
export class SessionExportError extends Error {
  readonly fault: SessionExportFault;

  constructor(fault: SessionExportFault, message: string) {
    super(message);
    this.name = "SessionExportError";
    this.fault = fault;
  }
}

/** One surviving turn of a conversation, in the order the record holds it. */
export interface SessionExportTurn {
  readonly role: "User" | "Assistant";
  readonly text: string;
}

/**
 * Supported thinking levels for a model and the enforcement policy of the list.
 *
 * - `closed`: Fixed vocabulary enforced by the harness (Pi levels, Claude effort
 *   names, Codex reasoning efforts). Unlisted levels generate a warning.
 * - `advisory`: Open vocabulary advertised by the harness (e.g., custom OpenCode
 *   variants). Unlisted levels are accepted without warning.
 */
export type ThinkingLevels =
  | { readonly kind: "closed"; readonly levels: readonly string[] }
  | { readonly kind: "advisory"; readonly levels: readonly string[] };

/**
 * One model a harness can run. `key` is the bare `"provider/model"` every layer
 * stores and every CLI flag carries; `label` is the optional display form a
 * picker shows in place of the key.
 */
export interface ModelEntry {
  readonly key: string;
  readonly label?: string;
  /**
   * The levels this model accepts, in the launching harness's own vocabulary,
   * with the list's kind. An empty `closed` list means the model has no
   * thinking control.
   */
  readonly thinkingLevels: ThinkingLevels;
}

/**
 * The slice of pi's model registry a harness reads to list what it can run:
 * which models are available, in the registry's own order. Structural, so the
 * harness layer never imports pi's registry type — and it is deliberately the
 * whole of what the pi family's list reads, nothing more.
 */
export interface ModelCatalog {
  getAvailable(): readonly {
    readonly provider: string;
    readonly id: string;
    /** pi's levels for this model; `["off"]` when it does not reason. */
    readonly thinkingLevels: readonly string[];
  }[];
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
 * One harness's answer about what it can run.
 *
 * `listed` is the harness's own catalog. `fallback` is a built-in catalog
 * standing in for one that could not be read, and `unavailable` is a list
 * that could not be read with nothing to stand in for it — both carry the
 * reason, which is the caller's to show because the caller holds the ctx and
 * a harness does not.
 */
export type ModelList =
  | { readonly kind: "listed"; readonly entries: readonly ModelEntry[] }
  | {
      readonly kind: "fallback";
      readonly entries: readonly ModelEntry[];
      readonly notice: string;
    }
  | { readonly kind: "unavailable"; readonly notice: string };

/** The models this answer offers: its own, its fallback's, or none. */
export function modelListEntries(list: ModelList): readonly ModelEntry[] {
  return list.kind === "unavailable" ? [] : list.entries;
}

/**
 * Diagnostic warning message associated with a fallback or unavailable model
 * list, or undefined if the harness returned its native catalog successfully.
 */
export function modelListNotice(list: ModelList): string | undefined {
  return list.kind === "listed" ? undefined : list.notice;
}

/**
 * Lists the models one harness can run. Never throws: a catalog that could not
 * be read is a `fallback` or an `unavailable` answer carrying its reason, so a
 * menu always opens and a boot warm never rejects.
 */
export type HarnessListModels = (
  request: HarnessListModelsRequest,
) => Promise<ModelList>;

/**
 * A harness's answer about this machine, with the line for the human riding the
 * arm it explains.
 *
 * `unavailable` keeps the harness out of the setting's offer. The notice is
 * present only where the machine has something surprising to report — a binary
 * that is installed but speaks another major; a binary that is simply missing
 * says nothing, because nothing about the machine is unexpected there.
 */
export type HarnessAvailability =
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly notice?: string };

/**
 * One harness implementation, over the launch type it reads: a built-in's
 * `LaunchRequestFor<K>` (its family's request), or `SubagentLaunchInputs` for a
 * plugin. The type parameter is what keeps one family's options out of another
 * implementation: a pi harness cannot name codex's project trust, and a plugin
 * cannot name any built-in option at all.
 */
export interface Harness<
  L extends SubagentLaunchInputs = HarnessLaunch,
  C = unknown,
> {
  /**
   * Configuration codec for this harness. Validated after plugins register; the
   * parsed value is passed to `prepare` as `request.config`.
   */
  readonly config?: HarnessConfigCodec<C>;
  /**
   * Env names this harness reserves besides the universal set, for a launch the
   * universal set alone does not protect. Optional because a plugin compiled
   * against the surface before this member existed declares none.
   */
  readonly reservedEnvVars?: () => readonly string[];
  /**
   * Variables this harness's launch must hand the child from this process's own
   * environment, read at launch time: the names a harness process uses to resolve
   * its own state, and by which the parent reads that state back, so the two
   * agree only when the child is handed the same values. Those names are reserved
   * (see `reservedEnvVars`), so configuration cannot override them and this
   * process is their only source. Absent when the pane's own environment is the
   * harness's whole answer; one family's launch never inherits another's names.
   */
  readonly inheritedEnv?: () => Readonly<Record<string, string>>;
  /**
   * The agent kind this harness launches as, in the multiplexer's vocabulary; the only
   * place a kind appears as a literal. A harness whose binary is not pi's can
   * only launch under its own kind, because the multiplexer matches the detected process
   * against it.
   */
  readonly agentMultiplexerKind: AgentMultiplexerKind;
  /**
   * What this machine can do with the harness, read at probe time. `unavailable`
   * keeps the harness out of the setting, and a template that still names it
   * falls back to pi instead of opening a pane that could never run it. The
   * notice, where there is one, is shown to the human once the UI exists.
   */
  availability(): HarnessAvailability;
  /**
   * Bring the pane into the state this harness launches in, for the launch this
   * family's own request describes. Idempotent; throws when the state could not
   * be established.
   */
  prepare(request: HarnessPrepareRequest<L, C>): Promise<void>;
  /**
   * Ask this run's process to exit through its own TUI keybindings. The
   * sequence is the harness's: pi, PiG, Pi-Bolt and codex exit on ctrl+d, while
   * opencode and claude interrupt with one ctrl+c and exit on the second. The
   * multiplexer only carries the keys and then confirms the process is gone.
   */
  stop: HarnessStop;
  /**
   * The complete argv the pane runs, including how the task rides (the pi
   * family ends with `@<taskFile>`). Pure: no shellouts, no filesystem writes.
   * Typed to this harness's own launch, so one family's flags cannot reach
   * another's buildArgs, and a plugin reads only the shared inputs.
   */
  buildArgs(launch: L): string[];
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
   * Read and classify one run's native session records for a handover. Optional:
   * a harness that cannot read its session omits it, and a handover from that
   * harness is refused as a capability gap rather than attempted — see
   * `canReadHandoverRecords`. The address is the run's own.
   */
  readHandoverRecords?: ReadHandoverRecords;
  /**
   * The models this harness can run, listed on demand — when a menu opens, and
   * when the spawn wizard opens. The pi family reads its catalog live on
   * every call. opencode and codex answer from their memoized fetches, so the
   * boot warm and every menu select share one CLI run; an empty answer is
   * never retained, so a failed list retries on the next read instead of
   * pinning an empty row. A harness that cannot produce its own list answers
   * with its fallback, if it has one, and carries the reason either way.
   */
  listModels(request: HarnessListModelsRequest): Promise<ModelList>;
  /**
   * Warm the model list in the background at boot. Required, with an explicit
   * no-op for a harness whose list is cheap — a harness that needs warming
   * but forgets this compiles loudly missing, never silently cold.
   * Fire-and-forget, so a slow channel never blocks the launch.
   */
  prefetchModels(pi: ExtensionAPI): void;
}

/**
 * Whether a harness can be the source of a handover: the optional reader is
 * present, not merely declared. Structural, so the check reads the capability
 * alone and narrows to a harness the shared layer can export through.
 */
export function canReadHandoverRecords(harness: {
  readonly readHandoverRecords?: ReadHandoverRecords;
}): harness is { readonly readHandoverRecords: ReadHandoverRecords } {
  return harness.readHandoverRecords !== undefined;
}

/**
 * A plugin harness's launch: the shared inputs plus the open arm's tag.
 * `family` is the union's one discriminant; `"plugin"` is not a built-in
 * family, so the tag can never be mistaken for one, and the plugin's own id
 * stays where it belongs — in the plan, not in the request. Nothing else rides
 * here: a plugin's own options live in its own code.
 */
export interface PluginLaunchRequest extends SubagentLaunchInputs {
  readonly family: "plugin";
}

/**
 * What one launch carries: a built-in family's request or the plugin arm.
 * `family` discriminates them: a built-in arm names its family, and the open
 * arm names `"plugin"`, so a plugin request can never equal a built-in family
 * and an exhaustive switch over the built-in arms still bottoms out at `never`.
 */
export type HarnessLaunch = BuiltinLaunchRequest | PluginLaunchRequest;

/**
 * One plugin harness: the same `Harness` contract a built-in implements, over
 * the shared launch inputs, plus the identity a plugin supplies for itself
 * because it is not keyed in this package's built-in table. The registry holds
 * it as the same `RegisteredHarness` a built-in becomes (see
 * harness/harness-registry.ts), so a caller never branches on where it came from.
 * `C` is the value its codec parses, which types the prepare request's config.
 */
export interface PluginHarness<C = unknown> extends Harness<
  SubagentLaunchInputs,
  C
> {
  /** The id config and `harness_type`-shaped values name this harness by. */
  readonly id: AnyHarnessId;
  /** The label its settings rows show. */
  readonly displayName: string;
}
