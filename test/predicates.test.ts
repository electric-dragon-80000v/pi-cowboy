/**
 * predicates.test.ts — the shared leaf predicates.
 * `isTaskAgentName`: pins the derived pattern (`SPAWN_ID_ALPHABET`/
 * `SPAWN_ID_LENGTH`, never re-typed) — non-hex ids still match, and every
 * minted id matches. `isRecord`: pins the array exclusion.
 */

import { describe, expect, it } from "vitest";
import { isRecord, isTaskAgentName } from "../src/predicates.js";
import {
  SPAWN_ID_ALPHABET,
  SPAWN_ID_LENGTH,
  generateSpawnId,
} from "../src/spawn/spawn-id.js";

describe("isTaskAgentName", () => {
  it("matches a Crockford id that is not hex", () => {
    // All valid Crockford digits outside [0-9a-f].
    expect(
      isTaskAgentName("cow-fix-login-flow-z7k3m9q2", "fix-login-flow"),
    ).toBe(true);
    expect(
      isTaskAgentName("cow-fix-login-flow-tvwyzx98", "fix-login-flow"),
    ).toBe(true);
  });

  // Proves the derived pattern accepts every id the mint emits.
  const mintedNames = Array.from(
    { length: 50 },
    () => `cow-some-task-${generateSpawnId()}`,
  );

  it.each(mintedNames)("matches every minted id: %s", (name) => {
    expect(isTaskAgentName(name, "some-task")).toBe(true);
  });

  it("is derived from the spawn id's own alphabet and length", () => {
    // The pattern cannot accept a character or length the mint never emits.
    const id = SPAWN_ID_ALPHABET.slice(0, SPAWN_ID_LENGTH);
    expect(id).toBe("01234567");
    expect(isTaskAgentName(`cow-t-${id}`, "t")).toBe(true);
    expect(isTaskAgentName(`cow-t-${id.slice(1)}`, "t")).toBe(false);
    expect(isTaskAgentName(`cow-t-${id}a`, "t")).toBe(false);
  });

  it.each(["i", "l", "o", "u"])(
    "rejects the ambiguous character %s Crockford excludes",
    (char) => {
      expect(isTaskAgentName(`cow-t-${char}bcdefgh`, "t")).toBe(false);
    },
  );

  it("keeps the slug boundary explicit", () => {
    expect(isTaskAgentName("cow-fix-01234567", "fix")).toBe(true);
    expect(isTaskAgentName("cow-fix-login-flow-01234567", "fix")).toBe(false);
    expect(isTaskAgentName("cow-fix-01234567", "fix-login-flow")).toBe(false);
    // No nameless form: a task slug names every agent.
    expect(isTaskAgentName("cow-0123456789abcdef0", "fix")).toBe(false);
  });
});

describe("isRecord", () => {
  it("accepts a keyed object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ kind: "ready", pid: 42 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("rejects an array", () => {
    // Callers read keyed fields off untrusted JSON; an array has none, so it
    // must never pass as a record.
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ role: "user" }])).toBe(false);
  });

  it.each([null, undefined, "text", 42, () => {}, Symbol("s")])(
    "rejects the non-object %s",
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
