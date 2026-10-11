/**
 * harness/opencode.ts — the opencode harness: detected on PATH, not launched.
 *
 * opencode is not a pi-compatible binary, so nothing here can reuse the
 * pi-compatible factory: `prepare` and `buildArgs` throw a not-yet-implemented
 * error, and a spawn configured for opencode fails loudly at launch rather than
 * running pi's argv under a binary that has not mapped it. Detection is real
 * meanwhile — the availability probe, the settings row, and the template's
 * `harness_type` enum all answer for it wherever the binary is on PATH.
 *
 * `listModels` is the one thing opencode already answers for, so its default
 * model is configurable today. It shells `opencode models` through `pi.exec`
 * (children inherit the session environment, as every other child here does)
 * and parses the output defensively: the real format is UNVERIFIED — there is no
 * opencode install in this repository to run it against — so the parse assumes
 * one `provider/model-id` per line, with blank lines and `#` comments between
 * them, and any other shape resolves to an empty list with a warning rather
 * than an exception. A settings menu must never fail to open because a list
 * command misbehaved.
 *
 * What lands with the implementation: the opencode CLI mapping in `buildArgs`,
 * opencode's own model settings, and its strict slice of the template
 * `[harness]` schema.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPath } from "../../infrastructure/exec-path.js";
import { HerdrError } from "../../infrastructure/herdr-client.js";
import { parseModelKey } from "../../utils.js";
import type { Harness, ModelEntry, OpencodeLaunchRequest } from "../harness.js";

const NOT_IMPLEMENTED =
  "the opencode harness is not implemented yet; use pi, pig, or pi-bolt meanwhile";

/** Budget for the list command; a hung CLI must not hold a menu open. */
const LIST_MODELS_TIMEOUT_MS = 10_000;

/** Warns with the `[subagents]` prefix every other config-plane warning carries. */
function warnListModels(reason: string): void {
  console.warn(
    `[subagents] Could not list the opencode models: ${reason}. The OpenCode Default Model row offers no models until the command answers.`,
  );
}

/**
 * The parsed list, or undefined when the output is a shape this parser does not
 * recognize. One line, one entry: the first field of a line is the model key,
 * so a decoration after it (a marker column, a trailing note) is ignored.
 */
function parseOpencodeModels(
  stdout: string,
): readonly ModelEntry[] | undefined {
  const entries: ModelEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const key = trimmed.split(/\s+/)[0] ?? "";
    const parsed = parseModelKey(key);
    // A line that is not a provider/model pair means this is not the assumed
    // shape — a table header, an error banner — so nothing here is trustworthy.
    if (!parsed) return undefined;
    entries.push({ key, label: parsed.modelId });
  }
  return entries;
}

/** Runs the CLI, then parses. Every failure mode resolves `[]`. */
async function listOpencodeModels(
  pi: ExtensionAPI,
): Promise<readonly ModelEntry[]> {
  let stdout: string;
  try {
    const result = await pi.exec("opencode", ["models"], {
      timeout: LIST_MODELS_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      warnListModels(
        `\`opencode models\` exited ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
      );
      return [];
    }
    stdout = result.stdout;
  } catch (err) {
    warnListModels(err instanceof Error ? err.message : String(err));
    return [];
  }
  const entries = parseOpencodeModels(stdout);
  if (entries === undefined) {
    warnListModels("unrecognized output");
    return [];
  }
  return entries;
}

export const opencodeHarness: Harness<"opencode"> = {
  id: "opencode",
  agentMuxKind: "opencode",
  available: () => commandPath("opencode") !== undefined,
  async prepare(): Promise<void> {
    throw new HerdrError(NOT_IMPLEMENTED, undefined);
  },
  buildArgs(_request: OpencodeLaunchRequest): string[] {
    throw new HerdrError(NOT_IMPLEMENTED, undefined);
  },
  // opencode reads its own catalog; the injected pi catalog is the pi family's,
  // which this harness does not run.
  listModels: async ({ pi }) => listOpencodeModels(pi),
  teardown: async () => {},
};
