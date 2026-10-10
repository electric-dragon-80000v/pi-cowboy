/**
 * shell.ts — the single mutable container for all per-session state.
 * Handler modules read via getter functions — no module-level mutable globals.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { ExecutionRuntime } from "./agents/agent-host.js";
import type { AgentConfig } from "./agents/types.js";
import type { OrchestratorConfig } from "./orchestrators/types.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { RepoLock } from "./spawn/repo-lock.js";
import {
  resolveWorktreeMaterialization,
  type WorktreeMaterialization,
} from "./spawn/worktree-policy.js";
import { resolveHarness, type HarnessId } from "./agents/harness.js";
import { unprobed, type Availability } from "./availability.js";
import type { PresenceMarker } from "./ui/indicator.js";
import { AgentSpawnStore } from "./agents/agent-spawn-store.js";
import { ConfigStore } from "./config/config-store.js";
import { SUBAGENT_TOKEN_PREFIX } from "./paths.js";

/** Directories a session's template registries scan; "" leaves that layer off. */
interface TemplateScanDirs {
  readonly user: string;
  readonly project: string;
  readonly shared: string;
}

/** The agent templates a session registered, plus the dirs later discovery scans. */
export interface AgentTemplateRegistry {
  agents: Map<string, AgentConfig>;
  scanDirs: TemplateScanDirs;
}

/** The orchestrator templates a session registered, plus the dirs discovery scans. */
export interface OrchestratorTemplateRegistry {
  orchestrators: Map<string, OrchestratorConfig>;
  scanDirs: TemplateScanDirs;
}

/** The template registries one session scans into. */
export interface SessionTemplates {
  readonly agents: AgentTemplateRegistry;
  readonly orchestrators: OrchestratorTemplateRegistry;
}

const NO_SCAN_DIRS: TemplateScanDirs = { user: "", project: "", shared: "" };

/** Empty registries — the state every session starts from. */
export function createSessionTemplates(): SessionTemplates {
  return {
    agents: { agents: new Map(), scanDirs: NO_SCAN_DIRS },
    orchestrators: { orchestrators: new Map(), scanDirs: NO_SCAN_DIRS },
  };
}

interface Shell {
  pi: ExtensionAPI | null;
  sessionCtx: ExtensionContext | null;
  manager: AgentManager | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
  runtime: ExecutionRuntime | null;
  agentSpawns: AgentSpawnStore;
  repoLock: RepoLock;
  sessionTemplates: SessionTemplates;
  indicatorMarker: PresenceMarker | null;
  cowAvailability: Availability<WorktreeMaterialization>;
  /** Which probe may write `cowAvailability`: the claim number of the newest one started. */
  cowAvailabilityClaim: number;
  harnessAvailability: Availability<HarnessId>;
}

const shell: Shell = {
  // Bound by the extension factory / session_start, in that order.
  pi: null,
  sessionCtx: null,
  manager: null,
  store: new ConfigStore(),
  coordinator: null,
  runtime: null,
  agentSpawns: new AgentSpawnStore(),
  repoLock: new RepoLock(),
  sessionTemplates: createSessionTemplates(),
  indicatorMarker: null,
  cowAvailability: unprobed(),
  cowAvailabilityClaim: 0,
  harnessAvailability: unprobed(),
};

export function getPiInstance(): ExtensionAPI {
  if (shell.pi === null) {
    throw new Error("pi instance read before the extension factory bound it");
  }
  return shell.pi;
}

export function getSessionCtx(): ExtensionContext {
  if (shell.sessionCtx === null) {
    throw new Error("session context read before session_start fired");
  }
  return shell.sessionCtx;
}

/**
 * The session's manager. A tool only runs in a session whose start bound one,
 * so a read outside that window is a bug to name, not a state to branch on.
 */
export function getManager(): AgentManager {
  if (shell.manager === null) {
    throw new Error("agent manager read outside a live session");
  }
  return shell.manager;
}

/**
 * The manager when a live session has bound one — for lifecycle and menu paths
 * that must degrade instead of running.
 */
export function getManagerOrNull(): AgentManager | null {
  return shell.manager;
}

export function getStore(): ConfigStore {
  return shell.store;
}

/**
 * The mounted presence marker. It owns both its overlay handle and the poll
 * keeping it current, so taking it down is its own business — this slot is only
 * who is mounted.
 */
export function getIndicatorMarker(): PresenceMarker | null {
  return shell.indicatorMarker;
}

export function setIndicatorMarker(marker: PresenceMarker | null): void {
  shell.indicatorMarker = marker;
}

