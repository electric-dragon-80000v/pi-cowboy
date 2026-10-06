/**
 * index.ts — herdr-pane subagents extension entry point.
 * The tool's per-call `model` parameter is the caller's and is never written
 * by the listener; config lives in ConfigStore.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setPiInstance, setRuntime, isInsideHerdr } from "./shell.js";
import { announceReadyForSpawn } from "./subagent/ipc-protocol.js";
import { createHerdrRuntime } from "./infrastructure/herdr-host.js";
import { missingCloneProgramReport } from "./infrastructure/git/cow-clone.js";
import { registerCowboyCommand, registerTools } from "./registration.js";
import { setupEventListeners } from "./events.js";
import { startCowSupportProbe } from "./cow-support-launch.js";
import { startHarnessAvailabilityProbe } from "./harness-availability-launch.js";

/**
 * Report a failed prerequisite once the UI exists. The entry point has no
 * context, so the message waits for the session event; the extension stays
 * unregistered either way.
 */
function reportInactive(pi: ExtensionAPI, message: string): void {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "error");
    }
  });
}

export default function (pi: ExtensionAPI) {
  // Subagents launch through the parent session's `herdr` CLI.
  if (!isInsideHerdr()) return;
  // Stay inert so subagents can never spawn further subagents — but first tell
  // the parent this process booted.
  if (announceReadyForSpawn()) return;
  // A program the clone path needs is missing, so copy-on-write could never
  // work here. Staying unregistered says so once; a volume that cannot clone
  // still activates and falls back to a classic checkout.
  const prereq = missingCloneProgramReport();
  if (prereq !== undefined) {
    reportInactive(pi, prereq);
    return;
  }
  setPiInstance(pi);
  setRuntime(createHerdrRuntime(pi));
  // Registered once, here: the switch toggles them through the active set.
  registerTools(pi);
  registerCowboyCommand(pi);
  setupEventListeners(pi);
  // What the worktree volume can do decides which materializations stay on offer.
  startCowSupportProbe(pi);
  // Which harnesses are on PATH decides which stay on offer.
  startHarnessAvailabilityProbe();
}
