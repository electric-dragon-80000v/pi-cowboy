/**
 * harness-registry.ts — the one module that knows every harness.
 *
 * `createHarnessRegistry()` builds the id → implementation lookup a session
 * uses. Its built-ins are seeded at construction, and a plugin harness is added
 * by `register` at session start; both become the same `RegisteredHarness`, so
 * no caller can tell a built-in from a plugin by how it arrived. Because the map
 * is a closure of the object, its lifetime is the object's: a session installs a
 * fresh registry, and the previous session's plugin entries cannot outlive it.
 *
 * Registration is id-keyed and first-wins — the first registration for an id is
 * kept and a later one is refused with a warning — so a plugin can never
 * displace a built-in, and two plugins claiming one id do not race: the plugin
 * loader sorts by package name, so the same one wins every load.
 *
 * A built-in keeps its per-family typing behind the wall
 * (`Harness<LaunchRequestFor<K>>`); the wall narrows a launch to the built-in's
 * own request by its `family` tag, which the caller built from the same id (see
 * agent-runner.buildLaunchRequest). A plugin is the same `Harness` contract
 * over the shared inputs, so it is stored as it registered. Everything above
 * the wall holds a `RegisteredHarness` and never branches on origin.
 */

import { assertNever, errorMessage } from "../../utils.js";
import {
  isAvailable,
  isProven,
  type Availability,
} from "../../availability.js";
import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  isPiFamilyHarness,
  modelListEntries,
  modelListNotice,
  parseHarnessId,
  type AnyHarnessId,
  type BuiltinLaunchRequest,
  type Harness,
  type HarnessConfigIssue,
  type HarnessFamily,
  type HarnessId,
  type HarnessLaunch,
  type HarnessListModelsRequest,
  type LaunchRequestFor,
  type ModelEntry,
  type ModelList,
  type PluginHarness,
  type ThinkingLevels,
} from "../harness.js";
import { piHarness } from "./pi.js";
import { pigHarness } from "./pig.js";
import { piBoltHarness } from "./pi-bolt.js";
import { opencodeHarness } from "./opencode/index.js";
import { codexHarness } from "./codex.js";
import { claudeHarness } from "./claude/index.js";

/** Keyed by id, so a harness added to `HARNESS_IDS` without an implementation fails to compile. */
const BUILTIN_HARNESSES: { [K in HarnessId]: Harness<LaunchRequestFor<K>> } = {
  pi: piHarness,
  pig: pigHarness,
  "pi-bolt": piBoltHarness,
  opencode: opencodeHarness,
  codex: codexHarness,
  claude: claudeHarness,
};

/** How a built-in's own settings row is labeled. */
const BUILTIN_DISPLAY_NAMES: Record<HarnessId, string> = {
  pi: "Pi",
  pig: "PiG",
  "pi-bolt": "Pi-Bolt",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude",
};

/** The catalogue a built-in's model keys belong to; keyed, so a new id without a family fails to compile. */
const BUILTIN_FAMILIES: Record<HarnessId, HarnessFamily> = {
  pi: "pi",
  pig: "pi",
  "pi-bolt": "pi",
  opencode: "opencode",
  codex: "codex",
  claude: "claude",
};

/**
 * Everything one launch needs that a harness can be handed without knowing its
 * origin: the one contract every implementation presents, plus the identity the
 * registry keys it by. A caller holds this, never the underlying `Harness` or
 * `PluginHarness`.
 */
export interface RegisteredHarness extends Harness<HarnessLaunch> {
  readonly id: AnyHarnessId;
  readonly displayName: string;
}

/**
 * Dispatch a built-in launch to the built-in the plan selected, with the request
 * narrowed to that harness's own family request. The switch is exhaustive over
 * `HarnessId`, and each arm pairs the harness with the narrowing that belongs to
 * it — the guarantee the uniform `RegisteredHarness` would otherwise erase, so a
 * pi-family implementation can never be handed an opencode request (which would
 * compile, with its missing fields silently `undefined`).
 *
 * The dispatch is per *id*, not per family: the pi family shares one launch
 * request but its three harnesses prepare differently, so the family alone does
 * not name the implementation.
 */