/**
 * Deliberately never reset — not by setManager, not by shutdown — so spawns
 * outlive a same-process session replacement (/new, /resume, /fork) and stay
 * listed and cleanable. Rebuilt empty by a /reload, which re-imports this module.
 */
export function getAgentSpawns(): AgentSpawnStore {
  return shell.agentSpawns;
}

/**
 * The session's one repository lock, shared by every worktree-creating flow so two
 * spawns cannot both hold it. Deliberately never reset: a run holding it must keep
 * excluding the runs queued behind it, even across a session replacement.
 */
export function getRepoLock(): RepoLock {
  return shell.repoLock;
}

/**
 * The session's coordinator. A spawn only happens inside a live session, whose
 * start bound one, so a read outside that window is a bug to name.
 */
export function getCoordinator(): SpawnCoordinator {
  if (shell.coordinator === null) {
    throw new Error("spawn coordinator read outside a live session");
  }
  return shell.coordinator;
}

/**
 * The coordinator when a live session has bound one — for lifecycle paths that
 * must degrade instead of running.
 */
export function getCoordinatorOrNull(): SpawnCoordinator | null {
  return shell.coordinator;
}

/** Which materializations the worktree volume can honor; unknown until the probe lands. */
export function getCowAvailability(): Availability<WorktreeMaterialization> {
  return shell.cowAvailability;
}

/**
 * A probe's claim on the `cowAvailability` slot. Probes are fire-and-forget and
 * can finish out of order, so a verdict is only worth anything together with the
 * claim it was taken under: the volume it describes is the one the newest probe
 * asked about.
 */
export type CowAvailabilityClaim = number;

/**
 * Open a claim for a probe that is starting. Every claim opened earlier is now
 * stale, so a slower one cannot land on top of this one.
 */
export function beginCowAvailabilityProbe(): CowAvailabilityClaim {
  shell.cowAvailabilityClaim += 1;
  return shell.cowAvailabilityClaim;
}

/** Record a verdict, but only under the current claim. Answers whether it was recorded. */
export function setCowAvailability(
  claim: CowAvailabilityClaim,
  availability: Availability<WorktreeMaterialization>,
): boolean {
  if (claim !== shell.cowAvailabilityClaim) return false;
  shell.cowAvailability = availability;
  return true;
}

/** Which harnesses this machine can launch; unknown until the launch probe lands. */
export function getHarnessAvailability(): Availability<HarnessId> {
  return shell.harnessAvailability;
}

export function setHarnessAvailability(
  availability: Availability<HarnessId>,
): void {
  shell.harnessAvailability = availability;
}

/**
 * The materialization this session's spawns use: the setting, narrowed to what
 * the worktree volume can actually do. Every reader goes through this, so the
 * menu, the wizard and the launcher cannot disagree.
 */
export function getWorktreeMaterialization(): WorktreeMaterialization {
  return resolveWorktreeMaterialization(
    shell.store.agent.worktreeMaterialization,
    shell.cowAvailability,
  );
}

/**
 * The harness this session's spawns use: the setting, narrowed to what this
 * machine can launch. Every reader goes through the spawn defaults, so the menu
 * and a spawn cannot disagree.
 */
export function getHarnessType(): HarnessId {
  return resolveHarness(
    shell.store.agent.harnessType,
    shell.harnessAvailability,
  );
}

export function getRuntime(): ExecutionRuntime | null {
  return shell.runtime;
}

export function getSessionTemplates(): SessionTemplates {
  return shell.sessionTemplates;
}

export function setPiInstance(pi: ExtensionAPI): void {
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  shell.manager = m;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  shell.coordinator = c;
}

export function setRuntime(r: ExecutionRuntime | null): void {
  shell.runtime = r;
}

/**
 * Installs a session's template registries. A session start installs empty ones,
 * so a session that replaced another can never read the replaced one's templates.
 */
export function setSessionTemplates(next: SessionTemplates): void {
  shell.sessionTemplates = next;
}

/** The token within one argv entry; the id is a spawn id or an agent name. */
const SUBAGENT_TOKEN = new RegExp(`${SUBAGENT_TOKEN_PREFIX}([A-Za-z0-9_-]+)`);

/**
 * Agent id from our argv's subagent token, or undefined in a root session. The
 * marker is written by `subagentTokenFor`; this is its only reader.
 */
export function detectSubagentSpawn(
  argv: readonly string[] = process.argv,
): string | undefined {
  for (const arg of argv) {
    const match = SUBAGENT_TOKEN.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}

export function isInsideHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}
