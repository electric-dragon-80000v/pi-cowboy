/**
 * claude/staging.ts — the config directory a spawn is pointed at: its path,
 * its assembly, and its removal.
 *
 * claude launches with `CLAUDE_CONFIG_DIR` naming this directory, so every
 * answers-everything dialog the interactive TUI would otherwise park at is
 * decided here, before the pane exists: the theme picker (`theme`), the
 * first-run bypass-permissions acceptance (`skipDangerousModePermissionPrompt`,
 * the persisted half of `--dangerously-skip-permissions`), the onboarding
 * marker (`hasCompletedOnboarding`), and the workspace trust for the spawn's
 * own directory (`hasTrustDialogAccepted`). claude resolves the workspace to
 * its real path before the trust lookup (`/tmp` reads as `/private/tmp`), so
 * the seeded entry is keyed by the canonical path, and trust is inherited
 * downward — one entry covers the spawn whatever its worktree is named.
 * Nothing here launches anything or knows which pane the process will live in.
 *
 * The config directory itself is disposable — it lives under the spawn's
 * `<tmpdir>/pi-cowboy/` staging tree, and teardown removes the whole tree.
 * claude's session transcripts cannot be: they are the record of what the run
 * did, and nothing may discard them. So the one subtree claude keeps them in,
 * `<configDir>/projects/`, is a symlink to the store the user's own sessions
 * live in (`$CLAUDE_CONFIG_DIR/projects` when the session sets one, otherwise
 * `~/.claude/projects`). Transcripts therefore land in the user's own store,
 * keyed by the worktree's slug, where `claude --resume` in that worktree can
 * pick them up — and removing the config directory unlinks the link and
 * deletes no transcript. Everything else — settings, `.claude.json`, trust,
 * onboarding — stays in the throwaway directory.
 *
 * The run's session id is minted here rather than read back afterwards: the
 * store is shared, so its project directory holds other runs' and the user's
 * own conversations, and "the one session file in there" is no answer. The id
 * is written to `session.json` for the export, and the launcher pins it on the
 * command line with `--session-id`, so the run writes exactly one file and the
 * export knows its name.
 *
 * What is deliberately absent is the custom-API-key approval
 * (`customApiKeyResponses`): it names the tail of the `ANTHROPIC_API_KEY` in
 * the launching environment, and the harness neither sets nor reads
 * credentials — a spawn inherits whatever environment the parent session has.
 * A session that authenticates through that variable therefore still meets the
 * consent dialog once per spawn; OAuth/keychain sessions have no such dialog,
 * because the launcher pins their credential store independently of the
 * staged config directory.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
  canonicalPath,
  expandTilde,
  subagentResultDirFor,
} from "../../../paths.js";
import {
  ensureResultDir,
  writeResultFile,
} from "../../result-file-permissions.js";

/** The config directory's name inside a spawn's staging directory. */
const CONFIG_DIR_NAME = "claude";

/** Where claude reads its user settings inside a config directory. */
const SETTINGS_FILE_NAME = "settings.json";

/** Where claude keeps its global state inside a config directory. */
const STATE_FILE_NAME = ".claude.json";

/** Where claude keeps its session transcripts inside a config directory. */
const PROJECTS_DIR_NAME = "projects";

/** The run record this harness writes beside claude's own state. */
const SESSION_RECORD_NAME = "session.json";

/** The default config directory claude resolves when none is set. */
const DEFAULT_CONFIG_DIR_NAME = ".claude";

/**
 * A staged launch: the config dir claude is pointed at, and the session id
 * pinned on its command line, which names the one transcript this run writes.
 */
export interface ClaudeStaging {
  readonly configDir: string;
  readonly sessionId: string;
}

/**
 * `<subagentResultDirFor(id)>/claude` — the config dir claude is pointed at.
 */
export function claudeConfigDir(subagentId: string): string {
  return path.join(subagentResultDirFor(subagentId), CONFIG_DIR_NAME);
}

/** The staged user settings file inside a config directory. */
export function claudeSettingsFile(configDir: string): string {
  return path.join(configDir, SETTINGS_FILE_NAME);
}

/** The run record naming this launch's session inside a config directory. */
export function claudeSessionRecordFile(configDir: string): string {
  return path.join(configDir, SESSION_RECORD_NAME);
}

/**
 * The link claude writes its transcripts through. Its target is the durable
 * store, so what claude sees here is claude's own layout — `projects/` inside
 * its config dir — while the bytes outlive the config dir.
 */
export function claudeProjectsDir(configDir: string): string {
  return path.join(configDir, PROJECTS_DIR_NAME);
}

/**
 * The store the user's own sessions live in: the `projects/` directory of the
 * config dir the launching session resolved, falling back to claude's own
 * default (`~/.claude`) when the session exported none or an empty value.
 *
 * That fallback is a deliberate divergence, not a reading of claude's rule.
 * claude keeps an empty value (`??`, not `||`), leaves `~` unexpanded, and
 * resolves a relative value against the run's cwd; here an empty value lands on
 * the default, `~` is expanded, and a relative value resolves against this
 * process's cwd. Under either input a later `claude --resume` in the same
 * environment reads a different store than this link points at. Mirroring
 * claude's resolution instead would place `projects/` inside the worktree,
 * where its untracked files would keep the worktree dirty and block its
 * cleanup — the durable store wins over resume parity for those two inputs.
 *
 * Resolved per call, so a test that redirects `HOME` or `CLAUDE_CONFIG_DIR`
 * moves the store with it, and so a run inherits the store of the session that
 * launched it rather than a path cached at import time.
 */
