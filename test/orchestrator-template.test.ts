/**
 * orchestrator-template.test.ts — OrchestratorTemplateSchema shape rules.
 * Strict at the root AND inside `[cues]`; per-cue variable validation fails
 * on the failing cue's own path. Rejections are read through
 * describeParseError, pinning the one-line message a user actually sees.
 */

import { describe, expect, it } from "vitest";
import { parseOrchestratorFile } from "../src/orchestrators/orchestrator-discovery.js";
import { OrchestratorTemplateSchema } from "../src/orchestrators/orchestrator-template.js";
import { describeParseError } from "../src/templates/template-files.js";

/** Run a parse that must fail; return its collapsed one-line message. */
function parseError(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return describeParseError(err);
  }
  throw new Error("expected the template to be rejected");
}

describe("OrchestratorTemplateSchema", () => {
  it("accepts the typed fields and the cues table", () => {
    const parsed = OrchestratorTemplateSchema.parse({
      name: "two-phase",
      display_name: "Two Phase",
      guidance: "inert prose",
      cues: { spawned: "one {{agent_id}}" },
    });

    expect(parsed).toEqual({
      name: "two-phase",
      display_name: "Two Phase",
      guidance: "inert prose",
      cues: { spawned: "one {{agent_id}}" },
    });
  });

  it("rejects the removed description key", () => {
    expect(
      parseError(() =>
        OrchestratorTemplateSchema.parse({
          name: "x",
          description: "Delegate twice.",
        }),
      ),
    ).toBe('Unrecognized key: "description"');
  });

  it("rejects an unknown root key", () => {
    expect(
      parseError(() =>
        OrchestratorTemplateSchema.parse({ name: "x", descripton: "typo" }),
      ),
    ).toBe('Unrecognized key: "descripton"');
  });

  it("rejects an unknown cue event", () => {
    expect(
      parseError(() =>
        OrchestratorTemplateSchema.parse({ cues: { spwned: "{{agent_id}}" } }),
      ),
    ).toBe('cues: Unrecognized key: "spwned"');
  });

  it("rejects a cue that is not a string, naming the cue", () => {
    expect(
      parseError(() =>
        OrchestratorTemplateSchema.parse({ cues: { spawned: 5 } }),
      ),
    ).toBe("cues.spawned: Invalid input: expected string, received number");
  });

  it("rejects a cues value that is not a table", () => {
    expect(
      parseError(() => OrchestratorTemplateSchema.parse({ cues: "nope" })),
    ).toBe("cues: Invalid input: expected object, received string");
  });

  it("rejects an unknown cue variable, naming the cue", () => {
    expect(
      parseError(() =>
        OrchestratorTemplateSchema.parse({
          cues: { spawned: "hi {{worktre_path}}" },
        }),
      ),
    ).toMatch(/^cues\.spawned: unknown variable "\{\{worktre_path\}\}"/);
  });

  it("rejects a partial or delimiter change in a cue", () => {
    expect(
      parseError(() =>
        OrchestratorTemplateSchema.parse({ cues: { settled: "{{>shared}}" } }),
      ),
    ).toBe('cues.settled: partials are not supported: "{{>shared}}"');
  });

  it("rejects a wrongly-typed metadata field", () => {
    expect(
      parseError(() => OrchestratorTemplateSchema.parse({ name: true })),
    ).toBe("name: Invalid input: expected string, received boolean");
  });

  it("surfaces the same rejection through the file parser", () => {
    expect(
      parseError(() =>
        parseOrchestratorFile(
          'name = "x"\n\n[cues]\nspwned = "{{agent_id}}"\n',
        ),
      ),
    ).toBe('cues: Unrecognized key: "spwned"');
  });
});