function withBuiltin<T>(
  id: HarnessId,
  launch: HarnessLaunch,
  run: <K extends HarnessId>(
    harness: Harness<LaunchRequestFor<K>>,
    request: LaunchRequestFor<K>,
  ) => T,
): T {
  switch (id) {
    case "pi":
      return run(BUILTIN_HARNESSES.pi, familyRequest(launch, "pi"));
    case "pig":
      return run(BUILTIN_HARNESSES.pig, familyRequest(launch, "pi"));
    case "pi-bolt":
      return run(BUILTIN_HARNESSES["pi-bolt"], familyRequest(launch, "pi"));
    case "opencode":
      return run(BUILTIN_HARNESSES.opencode, familyRequest(launch, "opencode"));
    case "codex":
      return run(BUILTIN_HARNESSES.codex, familyRequest(launch, "codex"));
    case "claude":
      return run(BUILTIN_HARNESSES.claude, familyRequest(launch, "claude"));
    default:
      return assertNever(id);
  }
}

/**
 * The launch narrowed to one built-in family's request. The guard is the point:
 * the pair is built at one site (agent-runner.buildLaunchRequest), so a mismatch
 * is a bug there, and naming it here is what lets each built-in stay typed to
 * its own request instead of the erased union. The plugin arm's `"plugin"` tag
 * can never equal a built-in family, so this one check covers both arms — one
 * guarded cast, not a blanket one.
 */
function familyRequest<K extends HarnessFamily>(
  launch: HarnessLaunch,
  family: K,
): Extract<BuiltinLaunchRequest, { readonly family: K }> {
  if (launch.family !== family) {
    throw new Error(
      `a "${launch.family}" launch reached the "${family}" harness`,
    );
  }
  return launch as Extract<BuiltinLaunchRequest, { readonly family: K }>;
}

/**
 * Adapter for a built-in: its implementation is typed to its own family's
 * request, so the uniform registry entry narrows by id. A plugin needs no
 * adapter — it is the same contract over the shared inputs.
 */
function wrapBuiltin(id: HarnessId): RegisteredHarness {
  const harness = BUILTIN_HARNESSES[id];
  return {
    id,
    displayName: BUILTIN_DISPLAY_NAMES[id],
    // The codec is what `validateConfigs` reads for a built-in too, so the
    // uniform entry carries it.
    config: harness.config,
    agentMultiplexerKind: harness.agentMultiplexerKind,
    availability: () => harness.availability(),
    // The launch reads these off the registry entry, so the adapter carries
    // them: dropped here, a built-in's child would silently resolve another
    // store, and a name a built-in declares its own would not be reserved.
    ...(harness.reservedEnvVars === undefined
      ? {}
      : { reservedEnvVars: harness.reservedEnvVars.bind(harness) }),
    ...(harness.inheritedEnv === undefined
      ? {}
      : { inheritedEnv: harness.inheritedEnv.bind(harness) }),
    prepare: (request) =>
      withBuiltin(id, request.launch, (typed, launch) =>
        typed.prepare({
          pi: request.pi,
          pane: request.pane,
          paneId: request.paneId,
          cwd: request.cwd,
          launch,
          config: request.config,
        }),
      ),
    buildArgs: (launch) =>
      withBuiltin(id, launch, (typed, request) => typed.buildArgs(request)),
    teardown: (request) => harness.teardown(request),
    listModels: (request) => harness.listModels(request),
    prefetchModels: (pi) => harness.prefetchModels(pi),
    // Absent stays absent: the capability is what a handover checks, so an
    // adapter must not supply a record reader the implementation never wrote.
    ...(harness.readHandoverRecords === undefined
      ? {}
      : { readHandoverRecords: harness.readHandoverRecords.bind(harness) }),
  };
}

/**
 * A plugin written against the earlier `ModelEntry` shape names a model's
 * levels as a bare array. That array was an exact vocabulary, so it folds to
 * `closed`: read as `advisory` it would drop the warning a level outside it
 * earns, and a shape mismatch must not change what the answer means. Folding at
 * registration leaves one shape for every reader.
 */
function withOneLevelShape(harness: PluginHarness): PluginHarness {
  return {
    ...harness,
    listModels: async (request) => {
      const list = await harness.listModels(request);
      if (list.kind === "unavailable") return list;
      return {
        ...list,
        entries: list.entries.map((entry) => ({
          ...entry,
          thinkingLevels: foldLevels(entry.thinkingLevels),
        })),
      };
    },
  };
}

/** One model entry's levels in the current shape; a flat array is a closed vocabulary. */
function foldLevels(
  levels: ThinkingLevels | readonly string[],
): ThinkingLevels {
  return isFlatLevels(levels) ? { kind: "closed", levels } : levels;
}

