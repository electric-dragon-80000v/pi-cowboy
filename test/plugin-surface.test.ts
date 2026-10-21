/**
 * plugin-surface.test.ts — the `pi-cowboy/plugin` subpath names everything a
 * plugin helper needs. `ModelList` is the return type of a callback a plugin
 * implements, so a helper that answers with one must be able to name it here
 * rather than reach for `ReturnType<…>`.
 */

import { describe, expect, it } from "vitest";
import { modelListEntries, modelListNotice } from "../src/plugin/index.js";
import type { ModelEntry, ModelList } from "../src/plugin/index.js";

/** Compiles only while the subpath exports `ModelList` as a type. */
const catalog: ModelList = {
  kind: "listed",
  entries: [
    { key: "openai/gpt", thinkingLevels: { kind: "closed", levels: [] } },
  ],
};

/** Compiles only while the subpath exports the reads over an answer. */
const reads: readonly [
  (list: ModelList) => readonly ModelEntry[],
  (list: ModelList) => string | undefined,
] = [modelListEntries, modelListNotice];

describe("the plugin subpath", () => {
  it("reads a listed answer through the helpers it exports", () => {
    const [entries, notice] = reads;
    expect(entries(catalog).map((entry) => entry.key)).toEqual(["openai/gpt"]);
    expect(notice(catalog)).toBeUndefined();
  });

  it("reads an unavailable answer as no models plus its reason", () => {
    const [entries, notice] = reads;
    const answer: ModelList = { kind: "unavailable", notice: "no catalog" };
    expect(entries(answer)).toEqual([]);
    expect(notice(answer)).toBe("no catalog");
  });
});
