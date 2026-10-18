/**
 * default-transport.test.ts — the production transport wiring. Its
 * `createDeliverable` is the only deliverable production ever builds, so it must be
 * the file-backed reader for the run's result file.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentManagerTransport } from "../src/agents/agent-manager.js";
import type { ExecutionRuntime } from "../src/agents/agent-host.js";
import { FileDeliverable } from "../src/subagent/deliverable.js";

let madeDir: string | undefined;

afterEach(() => {
  if (madeDir !== undefined) rmSync(madeDir, { recursive: true, force: true });
  madeDir = undefined;
});

describe("createAgentManagerTransport", () => {
  it("builds a FileDeliverable bound to the run's result file", async () => {
    madeDir = mkdtempSync(join(tmpdir(), "cowboy-default-transport-"));
    const resultFile = join(madeDir, "result.md");
    writeFileSync(resultFile, "the report\n");

    // The runtime is bound, not used: this asserts the deliverable half.
    const transport = createAgentManagerTransport({} as ExecutionRuntime);
    const deliverable = transport.createDeliverable(resultFile);

    // Production must read the report from disk; nothing else does.
    expect(deliverable).toBeInstanceOf(FileDeliverable);
    expect(await deliverable.readDeliverable()).toEqual({
      content: "the report",
      mtime: expect.any(Number),
    });
  });

  it("hands back the one runtime's host and pane, not a fresh one per call", () => {
    const host = { hostAt: async () => ({}) };
    const pane = {
      kind: "test",
      run: async () => {},
      waitForOutput: async () => {},
    };
    const runtime = {
      host,
      view: {},
      pane,
      multiplexer: "test",
    } as unknown as ExecutionRuntime;

    const transport = createAgentManagerTransport(runtime);

    // Same object each time: the contract `ExecutionRuntime` documents ("built
    // once per parent session") holds because the transport holds the runtime.
    expect(transport.createHost({} as never)).toBe(host);
    expect(transport.createHost({} as never)).toBe(host);
    expect(transport.createPane({} as never)).toBe(pane);
  });
});
