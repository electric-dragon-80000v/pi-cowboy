/**
 * menu-worktree-command.ts — the `/cowboy worktree` command: name → checkout → create → report.
 *
 * Creates one git worktree under the configured worktree root and adopts it in
 * herdr with nothing running in it. The name is the branch and the directory at
 * once, the parent is the repository the session sits in, and the base is HEAD;
 * nothing else is asked. Only git knows about the result — there is no spawn
 * record, no entry in `/cowboy status`, and nothing cleans it up. Any failure
 * after the git create, a failed herdr adoption included, removes the worktree
 * and its branch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SelectList } from "@earendil-works/pi-tui";
import {
  gitProbe,
  isGitRepo,
  resolveMainCheckout,
  type WorktreeMaterializationOutcome,
} from "../../infrastructure/git-client.js";
import {
  getPiInstance,
  getRuntime,
  getStore,
  getWorktreeMaterialization,
} from "../../shell.js";
import {
  createAdoptedWorktree,
  type AdoptedWorktree,
} from "../../spawn/sandbox.js";
import {
  VALID_WORKTREE_CHECKOUT_TYPES,
  parseWorktreeCheckoutType,
  resolveWorktreeRoot,
  type WorktreeCheckoutType,
} from "../../spawn/worktree-policy.js";
import { errorMessage } from "../../utils.js";
import { actionReport, buildSelectListTheme, type Notify } from "./helpers.js";
import { ScreenHost } from "./screen-host.js";
import { createWorktreeCommandNameInput } from "./submenus/worktree-command-name.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** What each checkout policy means for the worktree this command is about to create. */
const CHECKOUT_DESCRIPTIONS: Record<WorktreeCheckoutType, string> = {
  dirty:
    "Start from the parent's uncommitted work: copy-on-write clones its edits and untracked files, checkout applies only its tracked changes.",
  clean:
    "Start at HEAD: the parent's uncommitted work stays out of the worktree.",
};

/** How the created worktree's tree was actually populated. */
function materializationLabel(outcome: WorktreeMaterializationOutcome): string {
  switch (outcome.kind) {
    case "cow":
      return "copy-on-write";
    case "cow-fallback":
      return "checkout (the volume cannot clone, so copy-on-write was unavailable)";
    case "checkout":
      return "checkout";
  }
}

/** What the created worktree took from the parent working tree. */
function inheritedLabel(
  outcome: WorktreeMaterializationOutcome,
  dirtyCheckout: WorktreeCheckoutType,
): string {
  switch (outcome.kind) {
    case "cow":
      if (outcome.clone.mode === "seeded") {
        return "nothing the parent had uncommitted: tracked files came from HEAD and only ignored state was seeded";
      }
      return outcome.clone.reason !== undefined
        ? "the parent's uncommitted work: its tracked edits and its untracked files"
        : "nothing uncommitted — the parent was clean, so the worktree is a clone at HEAD";
    case "cow-fallback":
      return "nothing: the fallback checkout starts at HEAD, whatever the checkout policy says";
    case "checkout":
      return dirtyCheckout === "dirty"
        ? "the parent's tracked changes, applied on top of git's checkout of HEAD (a clean parent carries none)"
        : "nothing: git checked out HEAD, and the parent's uncommitted work stays out";
  }
}

/** The one message a created worktree is reported with. */
function describeCreatedWorktree(
  created: AdoptedWorktree,
  dirtyCheckout: WorktreeCheckoutType,
): string {
  return [
    `Worktree ready: ${created.path}`,
    `branch: ${created.branch}`,
    `materialization: ${materializationLabel(created.materialization)}`,
    `inherited: ${inheritedLabel(created.materialization, dirtyCheckout)}`,
  ].join("\n");
}

/** Why the name is already taken, or undefined when it is free. */
async function describeCollision(
  pi: ExtensionAPI,
  repoCwd: string,
  branch: string,
  targetPath: string,
): Promise<string | undefined> {
  if (fs.existsSync(targetPath)) {
    return `Cannot create the worktree: ${targetPath} already exists. Pick another name.`;
  }
  const existingBranch = await gitProbe(
    pi,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoCwd,
  );
  if (existingBranch !== undefined) {
    return `Cannot create the worktree: the branch "${branch}" already exists. Pick another name.`;
  }
  return undefined;
}

/**
 * The `/cowboy worktree` flow. `inlineName` is the name given on the command
 * line, prefilled into the field; a bare command opens it empty.
 */
export async function showWorktreeCommandMenu(
  ctx: ExtensionCommandContext,
  inlineName: string,
): Promise<void> {
  const host = new ScreenHost(ctx);
  const notify: Notify = (message, kind) => ctx.ui.notify(message, kind);

  const name = await host.open<string>(
    ({ theme, close }) =>
      new SettingsListWrapper(
        createWorktreeCommandNameInput({
          prefill: inlineName,
          notify,
          onDone: (accepted) => close(accepted),
          onCancel: () => close(),
        }),
        { title: "Worktree Name", theme, passthroughKeys: true },
      ),
  );
  if (name === undefined) return;

  const store = getStore();
  const dirtyCheckout = await host.open<WorktreeCheckoutType>(
    ({ theme, close }) => {
      const list = new SelectList(
        VALID_WORKTREE_CHECKOUT_TYPES.map((value) => ({
          value,
          label: value,
          description: CHECKOUT_DESCRIPTIONS[value],
        })),
        VALID_WORKTREE_CHECKOUT_TYPES.length,
        buildSelectListTheme(theme),
      );
      // The configured policy leads; it is what a spawn would use right now.
      list.setSelectedIndex(
        VALID_WORKTREE_CHECKOUT_TYPES.indexOf(store.agent.worktreeCheckoutType),
      );
      list.onSelect = (item) => close(parseWorktreeCheckoutType(item.value));
      list.onCancel = () => close();
      return new SettingsListWrapper(list, {
        title: "Worktree Checkout",
        theme,
        onCancel: () => close(),
      });
    },
  );
  if (dirtyCheckout === undefined) return;

  const pi = getPiInstance();
  if (!(await isGitRepo(pi, ctx.cwd))) {
    notify(
      "Cannot create a worktree: this session is not inside a git repository.",
      "error",
    );
    return;
  }
  let repoRoot: string;
  try {
    repoRoot = await resolveMainCheckout(pi, ctx.cwd);
  } catch (err) {
    notify(`Cannot create a worktree: ${errorMessage(err)}`, "error");
    return;
  }

  const targetPath = path.join(
    resolveWorktreeRoot(store.agent.worktreeRoot, repoRoot),
    name,
  );
  const collision = await describeCollision(pi, repoRoot, name, targetPath);
  if (collision !== undefined) {
    notify(collision, "error");
    return;
  }

  const report = actionReport(ctx.ui);
  report.pending(`Creating worktree ${name}`);
  let created: AdoptedWorktree;
  try {
    created = await createAdoptedWorktree(pi, {
      repoCwd: repoRoot,
      path: targetPath,
      branch: name,
      materialization: getWorktreeMaterialization(),
      dirtyCheckout,
      notify,
      host: getRuntime()!.host,
    });
  } catch (err) {
    report.failed("Worktree creation failed", err);
    return;
  }
  report.succeeded(describeCreatedWorktree(created, dirtyCheckout));
}
