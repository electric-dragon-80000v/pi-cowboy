/**
 * harness/claude/index.ts — the claude harness: a binary of its own, staged
 * and launched behind the pane's `claude`.
 *
 * claude is not a pi-compatible binary: its task cannot ride the argv at all
 * (herdr rejects multi-line arguments, and a task is multi-line text), so the
 * launcher appends it as the positional initial prompt — past a `--` that ends
 * option parsing, `"$(cat '<taskFile>')"` expands inside the pane's shell, where herdr's single-line
 * argv encoding never reaches. `prepare` stages the config directory claude is
 * pointed at (staging.ts), installs that launcher into the pane, and then
 * proves the pane can see the staged files and resolve the binary; `buildArgs`
 * is claude's interactive CLI with the task deliberately absent;
 * `teardown` removes the staged tree.
 *
 * `listModels` is a curated constant: claude has no CLI enumeration, and a
 * wrong list is worse than a short one, so it names only the aliases a real
 * run was seen to answer (`haiku`, `sonnet`, `opus`) and nothing it was seen
 * to refuse.
 *
 * The strict `[harness.claude]` table carries `model`, `thinking`, and the tool
 * pair, all in claude's own vocabulary: the tool names ride `--tools` /
 * `--disallowedTools` and the effort rides `--effort` exactly as written, with
 * no translation, and the model key's `anthropic/` prefix is stripped at the
 * argv boundary because the CLI takes a bare alias or full model name.
 */

import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPath } from "../../../infrastructure/exec-path.js";
import { expandTilde, subagentTokenFor } from "../../../paths.js";
import type {
  ClaudeLaunchRequest,
  Harness,
  HarnessPrepareRequest,
  ModelEntry,
  ThinkingLevels,
} from "../../harness.js";
import {
  installPaneLauncher,
  launchEnvBody,
  type PaneProof,
} from "../pane-launcher.js";
import { exportClaudeSession } from "./session-export.js";
import {
  claudeConfigDir,
  claudeSettingsFile,
  removeClaudeStaging,
  writeClaudeStaging,
} from "./staging.js";

/** Budget for the pane's staged-state proof; shell builtins, no CLI boot. */
const STAGED_PROOF_TIMEOUT_MS = 15_000;

/** The command herdr types into the pane; the launcher is installed under it. */
const CLAUDE_COMMAND = "claude";

/** Signature carried by this launcher, so pane verification proves which launcher landed. */
const LAUNCHER_SIGNATURE = "CLAUDE_LAUNCHER_3f7a1d";

/** Token the verify command echoes once the launcher body is confirmed. */
const LAUNCHER_READY_MARKER = "CLAUDE_VERIFIED";

/** Token the staged-state proof echoes once the pane sees the launch state. */
const STAGED_MARKER = "CLAUDE_STAGED";

/**
 * The credential store the parent session is using, as claude derives it.
 * An explicitly empty `CLAUDE_SECURESTORAGE_CONFIG_DIR` is meaningful — it
 * pins the default store — so `??` is required here rather than `||`.
 */
function parentCredentialStore(): string {
  return (
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ??
    process.env.CLAUDE_CONFIG_DIR ??
    ""
  );
}

/**
 * The value a spawn exports for its credential store.
 *
 * macOS keeps credentials in the Keychain, and the service name is
 * `Claude Code-credentials` for an empty value and
 * `Claude Code-credentials-<sha256(value)[:8]>` otherwise. The value is hashed
 * verbatim, so the parent's value is forwarded unchanged; substituting
 * `~/.claude` would select a different, empty item.
 *
 * Linux keeps `.credentials.json` under the value, so an empty value means
 * `~/.claude` and the parent's directory is resolved. The value itself is not
 * tilde-expanded, so the expansion happens here.
 */
export function spawnCredentialStore(platform: NodeJS.Platform): string {
  const parent = parentCredentialStore();

  switch (platform) {
    case "darwin":
      return parent;

    case "linux": {
      const dir =
        parent === "" ? path.join(homedir(), ".claude") : expandTilde(parent);
      return path.isAbsolute(dir) ? dir : path.resolve(dir);
    }

    default:
      return parent;
  }
}

