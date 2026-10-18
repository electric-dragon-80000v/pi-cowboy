/**
 * harness/registry.ts — the one module that knows every harness.
 *
 * It owns the id → implementation lookup, so a caller that holds a
 * `harness_type` resolves it to the harness that launches it, and it owns the
 * listing that spans harnesses, so no caller has to name one.
 *
 * The registry is open: the six built-ins are seeded here at module load and a
 * plugin harness is added by `registerHarness` at session start, and both become
 * the same `RegisteredHarness`, so no caller can tell a built-in from a plugin
 * by how it arrived. Registration is id-keyed and first-wins — the first
 * registration for an id is kept and a later one is refused with a warning — so
 * a plugin can never displace a built-in, and two plugins claiming one id do not
 * race: the plugin loader sorts by package name, so the same one wins every
 * load. A load is torn down by `resetPluginHarnesses`, so a plugin registering
 * again after a session disposed it is a first registration again rather than a
 * duplicate.
 *
 * A built-in keeps its per-family typing behind the wall
 * (`Harness<LaunchRequestFor<K>>`); the wall narrows a launch to the built-in's
 * own request by its `family` tag, which the caller built from the same id (see
 * agent-runner.buildLaunchRequest). A plugin is the same `Harness` contract
 * over the shared inputs, so it is stored as it registered. Everything above
 * the wall holds a `RegisteredHarness` and never branches on origin.
 */

import { assertNever } from "../../utils.js";
import {
  isAvailable,
  isProven,
  type Availability,
} from "../../availability.js";
import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  isPiFamilyHarness,
  parseHarnessId,
  type AnyHarnessId,
  type BuiltinLaunchRequest,
  type Harness,
  type HarnessFamily,
  type HarnessId,
  type HarnessLaunch,
  type HarnessListModelsRequest,
  type LaunchRequestFor,
  type PiFamilyLaunchRequest,
  type PluginHarness,
} from "../harness.js";
import { buildPiLaunchArgs, piFamilyListModels } from "./pi-compatible.js";
import { pigHarness } from "./pig.js";
import { piBoltHarness } from "./pi-bolt.js";
import { opencodeHarness } from "./opencode/index.js";
import { codexHarness } from "./codex.js";
import { claudeHarness } from "./claude/index.js";

/**
 * Real pi is already the pane shell's `pi`: it is always launchable, and there
 * is nothing to prepare or tear down. Its argv is the family's shared
 * assembly — pi is the family's namesake — and its model list is the family's
 * shared catalog.
 */
const piHarness: Harness<PiFamilyLaunchRequest> = {
  agentMultiplexerKind: "pi",
  availability: () => ({ status: "available" }),
  prepare: async () => {},
  buildArgs: buildPiLaunchArgs,
  listModels: piFamilyListModels,
  // The catalog is local: nothing to warm.
  prefetchModels: () => {},
  teardown: async () => {},
};

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
    agentMultiplexerKind: harness.agentMultiplexerKind,
    availability: () => harness.availability(),
    prepare: (request) =>
      withBuiltin(id, request.launch, (typed, launch) =>
        typed.prepare({
          pi: request.pi,
          pane: request.pane,
          paneId: request.paneId,
          cwd: request.cwd,
          launch,
        }),
      ),
    buildArgs: (launch) =>
      withBuiltin(id, launch, (typed, request) => typed.buildArgs(request)),
    teardown: (request) => harness.teardown(request),
    listModels: (request) => harness.listModels(request),
    prefetchModels: (pi) => harness.prefetchModels(pi),
  };
}

/** Every registered harness, built-in first, in the order ids were registered. */
const REGISTERED = new Map<string, RegisteredHarness>(
  HARNESS_IDS.map((id): [string, RegisteredHarness] => [id, wrapBuiltin(id)]),
);

/** The ids the current plugin load owns; forgotten with the load (see resetPluginHarnesses). */
const PLUGIN_HARNESS_IDS = new Set<string>();

/**
 * Register a plugin harness, answering whether it was accepted. The first
 * registration for an id is kept: a plugin that claims a built-in's id, or an id
 * another plugin already claimed in this load, is refused with a warning and
 * answered `false`. The plugin loader resets the registry between loads
 * (`resetPluginHarnesses`), so a plugin registering again after a session
 * disposed it is the first registration again rather than a duplicate.
 */
