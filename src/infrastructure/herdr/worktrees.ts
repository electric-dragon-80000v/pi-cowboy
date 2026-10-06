/**
 * worktrees.ts — Layer 2: herdr-managed worktrees.
 *
 * Removal never breaks the caller's primary path (the worktree may already be
 * gone); `listWorktrees` throws instead, so its callers decide how to degrade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "../../paths.js";
import {
  boolField,
  HerdrError,
  HerdrTransport,
  objectField,
  strField,
} from "./herdr-transport.js";

/** Worktree listing budget (ms). */
const WORKTREE_LIST_TIMEOUT_MS = 15_000;

/** Worktree removal budget (ms). */
const WORKTREE_REMOVE_TIMEOUT_MS = 30_000;

/** One entry of `herdr worktree list`. */
export interface HerdrWorktreeInfo {
  path: string;
  /** Herdr's label for the checkout; absent when it reported none. */
  label?: string;
  isLinkedWorktree: boolean;
  /** Workspace hosting the worktree's tab (undefined when not open). */
  openWorkspaceId?: string;
  /** Branch the checkout carries, as herdr reports it (when reported). */
  branch?: string;
}

/** Worktree resource namespace. */
export class HerdrWorktrees {
  constructor(private readonly transport: HerdrTransport) {}

  /** Remove a herdr-managed worktree. Best effort; true when herdr confirmed it. */
  async removeHerdrWorktree(workspaceId: string): Promise<boolean> {
    try {
      await this.transport.call(
        ["worktree", "remove", "--workspace", workspaceId, "--force"],
        { timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS },
      );
      return true;
    } catch {
      // best effort — worktree may already be gone
      return false;
    }
  }

  /** Worktrees of the repo containing `cwd` (or all repos when omitted). Throws HerdrError. */
  async listWorktrees(cwd?: string): Promise<HerdrWorktreeInfo[]> {
    const args = ["worktree", "list"];
    if (cwd) args.push("--cwd", cwd);
    const result = await this.transport.call(args, {
      timeoutMs: WORKTREE_LIST_TIMEOUT_MS,
    });
    const listed = objectField(result, "worktrees");
    if (!Array.isArray(listed)) {
      throw new HerdrError(
        `herdr worktree list returned no worktrees array: ${JSON.stringify(result).slice(0, 300)}`,
        undefined,
      );
    }
    const out: HerdrWorktreeInfo[] = [];
    for (const entry of listed) {
      const path = strField(entry, "path");
      if (path === undefined) continue;
      out.push({
        path,
        label: strField(entry, "label"),
        isLinkedWorktree: boolField(entry, "is_linked_worktree") ?? false,
        openWorkspaceId: strField(entry, "open_workspace_id"),
        branch: strField(entry, "branch"),
      });
    }
    return out;
  }
}

/** Herdr-reported path in the one form this extension compares by. */
export function normalizeHerdrPath(value: string): string {
  // Herdr may name a checkout through a symlinked home, a bind mount, or
  // `/tmp`, so the path is resolved rather than taken at its word. A checkout
  // reported before it exists keeps its textual form — there is no real
  // spelling to prefer.
  return canonicalPath(value) ?? value.replace(/\\/g, "/");
}

/** Worktree namespace for one pi instance. */
function worktreeNamespace(pi: ExtensionAPI): HerdrWorktrees {
  const transport = new HerdrTransport(pi);
  return new HerdrWorktrees(transport);
}

export async function removeHerdrWorktree(
  pi: ExtensionAPI,
  workspaceId: string,
): Promise<boolean> {
  return worktreeNamespace(pi).removeHerdrWorktree(workspaceId);
}

export async function listWorktrees(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<HerdrWorktreeInfo[]> {
  return worktreeNamespace(pi).listWorktrees(cwd);
}
