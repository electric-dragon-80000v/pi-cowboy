/**
 * extension-loadout.integration.test.ts — what a real `pi` OFFERS the model.
 *
 * The subject is the extension's own on/off switch: a plain `--print` run with
 * the switch off must send a request whose `tools` no longer carry a single
 * cowboy tool name, while the same run with no config file does. Nothing shells
 * out at boot, so this path needs no herdr world: `installLocalExtension` marks
 * the run herdr-shaped and the extension loads, registers its tools, and reads
 * its config from the isolated agent dir.
 *
 * The stub stands in for the MODEL; what it records is the run's first request.
 * The stub server starts once per file (beforeAll/afterAll); each path owns an
 * isolated route under its own path prefix, and the world, the installed
 * extension and the scripted reply are the block's setup. Script and
 * verification stay inline; only application steps are factored
 * (scenario-steps.ts). See WRITING-TESTS.md.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COWBOY_TOOL_NAMES } from "../../src/registration.js";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai-server.js";
import {
  PI_RUN_TIMEOUT_MS,
  piIsolatedEnv,
  piModelArgs,
  runPiHeadless,
  STUB_API_KEY,
} from "./pi-headless.js";
import {
  initialize,
  installLocalExtension,
  type ScenarioContext,
} from "./scenario-steps.js";

/** One turn, one request: the reply the run's single inference consumes. */
const REPLY_TEXT = "pong";

const PROMPT = "Reply with the single word: pong";

/** The running test's fully qualified name, read at call time for the stub route prefix. */
function currentTestId(): string {
  const name = expect.getState().currentTestName;
  if (name === undefined) {
    throw new Error("currentTestId: no running test to take a prefix from");
  }
  return name;
}

/**
 * Tool names a request carried, in wire order. A decoder (not an expectation):
 * the tools array sits outside the stub's typed subset, so it is narrowed here.
 */
function toolNames(rawBody: unknown): string[] {
  if (typeof rawBody !== "object" || rawBody === null) return [];
  const tools = (rawBody as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const name = (tool as { function?: { name?: unknown } }).function?.name;
    return typeof name === "string" ? [name] : [];
  });
}

describe("step integration: a real pi process against the fake-openai stub", () => {
  let stub: FakeOpenAI;

  beforeAll(async () => {
    stub = await startFakeOpenAI({ expectedApiKey: STUB_API_KEY });
  });

  afterAll(async () => {
    await stub.close();
  });

  describe("the tool loadout a boot loads", () => {
    let ctx: ScenarioContext;

    // The config file is read while the run boots, so the flag each path scripts
    // must be written before that path starts pi: world, installed extension and
    // scripted reply are shared, the boot is the fork.
    beforeEach(() => {
      ctx = initialize(stub, currentTestId());
      installLocalExtension(ctx);
      stub.enqueue({
        method: "POST",
        path: ctx.chatPath,
        reply: { kind: "text", text: REPLY_TEXT },
      });
    });

    it("offers the Cowboy tools to the model", async () => {
      const result = await runPiHeadless(
        [...piModelArgs(), "--no-session", "--print", PROMPT],
        {
          cwd: ctx.workDir,
          timeoutMs: PI_RUN_TIMEOUT_MS,
          env: {
            ...piIsolatedEnv(ctx.agentDir, join(ctx.workDir, "sessions")),
            ...ctx.runEnv,
          },
        },
      );

      expect(result.code).toBe(0);
      const requests = stub.requests({ method: "POST", path: ctx.chatPath });
      expect(requests).toHaveLength(1);
      const names = toolNames(requests[0]!.rawBody);
      expect(names).toContain("cowboy_agent");
      expect(names).toContain("read");
    });

    it("unloads every Cowboy tool when the config disables the extension", async () => {
      mkdirSync(join(ctx.agentDir, "pi-cowboy"), { recursive: true });
      writeFileSync(
        join(ctx.agentDir, "pi-cowboy", "config.json"),
        JSON.stringify({ agent: { extensionEnabled: false } }),
      );

      const result = await runPiHeadless(
        [...piModelArgs(), "--no-session", "--print", PROMPT],
        {
          cwd: ctx.workDir,
          timeoutMs: PI_RUN_TIMEOUT_MS,
          env: {
            ...piIsolatedEnv(ctx.agentDir, join(ctx.workDir, "sessions")),
            ...ctx.runEnv,
          },
        },
      );

      expect(result.code).toBe(0);
      const requests = stub.requests({ method: "POST", path: ctx.chatPath });
      expect(requests).toHaveLength(1);
      const names = toolNames(requests[0]!.rawBody);
      expect(names.filter((name) => COWBOY_TOOL_NAMES.includes(name))).toEqual(
        [],
      );
      // The switch is about the extension's own tools, nothing else.
      expect(names).toContain("read");
      expect(names).toContain("bash");
    });
  });
});
