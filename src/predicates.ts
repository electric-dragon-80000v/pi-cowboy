/**
 * predicates.ts — shared leaf predicates used across layers.
 * `isTaskAgentName` lives here so the infrastructure layer need not import
 * across the layer boundary into spawn/. Its pattern derives from the
 * spawn-id leaf (`SPAWN_ID_ALPHABET`, `SPAWN_ID_LENGTH`), never re-typed, so
 * an alphabet change cannot silently stop matching real agent names.
 * The agent-name grammar — the `-<index>` suffix that lets one checkout host
 * several agents — lives here too, for the same reason: the placement layer
 * composes names and the spawn layer budgets them, and neither may depend on
 * the other.
 */

import { SPAWN_ID_ALPHABET, SPAWN_ID_LENGTH } from "./spawn/spawn-id.js";

const SPAWN_ID_PATTERN = `[${SPAWN_ID_ALPHABET}]{${SPAWN_ID_LENGTH}}`;

/** herdr caps an agent name at 32 characters — the one value every name-length rule reads. */
export const HERDR_AGENT_NAME_MAX_LENGTH = 32;

/**
 * Highest per-checkout agent index. One digit keeps the `-<n>` suffix inside the
 * name budget the branch and task-slug rules reserve for it, and it bounds how
 * many agents one checkout can host.
 */
export const AGENT_NAME_INDEX_MAX = 9;

/** The widest suffix `agentNameWithIndex` can append: the dash plus that one digit. */
export const AGENT_NAME_SUFFIX_MAX_LENGTH =
  String(AGENT_NAME_INDEX_MAX).length + 1;

/** A placement's name: the worktree/branch base plus its index (herdr names must be unique). */
export function agentNameWithIndex(base: string, index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > AGENT_NAME_INDEX_MAX) {
    throw new Error(
      `agent index must be an integer in 1..${AGENT_NAME_INDEX_MAX}, got ${String(index)}`,
    );
  }
  const name = `${base}-${index}`;
  if (name.length > HERDR_AGENT_NAME_MAX_LENGTH) {
    throw new Error(
      `agent name "${name}" is ${name.length} characters, over herdr's ${HERDR_AGENT_NAME_MAX_LENGTH}-character limit`,
    );
  }
  return name;
}

/** A placement name split back into the base it was built from and its index. */
export interface ParsedAgentName {
  /** The worktree/branch base — the name with its `-<index>` suffix removed. */
  readonly base: string;
  /** 1 for a name with no suffix (a placement named before indices existed). */
  readonly index: number;
}

/**
 * Split a placement name into its base and index — the inverse of
 * `agentNameWithIndex`, so a checkout's branch survives as the name the agent
 * was given.
 *
 * A trailing `-<digits>` is an index only when it is one this module could have
 * appended, i.e. within `1..AGENT_NAME_INDEX_MAX`. That bound is what makes the
 * read safe: a spawn id is a fixed eight characters, so its digits are never
 * short enough to be mistaken for an index, and nothing else in a placement name
 * ends in a bare number.
 */
export function parseAgentName(name: string): ParsedAgentName {
  const match = /^(.*)-(\d+)$/.exec(name);
  if (match === null) return { base: name, index: 1 };
  const index = Number(match[2]);
  if (
    !Number.isSafeInteger(index) ||
    index < 1 ||
    index > AGENT_NAME_INDEX_MAX
  ) {
    return { base: name, index: 1 };
  }
  return { base: match[1], index };
}

/**
 * Agent names are `cow-<slug>-<id>`, optionally followed by `-<index>`. The
 * slug boundary is explicit — `fix` must not match `fix-login-flow-<id>` — hence
 * the full anchored shape instead of a prefix test. A name with no suffix is the
 * index-1 spelling every placement carried before indices existed.
 */
export function isTaskAgentName(name: string, taskSlug: string): boolean {
  // taskSlug comes from buildTaskSlug: only [a-z0-9_-], no regex metacharacters.
  return new RegExp(`^cow-${taskSlug}-${SPAWN_ID_PATTERN}(-\\d+)?$`).test(name);
}

/**
 * A keyed object, not an array: callers reading fields off untrusted JSON read
 * `undefined` rather than an array's absent properties.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The string an environment value carries, or nothing when it is absent or
 * blank: an unset variable and an empty one both mean `unset` to every reader
 * here, which is why the answer is a value rather than a flag.
 */
export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
