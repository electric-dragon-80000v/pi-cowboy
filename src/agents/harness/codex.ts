/**
 * harness/codex.ts — the codex harness: a binary of its own, launched as the
 * interactive TUI behind the pane's `codex`.
 *
 * codex is not a pi-compatible binary, so nothing here can reuse the
 * pi-compatible factory: it takes no system prompt on its argv (the prompt is
 * read from the file `model_instructions_file` names), and its task arrives
 * differently too. A multi-line task cannot ride the argv — herdr
 * single-quotes every argument it passes and refuses multi-line ones outright —
 * so the launcher appends it as the positional prompt the TUI starts its
 * session with. The stdin form is unusable here: the TUI exits when stdin
 * reaches EOF instead of reopening the terminal for input, so the task must
 * not ride a redirect.
 *
 * The launch is the minimal *interactive* UI and is load-bearing: `codex exec`
 * exits when its turn ends and never reads the terminal again, so a later
 * steer would be typed into a pty nobody reads. Steering stays possible
 * because the TUI keeps reading the pane.
 *
 * `prepare` installs that launcher into the pane and nothing else: every
 * switch the launch needs rides the argv as a flag, so there is no staged
 * directory to prove live and nothing to remove in `teardown`. `prepare`
 * proves no system-prompt state either — a missing or empty instructions file
 * is a loud `codex` hard error at boot, not a silent fallback, so there is no
 * quiet mislaunch to catch early.
 *
 * `listModels` shells `codex debug models --bundled` through `pi.exec`
 * (children inherit the session environment, as every other child here does)
 * and parses the output defensively. The real format — verified against the
 * installed CLI by test/codex-harness.integration.test.ts — is a JSON object
 * with a `models` array of `{ slug, visibility, display_name }` entries. Only
 * `visibility: "list"` entries are offered; any other shape resolves to an
 * empty list with a warning rather than an exception, because a settings menu
 * must never fail to open when a list command misbehaves. The integration
 * test is what keeps the verified shape true as codex changes.
 *
 * The strict `[harness.codex]` table carries `model` alone: codex has no tools
 * flag, so there is no tool pair to stage, and the shared `toolSelection` a
 * codex launch receives is left unread.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPath } from "../../infrastructure/exec-path.js";
import type {
  CodexLaunchRequest,
  Harness,
  HarnessPrepareRequest,
  ModelEntry,
} from "../harness.js";
import { installPaneLauncher, singleQuoteShellWord } from "./pane-launcher.js";

/** Budget for the list command; a hung CLI must not hold a menu open. */
const LIST_MODELS_TIMEOUT_MS = 10_000;

/** The command herdr types into the pane; the launcher is installed under it. */
const CODEX_COMMAND = "codex";

/** Signature carried by this launcher, so pane verification proves which launcher landed. */
const LAUNCHER_SIGNATURE = "CODEX_LAUNCHER_3f8a1c";

/** Token the verify command echoes once the launcher body is confirmed. */
const LAUNCHER_READY_MARKER = "CODEX_VERIFIED";

/** The provider every codex model key is stored under. */
const CODEX_PROVIDER = "openai";

/** The prefix a stored codex model key carries in front of its slug. */
const CODEX_KEY_PREFIX = `${CODEX_PROVIDER}/`;

/**
 * The launcher body: the real binary with the pane's own arguments, then the
 * task as the positional prompt the TUI starts its session with.
 *
 * Bare `codex` keeps the pane's `PATH` the authority on which binary runs,
 * and `command` bypasses this very function. The substitution is
 * double-quoted, so the task text is one argument whatever whitespace it
 * holds, and it is never re-expanded: the shell expands `$(cat …)` once, and
 * the task's own `$`, backticks and quotes ride literally. The task content
 * never crosses herdr's single-line argv encoder — only the file path does.
 */
function launcherBody(taskFile: string): string {
  return `command codex "$@" "$(cat ${singleQuoteShellWord(taskFile)})"`;
}

/**
 * One `-c` value as a TOML string: the quotes make the reading deterministic
 * rather than incidental. An unquoted value is parsed as TOML with a fallback
 * to the literal, which a staging path happens to survive; the string form
 * holds for paths with spaces too. Every escape `JSON.stringify` emits is a
 * valid TOML basic-string escape, so the two syntaxes agree on the bytes.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The `-m` value for a stored model key, or `null` when no override exists.
 *
 * `-m` takes codex's bare slug: the stored key carries the `openai/` provider
 * every `ModelEntry` key carries, which the API rejects verbatim. A key
 * outside codex's own catalogue rides as written — a list the command could
 * not produce is no reason to refuse it.
 */
