/**
 * predicates.ts — shared leaf predicates used across layers.
 * `isTaskAgentName` lives here so the infrastructure layer need not import
 * across the layer boundary into spawn/. Its pattern derives from the
 * spawn-id leaf (`SPAWN_ID_ALPHABET`, `SPAWN_ID_LENGTH`), never re-typed, so
 * an alphabet change cannot silently stop matching real agent names.
 */

import { SPAWN_ID_ALPHABET, SPAWN_ID_LENGTH } from "./spawn/spawn-id.js";

const SPAWN_ID_PATTERN = `[${SPAWN_ID_ALPHABET}]{${SPAWN_ID_LENGTH}}`;

/**
 * Agent names are `cow-<slug>-<id>`. The slug boundary is explicit — `fix`
 * must not match `fix-login-flow-<id>` — hence the full anchored shape
 * instead of a prefix test.
 */
export function isTaskAgentName(name: string, taskSlug: string): boolean {
  // taskSlug comes from buildTaskSlug: only [a-z0-9_-], no regex metacharacters.
  return new RegExp(`^cow-${taskSlug}-${SPAWN_ID_PATTERN}$`).test(name);
}

/**
 * A keyed object, not an array: callers reading fields off untrusted JSON read
 * `undefined` rather than an array's absent properties.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