/** Whether an answer named its levels as the earlier contract's bare array. */
function isFlatLevels(
  levels: ThinkingLevels | readonly string[],
): levels is readonly string[] {
  return Array.isArray(levels);
}

/**
 * One session's harness vocabulary: the built-ins plus whatever that session's
 * plugins registered.
 */
export interface HarnessRegistry {
  /**
   * Register a plugin harness, answering whether it was accepted. The first
   * registration for an id is kept: a plugin that claims a built-in's id, or an
   * id another plugin already claimed in this session, is refused with a warning
   * and answered `false`.
   */
  register(harness: PluginHarness): boolean;
  /**
   * Forget one plugin harness — the undo a plugin's own load needs when its
   * factory throws after registering. A built-in id is never removed, and
   * neither is an id this registry did not register.
   */
  unregister(id: AnyHarnessId): void;
  /** Every registered id, built-in ids first then plugins in registration order. */
  ids(): readonly AnyHarnessId[];
  /** The harness for one id, or undefined for an id nothing registered. */
  get(id: AnyHarnessId): RegisteredHarness | undefined;
  /**
   * Validate every registered harness's configuration section against the
   * session's raw layers, recording the value its launch reads. A codec that
   * declares no project scope receives no project slice; one that throws takes
   * its harness out of the session's vocabulary instead of ending startup.
   */
  validateConfigs(
    layers: {
      readonly global: Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
      readonly project: Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
    },
    report: (id: AnyHarnessId, issue: HarnessConfigIssue) => void,
  ): void;
  /**
   * The harness for one id. A caller that reaches here has already narrowed the
   * id to a registered one (config resolve, request refusal), so an unregistered
   * id is a bug to name, not a state to branch on.
   */
  require(id: AnyHarnessId): RegisteredHarness;
  /** The display form of one harness; an unregistered id shows as itself. */
  displayName(id: AnyHarnessId): string;
  /**
   * The harnesses a spawn here can really use: built-in ids first (in
   * `HARNESS_IDS` order), then plugin ids (in registration order). pi runs the
   * pane it would launch in, so the family answers always; any other harness —
   * built-in or plugin — needs the probe to have confirmed it.
   */
  runnable(availability: Availability<AnyHarnessId>): AnyHarnessId[];
  /** The value this harness's codec validated, or undefined when it has none. */
  config(id: AnyHarnessId): unknown;
  /**
   * Which harness a spawn launches under: the configured one when it is both
   * registered and launchable here, pi otherwise. Registration is checked as
   * well as availability because config may name a plugin harness that is not
   * installed, and while the probe is `unprobed` every id reads as "available" —
   * so availability alone would hand a spawn an id that `require` then refuses.
   */
  resolve(
    configured: AnyHarnessId,
    availability: Availability<AnyHarnessId>,
  ): AnyHarnessId;
  /**
   * One model list per runnable harness, each answering for itself, read once
   * when a menu tree opens so every picker under it selects from the same
   * answer. A harness whose list could not be produced is present with an empty
   * list: "no models" belongs to that harness alone. A harness that could not
   * answer for itself contributes a notice for the caller to show.
   */
  listModelOptions(
    request: HarnessListModelsRequest,
    availability: Availability<AnyHarnessId>,
  ): Promise<HarnessModelListing>;
}

/**
 * The harness vocabulary one session runs with. The built-in entries are built
 * here, so each registry owns its own wrappers — a stale registry cannot answer
 * with an entry another session replaced.
 */
