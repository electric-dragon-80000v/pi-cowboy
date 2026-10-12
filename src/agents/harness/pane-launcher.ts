/**
 * pane-launcher.ts — the pane-side preparation a harness performs: typing a
 * shell-function launcher into a pane, proving it landed, and proving whatever
 * else the harness's launch reads.
 *
 * A harness whose process must launch under a name the pane does not resolve by
 * itself installs that name as a shell function in the pane before the mux
 * starts the agent. herdr's `pane run` is fire-and-forget: it returns before the
 * shell has evaluated the command, so a run that arrives before the shell is at
 * its prompt is silently lost. The install is therefore define-then-verify,
 * retried within a bounded budget, and the verification reads the function back
 * rather than trusting the run that defined it. A harness whose pane state is
 * more than the function asks for that too, in `proof`: opencode's staged agent
 * definition is read back by the CLI, and nothing about the function proves it.
 *
 * Nothing here knows which harness is installing: the command name, the
 * launcher body, the tokens and the proof belong to the caller. herdr is
 * reached only here, so no harness holds the control-plane API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HerdrError,
  runInPane,
  waitForPaneOutput,
} from "../../infrastructure/herdr-client.js";
import { sleep } from "../../utils.js";

/**
 * A value as one POSIX shell word: single quotes around it, and the `'\''`
 * dance for any single quote inside. Every path a harness passes is its own
 * staging path, but a launcher is a shell command herdr types into the pane,
 * so the value is quoted rather than trusted.
 */
export function singleQuoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
  /**
   * The launch state past the launcher itself, proven once the launcher has
   * landed — for a harness whose pane reads something the function alone does
   * not prove. Absent when the function is the whole of the state.
   */
  readonly proof?: PaneProof;
}

/**
 * One command the pane runs and the output it must print, run through the
 * launcher and its environment. The failure message is the caller's: only the
 * caller knows what a missing answer means for its launch.
 */
export interface PaneProof {
  readonly command: string;
  /** Output the command must print; the pane's output is searched for it. */
  readonly output: string;
  /** Budget for the output to appear (ms). */
  readonly timeoutMs: number;
  /** Message the install fails with when the output never appears. */
  readonly failure: string;
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
 * the body is there; then prove whatever else the caller asked for. Throws when
 * the pane never takes the launcher, or when the proof's output never appears.
 *
 * Verification matches the signature rather than asking the shell what the name
 * is (`type <fn>`), because that wording varies by shell (`is a function` in
 * bash, `is a shell function` in zsh). Only the install is retried: a proof
 * that failed is a statement about the launch, not about a lost `pane run`.
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
    if (
      await panePrinted(pi, paneId, spec.readyMarker, INSTALL_OUTPUT_TIMEOUT_MS)
    ) {
      if (spec.proof !== undefined) {
        await requirePaneProof(pi, paneId, spec.proof);
      }
      return;
    }
    if (attempt < INSTALL_MAX_ATTEMPTS) await sleep(INSTALL_RETRY_DELAY_MS);
  }
  throw new HerdrError(
    `failed to prepare pane ${paneId}: the ${spec.commandName} launcher never landed`,
    undefined,
  );
}

/** Whether the pane's output came to contain `output` within the budget. */
async function panePrinted(
  pi: ExtensionAPI,
  paneId: string,
  output: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await waitForPaneOutput(pi, paneId, output, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the caller's proof through the pane's launcher and wait for its output.
 * The command reaches the pane through the same seam as the install itself, so
 * the proof runs in the shell that holds the launcher and its environment.
 */
async function requirePaneProof(
  pi: ExtensionAPI,
  paneId: string,
  proof: PaneProof,
): Promise<void> {
  await runInPane(pi, paneId, proof.command);
  try {
    await waitForPaneOutput(pi, paneId, proof.output, proof.timeoutMs);
  } catch (err) {
    throw new HerdrError(
      proof.failure,
      err instanceof HerdrError ? err.code : undefined,
    );
  }
}
