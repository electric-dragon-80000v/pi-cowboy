/**
 * agent-assets.ts — located-artifacts seam: locate a run's work, then act on it.
 * AgentAssets: locate/observe/deliverable + actuators. AgentAssetsDeps: raw probes it composes.
 * LocateResult: Located (tracked/recovered) | Ambiguous | NotFound.
 * CleanupDeps: injected host/git actuators. PaneRef/LocatedCandidate: addresses.
 * createAgentAssets: bind over probes. createMultiplexerAgentAssets: bind to a session's multiplexer.
 * Authority is per-asset: provenance (worktreeManaged/paneCreated) is memory-only;
 * addresses (workspace/pane/branch/path) are live probes (memory can be stale, not just absent).
 * Unreadable registries degrade to memory's answer, never to absence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSpawn } from "../types.js";
import type {
  BranchCleanupResult,
  DeleteBranchOptions,
} from "../infrastructure/git-client.js";
import {
  deleteWorktreeBranch,
  isWorktreeDirty,
  removeGitWorktree,
  resolveMainCheckout,
} from "../infrastructure/git-client.js";
import { getHarnessRegistry, getSessionCtx, getStore } from "../shell.js";
import { createLogger } from "../logger.js";
import { errorMessage } from "../utils.js";
import { subagentResultFileFor } from "../paths.js";
import {
  buildWorktreeBranch,
  isExtensionWorktree,
  isSpawnArtifactName,
  resolveWorktreeRoot,
  slugifyWorktreeType,
} from "../spawn/worktree-policy.js";
import type {
  AgentMultiplexer,
  AgentHost,
  AgentHostRef,
  HostObservation,
  PlacementCatalog,
  PlacementRecord,
  PlacementWorktree,
} from "./agent-host.js";
import type { AnyHarnessId } from "./harness.js";
import type {
  CleanupSource,
  LocatedArtifacts,
  LocatedPane,
  RecoveredDeliverable,
} from "./cleanup-policy.js";

const log = createLogger("assets");

/* ── The actuator half ─────────────────────────────────────────────────── */

/**
 * Injected host/git actuators. Host ops take the run's address (bound to release/close, never stop); git ops stay path-based (the host never destroys filesystem state).
 * Function-typed properties, not methods: these are bare injected functions, and callers hand them on as values (`deps.isWorktreeDirty`).
 */
export interface CleanupDeps {
  /** Dirty/unverifiable retention probe. */
  isWorktreeDirty: (worktreePath: string) => Promise<boolean | undefined>;
  /** Filesystem probe (injected; this module never touches the filesystem). */
  worktreeExists: (worktreePath: string) => Promise<boolean>;
  /** Drop the worktree association, returning true only when confirmed gone. */
  removeSpaceAssociation: (ref: AgentHostRef) => Promise<boolean>;
  /** Remove a checkout that was never adopted into herdr. */
  removeGitWorktree: (
    worktreePath: string,
    repoCwd: string,
  ) => Promise<boolean>;
  /** Delete the branch a removed worktree carried once it is merged and unattached. */
  deleteBranch: (options: DeleteBranchOptions) => Promise<BranchCleanupResult>;
  /** Close a run's own placement; the host decides whether the address is safe to close. */
  closeRunPlacement: (ref: AgentHostRef) => Promise<void>;
  /**
   * Undo the harness state left behind by each run engaged by the environment,
   * each at the address it prepared — ordered before any worktree dirty probe;
   * see Harness.teardown. The bound actuator resolves each run's harness and
   * supplies the pi instance. Any teardown failure is logged rather than
   * thrown, and remaining runs still execute: one bad harness cannot keep the
   * worktree.
   */
  teardownEnvironment: (request: EnvironmentTeardown) => Promise<void>;
}

/** One run whose harness state cleanup must undo, at the address it prepared. */
export interface RunTeardown {
  readonly harness: AnyHarnessId;
  /** The pane the run prepared; null when the pane is already gone. */
  readonly paneId: string | null;
  /** The tree the run prepared; null when no directory address is known. */
  readonly cwd: string | null;
}

/** All runs engaged by an environment, oldest first, and the subagent ID under which they report. */
export interface EnvironmentTeardown {
  readonly subagentId: string;
  readonly runs: readonly RunTeardown[];
}

/* ── The locator half ──────────────────────────────────────────────────── */

export interface PaneRef {
  readonly paneId: string;
}

/** One artifact pair answering to a contested id (ambiguity payload). */
interface LocatedCandidate {
  worktreePath: string;
  branch: string;
  workspaceId?: string;
}

