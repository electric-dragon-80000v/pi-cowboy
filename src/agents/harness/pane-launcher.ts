/**
 * pane-launcher.ts — the pane-side preparation a harness performs: installing a
 * shell-function launcher into a pane, proving it landed, and proving whatever
 * else the harness's launch reads.
 *
 * A harness whose process must launch under a name the pane does not resolve by
 * itself installs that name as a shell function in the pane before the multiplexer
 * starts the agent. A multiplexer's `run` is fire-and-forget: it returns before the
 * shell has evaluated the command, so a run that arrives before the shell is at
 * its prompt is silently lost. The install is therefore define-then-verify,
 * retried within a bounded budget, and the verification reads the function back
 * rather than trusting the run that defined it. A harness whose pane state is
 * more than the function asks for that too, in `proof`: opencode's staged agent
 * definition is read back by the CLI, and nothing about the function proves it.
 *
 * Only a short `. '<file>'` is ever typed. The launcher and the proof are
 * staged as files and sourced, because a long line typed into an interactive
 * line editor that is still starting or redrawing its prompt (zsh with a
 * themed prompt) arrives truncated — and a truncated definition leaves an open
 * quote, a continuation prompt, and a shell that swallows every line typed
 * after it.
 *
 * Nothing here knows which harness is installing: the command name, the
 * launcher body, the tokens and the proof belong to the caller. The pane is
 * reached through the multiplexer's `PaneControl` — never a multiplexer's own client —
 * so the same install runs under any multiplexer that offers the surface and no
 * harness holds the control-plane API.
 */

import path from "node:path";
import type { PaneControl } from "../agent-host.js";
import {
  ensureResultDir,
  writeResultFile,
} from "../result-file-permissions.js";
import { sleep } from "../../utils.js";

/**
 * A value as one POSIX shell word: single quotes around it, and the `'\''`
 * dance for any single quote inside. Every path a harness passes is its own
 * staging path, but a launcher is a shell command typed into the pane, so the
 * value is quoted rather than trusted.
 */
export function singleQuoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * A launcher body that runs with the launch's staged variables, or the body
 * unchanged for a launch that carries none.
 *
 * The values stay in the file (see launch-env.ts): interpolating them here
 * would put them on the command line kept in the pane's scrollback. The body
 * runs in a subshell, because sourcing modifies the environment of the shell that
 * reads the file and the pane's interactive shell must preserve its own environment
 * after the agent exits. `&&` keeps a launch from starting without the variables
 * it was configured with — an unreadable file stops the command instead of quietly
 * launching an unconfigured agent.
 */
export function launchEnvBody(envFile: string | null, body: string): string {
  if (envFile === null) return body;
  return `( . ${singleQuoteShellWord(envFile)} && { ${body}; } )`;
}

/** Bounded install attempts: a `run` before the shell is at its prompt is silently lost. */
const INSTALL_MAX_ATTEMPTS = 5;
const INSTALL_OUTPUT_TIMEOUT_MS = 2_000;
const INSTALL_RETRY_DELAY_MS = 250;

export interface PaneLauncherSpec {
  /**
   * Where the launcher is staged for the pane to source — a path inside the
   * spawn's own staging directory, visible from the pane. The proof, when the
   * spec carries one, is staged beside it (see `proofFileFor`).
   */
  readonly file: string;
  /**
   * The command the multiplexer types into the pane — the harness's `agentMultiplexerKind`.
   * The install defines a shell function under this name, so the command the
   * multiplexer runs resolves to this launcher instead of to a PATH binary.
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
  /** Token the staged read-back echoes once the launcher body is confirmed. */
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
 * Split a marker with a `""` so that only the shell's evaluation of a command —
 * not an echo of the command's own text, which `wait-output` also sees —
 * produces the contiguous token. A sourced file is echoed too when the pane's
 * shell runs with `verbose` set.
 */
export function splitMarker(marker: string): string {
  const at = marker.indexOf("_");
  return at === -1
    ? marker
    : `${marker.slice(0, at + 1)}""${marker.slice(at + 1)}`;
}

/** The file a launcher's proof is staged in, beside the launcher itself. */
export function proofFileFor(launcherFile: string): string {
  return `${launcherFile}.proof`;
}

/** The one line typed into the pane to run a staged file in the pane's own shell. */
export function sourceCommand(file: string): string {
  return `. ${singleQuoteShellWord(file)}`;
}

/**
 * The staged launcher: the function definition, then its read-back. Sourcing
 * it defines the function in the pane's shell and prints the ready marker only
 * when the function the shell now holds carries this launcher's signature.
 *
 * The read-back matches the signature rather than asking the shell what the
 * name is (`type <fn>`), because that wording varies by shell (`is a function`
 * in bash, `is a shell function` in zsh).
 */
export function launcherScript(spec: PaneLauncherSpec): string {
  return [
    `${spec.commandName}() { : "${spec.signature}"; ${spec.body}; }`,
    `typeset -f ${spec.commandName} 2>/dev/null | grep -q "${spec.signature}" && echo ${splitMarker(spec.readyMarker)}`,
    "",
  ].join("\n");
}

/**
 * Stage the launcher, source it in the pane until the marker proves the body
 * is there, then prove whatever else the caller asked for. Throws when the
 * pane never takes the launcher, or when the proof's output never appears.
 *
 * Sourcing is idempotent, so a retry that lands after an earlier attempt only
 * redefines the same function. Only the install is retried: a proof that
 * failed is a statement about the launch, not about a lost run.
 */
export async function installPaneLauncher(
  pane: PaneControl,
  paneId: string,
  spec: PaneLauncherSpec,
): Promise<void> {
  ensureResultDir(path.dirname(spec.file));
  writeResultFile(spec.file, launcherScript(spec));
  const install = sourceCommand(spec.file);

  for (let attempt = 1; attempt <= INSTALL_MAX_ATTEMPTS; attempt++) {
    await pane.run(paneId, install);
    if (
      await panePrinted(
        pane,
        paneId,
        spec.readyMarker,
        INSTALL_OUTPUT_TIMEOUT_MS,
      )
    ) {
      if (spec.proof !== undefined) {
        await requirePaneProof(
          pane,
          paneId,
          proofFileFor(spec.file),
          spec.proof,
        );
      }
      return;
    }
    if (attempt < INSTALL_MAX_ATTEMPTS) await sleep(INSTALL_RETRY_DELAY_MS);
  }
  throw new Error(
    `failed to prepare pane ${paneId}: the ${spec.commandName} launcher never landed`,
  );
}

/** Whether the pane's output came to contain `output` within the budget. */
async function panePrinted(
  pane: PaneControl,
  paneId: string,
  output: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await pane.waitForOutput(paneId, output, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the caller's proof through the pane's launcher and wait for its output.
 * The command is staged and sourced, so it runs in the shell that holds the
 * launcher and its environment without being typed at length.
 */
async function requirePaneProof(
  pane: PaneControl,
  paneId: string,
  file: string,
  proof: PaneProof,
): Promise<void> {
  writeResultFile(file, `${proof.command}\n`);
  await pane.run(paneId, sourceCommand(file));
  try {
    await pane.waitForOutput(paneId, proof.output, proof.timeoutMs);
  } catch {
    throw new Error(proof.failure);
  }
}
