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
 * The strict `[harness.codex]` table carries `model` and `thinking`: codex has
 * no tools flag, so there is no tool pair to stage, and the shared
 * `toolSelection` a codex launch receives is left unread.
 *
 * `exportForHandover` reads the run's rollout from codex's own session store:
 * the newest session file whose metadata names the run's cwd, with the thread
 * id that `codex resume` accepts. The reader lives in codex-session.ts so the
 * artifact and the lookup can be tested without a process, and the home that
 * store lives under is resolved there too — the launch hands the child that
 * same home (`inheritedEnv`), so the child writes where the export reads.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { commandPath } from "../../infrastructure/exec-path.js";
import type {
  CodexLaunchRequest,
  Harness,
  HarnessPrepareRequest,
  ModelEntry,
} from "../harness.js";
import {
  CODEX_HOME_ENV_VAR,
  codexHomeDirectory,
  exportCodexSession,
} from "./codex-session.js";
import {
  installPaneLauncher,
  launchEnvBody,
  singleQuoteShellWord,
} from "./pane-launcher.js";

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
 *
 * The launch's own variables arrive the same way: a staged file the body
 * sources, so the values never reach the typed command line.
 */
function launcherBody(taskFile: string, envFile: string | null): string {
  return launchEnvBody(
    envFile,
    `command codex "$@" "$(cat ${singleQuoteShellWord(taskFile)})"`,
  );
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

/**
 * The catalogue this harness offers when the CLI cannot answer: the bundled
 * models as the real command was verified to report them here. A fallback,
 * never a second source of truth — the CLI's own answer always replaces it.
 */
/** One bundled model, with the reasoning efforts codex accepts for it. */
function bundledModel(
  slug: string,
  label: string,
  levels: readonly string[],
): ModelEntry {
  return {
    key: `${CODEX_KEY_PREFIX}${slug}`,
    label,
    thinkingLevels: { kind: "closed", levels },
  };
}

const CODEX_FALLBACK_MODELS: readonly ModelEntry[] = [
  bundledModel("gpt-6-astra", "GPT-6-Astra", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  bundledModel("gpt-6.1-sol", "GPT-6.1-Sol", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  bundledModel("gpt-6-sol", "GPT-6-Sol", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  bundledModel("gpt-6-luna", "GPT-6-Luna", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
  bundledModel("gpt-5.6-sol", "GPT-5.6-Sol", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  bundledModel("gpt-5.6-terra", "GPT-5.6-Terra", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]),
  bundledModel("gpt-5.6-luna", "GPT-5.6-Luna", [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
  bundledModel("gpt-5.5", "GPT-5.5", ["low", "medium", "high", "xhigh"]),
];

/**
 * The catalogue's envelope: one object per model. An entry that is not listed
 * is skipped before the model schema reads it, so this only has to be loose
 * enough to keep every key around for that later read.
 */
const CodexCatalogSchema = z.object({
  models: z.array(z.looseObject({ visibility: z.string().optional() })),
});

/** One reasoning level, as the catalogue declares it. */
const CodexReasoningLevelSchema = z.object({ effort: z.string().min(1) });

/**
 * One listed model, as far as this harness reads it. A model without
 * `supported_reasoning_levels` has no reasoning control.
 */
const CodexModelSchema = z.object({
  slug: z.string().regex(/^\S+$/),
  visibility: z.literal("list"),
  display_name: z.string().optional(),
  supported_reasoning_levels: z.array(CodexReasoningLevelSchema).optional(),
});

/** One listed model, as the schema read it. */
type CodexModel = z.infer<typeof CodexModelSchema>;

/** One listed model as the catalogue entry a spawn selects. */
function codexEntry(model: CodexModel): ModelEntry {
  const name = model.display_name;
  return {
    key: `${CODEX_KEY_PREFIX}${model.slug}`,
    label: name !== undefined && name !== "" ? name : model.slug,
    // The CLI's own list for this model is the vocabulary it enforces.
    thinkingLevels: {
      kind: "closed",
      levels: (model.supported_reasoning_levels ?? []).map(
        (level) => level.effort,
      ),
    },
  };
}

/**
 * The parsed list, or undefined when the output is a shape this parser does
 * not recognize. Unlisted entries are skipped before anything is read, so an
 * oddly-shaped hidden entry cannot blank the catalogue; a listed entry the
 * schema rejects means this is not the assumed shape, so nothing here is
 * trustworthy.
 */
function parseCodexModels(stdout: string): readonly ModelEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const catalog = CodexCatalogSchema.safeParse(parsed);
  if (!catalog.success) return undefined;
  const entries: ModelEntry[] = [];
  for (const model of catalog.data.models) {
    if (model.visibility !== "list") continue;
    const listed = CodexModelSchema.safeParse(model);
    if (!listed.success) return undefined;
    entries.push(codexEntry(listed.data));
  }
  return entries;
}

/** One list read: the CLI's own catalogue, or the fallback standing in for it. */
type ModelListAnswer =
  | { readonly kind: "listed"; readonly entries: readonly ModelEntry[] }
  | {
      readonly kind: "fallback";
      readonly entries: readonly ModelEntry[];
      /** Why the catalogue is the fallback's, for the caller to show. */
      readonly notice: string;
    };

/** Runs the CLI, then parses. A list the CLI cannot answer is the fallback. */
async function listCodexModels(pi: ExtensionAPI): Promise<ModelListAnswer> {
  let reason: string;
  try {
    const result = await pi.exec("codex", ["debug", "models", "--bundled"], {
      timeout: LIST_MODELS_TIMEOUT_MS,
    });
    if (result.code === 0) {
      const entries = parseCodexModels(result.stdout);
      if (entries !== undefined) return { kind: "listed", entries };
      reason = "unrecognized output";
    } else {
      reason = `\`codex debug models --bundled\` exited ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ""}`;
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  return {
    kind: "fallback",
    entries: CODEX_FALLBACK_MODELS,
    notice: `Could not list the codex models (${reason}); using the built-in defaults.`,
  };
}

/**
 * Fetches by requesting pi instance. This is memoization of an idempotent
 * read, owned by the code that performs it — not session lifecycle state, so
 * it lives here rather than in the shell. Keying by caller means no read can
 * pin another caller's pi (the instance is process-singleton in production;
 * the keying is strictness for tests and embedders, which also keeps cases
 * from leaking answers into each other with no reset helper). An empty
 * answer reads exactly like a failed list, so it is forgotten and the next
 * read retries instead of pinning an empty row; a fallback is a usable
 * answer and is kept.
 */
const modelFetches = new WeakMap<ExtensionAPI, Promise<ModelListAnswer>>();

/** The models for this caller, fetching once and memoizing the answer. */
function fetchModels(pi: ExtensionAPI): Promise<ModelListAnswer> {
  const existing = modelFetches.get(pi);
  if (existing !== undefined) return existing;
  const fetch = listCodexModels(pi);
  modelFetches.set(pi, fetch);
  // listCodexModels never rejects — every failure mode resolves an answer — so
  // the rejection arm only guards the contract, never the CLI.
  void fetch.then(
    (answer) => {
      if (answer.entries.length === 0) modelFetches.delete(pi);
    },
    () => {
      modelFetches.delete(pi);
    },
  );
  return fetch;
}

export const codexHarness: Harness<CodexLaunchRequest> = {
  agentMultiplexerKind: "codex",
  availability: () =>
    commandPath("codex") === undefined
      ? { status: "unavailable" }
      : { status: "available" },
  /**
   * codex resolves its session store from its home, and this harness's export
   * reads that store back from this process's value; a child left to resolve a
   * home of its own — from a pane environment that need not be this one's —
   * could write somewhere the export never looks. The name is reserved by the
   * codex family's table, so this process is its only source, and what is
   * handed over is the resolved directory the export reads by.
   */
  inheritedEnv: () => ({ [CODEX_HOME_ENV_VAR]: codexHomeDirectory() }),
  /**
   * Install the launcher that appends the task as the TUI's positional
   * prompt. The launcher is the whole of the pane state this harness needs,
   * so its verification is the whole of the preparation.
   */
  async prepare({
    pane,
    paneId,
    launch,
  }: HarnessPrepareRequest<CodexLaunchRequest>): Promise<void> {
    await installPaneLauncher(pane, paneId, {
      commandName: CODEX_COMMAND,
      body: launcherBody(launch.taskFile, launch.envFile),
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
   * bare slug. The reasoning effort rides `model_reasoning_effort` as a
   * config override when one was resolved: the level is codex's own effort
   * token, exactly as its catalogue declares it, so no translation happens
   * here.
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
    if (request.thinking !== null)
      args.push("-c", `model_reasoning_effort=${tomlString(request.thinking)}`);
    return args;
  },
  // codex reads its own catalog; the injected pi catalog is the pi family's,
  // which this harness does not run. Reads share the memoized fetch, so the
  // boot warm and every menu select ride one CLI run. The answer carries its
  // reason when it is the fallback's, so every reader sees why.
  listModels: ({ pi }) => fetchModels(pi),
  prefetchModels: (pi) => {
    void fetchModels(pi);
  },
  // Best effort and idempotent: this harness stages no filesystem state — the
  // system prompt and task files belong to the result-dir artifacts the
  // session owns — and the launcher dies with the pane.
  teardown: async () => {},
  // The run's cwd is its worktree, and codex keys each rollout by the cwd it
  // started in. The process is still alive when this is called, so its file is
  // the newest one for that cwd. A record the reader cannot use costs that
  // record: the export reports how many it skipped and the caller decides
  // whether that is too much to hand over.
  exportForHandover: async ({ cwd }) => {
    const exported = exportCodexSession({
      cwd,
      codexHome: codexHomeDirectory(),
    });
    return {
      sessionId: exported.sessionId,
      session: exported.session,
      loss: exported.loss,
    };
  },
};
