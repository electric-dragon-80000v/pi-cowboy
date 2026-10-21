/**
 * thinking-offering.test.ts — the thinking control one model offers, as the
 * harness that will run it describes it: a closed list, an advisory list a
 * token may fall outside of, or no control at all.
 */

import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelEntry } from "../src/agents/harness.js";
import { thinkingOfferingFor } from "../src/models/thinking-offering.js";

function reasoningModel(): Model<Api> {
  return {
    provider: "anthropic",
    id: "claude-3",
    reasoning: true,
  } as unknown as Model<Api>;
}

function plainModel(): Model<Api> {
  return {
    provider: "anthropic",
    id: "claude-3",
    reasoning: false,
  } as unknown as Model<Api>;
}

function entry(
  key: string,
  thinkingLevels: ModelEntry["thinkingLevels"],
): ModelEntry {
  return { key, thinkingLevels };
}

describe("thinkingOfferingFor — the pi family", () => {
  it("reads a reasoning model's own closed list", () => {
    const offering = thinkingOfferingFor({
      harnessId: "pi",
      modelKey: "anthropic/claude-3",
      entries: [],
      piModel: reasoningModel(),
    });

    expect(offering.kind).toBe("closed");
    if (offering.kind !== "closed") return;
    expect(offering.levels).toContain("off");
    expect(offering.levels).toContain("high");
  });

  it("has no control for a model pi does not run at a reasoning level", () => {
    expect(
      thinkingOfferingFor({
        harnessId: "pi",
        modelKey: "anthropic/claude-3",
        entries: [],
        piModel: plainModel(),
      }).kind,
    ).toBe("none");
  });

  it("leaves the list open for a key the registry no longer lists", () => {
    // Nothing here can enumerate that model's levels, and pi may still take
    // the key, so no consumer may drop a token for it.
    expect(
      thinkingOfferingFor({
        harnessId: "pig",
        modelKey: "anthropic/gone",
        entries: [],
        piModel: undefined,
      }),
    ).toEqual({ kind: "advisory", levels: [] });
  });
});

describe("thinkingOfferingFor — a foreign harness", () => {
  it("keeps a list the harness only advertises", () => {
    expect(
      thinkingOfferingFor({
        harnessId: "opencode",
        modelKey: "openai/gpt-4o",
        entries: [
          entry("openai/gpt-4o", {
            kind: "advisory",
            levels: ["low", "high"],
          }),
        ],
        piModel: undefined,
      }),
    ).toEqual({ kind: "advisory", levels: ["low", "high"] });
  });

  it("treats a non-empty closed list as the whole vocabulary", () => {
    expect(
      thinkingOfferingFor({
        harnessId: "codex",
        modelKey: "openai/gpt-5",
        entries: [
          entry("openai/gpt-5", { kind: "closed", levels: ["low", "medium"] }),
        ],
        piModel: undefined,
      }),
    ).toEqual({ kind: "closed", levels: ["low", "medium"] });
  });

  it("reads an empty closed list as no control at all", () => {
    expect(
      thinkingOfferingFor({
        harnessId: "codex",
        modelKey: "openai/gpt-5",
        entries: [entry("openai/gpt-5", { kind: "closed", levels: [] })],
        piModel: undefined,
      }).kind,
    ).toBe("none");
  });

  it("leaves the list open for a key its own list no longer names", () => {
    // The harness, not this session, is the authority on what it accepts.
    expect(
      thinkingOfferingFor({
        harnessId: "opencode",
        modelKey: "openai/gone",
        entries: [entry("openai/gpt-4o", { kind: "closed", levels: ["low"] })],
        piModel: undefined,
      }),
    ).toEqual({ kind: "advisory", levels: [] });
  });
});
