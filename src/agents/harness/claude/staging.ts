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
 * What is deliberately absent is the custom-API-key approval
 * (`customApiKeyResponses`): it names the tail of the `ANTHROPIC_API_KEY` in
 * the launching environment, and the harness neither sets nor reads
 * credentials — a spawn inherits whatever environment the parent session has.
 * A session that authenticates through that variable therefore still meets the
 * consent dialog once per spawn; OAuth/keychain sessions have no such dialog
 * (the keychain entry is keyed by account, not by config directory).
 */

import fs from "node:fs";
import * as path from "node:path";
import { canonicalPath, subagentResultDirFor } from "../../../paths.js";
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

/**
 * Write the whole staging tree and return the config dir. Nothing here is
 * best-effort: every write throws, so a spawn that cannot stage its answers
 * fails its launch instead of starting into the dialogs the staging exists
 * to skip.
 */
export function writeClaudeStaging(input: {
  subagentId: string;
  cwd: string;
}): string {
  const configDir = claudeConfigDir(input.subagentId);
  ensureResultDir(configDir);
  writeResultFile(path.join(configDir, SETTINGS_FILE_NAME), settingsJson());
  writeResultFile(path.join(configDir, STATE_FILE_NAME), stateJson(input.cwd));
  return configDir;
}

/**
 * Remove the staging tree. Best effort and idempotent — a no-op when its
 * target is already gone (a launch that failed before prepare staged nothing).
 */
export function removeClaudeStaging(subagentId: string): void {
  try {
    fs.rmSync(claudeConfigDir(subagentId), { recursive: true, force: true });
  } catch {
    // Best effort: the config directory is a temp-dir artifact, like the rest of
    // the spawn's staging files.
  }
}
