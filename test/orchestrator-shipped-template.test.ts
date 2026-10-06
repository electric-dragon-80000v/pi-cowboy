/**
 * orchestrator-shipped-template.test.ts — The extension-shipped
 * `with code review` template (orchestrators/with-code-review.toml).
 *
 * The file keeps its OWN name/display_name while its parsed cues
 * must deep-equal the code `default` cues (trailing newlines included).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORCHESTRATORS } from "../src/orchestrators/default-orchestrators.js";
import {
  mergeOrchestrators,
  parseOrchestratorFile,
  scanOrchestratorFilesInDir,
} from "../src/orchestrators/orchestrator-discovery.js";
import { EXTENSION_ORCHESTRATORS_DIR } from "../src/paths.js";

const BASE = DEFAULT_ORCHESTRATORS.default;

/** The file's own metadata — deliberately NOT the default's. */
const SHIPPED_NAME = "with code review";

/** Conditional on there being changes at all: a read-only task skips both the review and the commit. */
const SHIPPED_GUIDANCE =
  "If you make changes to the code: before committing them, launch the code review tool. Once the code is approved by the user, commit the changes to your branch. (This applies even if the task prompt says not to commit — commits stay on that branch and are needed for merging.)";

function readShipped(): string {
  return fs.readFileSync(
    path.join(EXTENSION_ORCHESTRATORS_DIR, "with-code-review.toml"),
    "utf-8",
  );
}

describe("shipped with-code-review orchestrator template", () => {
  it("is discovered in the extension directory without warnings", async () => {
    const notify = vi.fn();

    const found = await scanOrchestratorFilesInDir(
      EXTENSION_ORCHESTRATORS_DIR,
      notify,
    );

    expect(found.map((o) => o.name)).toContain(SHIPPED_NAME);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps its own metadata with cues byte-identical to the code default", () => {
    const parsed = parseOrchestratorFile(readShipped());

    expect(parsed.name).toBe(SHIPPED_NAME);
    expect(parsed.display_name).toBe(SHIPPED_NAME);
    // toStrictEqual is exact: a trailing-newline chomping difference fails here.
    expect(parsed.cues).toStrictEqual(BASE.cues);
  });

  it("parses into the fields its file declares", () => {
    const parsed = parseOrchestratorFile(readShipped());

    expect(parsed.display_name).toBe(SHIPPED_NAME);
    expect(parsed.guidance).toBe(SHIPPED_GUIDANCE);
    expect(parsed.cues?.spawned).toBeDefined();
    expect(parsed.cues?.queued).toBeDefined();
    expect(parsed.cues?.settled).toBeDefined();
  });

  it("keeps its guidance free of template sequences", () => {
    const parsed = parseOrchestratorFile(readShipped());

    expect(parsed.guidance).not.toContain("{{");
    expect(parsed.guidance?.trim()).not.toBe("");
  });

  it("merges the default cues under the file's own name", async () => {
    const notify = vi.fn();
    const found = await scanOrchestratorFilesInDir(
      EXTENSION_ORCHESTRATORS_DIR,
      notify,
    );

    const merged = mergeOrchestrators(DEFAULT_ORCHESTRATORS, found, [], []);
    const config = merged.get(SHIPPED_NAME);

    expect(config).toBeDefined();
    expect(config!.cues).toEqual(BASE.cues);
    expect(config!.name).toBe(SHIPPED_NAME);
    expect(config!.displayName).toBe(SHIPPED_NAME);
    expect(config!.guidance).toBe(SHIPPED_GUIDANCE);
    expect(notify).not.toHaveBeenCalled();
  });
});
