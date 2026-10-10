/**
 * pi-compatible.ts — the shared launch mechanics for a pi-compatible binary
 * behind the pane's `pi`.
 *
 * herdr types the canonical name `pi` into the pane, so a harness whose binary
 * is not named `pi` must point the pane's `pi` at its own binary before herdr
 * starts the agent. That shell trick is identical for every such harness, so
 * this factory builds one from a binary name and a signature that proves which
 * launcher landed. The argv is identical too — pi's CLI — so the whole family
 * shares `buildPiLaunchArgs`, and only the shell trick varies per binary.
 */

import {
  HerdrError,
  runInPane,
  waitForPaneOutput,
} from "../../infrastructure/herdr-client.js";
import { commandPath } from "../../infrastructure/exec-path.js";
import { sleep } from "../../utils.js";
import { subagentTokenFor } from "../../paths.js";
import type {
  Harness,
  HarnessId,
  HarnessLaunchRequest,
  HarnessPrepareRequest,
} from "../harness.js";

/**
 * The pi family's argv: every flag a pi-compatible launch carries, ending with
 * the task riding as `@<taskFile>` (the pane shell expands it, so multi-line
 * task text never crosses herdr's single-line shell encoder). The report
 * token rides via `--append-system-prompt` because `--system-prompt` names a
 * file and a path cannot carry the marker.
 */
export function buildPiLaunchArgs(request: HarnessLaunchRequest): string[] {
  const args: string[] = [
    "--system-prompt",
    request.systemPromptFile,
    "--append-system-prompt",
    subagentTokenFor(request.subagentId),
    "--name",
    request.subagentId,
    "--no-context-files",
  ];
  if (request.modelKey !== null) args.push("--model", request.modelKey);
  if (request.thinkingLevel !== null)
    args.push("--thinking", request.thinkingLevel);
  if (request.forkSessionFile !== null)
    args.push("--fork", request.forkSessionFile);
  const tools = request.toolSelection;
  if (tools.kind === "none") {
    args.push("--no-tools");
  } else if (tools.kind === "include") {
    args.push("--tools", tools.names.join(","));
  } else if (tools.kind === "exclude") {
    args.push("--exclude-tools", tools.names.join(","));
  }
  if (request.skills.kind === "none") args.push("--no-skills");
  if (request.extensions.kind === "none") {
    args.push("--no-extensions");
  } else if (request.extensions.kind === "paths") {
    args.push("--no-extensions");
    for (const extPath of request.extensions.paths) args.push("-e", extPath);
  }
  args.push(request.projectTrusted ? "--approve" : "--no-approve");
  args.push(`@${request.taskFile}`);
  return args;
}

/** Bounded prepare attempts: a `pane run` before the shell is at its prompt is silently lost. */
const PREPARE_MAX_ATTEMPTS = 5;
const PREPARE_OUTPUT_TIMEOUT_MS = 2_000;
const PREPARE_RETRY_DELAY_MS = 250;

export interface PiCompatibleSpec {
  readonly id: HarnessId;
  /** Binary the pane's `pi` forwards to, resolved on the pane's PATH. */
  readonly binary: string;
  /**
   * Signature carried by the launcher so verification can prove the pane's `pi`
   * is this harness's launcher rather than another one's. A comment would be
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
 * Build the harness for one pi-compatible binary.
 *
 * The launcher runs the binary as a child of the pane's shell rather than via
 * `exec`: replacing the shell would make the pane close when the binary exits,
 * and the pane must outlive the process (only cleanup closes a pane it created).
 * `HERDR_AGENT=pi` is what makes herdr's pi screen manifest detect the process —
 * without it the start times out and the pane never registers as an agent.
 *
 * Verification reads the pane's `pi` back with `typeset -f` and matches the
 * signature, so a match means the body is this launcher rather than an unrelated
 * `pi` from the pane's rc. `type pi` is not used: its wording varies by shell
 * (`is a function` in bash, `is a shell function` in zsh).
 */
export function createPiCompatibleHarness(spec: PiCompatibleSpec): Harness {
  const launcher = `pi() { : "${spec.signature}"; export HERDR_AGENT=pi; ${spec.binary} "$@"; }`;
  const verifyCommand = `typeset -f pi 2>/dev/null | grep -q "${spec.signature}" && echo ${splitMarker(spec.readyMarker)}`;

  return {
    id: spec.id,
    // The launcher runs `spec.binary` inside the pane, so a machine without it
    // can never launch this harness — however well the preparation itself would
    // go.
    available: () => commandPath(spec.binary) !== undefined,
    // The binary is pi behind the shell trick, so the argv is pi's; only a
    // harness that stages filesystem state before launch has teardown work —
    // the launcher dies with the pane and the staged files belong to the
    // result-dir artifacts the session owns.
    buildArgs: buildPiLaunchArgs,
    teardown: async () => {},
    async prepare({ pi, paneId }: HarnessPrepareRequest): Promise<void> {
      for (let attempt = 1; attempt <= PREPARE_MAX_ATTEMPTS; attempt++) {
        await runInPane(pi, paneId, launcher);
        await runInPane(pi, paneId, verifyCommand);
        try {
          await waitForPaneOutput(
            pi,
            paneId,
            spec.readyMarker,
            PREPARE_OUTPUT_TIMEOUT_MS,
          );
          return;
        } catch {
          if (attempt < PREPARE_MAX_ATTEMPTS)
            await sleep(PREPARE_RETRY_DELAY_MS);
        }
      }
      throw new HerdrError(
        `failed to prepare pane ${paneId} for the ${spec.id} harness: the pi launcher never landed`,
        undefined,
      );
    },
  };
}
