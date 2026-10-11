/**
 * pane-launcher.ts — typing a shell-function launcher into a pane and proving
 * it landed.
 *
 * A harness whose process must launch under a name the pane does not resolve by
 * itself installs that name as a shell function in the pane before the mux
 * starts the agent. herdr's `pane run` is fire-and-forget: it returns before the
 * shell has evaluated the command, so a run that arrives before the shell is at
 * its prompt is silently lost. The install is therefore define-then-verify,
 * retried within a bounded budget, and the verification reads the function back
 * rather than trusting the run that defined it.
 *
 * Nothing here knows which harness is installing: the command name, the
 * launcher body, and the two tokens belong to the caller.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HerdrError,
  runInPane,
  waitForPaneOutput,
} from "../../infrastructure/herdr-client.js";
import { sleep } from "../../utils.js";

/** Bounded install attempts: a `pane run` before the shell is at its prompt is silently lost. */
const INSTALL_MAX_ATTEMPTS = 5;
const INSTALL_OUTPUT_TIMEOUT_MS = 2_000;
const INSTALL_RETRY_DELAY_MS = 250;

export interface PaneLauncherSpec {
  /**
   * The command the mux types into the pane — the harness's `agentMuxKind`.
   * The install defines a shell function under this name, so the command the
   * mux runs resolves to this launcher instead of to a PATH binary.
   */
  readonly commandName: string;
  /**
   * The shell body after the function name — how the launcher runs its
   * process. The install terminates it, so it carries no trailing `;` of its
   * own.
   */
  readonly body: string;
  /**
   * Signature carried by the launcher so verification can prove the function in
   * the pane is this launcher rather than another one's. A comment would be
   * stripped when the shell stores the definition, so it rides as an inert `:`
   * command.
   */
  readonly signature: string;
  /** Token the verify command echoes once the launcher body is confirmed. */
  readonly readyMarker: string;
}

/**
 * Break the marker with a `""` so only the shell's evaluation of the command —
 * not the command line's own echo, which `wait-output` also sees — produces the
 * contiguous token.
 */
function splitMarker(marker: string): string {
  const at = marker.indexOf("_");
  return at === -1
    ? marker
    : `${marker.slice(0, at + 1)}""${marker.slice(at + 1)}`;
}

/**
 * Install the launcher into the pane, then read it back until the marker proves
 * the body is there. Throws when the pane never takes it.
 *
 * Verification matches the signature rather than asking the shell what the name
 * is (`type <fn>`), because that wording varies by shell (`is a function` in
 * bash, `is a shell function` in zsh).
 */
export async function installPaneLauncher(
  pi: ExtensionAPI,
  paneId: string,
  spec: PaneLauncherSpec,
): Promise<void> {
  const definition = `${spec.commandName}() { : "${spec.signature}"; ${spec.body}; }`;
  const verifyCommand = `typeset -f ${spec.commandName} 2>/dev/null | grep -q "${spec.signature}" && echo ${splitMarker(spec.readyMarker)}`;

  for (let attempt = 1; attempt <= INSTALL_MAX_ATTEMPTS; attempt++) {
    await runInPane(pi, paneId, definition);
    await runInPane(pi, paneId, verifyCommand);
    try {
      await waitForPaneOutput(
        pi,
        paneId,
        spec.readyMarker,
        INSTALL_OUTPUT_TIMEOUT_MS,
      );
      return;
    } catch {
      if (attempt < INSTALL_MAX_ATTEMPTS) await sleep(INSTALL_RETRY_DELAY_MS);
    }
  }
  throw new HerdrError(
    `failed to prepare pane ${paneId}: the ${spec.commandName} launcher never landed`,
    undefined,
  );
}
