/**
 * menu-spawn-worktree.ts — the spawn wizard's worktree step: the repo's
 * worktrees, the row that picks one, and the name field a new worktree is shown
 * after Spawn.
 *
 * The git questions belong to `src/infrastructure/git/git-worktree.ts`, reached
 * through the `git-client` facade; this module only decides what the wizard
 * offers and how a choice reads. The picker is a submenu, so it renders in place
 * of the options rows rather than opening a screen of its own.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { Theme } from "../types.js";
import {
  isGitRepo,
  listGitWorktrees,
  type GitWorktreeEntry,
} from "../../infrastructure/git-client.js";
import { truncatePath } from "../format.js";
import { createSearchableSelect, type Notify } from "./helpers.js";
import { ScreenHost } from "./screen-host.js";
import { createWorktreeNameInput } from "./submenus/worktree-name.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** Picker sentinels: not produced by `git worktree list`, so they cannot collide with a path. */
const INHERIT_WORKTREE_VALUE = "__inherit_worktree__";
const CREATE_NEW_WORKTREE_VALUE = "__create_new_worktree__";

/** Real paths are shown by this much of their tail; the row still carries the whole path. */
const WORKTREE_PATH_TRUNCATE_LEN = 60;

/** The Worktree row's choice: `new` has no name yet, because the name field comes after Spawn. */
export type WorktreePick =
  | { kind: "inherit" }
  | { kind: "picked"; path: string; branch: string }
  | { kind: "new" };

/** The branch a run in this worktree lands on; a detached checkout is named by its directory. */
function worktreeBranch(entry: GitWorktreeEntry): string {
  return entry.branch ?? path.basename(entry.path);
}

/** The Worktree row's summary for a pick. */
function pickLabel(pick: WorktreePick): string {
  switch (pick.kind) {
    case "inherit":
      return "Inherits parent cwd";
    case "picked":
      return pick.branch;
    case "new":
      return "New worktree";
  }
}

/** The picker's rows: a new worktree, the parent cwd, then one per existing worktree. */
function pickerItems(worktrees: readonly GitWorktreeEntry[]) {
  return [
    { value: CREATE_NEW_WORKTREE_VALUE, label: "New worktree" },
    { value: INHERIT_WORKTREE_VALUE, label: "Inherits parent cwd" },
    ...worktrees.map((entry) => ({
      value: entry.path,
      label: truncatePath(entry.path, WORKTREE_PATH_TRUNCATE_LEN),
      provider: entry.isDetached ? "detached" : (entry.branch ?? "detached"),
    })),
  ];
}

/**
 * The worktrees a spawn can pick from, or null when this session has no repo to
 * offer one (no cwd, or a cwd outside git). A repo whose listing fails still
 * offers the picker, with only the new and inherit choices.
 */
export async function loadWorktreeChoices(
  pi: ExtensionAPI,
  cwd: string | null,
): Promise<GitWorktreeEntry[] | null> {
  if (cwd === null) return null;
  if (!(await isGitRepo(pi, cwd))) return null;
  return (await listGitWorktrees(pi, cwd)) ?? [];
}

export interface WorktreeRowOptions {
  /** The pick in force, for the row's summary. */
  current: WorktreePick;
  theme: Theme;
  /** Record the pick; the summary is the picker's own `done` value. */
  onPick: (pick: WorktreePick) => void;
}

/** The Worktree row, whose picker lists the repo's checkouts. */
export function buildWorktreeRow(
  worktrees: readonly GitWorktreeEntry[],
  options: WorktreeRowOptions,
): SettingItem {
  return {
    id: "worktree",
    label: "Worktree",
    currentValue: pickLabel(options.current),
    description:
      "Run in a linked git worktree instead of parent cwd; a new one is named after Spawn",
    submenu: (_value: string, done: (value?: string) => void) => {
      const record = (pick: WorktreePick): void => {
        options.onPick(pick);
        done(pickLabel(pick));
      };
      return createSearchableSelect(
        pickerItems(worktrees),
        {
          onSelect: (value) => {
            if (value === CREATE_NEW_WORKTREE_VALUE) {
              record({ kind: "new" });
              return;
            }
            if (value === INHERIT_WORKTREE_VALUE) {
              record({ kind: "inherit" });
              return;
            }
            const entry = worktrees.find((wt) => wt.path === value);
            if (entry) {
              record({
                kind: "picked",
                path: entry.path,
                branch: worktreeBranch(entry),
              });
            }
          },
          onCancel: () => done(),
        },
        options.theme,
      );
    },
  };
}

/**
 * The Worktree Name screen: one screen, resolved with the accepted name or
 * undefined when the user left without one.
 */
export async function showWorktreeNameStep(
  host: ScreenHost,
  notify: Notify,
): Promise<string | undefined> {
  return await host.open<string>(
    ({ theme, close }) =>
      new SettingsListWrapper(
        createWorktreeNameInput({
          notify,
          onDone: (name) => close(name),
          onCancel: () => close(),
        }),
        { title: "Worktree Name", theme, passthroughKeys: true },
      ),
  );
}