export function claudeProjectsStore(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const base =
    configured === undefined || configured === ""
      ? path.join(homedir(), DEFAULT_CONFIG_DIR_NAME)
      : expandTilde(configured);
  return path.join(path.resolve(base), PROJECTS_DIR_NAME);
}

/**
 * The project directory claude derives from a cwd: the canonical path with
 * every non-alphanumeric character replaced by `-`. `/tmp` resolves to
 * `/private/tmp` on macOS before this runs, which is the spelling claude uses.
 *
 * Reached through `claudeProjectsDir`, so with the store linked this names the
 * durable directory — the link is resolved by the kernel, not spelled here.
 */
export function claudeProjectDir(configDir: string, cwd: string): string {
  const resolved = canonicalPath(cwd) ?? cwd;
  const slug = resolved.replace(/[^A-Za-z0-9]/g, "-");
  return path.join(claudeProjectsDir(configDir), slug);
}

/**
 * The staged user settings: the theme that skips the syntax-theme picker, and
 * the persisted bypass acceptance `--dangerously-skip-permissions` needs in an
 * interactive session (without it every launch parks at the responsibility
 * dialog). Nothing else: the model, the permissions mode and the MCP policy
 * ride the argv, so the file carries only answers the argv has no route for.
 *
 * `apiKeyHelper` is first and occupies exactly one line: it names no key
 * material (only the variable the launcher fills), and the launcher deletes
 * precisely that line on a keyless run, where a configured-but-failing helper
 * would error instead of falling through to OAuth.
 */
function settingsJson(): string {
  return `${JSON.stringify(
    {
      apiKeyHelper: `printf '%s' "$COWBOY_API_KEY"`,
      theme: "dark",
      skipDangerousModePermissionPrompt: true,
    },
    null,
    2,
  )}\n`;
}

/**
 * The staged global state: onboarding marked complete, and the workspace trust
 * for the spawn's own directory. The trust entry is keyed by the directory's
 * canonical path — claude looks the workspace up resolved, so the unresolved
 * spelling would miss.
 */
function stateJson(cwd: string): string {
  const trustedPath = canonicalPath(cwd) ?? cwd;
  return `${JSON.stringify(
    {
      hasCompletedOnboarding: true,
      projects: { [trustedPath]: { hasTrustDialogAccepted: true } },
    },
    null,
    2,
  )}\n`;
}

/** The run record: the id the launcher pins, and nothing else. */
function sessionJson(sessionId: string): string {
  return `${JSON.stringify({ sessionId }, null, 2)}\n`;
}

/**
 * Point `<configDir>/projects` at the durable store, creating the store when
 * this machine has none. A link already pointing there is left alone, so a
 * second launch in the same spawn keeps the same store.
 *
 * An entry that is not a link is not replaced: it can only be a real
 * directory, and removing it would remove transcripts. Failing the launch is
 * the honest answer, because a run that wrote into the disposable tree would
 * lose its history at teardown.
 */
function linkProjectStore(configDir: string): void {
  const store = claudeProjectsStore();
  fs.mkdirSync(store, { recursive: true });

  const link = claudeProjectsDir(configDir);
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing === undefined) {
    fs.symlinkSync(store, link);
    return;
  }
  if (!existing.isSymbolicLink()) {
    throw new Error(
      `refusing to stage claude: ${link} is not a link to ${store}, and replacing it could remove session transcripts`,
    );
  }

  const current = path.resolve(configDir, fs.readlinkSync(link));
  if (current === path.resolve(store)) return;
  fs.unlinkSync(link);
  fs.symlinkSync(store, link);
}

/**
 * Write the whole staging tree and return the config dir and the run's session
 * id. Nothing here is best-effort: every write throws, so a spawn that cannot
 * stage its answers — or cannot reach a durable store for its transcripts —
 * fails its launch instead of starting into the dialogs the staging exists to
 * skip.
 */
export function writeClaudeStaging(input: {
  subagentId: string;
  cwd: string;
}): ClaudeStaging {
  const configDir = claudeConfigDir(input.subagentId);
  const sessionId = randomUUID();
  ensureResultDir(configDir);
  linkProjectStore(configDir);
  writeResultFile(path.join(configDir, SETTINGS_FILE_NAME), settingsJson());
  writeResultFile(path.join(configDir, STATE_FILE_NAME), stateJson(input.cwd));
  writeResultFile(claudeSessionRecordFile(configDir), sessionJson(sessionId));
  return { configDir, sessionId };
}

/**
 * Remove the staging tree. Best effort and idempotent — a no-op when its
 * target is already gone (a launch that failed before prepare staged nothing).
 *
 * The transcripts are not in the tree: `projects/` is a link, and removing a
 * link removes the link, never what it points at.
 */
export function removeClaudeStaging(subagentId: string): void {
  try {
    fs.rmSync(claudeConfigDir(subagentId), { recursive: true, force: true });
  } catch {
    // Best effort: the config directory is a temp-dir artifact, like the rest of
    // the spawn's staging files, and nothing durable lives inside it.
  }
}
