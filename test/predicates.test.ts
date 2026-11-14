/**
 * predicates.test.ts — the shared leaf predicates.
 * `isTaskAgentName`: pins the derived pattern (`SPAWN_ID_ALPHABET`/
 * `SPAWN_ID_LENGTH`, never re-typed) — non-hex ids still match, and every
 * minted id matches. `isRecord`: pins the array exclusion.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_INDEX_MAX,
  agentNameWithIndex,
  isRecord,
  isTaskAgentName,
  parseAgentName,
} from "../src/predicates.js";
import {
  SPAWN_ID_ALPHABET,
  SPAWN_ID_LENGTH,
  generateSpawnId,
} from "../src/spawn/spawn-id.js";

describe("agent name indices", () => {
  it("appends the index after a dash", () => {
    expect(agentNameWithIndex("cow-fix-login", 1)).toBe("cow-fix-login-1");
    expect(agentNameWithIndex("cow-fix-login", 3)).toBe("cow-fix-login-3");
  });

  it("refuses an index outside 1..max", () => {
    expect(() => agentNameWithIndex("cow-fix", 0)).toThrow(/in 1\.\./);
    expect(() =>
      agentNameWithIndex("cow-fix", AGENT_NAME_INDEX_MAX + 1),
    ).toThrow(/in 1\.\./);
    expect(() => agentNameWithIndex("cow-fix", 1.5)).toThrow(/in 1\.\./);
  });

  it("refuses a name the suffix pushes over herdr's limit", () => {
    expect(() => agentNameWithIndex("a".repeat(32), 1)).toThrow(/over herdr/);
  });

  it("reads a bare name as index 1, so old names keep their meaning", () => {
    expect(parseAgentName("cow-fix-01234567")).toEqual({
      base: "cow-fix-01234567",
      index: 1,
    });
  });

  it("splits a suffixed name back into its base and index", () => {
    expect(parseAgentName("cow-fix-01234567-2")).toEqual({
      base: "cow-fix-01234567",
      index: 2,
    });
  });

  it("recovers the branch a placement name was built from", () => {
    expect(parseAgentName("cow-fix-login-flow-01234567-3").base).toBe(
      "cow-fix-login-flow-01234567",
    );
  });

  it("does not read a spawn id's own digits as an index", () => {
    // The id is a fixed eight characters, so it is never short enough to be an
    // index; a run past the bound stays part of the base.
    expect(parseAgentName("cow-fix-01234567")).toEqual({
      base: "cow-fix-01234567",
      index: 1,
    });
    expect(parseAgentName("cow-fix-01234567-1234")).toEqual({
      base: "cow-fix-01234567-1234",
      index: 1,
    });
  });

  it.each(Array.from({ length: AGENT_NAME_INDEX_MAX }, (_u, i) => i + 1))(
    "parses what it composes, at index %i",
    (index) => {
      expect(
        parseAgentName(agentNameWithIndex("cow-fix-01234567", index)),
      ).toEqual({ base: "cow-fix-01234567", index });
    },
  );
});

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

  it("matches the index suffix the composer writes", () => {
    expect(isTaskAgentName("cow-fix-01234567-1", "fix")).toBe(true);
    expect(isTaskAgentName("cow-fix-01234567-2", "fix")).toBe(true);
    expect(
      isTaskAgentName(`cow-fix-01234567-${AGENT_NAME_INDEX_MAX}`, "fix"),
    ).toBe(true);
  });

  it.each(Array.from({ length: AGENT_NAME_INDEX_MAX }, (_u, i) => i + 1))(
    "accepts the name it composes at index %i",
    (index) => {
      expect(
        isTaskAgentName(agentNameWithIndex("cow-fix-01234567", index), "fix"),
      ).toBe(true);
    },
  );
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
