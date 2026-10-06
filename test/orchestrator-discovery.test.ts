/**
 * orchestrator-discovery.test.ts — File parsing, scanning, and per-cue
 * merging. Registry coverage lives in orchestrator-types.test.ts, schema
 * shape rejections in orchestrator-template.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeOrchestrators,
  parseOrchestratorFile,
  scanOrchestratorFilesInDir,
} from "../src/orchestrators/orchestrator-discovery.js";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import { describeParseError } from "../src/templates/template-files.js";
import type { OrchestratorConfig } from "../src/orchestrators/types.js";

const BASE = DEFAULT_ORCHESTRATORS.default;

/** Run a parse that must fail; return the one-line message the user sees. */
function parseError(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return describeParseError(err);
  }
  throw new Error("expected the template to be rejected");
}

describe("parseOrchestratorFile", () => {
  it("parses metadata and cue templates, carrying the guidance verbatim", () => {
    const parsed = parseOrchestratorFile(
      [
        'name = "two-phase"',
        'display_name = "Two Phase"',
        'guidance = "Guidance mentions {{agent_id}} and even {{nope}} — it is not a template."',
        "",
        "[cues]",
        'spawned = "phase one {{agent_id}}"',
        'settled = "{{result}}"',
      ].join("\n"),
    );

    expect(parsed.name).toBe("two-phase");
    expect(parsed.display_name).toBe("Two Phase");
    expect(parsed.cues).toEqual({
      spawned: "phase one {{agent_id}}",
      settled: "{{result}}",
    });
    // Authored guidance is prose, not a cue template: its braces stay literal.
    expect(parsed.guidance).toContain("Guidance mentions {{agent_id}}");
  });

  it("leaves cues undefined when the file defines no cues table", () => {
    const parsed = parseOrchestratorFile('name = "minimal"\nguidance = "d"');

    expect(parsed.cues).toBeUndefined();
  });

  it("keeps an empty cues table as an empty override", () => {
    const parsed = parseOrchestratorFile('name = "minimal"\n\n[cues]\n');

    expect(parsed.cues).toEqual({});
  });

  it("throws on an unknown cue variable (skipping is the scanner's job)", () => {
    expect(
      parseError(() =>
        parseOrchestratorFile(
          'name = "bad"\n\n[cues]\nspawned = "{{worktre_path}}"\n',
        ),
      ),
    ).toMatch(/cues\.spawned: unknown variable/);
  });

  it("throws on an unknown cue event (a typo fails loud)", () => {
    expect(
      parseError(() =>
        parseOrchestratorFile(
          'name = "typos"\n\n[cues]\nspwned = "{{agent_id}}"\n',
        ),
      ),
    ).toMatch(/Unrecognized key: "spwned"/);
  });
});

describe("scanOrchestratorFilesInDir", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function scanDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-orch-"));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  it("returns [] for a missing directory", async () => {
    await expect(
      scanOrchestratorFilesInDir(
        path.join(os.tmpdir(), "pi-cowboy-no-such-orch-dir"),
      ),
    ).resolves.toEqual([]);
  });

  it("skips a file with no name, silently", async () => {
    const dir = scanDir({
      "nameless.toml": 'guidance = "no name here"',
      "named.toml": 'name = "named"',
    });
    const notify = vi.fn();

    const found = await scanOrchestratorFilesInDir(dir, notify);

    expect(found.map((o) => o.name)).toEqual(["named"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns once, naming the file, when the TOML is malformed", async () => {
    const dir = scanDir({
      "broken.toml": 'name = "broken"\nnope = ',
      "fine.toml": 'name = "fine"',
    });
    const notify = vi.fn();

    const found = await scanOrchestratorFilesInDir(dir, notify);

    expect(found.map((o) => o.name)).toEqual(["fine"]);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0];
    expect(kind).toBe("warning");
    expect(message).toContain(
      `[cowboy] Orchestrator file ${path.join(dir, "broken.toml")}`,
    );
    expect(message).toContain(
      "is not a valid orchestrator template and was skipped",
    );
    expect(message).toContain("Invalid TOML document");
    expect(message).not.toContain("\n");
  });

  it("warns once and skips a file with an invalid cue template", async () => {
    const dir = scanDir({
      "bad-cue.toml":
        'name = "bad-cue"\n\n[cues]\nspawned = "{{worktre_path}}"\n',
    });
    const notify = vi.fn();

    const found = await scanOrchestratorFilesInDir(dir, notify);

    expect(found).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message] = notify.mock.calls[0];
    expect(message).toContain("cues.spawned: unknown variable");
    // A cue failure is not a TOML failure, and the warning must not claim one.
    expect(message).not.toContain("Invalid TOML");
    expect(message).not.toContain("\n");
  });

  it("warns and skips a cues table of the wrong shape", async () => {
    const dir = scanDir({
      "bad-block.toml": 'name = "bad-block"\ncues = "nope"',
      "bad-value.toml": 'name = "bad-value"\n\n[cues]\nspawned = 5\n',
    });
    const notify = vi.fn();

    await expect(scanOrchestratorFilesInDir(dir, notify)).resolves.toEqual([]);
    // readdir order is not contractual — match on content, not order.
    const messages = notify.mock.calls.map(([m]) => m as string);
    expect(messages).toHaveLength(2);
    expect(
      messages.some((m) =>
        m.includes("cues: Invalid input: expected object, received string"),
      ),
    ).toBe(true);
    // A shape failure is not a TOML failure, and the warning must not claim one.
    expect(messages.every((m) => m.includes("Invalid TOML") === false)).toBe(
      true,
    );
    expect(
      messages.some((m) =>
        m.includes(
          "cues.spawned: Invalid input: expected string, received number",
        ),
      ),
    ).toBe(true);
  });
});