/**
 * The launcher body: the credential rename first, then claude's config
 * directory and the memory suppression a spawn needs (pi-cowboy renders
 * context into the system prompt itself, so the worktree's memory files would
 * only load twice), then the real binary with the pane's own arguments and
 * the task as its positional initial prompt.
 *
 * The rename keeps the consent predicate from ever seeing a key: with
 * `ANTHROPIC_API_KEY` unset it cannot fire, and the key resolves through the
 * staged `apiKeyHelper` instead, which has no approval check. The `unset` is
 * load-bearing — a staged helper alone does not suppress the dialog while the
 * variable is still set (verified against the real CLI: the TUI parks at the
 * consent prompt). Pane-side, `env` therefore shows `COWBOY_API_KEY` where
 * the ambient key was: that absence is this line working, not a missing
 * credential. On a keyless run the rename is a no-op, so the launcher deletes the helper's line from
 * the staged settings — a configured-but-failing helper errors instead of
 * falling through to OAuth, and only an absent helper leaves that path open.
 * The deletion names the line's key rather than its number, so it survives
 * reformatting as long as the helper keeps its own line (see staging.ts);
 * `grep` + `mv` are POSIX-portable where `sed -i` is not, and a failed trim
 * leaves the file untouched (loud helper error) rather than half-edited.
 *
 * Bare `claude` keeps the pane's `PATH` the authority on which binary runs,
 * and `command` bypasses this very function. The `$(cat …)` expansion is what
 * delivers a multi-line task: herdr encodes the argv it types and refuses
 * multi-line arguments, but this expansion happens inside the pane's shell,
 * past that encoding, as one word of the launched command. The `--` before it
 * ends option parsing: `--tools` / `--disallowedTools` are variadic and would
 * otherwise swallow the task as another tool name (and a task starting with
 * `-` would parse as a flag), leaving the TUI idle with no initial prompt.
 *
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` is exported before `CLAUDE_CONFIG_DIR` so
 * the credential store stays the parent's while the config dir is the staging
 * dir. An empty value is written as `''`, which pins the default store.
 */
function launcherBody(
  configDir: string,
  taskFile: string,
  credentialStore: string,
  envFile: string | null,
): string {
  const settings = singleQuote(claudeSettingsFile(configDir));
  const trimmed = singleQuote(`${claudeSettingsFile(configDir)}.tmp`);
  return [
    `if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then export COWBOY_API_KEY="$ANTHROPIC_API_KEY"; unset ANTHROPIC_API_KEY; else grep -v '"apiKeyHelper"' ${settings} > ${trimmed} && mv ${trimmed} ${settings}; fi`,
    `export CLAUDE_SECURESTORAGE_CONFIG_DIR=${singleQuote(credentialStore)}`,
    `export CLAUDE_CONFIG_DIR=${singleQuote(configDir)}`,
    "export CLAUDE_CODE_DISABLE_CLAUDE_MDS=1",
    launchEnvBody(
      envFile,
      `command claude "$@" -- "$(cat ${singleQuote(taskFile)})"`,
    ),
  ].join("; ");
}

/**
 * A value as one POSIX shell word: single quotes around it, and the `'\''` dance
 * for any single quote inside. Every path this harness passes is its own temp
 * path, but the launcher is a shell command herdr types into the pane, so the
 * value is quoted rather than trusted.
 */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The proof that the pane can launch what prepare staged, read back through
 * the shell that will run it.
 *
 * `command -v` (not `claude --version`) proves the binary resolves on the
 * pane's `PATH` — which need not match the parent's — without booting the CLI
 * into a networked update check. The lookup runs past an `unset -f` in a
 * subshell because `command -v` resolves functions before `PATH`: without it
 * the check would pass on the launcher this install just defined, even with
 * no binary anywhere, and the failure below could never fire. The subshell
 * keeps the installed launcher intact for the launch that follows. The
 * `test -r` pair proves the staged settings and the task file the launcher
 * names are visible from the pane; without them the TUI would park at its
 * onboarding or trust dialog, which nothing in the argv or exit status
 * reports. The marker is broken with a `""` so only the shell's evaluation
 * of the command — not the command line's own echo, which `wait-output` also
 * sees — produces the contiguous token.
 */
function stagedProof(configDir: string, taskFile: string): PaneProof {
  return {
    command: `test -r ${singleQuote(claudeSettingsFile(configDir))} && test -r ${singleQuote(taskFile)} && (unset -f ${CLAUDE_COMMAND}; command -v ${CLAUDE_COMMAND} >/dev/null) && echo CLAUDE_""STAGED`,
    output: STAGED_MARKER,
    timeoutMs: STAGED_PROOF_TIMEOUT_MS,
    failure: `failed to prepare the pane: the pane never proved it can see the staged claude state — the settings ${claudeSettingsFile(configDir)}, the task ${taskFile}, or the claude binary on its PATH. The agent did not start.`,
  };
}

/**
 * The model key as claude's `--model` takes it: the CLI accepts a bare alias
 * (`sonnet`) or a full model name, never the `provider/model` shape every
 * layer stores, so the `anthropic/` prefix is stripped at this boundary. A key
 * outside the anthropic provider rides as written — there is nothing to
 * translate it to, and the API surfaces the mistake.
 */
function claudeModelName(modelKey: string): string {
  const prefix = "anthropic/";
  return modelKey.startsWith(prefix) ? modelKey.slice(prefix.length) : modelKey;
}

/**
 * The tool selection as claude's tool flags, in claude's own names
 * (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Task`, …) exactly as the
 * template wrote them. `--tools ""` is claude's spelling of none; the default
 * case emits no flag, so claude's own discovery stands.
 */
function toolArgs(request: ClaudeLaunchRequest): string[] {
  switch (request.toolSelection.kind) {
    case "default":
      return [];
    case "none":
      return ["--tools", ""];
    case "include":
      return ["--tools", request.toolSelection.names.join(",")];
    case "exclude":
      return ["--disallowedTools", request.toolSelection.names.join(",")];
  }
}

