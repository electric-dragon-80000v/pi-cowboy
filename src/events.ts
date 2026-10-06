/**
 * events.ts — session lifecycle wiring.
 * session_start loads the config and the agent/orchestrator templates, wires the
 * manager + coordinator, then puts the active set and the presence marker in
 * line with the switch; the tool_call listener injects resolved models.
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
import { AgentManager } from "./agents/agent-manager.js";
import { ACTIVE_AGENT_PHASES } from "./types.js";
import { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { toolCallListener } from "./agents/tool-execution.js";
import { activateExtension, deactivateExtension } from "./registration.js";
import { isExtensionEnabled } from "./extension-toggle.js";
import { hideExtensionIndicator } from "./ui/indicator.js";
import {
  createSessionTemplates,
  getManagerOrNull,
  getCoordinatorOrNull,
  getStore,
  setSessionCtx,
  setManager,
  setCoordinator,
  setRuntime,
  setSessionTemplates,
} from "./shell.js";

/** Idempotent — safe to call on every session_start. */
function ensureManagerAndCoordinator(): void {
  if (!getManagerOrNull()) {
    const newManager = new AgentManager(
      undefined,
      getStore().concurrency as unknown as ConstructorParameters<
        typeof AgentManager
      >[1],
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
 * Config, templates, manager and coordinator: everything a session needs
 * whatever the switch says, because the /cowboy menus read the registries.
 */
async function loadSessionConfig(ctx: ExtensionContext): Promise<void> {
  // Fresh registries before the scan: a session never serves the templates registered by the session it replaced.
  setSessionTemplates(createSessionTemplates());
  // Mirrors the .pi/agents scan-dir trust gate.
  const projectDir = ctx.isProjectTrusted()
    ? path.join(ctx.cwd, ".pi")
    : undefined;
  getStore().setProjectDir(projectDir);
  getStore().reload();
  ensureManagerAndCoordinator();
  await scanAndRegisterAgents(ctx);
  await scanAndRegisterOrchestrators(ctx);
}

export function setupEventListeners(pi: ExtensionAPI): void {
  pi.on("tool_call", toolCallListener);

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    setSessionCtx(ctx);
    await loadSessionConfig(ctx);
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
          `${active.length} subagent pane(s) left running in herdr (tracking stopped for the previous session)`,
          "warning",
        );
      }
    }
    // Panes keep running in herdr — they are independent processes; only tracking stops.
    getCoordinatorOrNull()?.dispose();
    setCoordinator(null);
    setRuntime(null);
    getStore().dispose();
    const mgr = getManagerOrNull();
    if (mgr) {
      mgr.dispose();
      setManager(null);
    }
    // The marker polls the spawn store on a timer, so it goes with the runtime
    // that owns that store; a reload mounts a fresh one in its place.
    hideExtensionIndicator();
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
