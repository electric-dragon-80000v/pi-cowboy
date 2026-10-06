/**
 * spawn-id.ts — the single canonical spawn identity.
 * One id per spawn: worktree branch suffix, directory basename, agent/tab label, and spawn handle.
 * 8 lowercase Crockford base32 chars (40 bits); unambiguous to copy, safe for branch/dir/herdr names.
 * Uniqueness is the caller's business — see generateUniqueSpawnId.
 */

import { randomBytes } from "node:crypto";
import { CrockfordBase32 } from "crockford-base32";

/** Spawn-id alphabet (lowercase Crockford base32); src/predicates.ts derives its pattern from this. */
export const SPAWN_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Exact length of every spawn id (40 bits ⇒ 8 base32 chars). */
export const SPAWN_ID_LENGTH = 8;

/** Random bytes per mint: 5 bytes = 40 bits = 8 base32 chars. */
const SPAWN_ID_BYTES = 5;

/** Unique-mint retry budget: bounded, never loops forever. */
export const SPAWN_ID_MINT_ATTEMPTS = 32;

/** Thrown when every mint attempt in the budget returned a taken id. */
export class SpawnIdExhaustedError extends Error {
  constructor(attempts: number) {
    super(
      `Could not mint a unique spawn id after ${attempts} attempts — the id space is exhausted or the taken-check is misreporting ids.`,
    );
    this.name = "SpawnIdExhaustedError";
  }
}

/** Mint one spawn id. */
export function generateSpawnId(): string {
  return CrockfordBase32.encode(randomBytes(SPAWN_ID_BYTES)).toLowerCase();
}

/**
 * Mint an unclaimed spawn id, retrying taken candidates up to SPAWN_ID_MINT_ATTEMPTS times.
 * `mint` is injectable so retry/exhaustion are testable without a random collision.
 */
export function generateUniqueSpawnId(
  isTaken: (id: string) => boolean,
  mint: () => string = generateSpawnId,
): string {
  for (let attempt = 0; attempt < SPAWN_ID_MINT_ATTEMPTS; attempt++) {
    const id = mint();
    if (!isTaken(id)) return id;
  }
  throw new SpawnIdExhaustedError(SPAWN_ID_MINT_ATTEMPTS);
}
