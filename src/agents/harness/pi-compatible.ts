/**
 * pi-compatible.ts — the shared launch mechanics for a pi-compatible binary
 * behind the pane's `pi`.
 *
 * herdr types the canonical name `pi` into the pane, so a harness whose binary
 * is not named `pi` must point the pane's `pi` at its own binary before herdr
 * starts the agent. That shell trick is identical for every such harness, so
 * this factory builds one from a binary name and a signature that proves which
 * launcher landed — the install itself is pane-launcher.ts's. The argv is
 * identical too — pi's CLI — so the whole family shares `buildPiLaunchArgs`, and
 * only the shell trick varies per binary.
 */

import { commandPath } from "../../infrastructure/exec-path.js";
import { subagentTokenFor } from "../../paths.js";
import type {
  Harness,
  HarnessListModels,
  HarnessPrepareRequest,
  ModelEntry,
  PiFamilyHarnessId,
  PiFamilyLaunchRequest,
} from "../harness.js";
import { installPaneLauncher } from "./pane-launcher.js";

/**
 * The pi family's argv: every flag a pi-compatible launch carries, ending with
 * the task riding as `@<taskFile>` (the pane shell expands it, so multi-line
 * task text never crosses herdr's single-line shell encoder). The report
 * token rides via `--append-system-prompt` because `--system-prompt` names a
 * file and a path cannot carry the marker.
 */
export function buildPiLaunchArgs(request: PiFamilyLaunchRequest): string[] {
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

/**
 * The pi family's model list: pi's own catalog, read in the order the registry
 * returns it. pig and pi-bolt run the pi binary, so they answer from this one
 * catalog — a second list for a second binary name could only disagree with it.
 */
export const piFamilyListModels: HarnessListModels = async ({ modelCatalog }) =>
  modelCatalog
    .getAvailable()
    .map((model): ModelEntry => ({ key: `${model.provider}/${model.id}` }));

export interface PiCompatibleSpec {
  readonly id: PiFamilyHarnessId;
  /** Binary the pane's `pi` forwards to, resolved on the pane's PATH. */
  readonly binary: string;
  /** Signature this binary's launcher carries, so pane verification proves which launcher landed. */
  readonly signature: string;
  /** Token the verify command echoes once the launcher body is confirmed. */
  readonly readyMarker: string;
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
 * The launcher is installed under the name herdr types into the pane, `pi`, so
 * the pane's `pi` forwards to this binary whatever it is called.
 */
export function createPiCompatibleHarness(
  spec: PiCompatibleSpec,
): Harness<PiFamilyHarnessId> {
  return {
    id: spec.id,
    // The pane's `pi` forwards to this binary, so herdr's pi detection is what
    // sees the child process.
    agentMuxKind: "pi",
    // The launcher runs `spec.binary` inside the pane, so a machine without it
    // can never launch this harness — however well the preparation itself would
    // go.
    available: () => commandPath(spec.binary) !== undefined,
    // The binary is pi behind the shell trick, so the argv is pi's; only a
    // harness that stages filesystem state before launch has teardown work —
    // the launcher dies with the pane and the staged files belong to the
    // result-dir artifacts the session owns.
    buildArgs: buildPiLaunchArgs,
    listModels: piFamilyListModels,
    teardown: async () => {},
    async prepare({ pi, paneId }: HarnessPrepareRequest): Promise<void> {
      await installPaneLauncher(pi, paneId, {
        commandName: "pi",
        body: `export HERDR_AGENT=pi; ${spec.binary} "$@"`,
        signature: spec.signature,
        readyMarker: spec.readyMarker,
      });
    },
  };
}
