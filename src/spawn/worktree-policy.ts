/**
 * worktree-policy.ts — pure worktree placement, `cow-<task>-<id>` naming, and ownership recognition.
 * The task slug comes from the cowboy_agent tool's required `task_name` parameter (no derivation fallback).
 * Extension-owned = path under the worktree root AND basename with the `cow-` prefix.
 */

import * as path from "node:path";
import { canonicalPath, defaultWorktreeRoot } from "../paths.js";
import { isAvailable, type Availability } from "../availability.js";
import { SPAWN_ID_LENGTH } from "./spawn-id.js";

/** Branch prefix on every extension-created worktree (branch + tab label + path basename). */
const WORKTREE_BRANCH_PREFIX = "cow-";

/**
 * How a new worktree's working tree is populated.
 *  - "copy-on-write": `--no-checkout` add, then a CoW clone of the parent tree (ignored state
 *    rides along, shared).
 *  - "checkout": git's own classic checkout during `git worktree add`; nothing shared.
 * Copy-on-write is an optimization, not a requirement: on a volume that cannot clone every spawn
 * falls back to "checkout", and that same answer is the only value the setting offers.
 * One strategy drives both the add args and the materialization step, so they cannot disagree.
 */
export type WorktreeMaterialization = "copy-on-write" | "checkout";
/** Materialization used when none is configured. */
export const DEFAULT_WORKTREE_MATERIALIZATION: WorktreeMaterialization =
  "copy-on-write";

/** Every selectable materialization, in menu order. */
export const VALID_WORKTREE_MATERIALIZATIONS = [
  "copy-on-write",
  "checkout",
] as const satisfies readonly WorktreeMaterialization[];

/** Parse untrusted materialization; invalid values fall back at the config boundary. */
export function parseWorktreeMaterialization(
  value: unknown,
): WorktreeMaterialization | undefined {
  if (value === "copy-on-write" || value === "checkout") return value;
  return undefined;
}

/** Narrow untrusted input (config, menu) to a canonical materialization. */
export function isWorktreeMaterialization(
  value: unknown,
): value is WorktreeMaterialization {
  return parseWorktreeMaterialization(value) !== undefined;
}

/**
 * The materialization a spawn actually uses. A volume that cannot clone falls back
 * to git's classic checkout whatever the setting says — the same answer the
 * setting itself is narrowed to, so the menu can never disagree with a spawn.
 */
export function resolveWorktreeMaterialization(
  configured: WorktreeMaterialization | undefined,
  availability: Availability<WorktreeMaterialization>,
): WorktreeMaterialization {
  if (!isAvailable("copy-on-write", availability)) return "checkout";
  return configured ?? DEFAULT_WORKTREE_MATERIALIZATION;
}

/**
 * What the new worktree's checkout inherits from a dirty parent working tree.
 *  - "dirty": the whole parent working tree is CoW-cloned verbatim, so the
 *    parent's uncommitted tracked edits and untracked files ride along and the
 *    new checkout deliberately starts dirty.
 *  - "clean": tracked files are materialized from HEAD and only ignored paths are
 *    CoW-seeded; the new checkout starts clean and the parent's WIP is never
 *    imported.
 * A clean parent is unaffected: it is always CoW-cloned whole.
 */
export type WorktreeCheckoutType = "dirty" | "clean";
/** Policy used when none is configured. */
export const DEFAULT_WORKTREE_CHECKOUT_TYPE: WorktreeCheckoutType = "clean";

/** Every selectable dirty-checkout policy, in menu order. */
export const VALID_WORKTREE_CHECKOUT_TYPES = [
  "dirty",
  "clean",
] as const satisfies readonly WorktreeCheckoutType[];

/** Parse an untrusted dirty-checkout policy; invalid values fall back at the config boundary. */
export function parseWorktreeCheckoutType(
  value: unknown,
): WorktreeCheckoutType | undefined {
  if (value === "dirty" || value === "clean") return value;
  return undefined;
}

/** Narrow untrusted input (config, menu, template) to a canonical dirty-checkout policy. */
export function isWorktreeCheckoutType(
  value: unknown,
): value is WorktreeCheckoutType {
  return parseWorktreeCheckoutType(value) !== undefined;
}

/**
 * A caller's worktree target before its facts are resolved.
 *  - "new": a fresh `cow-<task>-<id>` worktree, provisioned when the run launches.
 *  - "inherit": the parent session cwd; the run has no worktree of its own.
 *  - "picked": an existing checkout named by path; the run works inside it but
 *    never owns it.
 * The cowboy_agent tool accepts exactly this shape, so a tool spawn and the
 * spawn menu offer one vocabulary rather than two.
 */
export type WorktreeRequest =
  { kind: "new" } | { kind: "inherit" } | { kind: "picked"; path: string };

/**
 * A worktree target with its facts resolved: a picked checkout carries the
 * branch git reports for it, never a branch a caller supplied.
 */
export type WorktreeSelection =
  | { kind: "new" }
  | { kind: "inherit" }
  | { kind: "picked"; path: string; branch: string };

