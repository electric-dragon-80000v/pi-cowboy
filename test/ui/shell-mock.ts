/**
 * shell-mock.ts — composition-root shell faked for UI tests (vi.mock over src/shell.js).
 * Only the getters the menu layer calls; a new one fails loudly, never silently real.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../../src/config/config-store.js";
import type {
  CowAvailabilityClaim,
  SessionTemplates,
} from "../../src/shell.js";
import { AgentSpawnStore } from "../../src/agents/agent-spawn-store.js";
import { resolveHarness, type HarnessId } from "../../src/agents/harness.js";
import {
  resolveWorktreeMaterialization,
  type WorktreeMaterialization,
} from "../../src/spawn/worktree-policy.js";
import { unprobed, type Availability } from "../../src/availability.js";
import { RepoLock } from "../../src/spawn/repo-lock.js";
import type { PresenceMarker } from "../../src/ui/indicator.js";

/** Empty template registries — the state a fresh shell starts from. */
function emptyTemplates(): SessionTemplates {
  return {
    agents: {
      agents: new Map(),
      scanDirs: { user: "", project: "", shared: "" },
    },
    orchestrators: {
      orchestrators: new Map(),
      scanDirs: { user: "", project: "", shared: "" },
    },
  };
}

/** Mutable per-test shell state; resetShell() clears it. */
export const shellState = {
  store: undefined as unknown as ConfigStore,
  session: undefined as ExtensionContext | undefined,
  pi: undefined as unknown,
  coordinator: null as unknown,
  manager: null as unknown,
  runtime: null as unknown,
  sessionTemplates: emptyTemplates(),
  agentSpawns: new AgentSpawnStore(),
  indicatorMarker: null as PresenceMarker | null,
  repoLock: new RepoLock(),
  cowAvailability: unprobed() as Availability<WorktreeMaterialization>,
  cowAvailabilityClaim: 0,
  harnessAvailability: unprobed() as Availability<HarnessId>,
};

export function setStore(store: ConfigStore): void {
  shellState.store = store;
}

export function setCoordinator(coordinator: unknown): void {
  shellState.coordinator = coordinator;
}

export function setManager(manager: unknown): void {
  shellState.manager = manager;
}

export function setPi(pi: unknown): void {
  shellState.pi = pi;
}

export function setSession(session: ExtensionContext | undefined): void {
  shellState.session = session;
}

export function setRuntime(runtime: unknown): void {
  shellState.runtime = runtime;
}

export function resetShell(): void {
  shellState.store = undefined as unknown as ConfigStore;
  shellState.session = undefined;
  shellState.pi = undefined;
  shellState.coordinator = null;
  shellState.manager = null;
  shellState.runtime = null;
  shellState.sessionTemplates = emptyTemplates();
  shellState.agentSpawns = new AgentSpawnStore();
  shellState.indicatorMarker = null;
  shellState.repoLock = new RepoLock();
  // A session teardown invalidates any probe still in flight, exactly as a new
  // probe does: a verdict from the previous test must not land in this one.
  shellState.cowAvailabilityClaim += 1;
  shellState.cowAvailability = unprobed();
  shellState.harnessAvailability = unprobed();
}

// Getters mirroring src/shell.js.
export const getStore = (): ConfigStore => shellState.store;
export const getSessionCtx = (): ExtensionContext | undefined =>
  shellState.session;
export const getPiInstance = (): unknown => shellState.pi;
export const getCoordinator = (): unknown => shellState.coordinator;
export const getCoordinatorOrNull = (): unknown => shellState.coordinator;
export const getManager = (): unknown => shellState.manager;
export const getManagerOrNull = (): unknown => shellState.manager;
export const getRuntime = (): unknown => shellState.runtime;
export const getSessionTemplates = (): SessionTemplates =>
  shellState.sessionTemplates;
export const getAgentSpawns = (): AgentSpawnStore => shellState.agentSpawns;
export const getIndicatorMarker = (): PresenceMarker | null =>
  shellState.indicatorMarker;
export const setIndicatorMarker = (marker: PresenceMarker | null): void => {
  shellState.indicatorMarker = marker;
};
export const getRepoLock = (): RepoLock => shellState.repoLock;
export const getCowAvailability = (): Availability<WorktreeMaterialization> =>
  shellState.cowAvailability;
export const beginCowAvailabilityProbe = (): CowAvailabilityClaim => {
  shellState.cowAvailabilityClaim += 1;
  return shellState.cowAvailabilityClaim;
};
export const setCowAvailability = (
  claim: CowAvailabilityClaim,
  availability: Availability<WorktreeMaterialization>,
): boolean => {
  if (claim !== shellState.cowAvailabilityClaim) return false;
  shellState.cowAvailability = availability;
  return true;
};
export const getWorktreeMaterialization = (): string =>
  resolveWorktreeMaterialization(
    shellState.store.agent.worktreeMaterialization,
    shellState.cowAvailability,
  );
export const getHarnessAvailability = (): Availability<HarnessId> =>
  shellState.harnessAvailability;
export const setHarnessAvailability = (
  availability: Availability<HarnessId>,
): void => {
  shellState.harnessAvailability = availability;
};
export const getHarnessType = (): HarnessId =>
  resolveHarness(
    shellState.store.agent.harnessType,
    shellState.harnessAvailability,
  );
