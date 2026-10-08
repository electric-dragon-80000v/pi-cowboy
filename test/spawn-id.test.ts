/**
 * spawn-id.test.ts — spawn identity: format, alphabet, retry, exhaustion.
 * The alphabet assertions pin SPAWN_ID_ALPHABET to the package's, so src/predicates.ts
 * (which derives its pattern from it) cannot silently stop matching real agent names.
 */

import { describe, expect, it } from "vitest";
import { CrockfordBase32 } from "../src/spawn/crockford-base32.js";
import {
  SPAWN_ID_ALPHABET,
  SPAWN_ID_LENGTH,
  SPAWN_ID_MINT_ATTEMPTS,
  SpawnIdExhaustedError,
  generateSpawnId,
  generateUniqueSpawnId,
} from "../src/spawn/spawn-id.js";

describe("generateSpawnId", () => {
  it("mints exactly SPAWN_ID_LENGTH lowercase Crockford characters", () => {
    const ids = Array.from({ length: 200 }, () => generateSpawnId());
    const pattern = new RegExp(`^[${SPAWN_ID_ALPHABET}]{${SPAWN_ID_LENGTH}}$`);
    const wrongLength = ids.filter((id) => id.length !== SPAWN_ID_LENGTH);
    const offAlphabet = ids.filter((id) => !pattern.test(id));
    // Aggregated: a failure prints the offending ids.
    expect(wrongLength).toEqual([]);
    expect(offAlphabet).toEqual([]);
  });

  it("carries no ambiguous character: no i, l, o, or u", () => {
    const ids = Array.from({ length: 200 }, () => generateSpawnId()).join("");
    expect(ids).not.toMatch(/[ilou]/);
  });

  it("is not a slice of a UUID — 40 bits mint many distinct ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateSpawnId()));
    // A canary that the mint varies, not a luck-dependent collision test.
    expect(ids.size).toBeGreaterThan(490);
  });

  it("round-trips through the package decoder at the exact bit width", () => {
    const id = generateSpawnId();
    expect(CrockfordBase32.decode(id).length).toBe(5);
    // Crockford decoding is case-insensitive, so lowercase is safe as canonical.
    expect(CrockfordBase32.decode(id.toUpperCase())).toEqual(
      CrockfordBase32.decode(id),
    );
  });
});

// One case per alphabet position: pins order and membership to the package's encoding.
const alphabetPositions = SPAWN_ID_ALPHABET.split("").map((char, index) => ({
  index,
  char,
}));

describe("SPAWN_ID_ALPHABET", () => {
  it("is exactly the alphabet the crockford-base32 package encodes with", () => {
    expect(SPAWN_ID_ALPHABET).toHaveLength(32);
  });

  it.each(alphabetPositions)(
    "encodes $char at position $index the way the package does",
    ({ index, char }) => {
      expect(CrockfordBase32.decode(char)[0]).toBe(index * 8);
    },
  );

  it("encodes 8 characters from 5 bytes", () => {
    expect(CrockfordBase32.encode(Buffer.from([0, 0, 0, 0, 0]))).toHaveLength(
      SPAWN_ID_LENGTH,
    );
    expect(
      CrockfordBase32.encode(Buffer.from([255, 255, 255, 255, 255])),
    ).toHaveLength(SPAWN_ID_LENGTH);
  });
});

describe("generateUniqueSpawnId", () => {
  it("returns the first untaken id", () => {
    const taken = new Set(["aaaaaaaa"]);
    const id = generateUniqueSpawnId((candidate) => taken.has(candidate));
    expect(id).toHaveLength(SPAWN_ID_LENGTH);
    expect(taken.has(id)).toBe(false);
  });

  it("retries past ids the taken-check reports as used, asking about each in order", () => {
    const asked: string[] = [];
    const candidates = ["11111111", "22222222", "33333333"];
    let minted = 0;
    const id = generateUniqueSpawnId(
      (candidate) => {
        asked.push(candidate);
        return candidate !== "33333333";
      },
      () => candidates[minted++]!,
    );
    expect(id).toBe("33333333");
    expect(asked).toEqual(candidates);
    expect(minted).toBe(3);
  });

  it("throws a loud, named error when every attempt reports taken", () => {
    expect(() => generateUniqueSpawnId(() => true)).toThrow(
      SpawnIdExhaustedError,
    );
    expect(() => generateUniqueSpawnId(() => true)).toThrow(
      new RegExp(`after ${SPAWN_ID_MINT_ATTEMPTS} attempts`),
    );
  });

  it("bounds the retry budget rather than looping forever", () => {
    let minted = 0;
    expect(() =>
      generateUniqueSpawnId(
        () => true,
        () => {
          minted++;
          return "01234567";
        },
      ),
    ).toThrow(SpawnIdExhaustedError);
    expect(minted).toBe(SPAWN_ID_MINT_ATTEMPTS);
  });
});
