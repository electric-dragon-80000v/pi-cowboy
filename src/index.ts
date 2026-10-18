/**
 * index.ts — pane-subagent extension entry point: the multiplexer hosting this
 * process decides whether it activates at all (see host-multiplexer.ts).
 * The tool's per-call `model` parameter is the caller's and is never written
 * by the listener; config lives in ConfigStore.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setPiInstance, detectSubagentSpawn } from "./shell.js";
import { getHostMultiplexer } from "./host-multiplexer.js";
import { missingCloneProgramReport } from "./infrastructure/git/cow-clone.js";
import { isInsideGitRepository } from "./infrastructure/git-client.js";
import {
  registerCowboyCommand,
  registerTools,
  registerUnavailableCowboyCommand,
} from "./registration.js";
import { setupEventListeners } from "./events.js";

/** The one reason the extension is unavailable when the session is not inside a git repository. */
const NOT_INSIDE_GIT_REPOSITORY =
  "pi-cowboy needs a git repository: this directory is not inside one, so pi-cowboy stays inactive";

/**
 * Report a failed prerequisite once the UI exists. The entry point has no
 * context, so the message waits for the session event; the extension stays
 * unregistered either way.
 */
function reportInactive(pi: ExtensionAPI, message: string): void {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    }
  });
}

export default function (pi: ExtensionAPI) {
  // Subagents launch through the multiplexer hosting this process; outside every
  // multiplexer there is no pane to launch them into.
  if (getHostMultiplexer() === undefined) return;
  // Stay inert so subagents can never spawn further subagents.
  if (detectSubagentSpawn() !== undefined) return;
  // A program the clone path needs is missing, so copy-on-write could never
  // work here. Staying unregistered says so once; a volume that cannot clone
  // still activates and falls back to a classic checkout.
  const prereq = missingCloneProgramReport();
  if (prereq !== undefined) {
    reportInactive(pi, prereq);
    return;
  }
  // No git repository means nowhere to build an agent's worktree, so the
  // extension stays inactive. `/cowboy` is still registered, in its
  // unavailable mode, so the human reads the reason on the command they would
  // have used.
  if (!isInsideGitRepository(process.cwd())) {
    reportInactive(pi, NOT_INSIDE_GIT_REPOSITORY);
    registerUnavailableCowboyCommand(pi, NOT_INSIDE_GIT_REPOSITORY);
    return;
  }
  setPiInstance(pi);
  // Registered once, here: the switch toggles them through the active set.
  registerTools(pi);
  registerCowboyCommand(pi);
  setupEventListeners(pi);
}
