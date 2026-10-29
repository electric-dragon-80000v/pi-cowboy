/**
 * events.ts — session lifecycle wiring.
 * session_start loads the config, brings the session runtime up (plugins included),
 * and — when a multiplexer can host the process — scans the templates, wires the
 * manager + coordinator, then puts the active set and the presence marker in line
 * with the switch; the tool_call listener injects resolved models.
 */

import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { agentDir } from "./paths.js";
import {
  registerAgents,
  setAgentScanDirs,
  scanAndMerge,
} from "./agents/agent-types.js";
import {
  registerOrchestrators,
  setOrchestratorScanDirs,
  scanAndMergeOrchestrators,
} from "./orchestrators/orchestrator-types.js";
import {
  AgentManager,
  createAgentManagerTransport,
} from "./agents/agent-manager.js";
import type { ExecutionRuntime } from "./agents/agent-host.js";
import { ConcurrencyPools } from "./concurrency-pools.js";
import { ACTIVE_AGENT_PHASES } from "./types.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { activateExtension, deactivateExtension } from "./registration.js";
import { startCowSupportProbe } from "./cow-support-launch.js";
import { type LoadedPlugins } from "./plugin/loader.js";
import { startSessionRuntime } from "./session-runtime.js";
import { isExtensionEnabled } from "./extension-toggle.js";
import { hideExtensionIndicator } from "./ui/indicator.js";
import {
  createSessionTemplates,
  getManagerOrNull,
  getCoordinatorOrNull,
  getRuntime,
  getStore,
  setSessionCtx,
  setManager,
  setCoordinator,
  setRuntime,
  setSessionTemplates,
} from "./shell.js";

/**
 * Wire the fleet controller and the spawn coordinator from the session's one
 * runtime: the manager's transport is built from it (see
 * createAgentManagerTransport), so a spawn reuses the multiplexer's host, view and
 * pane instead of building a second multiplexer per call. Idempotent — safe to call
 * on every session_start.
 */
function wireManagerAndCoordinator(runtime: ExecutionRuntime): void {
  if (!getManagerOrNull()) {
    const newManager = new AgentManager(
      new ConcurrencyPools(getStore().concurrency),
      createAgentManagerTransport(runtime),
    );
    setManager(newManager);
    // Config side-effect target: concurrency setters call setConcurrency.
    getStore().setDeps({ manager: newManager });

    const coordinator = new SpawnCoordinator(newManager);
    setCoordinator(coordinator);

    newManager.setOnComplete((spawn) => {
      coordinator.onAgentComplete(spawn);
    });
    newManager.setOnFollowUp((spawn, deliverable) => {
      coordinator.onAgentFollowUp(spawn, deliverable);
    });
  }
}

async function scanAndRegisterAgents(ctx: ExtensionContext): Promise<void> {
  const agentDirPath = agentDir();
  const userAgentDir = path.join(agentDirPath, "agents");
  const projectTrusted = ctx.isProjectTrusted();
  const sharedAgentDir = projectTrusted
    ? path.join(ctx.cwd, ".agents", "agents")
    : "";
  const projectAgentDir = projectTrusted
    ? path.join(ctx.cwd, ".pi", "agents")
    : "";

  // Scan dirs persist for on-demand discovery later in the session.
  setAgentScanDirs(userAgentDir, projectAgentDir, sharedAgentDir);

  const disableDefaults = getStore().agent.disableDefaultAgents;

  const merged = await scanAndMerge({
    disableDefaultAgents: disableDefaults,
    // The sink makes skipped malformed files visible.
    notify: (message, kind) => {
      ctx.ui.notify(message, kind);
    },
  });

  registerAgents(merged, { disableDefaultAgents: disableDefaults });
}

async function scanAndRegisterOrchestrators(
  ctx: ExtensionContext,
): Promise<void> {
  const agentDirPath = agentDir();
  const userOrchestratorDir = path.join(agentDirPath, "orchestrators");
  const projectTrusted = ctx.isProjectTrusted();
  const sharedOrchestratorDir = projectTrusted
    ? path.join(ctx.cwd, ".agents", "orchestrators")
    : "";
  const projectOrchestratorDir = projectTrusted
    ? path.join(ctx.cwd, ".pi", "orchestrators")
    : "";

  // Scan dirs persist for on-demand discovery later in the session.
  setOrchestratorScanDirs(
    userOrchestratorDir,
    projectOrchestratorDir,
    sharedOrchestratorDir,
  );

  const merged = await scanAndMergeOrchestrators({
    // The sink makes skipped malformed files visible.
    notify: (message, kind) => {
      ctx.ui.notify(message, kind);
    },
  });

  registerOrchestrators(merged);
}

/**
 * Config: everything the runtime needs to resolve the session's plugins and its
 * multiplexer. The template scans wait for the host decision (see
 * session_start), and the manager is wired later still (see
 * wireManagerAndCoordinator).
 */
