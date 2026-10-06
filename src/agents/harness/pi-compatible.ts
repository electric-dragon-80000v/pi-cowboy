/**
 * pi-compatible.ts — the shared preparation for a pi-compatible binary behind
 * the pane's `pi`.
 *
 * herdr types the canonical name `pi` into the pane, so a harness whose binary
 * is not named `pi` must point the pane's `pi` at its own binary before herdr
 * starts the agent. That shell trick is identical for every such harness, so
 * this factory builds one from a binary name and a signature that proves which
 * launcher landed.
 */

import {
  HerdrError,
  runInPane,
  waitForPaneOutput,
} from "../../infrastructure/herdr-client.js";
import { commandPath } from "../../infrastructure/exec-path.js";
import { sleep } from "../../utils.js";
import type { Harness, HarnessId, HarnessPrepareRequest } from "../harness.js";

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