describe("mergeOrchestrators", () => {
  const defaults = new Map<string, OrchestratorConfig>(
    Object.entries(DEFAULT_ORCHESTRATORS),
  );

  it("merges cues per event over the code default", () => {
    const merged = mergeOrchestrators(
      defaults,
      [
        {
          name: "default",
          display_name: "Base",
          cues: { settled: "settled: {{result}}" },
        },
      ],
      [],
      [],
    );

    const config = merged.get("default")!;
    expect(config.cues).toEqual({
      spawned: BASE.cues.spawned,
      queued: BASE.cues.queued,
      settled: "settled: {{result}}",
    });
    expect(config.displayName).toBe("Base");
  });

  it("seeds a new name from the code default template", () => {
    const merged = mergeOrchestrators(
      defaults,
      [
        {
          name: "two-phase",
          cues: { spawned: "one {{agent_id}}" },
          guidance: "",
        },
      ],
      [],
      [],
    );

    const config = merged.get("two-phase")!;
    expect(config.name).toBe("two-phase");
    expect(config.cues.spawned).toBe("one {{agent_id}}");
    expect(config.cues.queued).toBe(BASE.cues.queued);
    expect(config.cues.settled).toBe(BASE.cues.settled);
  });

  it("inherits the base guidance when a file omits it, and replaces it when set", () => {
    const merged = mergeOrchestrators(
      defaults,
      [
        {
          name: "quiet",
          cues: { spawned: "one {{agent_id}}" },
        },
        {
          name: "loud",
          guidance: "Review the diff before committing.",
        },
      ],
      [],
      [],
    );

    expect(merged.get("quiet")!.guidance).toBe(BASE.guidance);
    expect(merged.get("loud")!.guidance).toBe(
      "Review the diff before committing.",
    );
  });

  it("applies precedence user < shared < project, field by field", () => {
    const merged = mergeOrchestrators(
      defaults,
      [
        {
          name: "default",
          guidance: "user guidance",
          cues: { spawned: "user spawned" },
        },
      ],
      [
        {
          name: "default",
          display_name: "shared",
          cues: { queued: "shared queued" },
        },
      ],
      [
        {
          name: "default",
          guidance: "project guidance",
          cues: { spawned: "project spawned" },
        },
      ],
    );

    const config = merged.get("default")!;
    expect(config.guidance).toBe("project guidance");
    expect(config.displayName).toBe("shared");
    expect(config.cues).toEqual({
      spawned: "project spawned",
      queued: "shared queued",
      settled: BASE.cues.settled,
    });
  });

  it("ignores entries without a name", () => {
    const merged = mergeOrchestrators(
      defaults,
      [{ cues: { spawned: "x" } }],
      [],
      [],
    );

    expect([...merged.keys()]).toEqual(["default"]);
  });

  it("gives a new name its own name as the display name when display_name is omitted", () => {
    const merged = mergeOrchestrators(
      defaults,
      [{ name: "two-phase", cues: { spawned: "one {{agent_id}}" } }],
      [],
      [],
    );

    expect(merged.get("two-phase")!.displayName).toBe("two-phase");
  });

  it("keeps a registered name's display name when a higher layer omits display_name", () => {
    const merged = mergeOrchestrators(
      defaults,
      [],
      [{ name: "review", display_name: "Code review" }],
      [{ name: "review", guidance: "project guidance" }],
    );

    expect(merged.get("review")!.displayName).toBe("Code review");
    expect(merged.get("review")!.guidance).toBe("project guidance");
  });
});