/**
 * claude's effort levels: the values `--effort` accepts, verified against the
 * installed CLI. The CLI enumerates nothing per model, so every alias carries
 * the same list rather than a guess at which levels its model supports.
 */
const CLAUDE_THINKING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Every alias carries the same closed list: `--effort` accepts these and no others. */
const CLAUDE_THINKING: ThinkingLevels = {
  kind: "closed",
  levels: CLAUDE_THINKING_LEVELS,
};

/**
 * Every model this harness offers, as `anthropic/<alias>` keys, in ascending
 * capability. claude's CLI has no list command, so this list is curated, not
 * discovered: each alias was seen to answer on the real CLI, and an alias that
 * was seen refused stays off. A menu therefore offers only models a launch can
 * actually run. `fable` is additionally gated behind a one-time usage-credits
 * consent that only an interactive `/model fable` grants, so a spawn naming it
 * can still be refused or substituted by the CLI rather than by this harness.
 */
const CLAUDE_MODELS: readonly ModelEntry[] = [
  { key: "anthropic/haiku", label: "haiku", thinkingLevels: CLAUDE_THINKING },
  { key: "anthropic/sonnet", label: "sonnet", thinkingLevels: CLAUDE_THINKING },
  { key: "anthropic/opus", label: "opus", thinkingLevels: CLAUDE_THINKING },
  { key: "anthropic/fable", label: "fable", thinkingLevels: CLAUDE_THINKING },
  { key: "anthropic/mythos", label: "mythos", thinkingLevels: CLAUDE_THINKING },
];

export const claudeHarness: Harness<ClaudeLaunchRequest> = {
  agentMultiplexerKind: "claude",
  availability: () =>
    commandPath("claude") === undefined
      ? { status: "unavailable" }
      : { status: "available" },
  /**
   * Stage the config directory, install the launcher that points claude at it
   * and appends the task, and prove the pane sees the staged state behind it.
   * A launch reaches the CLI through this pane state alone, so it is verified
   * here rather than assumed.
   */
  async prepare({
    pane,
    paneId,
    cwd,
    launch,
  }: HarnessPrepareRequest<ClaudeLaunchRequest>): Promise<void> {
    const configDir = writeClaudeStaging({
      subagentId: launch.subagentId,
      cwd,
    });
    await installPaneLauncher(pane, paneId, {
      commandName: CLAUDE_COMMAND,
      body: launcherBody(
        configDir,
        launch.taskFile,
        spawnCredentialStore(process.platform),
        launch.envFile,
      ),
      signature: LAUNCHER_SIGNATURE,
      readyMarker: LAUNCHER_READY_MARKER,
      proof: stagedProof(configDir, launch.taskFile),
    });
  },
  /**
   * `--system-prompt-file` replaces claude's default system prompt (parity
   * with the pi family, which also replaces): the staged prompt already
   * carries the rendered context, so the default's own tool guidance is the
   * price of the replace. The identity rides `--append-system-prompt`, which
   * appends rather than replaces. `--dangerously-skip-permissions` is what
   * lets a background pane run tools without approvals, with its interactive
   * acceptance pre-seeded in the staged settings. `--setting-sources user`
   * and `--strict-mcp-config` keep the worktree's own settings and MCP
   * servers out of the spawn, so a launch reads only what this harness
   * staged. The task is absent: the launcher appends it as the positional
   * initial prompt, because multi-line text cannot cross herdr's argv. The
   * effort rides `--effort` only when one was resolved, as the level claude's
   * own vocabulary names it.
   */
  buildArgs(request: ClaudeLaunchRequest): string[] {
    const args = [
      "--system-prompt-file",
      request.systemPromptFile,
      "--append-system-prompt",
      subagentTokenFor(request.subagentId),
      "-n",
      request.subagentId,
      "--dangerously-skip-permissions",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
    ];
    if (request.modelKey !== null)
      args.push("--model", claudeModelName(request.modelKey));
    if (request.thinking !== null) args.push("--effort", request.thinking);
    args.push(...toolArgs(request));
    return args;
  },
  // The list is a constant, not a fetch: claude offers no enumeration command,
  // so there is nothing to memoize, nothing to warm, and nothing that can fail.
  listModels: () => Promise.resolve({ kind: "listed", entries: CLAUDE_MODELS }),
  prefetchModels: (_pi: ExtensionAPI) => {},
  // Best effort and idempotent: the staged tree is this harness's only
  // filesystem state, and a launch that failed before prepare staged nothing.
  teardown: async ({ subagentId }) => {
    removeClaudeStaging(subagentId);
  },
  /**
   * Read the run's conversation out of the staging directory this harness
   * pointed claude at. The config directory is a pure function of the subagent
   * id and the project directory a pure function of the run's cwd, so the
   * export is a lookup; the reader refuses, with a typed reason, when the run
   * left no single session behind. `pi` and `paneId` are not read: claude
   * writes its own store, so nothing here asks the CLI or the pane.
   */
  exportForHandover: async ({ subagentId, cwd }) =>
    exportClaudeSession({ configDir: claudeConfigDir(subagentId), cwd }),
};