export function createHarnessRegistry(): HarnessRegistry {
  const registered = new Map<string, RegisteredHarness>(
    HARNESS_IDS.map((id): [string, RegisteredHarness] => [id, wrapBuiltin(id)]),
  );
  /** The ids this registry's plugins own, so `unregister` cannot remove another's. */
  const owned = new Set<string>();
  /** Each harness's validated configuration, stored beside the entry. */
  const configs = new Map<string, unknown>();

  const registry: HarnessRegistry = {
    register(harness) {
      const refusal =
        parseHarnessId(harness.id) !== undefined
          ? "a built-in harness owns that id"
          : registered.has(harness.id)
            ? "another plugin already registered that id in this load"
            : undefined;
      if (refusal !== undefined) {
        console.warn(
          `[subagents] Ignoring harness "${harness.id}": ${refusal}`,
        );
        return false;
      }
      registered.set(harness.id, withOneLevelShape(harness));
      owned.add(harness.id);
      return true;
    },
    unregister(id) {
      if (!owned.has(id)) return;
      registered.delete(id);
      owned.delete(id);
      configs.delete(id);
    },
    ids() {
      return [...registered.keys()];
    },
    get(id) {
      return registered.get(id);
    },
    validateConfigs(layers, report) {
      for (const [id, harness] of registered) {
        const codec = harness.config;
        if (codec === undefined) continue;
        const project =
          codec.scope === "project" ? layers.project[id] : undefined;
        try {
          configs.set(
            id,
            codec.parse({ global: layers.global[id], project }, (issue) =>
              report(id, issue),
            ),
          );
        } catch (error) {
          // `parse` is plugin code. A harness whose codec cannot answer would
          // hand `prepare` no config at all, so it leaves the session's
          // vocabulary instead of ending session startup.
          registered.delete(id);
          owned.delete(id);
          configs.delete(id);
          console.warn(
            `[subagents] Disabling harness "${id}": its configuration codec failed to parse it (${errorMessage(error)}).`,
          );
        }
      }
    },
    require(id) {
      const harness = registered.get(id);
      if (harness === undefined) {
        throw new Error(`no harness registered for "${id}"`);
      }
      return harness;
    },
    displayName(id) {
      return registered.get(id)?.displayName ?? id;
    },
    runnable(availability) {
      return registry
        .ids()
        .filter((id) => isPiFamilyHarness(id) || isProven(id, availability));
    },
    config(id) {
      return configs.get(id);
    },
    resolve(configured, availability) {
      return registered.has(configured) && isAvailable(configured, availability)
        ? configured
        : DEFAULT_HARNESS;
    },
    async listModelOptions(request, availability) {
      const answered = await Promise.all(
        registry.runnable(availability).map(async (id) => {
          try {
            return { id, list: await registry.require(id).listModels(request) };
          } catch (error) {
            // `listModels` is not supposed to throw; one that does costs its
            // own list, never the others'.
            return {
              id,
              list: {
                kind: "unavailable",
                notice: `Could not list the ${registry.displayName(id)} models (${errorMessage(error)}).`,
              } satisfies ModelList,
            };
          }
        }),
      );
      const options = new Map(
        answered.map(
          (answer) => [answer.id, modelListEntries(answer.list)] as const,
        ),
      );
      const notices = answered.flatMap((answer) => {
        const notice = modelListNotice(answer.list);
        return notice === undefined ? [] : [notice];
      });
      return { options, notices };
    },
  };
  return registry;
}

/**
 * The family whose template table this harness's launch reads: the built-in
 * family the id maps to, or undefined when the id is a plugin harness's own.
 * A plugin's family is its id, which keys no template table, so the caller
 * reads no slice rather than another family's.
 */
export function harnessFamilyOf(id: AnyHarnessId): HarnessFamily | undefined {
  const builtin = parseHarnessId(id);
  return builtin === undefined ? undefined : BUILTIN_FAMILIES[builtin];
}

/**
 * The models each harness this machine can run offers, keyed by harness — the
 * entries themselves, because a picker offers a key and a launch offers a
 * level, and both answers come from the same listing. A harness whose list
 * could not be produced is present with an empty list: "no models" belongs to
 * that harness alone and is never filled in from another's.
 */
export type HarnessModelOptions = ReadonlyMap<
  AnyHarnessId,
  readonly ModelEntry[]
>;

/** The keys one harness's entries carry, for the pickers that offer keys alone. */
export function modelKeysOf(
  options: HarnessModelOptions,
  harness: AnyHarnessId,
): readonly string[] {
  return (options.get(harness) ?? []).map((entry) => entry.key);
}

/**
 * One read of every harness's list: the keys for the menus, and one line per
 * harness whose keys are not its own catalog's, for the caller that holds a UI
 * to show them on.
 */
export interface HarnessModelListing {
  readonly options: HarnessModelOptions;
  readonly notices: readonly string[];
}

/**
 * The one merged view of the per-harness structure: every harness's keys, once
 * each, in registration order. Only the concurrency menu asks for it — its
 * slots are keyed by model key across harnesses, so it must offer every key a
 * spawn could carry.
 */
export function mergeHarnessModelOptions(
  options: HarnessModelOptions,
): string[] {
  const keys = new Set<string>();
  for (const entries of options.values()) {
    for (const entry of entries) keys.add(entry.key);
  }
  return [...keys];
}
