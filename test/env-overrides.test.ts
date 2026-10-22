/**
 * env-overrides.test.ts — the rule an env entry passes, the table of entries
 * that did, and the one constructor that vouches for a table outright.
 *
 * The layers above word a refusal their own way, so what is asserted here is
 * which rule refused which entry and what survived; the wording belongs to the
 * config and template tests.
 */

import { describe, expect, it } from "vitest";
import {
  mergeEnv,
  sanitizeEnv,
  trustedEnv,
  type EnvProblem,
} from "../src/agents/harness/env-overrides.js";

interface Reported {
  readonly name: string;
  readonly problem: EnvProblem;
  readonly value: unknown;
}

/** Run one table through the sanitizer and collect what it reported. */
function sanitize(
  raw: Readonly<Record<string, unknown>>,
  reserved: readonly string[] = [],
): { kept: Record<string, string>; reports: Reported[] } {
  const reports: Reported[] = [];
  const kept = sanitizeEnv(raw, {
    reserved,
    report: (name, problem, value) => reports.push({ name, problem, value }),
  });
  return { kept, reports };
}

describe("sanitizeEnv", () => {
  it("keeps the entries that pass and reports each refusal by its rule", () => {
    const { kept, reports } = sanitize({
      MODE: "fast",
      COUNT: 2,
      "not-a-name": "v",
      PATH: "/evil",
      MESSAGE: "a\nb",
      TAB: "a\tb",
    });

    expect(kept).toEqual({ MODE: "fast" });
    expect(reports).toEqual([
      { name: "COUNT", problem: "not-string", value: 2 },
      { name: "not-a-name", problem: "name", value: "v" },
      { name: "PATH", problem: "reserved", value: "/evil" },
      { name: "MESSAGE", problem: "control", value: "a\nb" },
      { name: "TAB", problem: "control", value: "a\tb" },
    ]);
  });

  it("decides a name before the value it carries", () => {
    const { reports } = sanitize({ "not-a-name": 2, PATH: 2 });

    expect(reports.map(({ problem }) => problem)).toEqual(["name", "reserved"]);
  });

  it("refuses the caller's own reserved names on top of the universal ones", () => {
    const open = sanitize({ CODEX_HOME: "/tmp/x", PATH: "/evil" });
    expect(open.kept).toEqual({ CODEX_HOME: "/tmp/x" });
    expect(open.reports).toEqual([
      { name: "PATH", problem: "reserved", value: "/evil" },
    ]);

    const family = sanitize({ CODEX_HOME: "/tmp/x" }, ["CODEX_HOME"]);
    expect(family.kept).toEqual({});
    expect(family.reports).toEqual([
      { name: "CODEX_HOME", problem: "reserved", value: "/tmp/x" },
    ]);
  });

  it("refuses a reserved prefix without enumerating its members", () => {
    const { kept, reports } = sanitize({ HERDR_PANE_ID: "p1", KEPT: "yes" });

    expect(kept).toEqual({ KEPT: "yes" });
    expect(reports).toEqual([
      { name: "HERDR_PANE_ID", problem: "reserved", value: "p1" },
    ]);
  });

  it("drops an absent value without reporting it", () => {
    const { kept, reports } = sanitize({ PRESENT: "yes", ABSENT: undefined });

    expect(kept).toEqual({ PRESENT: "yes" });
    expect(reports).toEqual([]);
  });
});

describe("mergeEnv", () => {
  it("takes the only table it was given as it is", () => {
    const table = trustedEnv({ SHARED: "only" });

    expect(mergeEnv(table, undefined)).toBe(table);
    expect(mergeEnv(undefined, table)).toBe(table);
    expect(mergeEnv(undefined, undefined)).toBeUndefined();
  });

  it("lets the later table win per variable and keeps the rest", () => {
    const merged = mergeEnv(
      trustedEnv({ SHARED: "base", BASE_ONLY: "yes" }),
      trustedEnv({ SHARED: "over", OVER_ONLY: "yes" }),
    );

    expect(merged).toEqual({
      SHARED: "over",
      BASE_ONLY: "yes",
      OVER_ONLY: "yes",
    });
  });
});

describe("trustedEnv", () => {
  it("returns the table it was handed", () => {
    expect(trustedEnv({ MODE: "fast" })).toEqual({ MODE: "fast" });
  });

  it("fails loudly on a name no launch may carry", () => {
    expect(() => trustedEnv({ PATH: "/evil" })).toThrow(
      "Invalid environment variable PATH: reserved",
    );
    expect(() => trustedEnv({ "not-a-name": "v" })).toThrow(
      "Invalid environment variable not-a-name: name",
    );
  });

  it("accepts what the sanitizer kept, so a filtered table needs no second look", () => {
    const { kept } = sanitize({ GOOD: "yes", "not-a-name": "v", COUNT: 2 });

    expect(() => trustedEnv(kept)).not.toThrow();
    expect(trustedEnv(kept)).toEqual({ GOOD: "yes" });
  });
});
