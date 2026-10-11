/**
 * harness/opencode/index.ts — the opencode harness: detected on PATH, not launched.
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
 * and parses the output defensively. The real format — verified against the
 * installed CLI by test/opencode-staging.integration.test.ts — is one bare
 * `provider/model-id` per line with no decoration, the provider carrying no
 * slash and the model id allowed to (a real id such as
 * `groq/canopylabs/orpheus-…` does). The parser also tolerates blank lines and
 * `#` comments, which that verified output never contained; any other shape
 * resolves to an empty list with a warning rather than an exception, because a
 * settings menu must never fail to open when a list command misbehaves. The
 * integration test is what keeps the verified shape true as opencode changes.
 *
 * What lands with the implementation: the opencode CLI mapping in `buildArgs`
 * and opencode's own model settings. The strict `[harness.opencode]` table
 * already carries `variant`, which has no argv route: `--variant` exists on
 * `opencode run`, not on the top-level command pi-cowboy launches, so it must
 * ride the agent definition this harness prepares — which this module's
 * siblings stage (staging.ts, definition.ts, npm-seed.ts, permissions.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPath } from "../../../infrastructure/exec-path.js";
import { HerdrError } from "../../../infrastructure/herdr-client.js";
import { parseModelKey } from "../../../utils.js";
import type {
  Harness,
  HarnessPrepareRequest,
  ModelEntry,
  OpencodeLaunchRequest,
} from "../../harness.js";

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

/**
 * Fetches by requesting pi instance. This is memoization of an idempotent
 * read, owned by the code that performs it — not session lifecycle state, so
 * it lives here rather than in the shell. Keying by caller means no read can
 * pin another caller's pi (the instance is process-singleton in production;
 * the keying is strictness for tests and embedders, which also keeps cases
 * from leaking answers into each other with no reset helper). An empty
 * answer reads exactly like a failed list, so it is forgotten and the next
 * read retries instead of pinning an empty row.
 */
const modelFetches = new WeakMap<
  ExtensionAPI,
  Promise<readonly ModelEntry[]>
>();

/** The models for this caller, fetching once and memoizing the answer. */
function fetchModels(pi: ExtensionAPI): Promise<readonly ModelEntry[]> {
  const existing = modelFetches.get(pi);
  if (existing !== undefined) return existing;
  const fetch = listOpencodeModels(pi);
  modelFetches.set(pi, fetch);
  // listModels never rejects — every failure mode resolves [] — so the
  // rejection arm only guards the contract, never the CLI.
  void fetch.then(
    (models) => {
      if (models.length === 0) modelFetches.delete(pi);
    },
    () => {
      modelFetches.delete(pi);
    },
  );
  return fetch;
}

export const opencodeHarness: Harness<"opencode"> = {
  id: "opencode",
  agentMuxKind: "opencode",
  available: () => commandPath("opencode") !== undefined,
  async prepare(_request: HarnessPrepareRequest<"opencode">): Promise<void> {
    throw new HerdrError(NOT_IMPLEMENTED, undefined);
  },
  buildArgs(_request: OpencodeLaunchRequest): string[] {
    throw new HerdrError(NOT_IMPLEMENTED, undefined);
  },
  // opencode reads its own catalog; the injected pi catalog is the pi family's,
  // which this harness does not run. Reads share the memoized fetch, so the
  // boot warm and every menu select ride one CLI run. Returned unwrapped, so
  // every joiner holds the one shared promise — an `async` wrapper would mint
  // a copy per call.
  listModels: ({ pi }) => fetchModels(pi),
  prefetchModels: (pi) => {
    void fetchModels(pi);
  },
  teardown: async () => {},
};
