/**
 * harness/opencode/index.ts — the opencode harness: a binary of its own, staged
 * and launched behind the pane's `opencode`.
 *
 * opencode is not a pi-compatible binary, so nothing here can reuse the
 * pi-compatible factory: it takes no system prompt on its argv (the prompt is
 * read from a staged agent definition), and its task arrives differently too.
 * A multi-line task cannot ride the argv — herdr single-quotes every argument it
 * passes and refuses multi-line ones outright — so the launcher feeds the task
 * on stdin. `prepare` stages the config directory opencode is pointed at
 * (staging.ts and its siblings), installs that launcher into the pane, and then
 * proves the definition is live; `buildArgs` is opencode's minimal interactive
 * CLI; `teardown` removes the staged tree.
 *
 * `listModels` shells `opencode models` through `pi.exec` (children inherit the
 * session environment, as every other child here does) and parses the output
 * defensively. The real format — verified against the installed CLI by
 * test/opencode-staging.integration.test.ts — is one bare
 * `provider/model-id` per line with no decoration, the provider carrying no
 * slash and the model id allowed to (a real id such as
 * `groq/canopylabs/orpheus-…` does). The parser also tolerates blank lines and
 * `#` comments, which that verified output never contained; any other shape
 * resolves to an empty list with a warning rather than an exception, because a
 * settings menu must never fail to open when a list command misbehaves. The
 * integration test is what keeps the verified shape true as opencode changes.
 *
 * The strict `[harness.opencode]` table carries `variant`, which joins the model
 * reference on the argv: a variant has no flag of its own, so `buildArgs`
 * appends it to the model key as `provider/model#variant`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPath } from "../../../infrastructure/exec-path.js";
import { parseModelKey } from "../../../utils.js";
import type {
  Harness,
  HarnessPrepareRequest,
  ModelEntry,
  OpencodeLaunchRequest,
} from "../../harness.js";
import {
  installPaneLauncher,
  singleQuoteShellWord,
  type PaneProof,
} from "../pane-launcher.js";
import { removeOpencodeStaging, writeOpencodeStaging } from "./staging.js";

/** Budget for the list command; a hung CLI must not hold a menu open. */
const LIST_MODELS_TIMEOUT_MS = 10_000;

/**
 * Budget for the pane's `opencode agent list`. The command boots the CLI, so it
 * is slower than a shell builtin but answers in about a second on 1.18.35.
 */
const AGENT_LIST_TIMEOUT_MS = 15_000;

/** The command herdr types into the pane; the launcher is installed under it. */
const OPENCODE_COMMAND = "opencode";

/** Signature carried by this launcher, so pane verification proves which launcher landed. */
const LAUNCHER_SIGNATURE = "OPENCODE_LAUNCHER_7d3e91";

/** Token the verify command echoes once the launcher body is confirmed. */
const LAUNCHER_READY_MARKER = "OPENCODE_VERIFIED";

/**
 * The launcher body: opencode's config directory and the two switches that keep
 * a spawn from reading anyone else's configuration, then the real binary with
 * the pane's own arguments and the task on stdin.
 *
 * Bare `opencode` keeps the pane's `PATH` the authority on which binary runs,
 * and `command` bypasses this very function. The redirect is what delivers a
 * multi-line task: it becomes the initial message (opencode reads stdin as the
 * prompt when it is not a terminal), and mini mode then reopens the controlling
 * terminal for input, so later steers still reach the process.
 */
function launcherBody(configDir: string, taskFile: string): string {
  return [
    `export OPENCODE_CONFIG_DIR=${singleQuoteShellWord(configDir)}`,
    "export OPENCODE_DISABLE_PROJECT_CONFIG=1",
    "export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1",
    `command opencode "$@" < ${singleQuoteShellWord(taskFile)}`,
  ].join("; ");
}

/**
 * The proof that the staged definition is live, read back through the launcher
 * the pane just took.
 *
 * opencode falls back to its own default agent — no system prompt, no
 * permission map — when the named agent is missing or is not a primary agent,
 * and the fallback is a warning it prints rather than a failure: nothing in the
 * launch's argv or exit status reports one. `opencode agent list` is where the
 * answer can be read. The list is filtered in the pane to the one line this
 * wants: the unfiltered list runs past a thousand lines here (the staged agent
 * sorts last), which is deeper than the output herdr's literal `wait-output`
 * match searches, and `grep -x` pins the verified `^<subagentId> (primary)$`
 * line rather than accepting a mention of the id.
 */
function definitionProof(subagentId: string): PaneProof {
  const listed = `${subagentId} (primary)`;
  return {
    command: `${OPENCODE_COMMAND} agent list | grep -x ${singleQuoteShellWord(listed)}`,
    output: listed,
    timeoutMs: AGENT_LIST_TIMEOUT_MS,
    failure: `failed to prepare the pane: \`${OPENCODE_COMMAND} agent list\` never printed ${listed} — the definition staged for ${subagentId} is missing, unreadable, or not a primary agent, and opencode would fall back to its own default agent. The agent did not start.`,
  };
}

/**
 * The model reference opencode takes: the key, with the variant joined to it when
 * one was requested.
 */
function modelReference(modelKey: string, variant: string | null): string {
  return variant === null ? modelKey : `${modelKey}#${variant}`;
}

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
    const result = await pi.exec("opencode", ["models", "--standalone"], {
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
  /**
   * Stage the config directory, install the launcher that points opencode at it
   * and feeds it the task, and prove the staged definition is live behind it. A
   * launch reaches the CLI through this pane state alone, so it is verified here
   * rather than assumed.
   */
  async prepare({
    pi,
    paneId,
    launch,
  }: HarnessPrepareRequest<"opencode">): Promise<void> {
    const configDir = writeOpencodeStaging({
      subagentId: launch.subagentId,
      systemPromptFile: launch.systemPromptFile,
      variant: launch.variant,
      toolSelection: launch.toolSelection,
    });
    await installPaneLauncher(pi, paneId, {
      commandName: OPENCODE_COMMAND,
      body: launcherBody(configDir, launch.taskFile),
      signature: LAUNCHER_SIGNATURE,
      readyMarker: LAUNCHER_READY_MARKER,
      proof: definitionProof(launch.subagentId),
    });
  },
  /**
   * `mini` is the minimal *interactive* UI and is load-bearing: `opencode run`
   * exits when the session goes idle and never reads the terminal again, so a
   * later steer would be typed into the pane's shell. `--standalone` is
   * load-bearing for the same reason the argv names a subcommand at all: a
   * launch without it reads the shared background server's config directory,
   * where the staged definition is not. A variant has no flag of its own — it
   * joins the model key after `#`.
   */
  buildArgs(request: OpencodeLaunchRequest): string[] {
    const args = ["mini", "--standalone", "--agent", request.subagentId];
    if (request.modelKey !== null) {
      args.push("--model", modelReference(request.modelKey, request.variant));
    }
    return args;
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
  // Best effort and idempotent: the staged tree is this harness's only
  // filesystem state, and a launch that failed before prepare staged nothing.
  teardown: async ({ subagentId }) => {
    removeOpencodeStaging(subagentId);
  },
};
