/**
 * model-list-cache.test.ts — the last successful list of a harness standing in
 * for a read that carried no entries.
 *
 * The policy is tested directly, so each row of the matrix is one call, and the
 * file is tested through the catalog a picker actually reads.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelEntry, ModelList } from "../src/agents/harness.js";
import { createHarnessRegistry } from "../src/agents/harness/harness-registry.js";
import { createHarnessModelCatalog } from "../src/agents/harness/model-list-catalog.js";
import {
  answerWithModelListFallback,
  fileModelListCache,
  type ModelListCache,
} from "../src/agents/harness/model-list-cache.js";
import { probed } from "../src/availability.js";

const tmpDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-list-cache-"));
  tmpDirs.push(dir);
  return dir;
}

/** The file name the spec fixes for one harness. */
function cacheFile(dir: string, harness: string): string {
  return join(dir, `pi-cowboy-${encodeURIComponent(harness)}-models.json`);
}

function model(key: string): ModelEntry {
  return { key, thinkingLevels: { kind: "closed", levels: [] } };
}

function unavailable(notice: string): ModelList {
  return { kind: "unavailable", notice };
}

const ENTRIES: readonly ModelEntry[] = [
  model("anthropic/claude-opus-4"),
  model("openai/gpt-4o"),
];

const LISTED: ModelList = { kind: "listed", entries: ENTRIES };

/** An answer of the opencode-bug shape: exit 0, parseable, no entries. */
const EMPTY_LISTED: ModelList = { kind: "listed", entries: [] };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("answerWithModelListFallback", () => {
  it("stores a successful list and serves it when the next read carries none", async () => {
    const dir = freshDir();
    const cache = fileModelListCache(dir);

    await expect(
      answerWithModelListFallback(
        "opencode",
        "OpenCode",
        cache,
        async () => LISTED,
      ),
    ).resolves.toBe(LISTED);
    expect(existsSync(cacheFile(dir, "opencode"))).toBe(true);

    const failed = unavailable("Could not list the opencode models (boom).");
    await expect(
      answerWithModelListFallback(
        "opencode",
        "OpenCode",
        cache,
        async () => failed,
      ),
    ).resolves.toEqual({
      kind: "fallback",
      entries: ENTRIES,
      notice:
        "Could not list the opencode models (boom). Using the 2 models last " +
        `listed for this harness (${cacheFile(dir, "opencode")}).`,
    });
  });

  it("falls back for an empty enumeration, which is a list that did not answer", async () => {
    const dir = freshDir();
    const cache = fileModelListCache(dir);
    cache.write("opencode", ENTRIES);

    const answer = await answerWithModelListFallback(
      "opencode",
      "OpenCode",
      cache,
      async () => EMPTY_LISTED,
    );

    expect(answer).toMatchObject({ kind: "fallback", entries: ENTRIES });
  });

  it("leaves an empty answer exactly as it came when nothing is stored", async () => {
    const cache = fileModelListCache(freshDir());

    await expect(
      answerWithModelListFallback(
        "opencode",
        "OpenCode",
        cache,
        async () => EMPTY_LISTED,
      ),
    ).resolves.toBe(EMPTY_LISTED);
  });

  it("never stores a harness's own stand-in catalog", async () => {
    const dir = freshDir();
    const cache = fileModelListCache(dir);
    const standIn: ModelList = {
      kind: "fallback",
      entries: ENTRIES,
      notice: "Codex lists its built-in models.",
    };

    await expect(
      answerWithModelListFallback("codex", "Codex", cache, async () => standIn),
    ).resolves.toBe(standIn);
    expect(existsSync(cacheFile(dir, "codex"))).toBe(false);
  });

  it("keeps the harness's own notice and appends the cache's", async () => {
    const dir = freshDir();
    const cache = fileModelListCache(dir);
    cache.write("codex", ENTRIES);

    const answer = await answerWithModelListFallback(
      "codex",
      "Codex",
      cache,
      async () => ({
        kind: "fallback",
        entries: [],
        notice: "Codex lists its built-in models.",
      }),
    );

    expect(answer).toMatchObject({
      kind: "fallback",
      notice: expect.stringContaining("Codex lists its built-in models."),
    });
    expect(answer.kind === "fallback" ? answer.notice : "").toContain(
      "last listed for this harness",
    );
  });

  it("answers a read that throws as the harness's unavailable list", async () => {
    const cache = fileModelListCache(freshDir());

    await expect(
      answerWithModelListFallback("opencode", "OpenCode", cache, async () => {
        throw new Error("boom");
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      notice: "Could not list the OpenCode models (boom).",
    });
  });
});

describe("fileModelListCache", () => {
  it("refuses a file a harness's own name did not produce", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      cacheFile(dir, "codex"),
      JSON.stringify({
        version: 1,
        harness: "opencode",
        savedAt: "2026-01-01T00:00:00.000Z",
        entries: ENTRIES,
      }),
    );

    expect(fileModelListCache(dir).read("codex")).toBeUndefined();
  });

  it("ignores a malformed file", () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(cacheFile(dir, "opencode"), "{not json");

    expect(fileModelListCache(dir).read("opencode")).toBeUndefined();
  });

  it("stores beside config.json when no directory is given", () => {
    const root = freshDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      fileModelListCache().write("opencode", ENTRIES);
      expect(
        existsSync(join(root, "pi-cowboy", "pi-cowboy-opencode-models.json")),
      ).toBe(true);
      expect(fileModelListCache().read("opencode")?.entries).toEqual(ENTRIES);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("createHarnessModelCatalog with a cache", () => {
  /** A harness whose CLI cannot answer: the state the cache exists for. */
  function failingCatalog(cache: ModelListCache) {
    const registry = createHarnessRegistry();
    registry.register({
      id: "cached-harness",
      displayName: "Cached",
      agentMultiplexerKind: "cached",
      availability: () => ({ status: "available" }),
      prepare: async () => {},
      buildArgs: () => [],
      teardown: async () => {},
      stop: async () => {},
      steer: async () => ({ kind: "submitted" }),
      listModels: async () => ({ kind: "listed", entries: [] }),
    });
    const availability = probed(["cached-harness"]);
    return createHarnessModelCatalog({
      registry,
      availability,
      cache,
      request: {
        pi: { exec: vi.fn() } as unknown as ExtensionAPI,
        modelCatalog: { getAvailable: () => [] },
      },
    });
  }

  it("offers the stored list and its notice to the menu", async () => {
    const dir = freshDir();
    const cache = fileModelListCache(dir);
    cache.write("cached-harness", ENTRIES);
    const catalog = failingCatalog(cache);

    await catalog.loadOptions("cached-harness");

    expect(catalog.options.get("cached-harness")).toEqual(ENTRIES);
    expect(catalog.notices()).toEqual([
      expect.stringContaining(`${cacheFile(dir, "cached-harness")}`),
    ]);
  });

  it("stores nothing and reports nothing for an empty enumeration", async () => {
    const dir = freshDir();
    const cache = fileModelListCache(dir);
    const catalog = failingCatalog(cache);

    await expect(catalog.list("cached-harness")).resolves.toEqual({
      kind: "listed",
      entries: [],
    });

    expect(catalog.notices()).toEqual([]);
    // An enumeration with nothing to enumerate is not an observation.
    expect(existsSync(cacheFile(dir, "cached-harness"))).toBe(false);
  });
});