/** The located artifacts plus where they came from. */
export interface Located extends LocatedArtifacts {
  kind: "located";
  /** `tracked` (spawn record named them) or `recovered` (discovery did). */
  source: CleanupSource;
}

/** Two artifacts answer to one id. The caller arbitrates; cleanup refuses. */
export interface Ambiguous {
  kind: "ambiguous";
  id: string;
  candidates: readonly LocatedCandidate[];
}

/** Nothing answers to this id (no record, worktree, or proven branch). */
interface NotFound {
  kind: "not-found";
  id: string;
}

export type LocateResult = Located | Ambiguous | NotFound;

/**
 * The space an agent occupies: the workspace whose removal takes it with it, and
 * the checkout it works in. Tearing down is shared — several agents can live in
 * one workspace, each in its own tab, and a checkout is what they share — so
 * this is what cleanup asks about before removing anything.
 */
export interface SpaceKey {
  readonly workspaceId: string;
  /** The checkout whose removal would take the worktree out from under an agent. */
  readonly checkoutPath?: string;
}

/** The seam: locate an agent's artifacts, then act on them. Injected probes are function-typed properties (see CleanupDeps). */
export interface AgentAssets extends CleanupDeps {
  /**
   * The multiplexer every address this seam builds belongs to (see hostRefFor in
   * agent-cleanup.ts). It rides here rather than on `CleanupDeps` because only
   * the locator produces addresses; the allocation-failure path consumes them.
   */
  multiplexer: AgentMultiplexer;
  /** Run's deliverable, derived from the id alone without probing the run; reported, never deleted. */
  deliverable: (id: string) => RecoveredDeliverable;
  /** Locate one agent's artifacts (hint, else discovery); never stops anything — the pane is an address, not a process. */
  locate(id: string, hint?: AgentSpawn): Promise<LocateResult>;
  /**
   * Every other agent still living in a space. A workspace can host several
   * agents' tabs, so tearing one down is only safe once nothing else is left in
   * it — a failed read throws, since unreadable is not empty and cleanup must not
   * remove a space it cannot prove is empty.
   */
  otherTenants(space: SpaceKey, self: string): Promise<readonly string[]>;
  /** Raw liveness read: undefined = gone, a throw = unreadable (never evidence the run is over); no settlement verdict. */
  observe(pane: PaneRef): Promise<HostObservation | undefined>;
}

/** Raw single-plane probes; matching/authority/ambiguity stay in this module so tests fake the planes. Injected probes are function-typed properties (see CleanupDeps). */
export interface AgentAssetsDeps extends CleanupDeps {
  /** The multiplexer every address this seam builds belongs to. */
  multiplexer: AgentMultiplexer;
  /** Canonicalize a path the way the multiplexer spells its placements (see PlacementCatalog). */
  canonicalizePath: (value: string) => string;
  /** Run's deliverable and whether it exists. */
  deliverable: (id: string) => RecoveredDeliverable;
  /** Raw multiplexer registry read (the multiplexer's `worktree list`); a throw degrades discovery. */
  listWorktrees: () => Promise<readonly PlacementWorktree[]>;
  /** Raw multiplexer placement records (the multiplexer's `agent list`), nameless ones included. */
  listPlacements: () => Promise<readonly PlacementRecord[]>;
  /** One pane's raw state; undefined = gone, a throw = unreadable. */
  readPane(paneId: string): Promise<HostObservation | undefined>;
  /** The worktree root extension worktrees live under; undefined = unresolvable. */
  worktreeRoot(): Promise<string | undefined>;
  /** The configured prefix on generated names; may be empty. */
  worktreePrefix(): string;
  /** Entry names directly under `root` (the filesystem fallback). */
  listRootEntries(root: string): Promise<readonly string[]>;
  /** Main-checkout cwd derived from a checkout; undefined = it could not be resolved. */
  resolveRepoCwd(worktreePath: string): Promise<string | undefined>;
}

interface WorktreeCandidate {
  path: string;
  branch: string;
  workspaceId?: string;
}

/** A registry read that may have failed — absence and unreadability differ. */
type Probe<T> = { ok: true; entries: readonly T[] } | { ok: false };

async function probeList<T>(
  read: () => Promise<readonly T[]>,
): Promise<Probe<T>> {
  try {
    return { ok: true, entries: await read() };
  } catch {
    // Unreadable is not empty: callers keep memory's answer rather than concluding absence.
    return { ok: false };
  }
}

function matchWorktree(
  entries: readonly PlacementWorktree[] | undefined,
  worktreePath: string,
  canonicalize: (value: string) => string,
): PlacementWorktree | undefined {
  const wanted = canonicalize(worktreePath);
  return entries?.find((entry) => canonicalize(entry.path) === wanted);
}

