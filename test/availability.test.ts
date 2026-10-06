/**
 * availability.test.ts — the narrowing every availability-gated setting list is
 * built through: what a verdict does to the offered values, and what "no verdict
 * yet" deliberately does not do.
 */

import { describe, expect, it } from "vitest";
import {
  isAvailable,
  probed,
  selectable,
  unprobed,
  type Availability,
} from "../src/availability.js";

type Fruit = "apple" | "pear";

const ALL = ["apple", "pear"] as const satisfies readonly Fruit[];

describe("selectable", () => {
  it("keeps every value until a probe answers", () => {
    expect([...selectable(ALL, unprobed())]).toEqual(["apple", "pear"]);
  });

  it("keeps only the values the probe found", () => {
    expect([...selectable(ALL, probed<Fruit>(["pear"]))]).toEqual(["pear"]);
  });

  it("keeps the vocabulary's own order, never the probe's", () => {
    expect([...selectable(ALL, probed<Fruit>(["pear", "apple"]))]).toEqual([
      "apple",
      "pear",
    ]);
  });

  it("offers nothing when a probe found nothing", () => {
    expect([...selectable(ALL, probed<Fruit>([]))]).toEqual([]);
  });

  it("ignores ids outside the vocabulary it is given", () => {
    const wider: Availability<Fruit | "plum"> = probed(["plum"]);

    expect([...selectable(ALL, wider)]).toEqual([]);
  });
});

describe("isAvailable", () => {
  it("treats an unanswered probe as no reason to rule a value out", () => {
    expect(isAvailable("apple", unprobed<Fruit>())).toBe(true);
  });

  it("follows the verdict once there is one", () => {
    const availability = probed<Fruit>(["apple"]);

    expect(isAvailable("apple", availability)).toBe(true);
    expect(isAvailable("pear", availability)).toBe(false);
  });
});
