/**
 * extension-loadout.integration.test.ts — what a real `pi` OFFERS the model.
 *
 * The subject is what a boot registers: the extension's own on/off switch (a
 * plain `--print` run with the switch off must send a request whose `tools` no
 * longer carry a single cowboy tool name, while the same run with no config
 * file does) and the git-repository gate (a run whose cwd is not a repository
 * sends none either). Tools are read from the stub's recorded request; `/cowboy`
 * never reaches the model, so `registration-observer.ts` records the commands
 * from inside pi. The run's cwd is a git repository — Initialize makes it one,
 * and the extension probes for one at boot — and no herdr world is needed:
 * `installLocalExtension` marks the run herdr-shaped and the extension loads,
 * registers its tools, and reads its config from the isolated agent dir.
 *
 * The stub stands in for the MODEL; what it records is the run's first request.
 * The stub server starts once per file (beforeAll/afterAll); each path owns an
 * isolated route under its own path prefix, and the world, the installed
 * extension and the scripted reply are the block's setup. Script and
 * verification stay inline; only application steps are factored
 * (scenario-steps.ts). See WRITING-TESTS.md.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Add the registration probe to the run's extensions dir, pointed at this run's
 * record file. Commands never reach the model, so this is the only way a test
 * sees `/cowboy`.
 */
function installRegistrationObserver(ctx: ScenarioContext): void {
  symlinkSync(
    fileURLToPath(new URL("./registration-observer.ts", import.meta.url)),
    join(ctx.agentDir, "extensions", "registration-observer.ts"),
  );
  ctx.runEnv.PI_COWBOY_OBSERVER_FILE = join(ctx.agentDir, "registration.json");
}

/** What pi registered at session_start: active tool names and command names. */
function observedRegistration(ctx: ScenarioContext): {
  activeTools: string[];
  commands: string[];
} {
  return JSON.parse(
    readFileSync(join(ctx.agentDir, "registration.json"), "utf-8"),
  ) as { activeTools: string[]; commands: string[] };
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
    beforeEach(async () => {
      ctx = await initialize(stub, currentTestId());
      installLocalExtension(ctx);
      installRegistrationObserver(ctx);
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

      const observed = observedRegistration(ctx);
      expect(observed.activeTools).toEqual(
        expect.arrayContaining([...COWBOY_TOOL_NAMES]),
      );
      expect(observed.commands).toContain("cowboy");
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
      // The command stays registered so `/cowboy enable` can turn it back on.
      expect(observedRegistration(ctx).commands).toContain("cowboy");
    });

    it("keeps every Cowboy tool out of the loadout when the cwd is not a git repository", async () => {
      // The extension activates only inside a git repository; this path removes
      // the .git Initialize made, so the boot finds no repository.
      rmSync(join(ctx.workDir, ".git"), { recursive: true, force: true });

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
      expect(names).toContain("read");

      const observed = observedRegistration(ctx);
      expect(
        observed.activeTools.filter((name) => COWBOY_TOOL_NAMES.includes(name)),
      ).toEqual([]);
      // Inactive, but `/cowboy` is still registered so it can report the reason.
      expect(observed.commands).toContain("cowboy");
    });

    it("still offers the Cowboy tools when git cannot report the repository", async () => {
      // A git that cannot answer must not read as "not a repository": the cwd
      // is still inside one. A stray GIT_DIR — a git hook or a wrapper leaking
      // it — points git away from the checkout while the .git stays in place.
      const result = await runPiHeadless(
        [...piModelArgs(), "--no-session", "--print", PROMPT],
        {
          cwd: ctx.workDir,
          timeoutMs: PI_RUN_TIMEOUT_MS,
          env: {
            ...piIsolatedEnv(ctx.agentDir, join(ctx.workDir, "sessions")),
            ...ctx.runEnv,
            GIT_DIR: join(ctx.workDir, "no-such-git-dir"),
          },
        },
      );

      expect(result.code).toBe(0);
      const requests = stub.requests({ method: "POST", path: ctx.chatPath });
      expect(requests).toHaveLength(1);
      const names = toolNames(requests[0]!.rawBody);
      expect(names).toContain("cowboy_agent");
      expect(names).toContain("read");

      const observed = observedRegistration(ctx);
      expect(observed.activeTools).toContain("cowboy_agent");
      expect(observed.commands).toContain("cowboy");
    });
  });
});