function paneOf(record: PlacementRecord): LocatedPane {
  return {
    paneId: record.paneId,
    tabId: record.tabId,
    workspaceId: record.workspaceId,
  };
}

/**
 * The live placement for a tracked run: the record herdr reports in that run's
 * checkout, or memory's address when the registry has nothing to say. A restart
 * or a re-adopt mints new ids, so the live record wins — but only when it is the
 * only one there, since a checkout can now host several agents and memory's
 * address is the one run this cleanup is about.
 */
function livePaneFor(
  records: readonly PlacementRecord[] | undefined,
  recorded: LocatedPane | null,
  worktreePath: string | undefined,
  canonicalize: (value: string) => string,
): LocatedPane | undefined {
  if (worktreePath === undefined) return recorded ?? undefined;
  const inCheckout = (records ?? []).filter(
    (entry) =>
      entry.cwd !== undefined &&
      canonicalize(entry.cwd) === canonicalize(worktreePath),
  );
  return inCheckout.length === 1
    ? paneOf(inCheckout[0]!)
    : (recorded ?? undefined);
}

/**
 * The one placement record in a checkout or workspace, or undefined when the
 * answer is not unique. Discovery knows a run's id, not its name, so a second
 * agent in the same checkout makes the pane ambiguous — and picking one anyway
 * would let cleanup close a sibling's pane.
 */
function solePaneAmong(
  records: readonly PlacementRecord[] | undefined,
  matches: (entry: PlacementRecord) => boolean,
): LocatedPane | undefined {
  const found = records?.filter(matches) ?? [];
  return found.length === 1 ? paneOf(found[0]!) : undefined;
}