export function registerHarness(harness: PluginHarness): boolean {
  const refusal =
    parseHarnessId(harness.id) !== undefined
      ? "a built-in harness owns that id"
      : REGISTERED.has(harness.id)
        ? "another plugin already registered that id in this load"
        : undefined;
  if (refusal !== undefined) {
    console.warn(`[subagents] Ignoring harness "${harness.id}": ${refusal}`);
    return false;
  }
  REGISTERED.set(harness.id, harness);
  PLUGIN_HARNESS_IDS.add(harness.id);
  return true;
}

/**
 * Forget one plugin harness — the undo a plugin's own load needs when its
 * factory throws after registering. A built-in id is never removed, and neither
 * is an id this load did not register (so a failed plugin cannot unregister the
 * plugin that legitimately owns an id).
 */
export function unregisterHarness(id: AnyHarnessId): void {
  if (!PLUGIN_HARNESS_IDS.has(id)) return;
  REGISTERED.delete(id);
  PLUGIN_HARNESS_IDS.delete(id);
}

/**
 * Forget every plugin harness, leaving the built-ins. The plugin loader calls
 * this when it tears a load down, so the next load registers into a clean
 * registry instead of colliding with the previous session's entries.
 */
export function resetPluginHarnesses(): void {
  for (const id of PLUGIN_HARNESS_IDS) REGISTERED.delete(id);
  PLUGIN_HARNESS_IDS.clear();
}

/** Every registered harness id, built-in ids first then plugins in registration order. */
export function harnessIds(): readonly AnyHarnessId[] {
  return [...REGISTERED.keys()];
}

/** The harness for one id, or undefined for an id nothing registered. */
export function registeredHarness(
  id: AnyHarnessId,
): RegisteredHarness | undefined {
  return REGISTERED.get(id);
}

/**
 * The harness for one id. A caller that reaches here has already narrowed the
 * id to a registered one (config resolve, request refusal), so an unregistered
 * id is a bug to name, not a state to branch on.
 */
export function harnessFor(id: AnyHarnessId): RegisteredHarness {
  const harness = REGISTERED.get(id);
  if (harness === undefined) {
    throw new Error(`no harness registered for "${id}"`);
  }
  return harness;
}

/** The display form of one harness, for the rows that configure it. An unregistered id shows as itself. */
export function harnessDisplayName(id: AnyHarnessId): string {
  return REGISTERED.get(id)?.displayName ?? id;
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
 * The harnesses a spawn here can really use: built-in ids first (in `HARNESS_IDS`
 * order), then plugin ids (in registration order). pi runs the pane it would
 * launch in, so the family answers always; any other harness — built-in or
 * plugin — needs the probe to have confirmed it, because only the binary itself
 * can list the models it runs.
 */
export function runnableHarnessIds(
  availability: Availability<AnyHarnessId>,
): AnyHarnessId[] {
  return harnessIds().filter(
    (id) => isPiFamilyHarness(id) || isProven(id, availability),
  );
}

/**
 * Which harness a spawn launches under: the configured one when it is both
 * registered and launchable here, pi otherwise. Registration is checked as well
 * as availability because config may name a plugin harness that is not
 * installed, and while the probe is `unprobed` every id reads as "available" —
 * so availability alone would hand a spawn an id that `harnessFor` then refuses.
 */
export function resolveHarness(
  configured: AnyHarnessId,
  availability: Availability<AnyHarnessId>,
): AnyHarnessId {
  return REGISTERED.has(configured) && isAvailable(configured, availability)
    ? configured
    : DEFAULT_HARNESS;
}

/**
 * The model keys each harness this machine can run offers, keyed by harness.
 * A harness whose list could not be produced is present with an empty list:
 * "no models" belongs to that harness alone and is never filled in from
 * another's.
 */
export type HarnessModelOptions = ReadonlyMap<AnyHarnessId, readonly string[]>;

/**
 * One list per runnable harness, each answering for itself, read once when a
 * menu tree opens so every picker under it selects from the same answer.
 */
export async function listHarnessModelOptions(
  request: HarnessListModelsRequest,
  availability: Availability<AnyHarnessId>,
): Promise<HarnessModelOptions> {
  const entries = await Promise.all(
    runnableHarnessIds(availability).map(
      async (id): Promise<readonly [AnyHarnessId, readonly string[]]> => {
        try {
          const models = await harnessFor(id).listModels(request);
          return [id, models.map((entry) => entry.key)];
        } catch {
          // `listModels` is not supposed to throw; one that does costs its own
          // list, never the others'.
          return [id, []];
        }
      },
    ),
  );
  return new Map(entries);
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
  for (const list of options.values()) {
    for (const key of list) keys.add(key);
  }
  return [...keys];
}
