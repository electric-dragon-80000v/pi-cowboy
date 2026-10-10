/**
 * default-transport.test.ts — the production transport wiring. The manager's
 * default `createDeliverable` is the only deliverable production ever builds, so
 * it must be the file-backed reader for the run's result file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentManagerTransport } from "../src/agents/agent-manager.js";
import { FileDeliverable } from "../src/subagent/deliverable.js";

let madeDir: string | undefined;

afterEach(() => {
  if (madeDir !== undefined) rmSync(madeDir, { recursive: true, force: true });
  madeDir = undefined;
});

describe("defaultAgentManagerTransport.createDeliverable", () => {
  it("builds a FileDeliverable bound to the run's result file", async () => {
    madeDir = mkdtempSync(join(tmpdir(), "cowboy-default-transport-"));
    const resultFile = join(madeDir, "result.md");
    writeFileSync(resultFile, "the report\n");

    const deliverable =
      defaultAgentManagerTransport.createDeliverable(resultFile);

    // Production must read the report from disk; nothing else does.
    expect(deliverable).toBeInstanceOf(FileDeliverable);
    expect(await deliverable.readDeliverable()).toEqual({
      content: "the report",
      mtime: expect.any(Number),
    });
  });
});