/** Bind the seam over injected probes. */
export function createAgentAssets(deps: AgentAssetsDeps): AgentAssets {
  async function root(): Promise<string | undefined> {
    try {
      return await deps.worktreeRoot();
    } catch {
      return undefined;
    }
  }

  /**
   * Extension-owned worktrees answering to `id` (basename IS the branch, so
   * matching is exact). Herdr's registry first; the root scan covers trees
   * created but never adopted (failed launches herdr never heard of). Outside
   * a resolvable root is not ours.
   */
  async function discoverCandidates(
    id: string,
    entries: readonly PlacementWorktree[] | undefined,
  ): Promise<WorktreeCandidate[]> {
    const worktreeRoot = await root();
    const out: WorktreeCandidate[] = [];
    const seen = new Set<string>();
    const push = (candidate: WorktreeCandidate): void => {
      const key = deps.canonicalizePath(candidate.path);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(candidate);
    };

    for (const entry of entries ?? []) {
      const base = path.basename(entry.path);
      if (!isSpawnArtifactName(base, id)) continue;
      if (
        worktreeRoot !== undefined &&
        !isExtensionWorktree(entry.path, worktreeRoot)
      )
        continue;
      push({
        path: entry.path,
        // Basename is the branch by construction; herdr's report wins when it agrees on the id (catches directory/branch drift).
        branch:
          entry.branch !== undefined && isSpawnArtifactName(entry.branch, id)
            ? entry.branch
            : base,
        workspaceId: entry.workspaceId,
      });
    }

    // Scan only when the registry answered nothing: adopted checkouts are already listed.
    if (out.length > 0 || worktreeRoot === undefined) return out;
    for (const name of await deps.listRootEntries(worktreeRoot)) {
      if (!isSpawnArtifactName(name, id)) continue;
      push({ path: path.join(worktreeRoot, name), branch: name });
    }
    return out;
  }

  function candidateSummary(candidate: WorktreeCandidate): LocatedCandidate {
    return {
      worktreePath: candidate.path,
      branch: candidate.branch,
      workspaceId: candidate.workspaceId,
    };
  }

  async function locateTracked(
    id: string,
    hint: AgentSpawn,
    entries: readonly PlacementWorktree[] | undefined,
    records: readonly PlacementRecord[] | undefined,
  ): Promise<LocateResult> {
    const recorded = hint.execution.host;
    const worktreeCoords = hint.display.worktree;
    // Ownership rides with the coordinates: a picked tree is never owned,
    // so memory's path is read only for owned runs.
    const managed = worktreeCoords?.kind === "owned";
    const recordedPane: LocatedPane | null = recorded
      ? {
          paneId: recorded.paneId,
          tabId: recorded.tabId,
          workspaceId: recorded.workspaceId,
        }
      : null;
    const source: CleanupSource = "tracked";
    let worktreePath =
      worktreeCoords?.kind === "owned" ? worktreeCoords.path : undefined;
    let workspaceId = recorded?.workspaceId;

    if (worktreePath !== undefined) {
      // Prefer herdr's live workspace (restarts/re-adopts mint new ids; a dead recorded one fails removal); no open workspace means the git plane removes it.
      const entry = matchWorktree(entries, worktreePath, deps.canonicalizePath);
      if (entry !== undefined) workspaceId = entry.workspaceId;
    }

    // The run's own pane, never merely a pane in its checkout: a checkout can
    // host several agents, and closing a sibling's pane is not this run's
    // cleanup. With no recorded address there is no identity to match on, so a
    // checkout's pane is used only when exactly one exists.
    const pane =
      recordedPane !== null
        ? (livePaneFor(
            records,
            recordedPane,
            worktreePath,
            deps.canonicalizePath,
          ) ?? recordedPane)
        : worktreePath === undefined
          ? null
          : (solePaneAmong(
              records,
              (entry) =>
                entry.cwd !== undefined &&
                deps.canonicalizePath(entry.cwd) ===
                  deps.canonicalizePath(worktreePath),
            ) ?? null);
    const worktree =
      worktreePath === undefined
        ? null
        : {
            path: worktreePath,
            workspaceId,
            repoCwd: await deps.resolveRepoCwd(worktreePath),
          };
    return {
      kind: "located",
      source,
      id,
      // The run's branch: its worktree's when it has one, else the generated
      // `<prefix><task>-<id>` name parent-cwd runs launch under.
      branch:
        worktreeCoords?.branch ??
        buildWorktreeBranch(
          hint.display.taskSlug ?? slugifyWorktreeType(hint.display.type),
          hint.id,
          deps.worktreePrefix(),
        ),
      worktreeManaged: managed || worktree !== null,
      paneCreated: recorded?.paneCreated === true,
      worktree,
      pane,
    };
  }

  async function locateDiscovered(
    id: string,
    entries: readonly PlacementWorktree[] | undefined,
    records: readonly PlacementRecord[] | undefined,
  ): Promise<LocateResult> {
    const candidates = await discoverCandidates(id, entries);
    if (candidates.length === 0) return { kind: "not-found", id };
    if (candidates.length > 1) {
      return {
        kind: "ambiguous",
        id,
        candidates: candidates.map(candidateSummary),
      };
    }
    const found = candidates[0]!;
    // Nobody recorded a pane for this run, so the checkout and the workspace are
    // the only links to it — and either can now answer with a sibling agent's
    // placement. A pane is adopted from here only when one alone answers; an
    // ambiguous one is left null, which leaves any pane standing rather than
    // closing the wrong one.
    const pane =
      solePaneAmong(
        records,
        (entry) =>
          entry.cwd !== undefined &&
          deps.canonicalizePath(entry.cwd) ===
            deps.canonicalizePath(found.path),
      ) ??
      solePaneAmong(
        records,
        (entry) => entry.workspaceId === found.workspaceId,
      ) ??
      null;
    return {
      kind: "located",
      source: "recovered",
      id,
      branch: found.branch,
      // Discovery yields only extension-owned checkouts, but nobody survived to claim the pane: adopted, never closed.
      worktreeManaged: true,
      paneCreated: false,
      worktree: {
        path: found.path,
        workspaceId: found.workspaceId,
        repoCwd: await deps.resolveRepoCwd(found.path),
      },
      pane,
    };
  }

  async function locate(id: string, hint?: AgentSpawn): Promise<LocateResult> {
    const worktrees = await probeList(deps.listWorktrees);
    const records = await probeList(deps.listPlacements);
    const entries = worktrees.ok ? worktrees.entries : undefined;
    const live = records.ok ? records.entries : undefined;
    return hint === undefined
      ? locateDiscovered(id, entries, live)
      : locateTracked(id, hint, entries, live);
  }

  /**
   * The other agents in a space, by name where herdr reports one and by pane id
   * otherwise. A space is shared two ways — the workspace they sit in, and the
   * checkout they work in — so a match on either counts as a tenant.
   *
   * A failed read throws instead of answering "none": a space cleanup could not
   * prove empty is one it must not remove. `self` is excluded by pane id, since
   * the name a record carries is not guaranteed to be this agent's.
   */
  async function otherTenants(
    space: SpaceKey,
    self: string,
  ): Promise<readonly string[]> {
    const records = await deps.listPlacements();
    const wantedCheckout =
      space.checkoutPath === undefined
        ? undefined
        : deps.canonicalizePath(space.checkoutPath);
    return records
      .filter((record) => {
        if (record.paneId === self) return false;
        if (record.workspaceId === space.workspaceId) return true;
        return (
          wantedCheckout !== undefined &&
          record.cwd !== undefined &&
          deps.canonicalizePath(record.cwd) === wantedCheckout
        );
      })
      .map((record) => record.name ?? record.paneId);
  }

  return {
    multiplexer: deps.multiplexer,
    locate,
    otherTenants,
    observe: (pane) => deps.readPane(pane.paneId),
    deliverable: deps.deliverable,
    isWorktreeDirty: deps.isWorktreeDirty,
    worktreeExists: deps.worktreeExists,
    removeSpaceAssociation: deps.removeSpaceAssociation,
    removeGitWorktree: deps.removeGitWorktree,
    deleteBranch: deps.deleteBranch,
    closeRunPlacement: deps.closeRunPlacement,
    teardownEnvironment: deps.teardownEnvironment,
  };
}