function codexModelFlag(modelKey: string | null): string | null {
  if (modelKey === null) return null;
  if (!modelKey.startsWith(CODEX_KEY_PREFIX)) return modelKey;
  const slug = modelKey.slice(CODEX_KEY_PREFIX.length);
  return slug === "" ? modelKey : slug;
}

/** Warns with the `[subagents]` prefix every other config-plane warning carries. */
function warnListModels(reason: string): void {
  console.warn(
    `[subagents] Could not list the codex models: ${reason}. The Codex Default Model row offers no models until the command answers.`,
  );
}

/**
 * The parsed list, or undefined when the output is a shape this parser does
 * not recognize. Unlisted entries are skipped before anything is validated, so
 * an oddly-shaped hidden entry cannot blank the catalogue; a listed entry
 * without a usable slug means this is not the assumed shape, so nothing here
 * is trustworthy.
 */
function parseCodexModels(stdout: string): readonly ModelEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const models: unknown = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const entries: ModelEntry[] = [];
  for (const model of models) {
    if (typeof model !== "object" || model === null) return undefined;
    const record = model as Record<string, unknown>;
    if (record.visibility !== "list") continue;
    const { slug, display_name: displayName } = record;
    if (typeof slug !== "string" || slug === "" || /\s/.test(slug)) {
      return undefined;
    }
    entries.push({
      key: `${CODEX_KEY_PREFIX}${slug}`,
      label:
        typeof displayName === "string" && displayName !== ""
          ? displayName
          : slug,
    });
  }
  return entries;
}

/** Runs the CLI, then parses. Every failure mode resolves `[]`. */
async function listCodexModels(
  pi: ExtensionAPI,
): Promise<readonly ModelEntry[]> {
  let stdout: string;
  try {
    const result = await pi.exec("codex", ["debug", "models", "--bundled"], {
      timeout: LIST_MODELS_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      warnListModels(
        `\`codex debug models --bundled\` exited ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
      );
      return [];
    }
    stdout = result.stdout;
  } catch (err) {
    warnListModels(err instanceof Error ? err.message : String(err));
    return [];
  }
  const entries = parseCodexModels(stdout);
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
  const fetch = listCodexModels(pi);
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

export const codexHarness: Harness<"codex"> = {
  id: "codex",
  agentMuxKind: "codex",
  availability: () =>
    commandPath("codex") === undefined
      ? { status: "unavailable" }
      : { status: "available" },
  /**
   * Install the launcher that appends the task as the TUI's positional
   * prompt. The launcher is the whole of the pane state this harness needs,
   * so its verification is the whole of the preparation.
   */
  async prepare({
    pi,
    paneId,
    launch,
  }: HarnessPrepareRequest<"codex">): Promise<void> {
    await installPaneLauncher(pi, paneId, {
      commandName: CODEX_COMMAND,
      body: launcherBody(launch.taskFile),
      signature: LAUNCHER_SIGNATURE,
      readyMarker: LAUNCHER_READY_MARKER,
    });
  },
  /**
   * codex's minimal interactive CLI. The system prompt rides `-c
   * model_instructions_file`: the file replaces the built-in instructions, and
   * codex hard-errors on a missing or empty file, so the prompt is genuinely
   * replaced rather than layered. `project_doc_max_bytes=0` keeps the repo's
   * AGENTS.md chain out of the first turn. The sandbox stays `workspace-write`
   * whatever the trust: the child's report file lives outside the workspace,
   * so `read-only` would refuse the settlement write. Approval is the trust —
   * `never` where pi passes `--approve`, `on-request` where pi passes
   * `--no-approve` — because a background pane answers an approval the way
   * pi's does. The model rides `-m` only when one was resolved, as codex's
   * bare slug.
   */
  buildArgs(request: CodexLaunchRequest): string[] {
    const args = [
      "-c",
      `model_instructions_file=${tomlString(request.systemPromptFile)}`,
      "-c",
      "project_doc_max_bytes=0",
      "-s",
      "workspace-write",
      "--dangerously-bypass-approvals-and-sandbox",
    ];
    const model = codexModelFlag(request.modelKey);
    if (model !== null) args.push("-m", model);
    return args;
  },
  // codex reads its own catalog; the injected pi catalog is the pi family's,
  // which this harness does not run. Reads share the memoized fetch, so the
  // boot warm and every menu select ride one CLI run. Returned unwrapped, so
  // every joiner holds the one shared promise — an `async` wrapper would mint
  // a copy per call.
  listModels: ({ pi }) => fetchModels(pi),
  prefetchModels: (pi) => {
    void fetchModels(pi);
  },
  // Best effort and idempotent: this harness stages no filesystem state — the
  // system prompt and task files belong to the result-dir artifacts the
  // session owns — and the launcher dies with the pane.
  teardown: async () => {},
};