/** The target once the run has named a new worktree; every arm is launch-ready. */
export type ResolvedWorktree =
  { kind: "new"; branch: string } | Exclude<WorktreeSelection, { kind: "new" }>;

/** The branch a run in this worktree lands on; a detached checkout is named by its directory. */
export function worktreeBranchOf(entry: {
  path: string;
  branch: string | null;
}): string {
  return entry.branch ?? path.basename(entry.path);
}

/**
 * Parse the tool's `worktree` input: omitted/null is `new`, `"inherit"` runs in
 * the parent cwd, and `{ path }` names an existing checkout whose branch the
 * caller resolves against git. Every other shape throws before anything spawns.
 */
export function parseWorktreeRequest(value: unknown): WorktreeRequest {
  if (value === undefined || value === null) return { kind: "new" };
  if (value === "new" || value === "inherit") return { kind: value };
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string"
  ) {
    const picked = (value as { path: string }).path.trim();
    if (picked !== "") return { kind: "picked", path: picked };
  }
  throw new Error(
    'Invalid `worktree`: pass "new", "inherit", or { "path": "/absolute/checkout" }. Nothing was spawned.',
  );
}

/** Max words in a task slug (fits small UI elements). */
const TASK_SLUG_MAX_WORDS = 3;

/** herdr caps an agent name at 32 characters — the one value every name-length rule reads. */
export const HERDR_AGENT_NAME_MAX_LENGTH = 32;

/** Max slug length: a generated name spends `cow-`, `-`, and the spawn id, so the slug gets the rest. */
const TASK_SLUG_MAX_LENGTH =
  HERDR_AGENT_NAME_MAX_LENGTH -
  WORKTREE_BRANCH_PREFIX.length -
  1 -
  SPAWN_ID_LENGTH;

/** Lowercase a branch-name part into a filesystem/branch-safe slug; empty input gives "agent". */
export function slugifyWorktreeType(typeName: string): string {
  const slug = typeName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

/** The words a task name contributes to its branch name. */
function taskNameWords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** Turn an orchestrator-assigned name into a slug. Over-limit names throw (never truncate); empty throws too. */
export function buildTaskSlug(input: string): string {
  const words = taskNameWords(input);
  if (words.length === 0) {
    throw new Error("Task name is empty — provide a short 2-3 word name.");
  }
  if (words.length > TASK_SLUG_MAX_WORDS) {
    throw new Error(
      `Task name "${input}" gives the branch name "${words.join("-")}" with ${words.length} words. The limit is ${TASK_SLUG_MAX_WORDS} words.`,
    );
  }
  const slug = words.join("-");
  if (slug.length > TASK_SLUG_MAX_LENGTH) {
    throw new Error(
      `Task name "${input}" gives the branch name "${slug}" with ${slug.length} characters. The limit is ${TASK_SLUG_MAX_LENGTH} characters, because herdr limits agent names to 32 characters.`,
    );
  }
  return slug;
}

/** Build the worktree branch/basename: `cow-<task>-<id>`. */
export function buildWorktreeBranch(taskSlug: string, id: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${slugifyWorktreeType(taskSlug)}-${id}`;
}

/** Absolute path of a worktree under the given root. */
export function buildWorktreePath(
  root: string,
  taskSlug: string,
  id: string,
): string {
  return path.join(root, buildWorktreeBranch(taskSlug, id));
}

/** Resolve the worktree root: configured value as-is (relative against the repo root), else the extension working dir's `worktrees` subdir. */
export function resolveWorktreeRoot(
  configRoot: string | undefined,
  repoRoot: string,
): string {
  if (configRoot && configRoot.trim() !== "") {
    return path.isAbsolute(configRoot)
      ? configRoot
      : path.resolve(repoRoot, configRoot);
  }
  return defaultWorktreeRoot();
}

/** Normalize a path for prefix comparison: the one real spelling, where one exists. */
function normalizeRoot(value: string): string {
  const canonical = canonicalPath(value) ?? value.replace(/\\/g, "/");
  return canonical.replace(/\/+$/, "");
}

/**
 * True when a name answers to a spawn id: `cow-` prefixed with that exact id suffix.
 * Exact on purpose — the `cow-` prefix keeps a user's own same-suffixed branch out.
 */
export function isSpawnArtifactName(name: string, id: string): boolean {
  return (
    id !== "" &&
    name.startsWith(WORKTREE_BRANCH_PREFIX) &&
    name.length > id.length &&
    name.endsWith(`-${id}`)
  );
}

/** True when a worktree is extension-owned: path inside the root AND `cow-` basename. */
export function isExtensionWorktree(
  worktreePath: string,
  root: string,
): boolean {
  const p = normalizeRoot(worktreePath);
  const r = normalizeRoot(root);
  if (p !== r && !p.startsWith(`${r}/`)) return false;
  const base = p.split("/").filter(Boolean).pop() ?? "";
  return base.startsWith(WORKTREE_BRANCH_PREFIX);
}