/* ── The multiplexer composition ────────────────────────────────────────────── */

/**
 * Bind the seam to a session's multiplexer: the multiplexer's own reads come from the
 * runtime's `PlacementCatalog` and its actuators from the runtime's `AgentHost`,
 * so this module names no multiplexer. The rest — git, the filesystem, the config —
 * is multiplexer-neutral and bound here. Failed repo derivation is `undefined` (never
 * a borrowed cwd); failed pane reads throw (unreadable is not gone).
 */
export function createMultiplexerAgentAssets(
  pi: ExtensionAPI,
  host: AgentHost,
  catalog: PlacementCatalog,
): AgentAssets {
  return createAgentAssets({
    multiplexer: catalog.multiplexer,
    canonicalizePath: (value) => catalog.canonicalizePath(value),
    deliverable: (id) => {
      const resultFile = subagentResultFileFor(id);
      return { path: resultFile, present: fs.existsSync(resultFile) };
    },
    listWorktrees: () => catalog.listWorktrees(),
    listPlacements: () => catalog.listPlacements(),
    readPane: (paneId) => catalog.observePane(paneId),
    worktreeRoot: async () => {
      const cwd = getSessionCtx().cwd;
      if (!cwd) return undefined;
      const repoRoot = await resolveMainCheckout(pi, cwd).catch(
        () => undefined,
      );
      return repoRoot === undefined
        ? undefined
        : resolveWorktreeRoot(getStore().agent.worktreeRoot, repoRoot);
    },
    worktreePrefix: () => getStore().agent.worktreePrefix,
    listRootEntries: async (worktreeRoot) => {
      try {
        return await fs.promises.readdir(worktreeRoot);
      } catch {
        // A missing root holds no worktrees — a genuine empty answer.
        return [];
      }
    },
    resolveRepoCwd: async (worktreePath) => {
      try {
        return await resolveMainCheckout(pi, worktreePath);
      } catch {
        // No cwd beats a borrowed one (a wrong-repo cwd aims `git branch -D` at another repo's branch).
        return undefined;
      }
    },
    isWorktreeDirty: (worktreePath) => isWorktreeDirty(pi, worktreePath),
    worktreeExists: async (worktreePath) => fs.existsSync(worktreePath),
    removeSpaceAssociation: (ref) => host.release(ref, "worktree-association"),
    removeGitWorktree: async (worktreePath, repoCwd) => {
      await removeGitWorktree(pi, repoCwd, worktreePath);
      return !fs.existsSync(worktreePath);
    },
    deleteBranch: (options) =>
      deleteWorktreeBranch(pi, options, (candidate) =>
        host.isAttached(candidate, { repoCwd: options.repoCwd }),
      ),
    closeRunPlacement: async (ref) => {
      // A settled tracked run's own placement is cleanup's to close even when it
      // adopted the workspace's root pane. Failed-launch cleanup still uses the
      // provenance-gated "placement" scope directly.
      await host.release({ ...ref, paneCreated: true }, "placement");
    },
    teardownEnvironment: async ({ subagentId, runs }) => {
      // The IDs are read back from recorded runs rather than resolved here, so
      // a plugin reload or session replacement between launch and teardown
      // can leave a harness ID unregistered. Such an ID has no teardown to run —
      // the plugin's code went with its registration — which is the same success
      // as a harness that never prepared.
      const harnesses = getHarnessRegistry();
      for (const run of runs) {
        try {
          await harnesses.get(run.harness)?.teardown({
            pi,
            paneId: run.paneId,
            cwd: run.cwd,
            subagentId,
          });
        } catch (error: unknown) {
          log.warn("harness teardown failed during environment teardown", {
            subagentId,
            harness: run.harness,
            error: errorMessage(error),
          });
        }
      }
    },
  });
}