async function loadSessionConfig(ctx: ExtensionContext): Promise<void> {
  // Fresh registries before the scan: a session never serves the templates registered by the session it replaced.
  setSessionTemplates(createSessionTemplates());
  // Mirrors the .pi/agents scan-dir trust gate.
  const projectDir = ctx.isProjectTrusted()
    ? path.join(ctx.cwd, ".pi")
    : undefined;
  // The session's first read of the config files: the project layer is only
  // read once the trust gate above has decided which directory it is.
  getStore().setProjectDir(projectDir);
  getStore().reload();
}

/** Scan the agent and orchestrator templates a hosted session offers. */
async function scanSessionTemplates(ctx: ExtensionContext): Promise<void> {
  await scanAndRegisterAgents(ctx);
  await scanAndRegisterOrchestrators(ctx);
}

export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  // The one plugin load of this process; disposed and forgotten at shutdown so a
  // later session re-imports it.
  let plugins: LoadedPlugins | null = null;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadSessionConfig(ctx);
    // Plugins, the configured multiplexer, and the harness probe — in the order the
    // runtime depends on (see session-runtime.ts).
    const boot = await startSessionRuntime(pi, ctx);
    plugins = boot.plugins;
    if (boot.kind === "unhosted") {
      // Nothing here can launch a pane: leave the registered tools inactive. The
      // template scans and the probes would only describe work this session
      // cannot do. A session whose switch is off is the user's own decision, so
      // the reason is only worth saying while the extension would otherwise run.
      deactivateExtension(ctx.ui);
      if (ctx.hasUI && isExtensionEnabled()) {
        ctx.ui.notify(boot.reason, "warning");
      }
      return;
    }
    // The templates a hosted session offers; the scans wait for the host decision
    // so a session that can launch no agent reads nothing for one.
    await scanSessionTemplates(ctx);
    // The manager's transport is the session's runtime, so every spawn and dedup
    // check reuses one multiplexer instead of rebuilding it.
    wireManagerAndCoordinator(boot.runtime);
    // Awaited: one small clone (~100ms), and awaiting is what guarantees the
    // probe's `finally rm` runs — a fire-and-forget probe orphaned its
    // `.cow-probe-*` directory whenever a quick session exited mid-probe.
    await startCowSupportProbe(pi);
    if (isExtensionEnabled()) {
      activateExtension(ctx.ui);
    } else {
      // A session that replaced an enabled one can still hold the registered tools.
      deactivateExtension(ctx.ui);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "Cowboy extension is disabled — its tools are not loaded. Run /cowboy enable to turn it back on.",
          "info",
        );
      }
    }
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    const currentManager = getManagerOrNull();
    if (currentManager) {
      // Active phases only: only in-flight work is a pane left running.
      const active = currentManager.listAgents(ACTIVE_AGENT_PHASES);
      if (active.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `${active.length} subagent pane(s) left running in their panes (tracking stopped for the previous session)`,
          "warning",
        );
      }
    }
    // Everything but the plugins goes down synchronously, before the first
    // await: a session_start that lands while a plugin disposer runs must find a
    // clean shell (no manager, no coordinator, no store) to wire its own into.
    // Panes keep running in herdr — they are independent processes; only
    // tracking stops.
    getCoordinatorOrNull()?.dispose();
    setCoordinator(null);
    getStore().dispose();
    currentManager?.dispose();
    setManager(null);
    // The marker polls the spawn store on a timer, so it goes with the runtime
    // that owns that store; a reload mounts a fresh one in its place.
    hideExtensionIndicator();
    // Then the plugins, while the session's runtime is still recorded so a
    // disposer that wants the multiplexer can still reach it. Disposal also drops
    // this load's registrations, so the next session starts clean. Only a
    // runtime this shutdown still owns is cleared: one a replacement session has
    // already set is not ours to take away.
    // Captured and cleared *before* the await: a replacement session's start can
    // land while the disposers run, and the handle it sets there must survive
    // this shutdown finishing.
    const dying = plugins;
    plugins = null;
    const runtime = getRuntime();
    await dying?.dispose();
    if (getRuntime() === runtime) setRuntime(null);
    // The session's registries are not cleared here: disposal already undid this
    // load's registrations, and the next session_start installs its own.
  });

  // Ensure the terminal cursor and buffer are ALWAYS restored when exiting
  process.on("exit", () => {
    try {
      // \x1b[?2026l = End synchronized output mode (unfreezes buffered output)
      // \x1b[?25h   = Show hardware cursor (DECTCSR)
      // \x1b[0m     = Reset colors & text attributes (SGR reset)
      process.stderr.write("\x1b[?2026l\x1b[?25h\x1b[0m");
    } catch {
      // Ignore if streams are already closed
    }
  });
}
