/**
 * spawn-ids.ts — caller-minted spawn ids for tests: a counter keeps ids unique per file
 * without depending on randomness. 8 chars like the real ones, but not Crockford base32
 * (alphabet coverage lives in test/spawn-id.test.ts and the name predicate).
 */

let counter = 0;

/** Fresh 8-char spawn id per call, unique within the test process. */
export function nextSpawnId(): string {
  return `ts${(counter++).toString(36).padStart(6, "0")}`;
}
