/**
 * pi-cowboy.integration.test.ts — THIS repo's extension is the SUBJECT: the stub
 * scripts a `cowboy_agent` call, a real orchestrator process makes it, and the
 * extension executes it for real (herdr pane + second `pi` process).
 *
 * Both paths sit in one world: this repo's extension linked into an isolated
 * agent dir, a herdr session of the test's own, the delegated agent's own
 * provider, and the orchestrator script that delegates once and then answers
 * plainly. What each path forks is the delegated agent's script and the
 * conversation it verifies.
 *
 * The stub stands in for the MODEL on both sides; everything below the model is
 * real. It needs a herdr world of its own (`startFakeHerdr` — the session's pane
 * is the built-in multiplexer's, which hosts only a herdr process, and the
 * developer's session must stay out of it) and
 * a LIVE orchestrator (`engageOrchestrator` — the background launch needs a
 * parent that outlives its turn, and the conversation is where a settlement
 * message is read).
 *
 * The stub server starts once per file (beforeAll/afterAll); the test owns an
 * isolated route under its own path prefix. Script and verification stay inline;
 * only application steps are factored (scenario-steps.ts). See WRITING-TESTS.md.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  lastUserText,
  messageText,
  startFakeOpenAI,
  type ChatCompletionsRequest,
  type FakeOpenAI,
  type StubChatMessage,
} from "./fake-openai-server.js";
import { herdrAgentProcessId, startFakeHerdr } from "./herdr-fake.js";
import { STUB_API_KEY } from "./pi-headless.js";
import {
  engageOrchestrator,
  initialize,
  installLocalExtension,
  type ScenarioContext,
} from "./scenario-steps.js";

const TOOL_CALL_ID = "call_1";

const DELEGATED_TASK = "Reply with the single word: delegated";

/** `task_name` within the tool's 3-word/19-char slug limits. */
const DELEGATED_TASK_NAME = "verify spawn";

const ORCHESTRATOR_PROMPT =
  "Delegate a task to a subagent with the cowboy_agent tool, then reply with the single word: done";

/**
 * The delegated agent's own provider and route, separable from the orchestrator's
 * so its first reply can be HELD while the orchestrator's turns keep answering.
 * Spawns with no `model` parameter read only the configured `agent.default`, so
 * it points there. Declared before the delegation: the subagent reads
 * `models.json` at boot.
 */
const DELEGATED_PROVIDER_ID = "step-integration-delegated-fake";
const DELEGATED_MODEL_ID = "delegated-model";
const DELEGATED_ROUTE_SEGMENT = "delegated";

/** Subagent system-prompt marker: the one thing only a launched subagent can send. */
const SUBAGENT_MARKER = "cowboy-subagent-";

/** Root of the extension's per-agent status directories (`<tmpdir>/pi-cowboy`). */
const SUBAGENT_STATUS_DIR = join(tmpdir(), "pi-cowboy");

/** The delegated agent's report, as both the child and the parent's reader see it. */
const REPORT_BODY = "delegated report body";

/**
 * The child writes its report through its own `bash` tool, the way its prompt
 * tells it to: the newest staging directory under the shared root is its own.
 */
const WRITE_REPORT_COMMAND =
  `d="${SUBAGENT_STATUS_DIR}"; ` +
  't="$(ls -dt "$d"/*/ 2>/dev/null | head -1)"; ' +
  `printf '${REPORT_BODY}\\n' > "$t/result.md"; ` +
  'echo "wrote $t/result.md"';

/** The running test's fully qualified name, read at call time for the stub route prefix. */
function currentTestId(): string {
  const name = expect.getState().currentTestName;
  if (name === undefined) {
    throw new Error("currentTestId: no running test to take a prefix from");
  }
  return name;
}

/**
 * Text of a request's system message, or "". A decoder (not an expectation):
 * the spawn marker rides there, attributing the request to the subagent.
 */
function systemPromptText(body: ChatCompletionsRequest): string {
  const system = body.messages.find((message) => message.role === "system");
  return messageText(system?.content);
}

function reportedAgentId(spawnAcknowledgement: string): string {
  return /Agent ID: (\S+)/.exec(spawnAcknowledgement)?.[1] ?? "";
}

describe("step integration: a real pi process against the fake-openai stub", () => {
  let stub: FakeOpenAI;

  beforeAll(async () => {
    stub = await startFakeOpenAI({ expectedApiKey: STUB_API_KEY });
  });

  afterAll(async () => {
    await stub.close();
  });

  describe("a scripted cowboy_agent call against an installed extension", () => {
    let ctx: ScenarioContext;
    /** The delegated agent's route: its replies are the paths' to script. */
    let delegatedChatPath: string;

    beforeEach(async () => {
      const testId = currentTestId();
      ctx = await initialize(stub, testId);
      installLocalExtension(ctx);
      await startFakeHerdr(ctx);

      // Before the delegation: the subagent reads `models.json` at boot.
      delegatedChatPath = ctx.chatPath.replace(
        /\/chat\/completions$/,
        `/${DELEGATED_ROUTE_SEGMENT}/chat/completions`,
      );

      const models = JSON.parse(
        readFileSync(join(ctx.agentDir, "models.json"), "utf-8"),
      ) as { providers: Record<string, unknown> };
      models.providers[DELEGATED_PROVIDER_ID] = {
        baseUrl: `${ctx.baseUrl}/${DELEGATED_ROUTE_SEGMENT}`,
        apiKey: STUB_API_KEY,
        api: "openai-completions",
        models: [{ id: DELEGATED_MODEL_ID }],
      };
      writeFileSync(
        join(ctx.agentDir, "models.json"),
        JSON.stringify(models, null, 2),
      );
      mkdirSync(join(ctx.agentDir, "pi-cowboy"), { recursive: true });
      writeFileSync(
        join(ctx.agentDir, "pi-cowboy", "config.json"),
        JSON.stringify({
          agent: {
            default: `${DELEGATED_PROVIDER_ID}/${DELEGATED_MODEL_ID}`,
          },
        }),
      );

      stub.enqueue({
        method: "POST",
        path: ctx.chatPath,
        reply: {
          kind: "tool-call",
          text: "",
          calls: [
            {
              id: TOOL_CALL_ID,
              name: "cowboy_agent",
              arguments: {
                agents: [
                  {
                    prompt: DELEGATED_TASK,
                    task_name: DELEGATED_TASK_NAME,
                  },
                ],
              },
            },
          ],
        },
      });

      // Default for the orchestrator's later turns, so an arrival lands while live.
      stub.on({
        method: "POST",
        path: ctx.chatPath,
        reply: { kind: "text", text: "done" },
      });
    }, 60_000);

    it("fails the delegated agent's first inference and leaves the run live", async () => {
      // HELD UNTIL RELEASE, then FAILED with a 400 (terminal: the client retries
      // 5xx/429, not 4xx). Scripted before the delegation — the subagent asks the
      // moment it boots, so a later reply would race the request it must hold.
      stub.on({
        method: "POST",
        path: delegatedChatPath,
        reply: {
          kind: "error",
          status: 400,
          message: "the fake model rejected this request",
          code: "delegated_model_failure",
          hold: "until-released",
        },
      });

      // LIVE orchestrator (rpc mode): stays up so the background launch can run.
      const orchestrator = engageOrchestrator(ctx, ORCHESTRATOR_PROMPT);

      const parentRequests = (): ReturnType<typeof stub.requests> =>
        stub.requests({ method: "POST", path: ctx.chatPath });

      const acknowledgement = (): StubChatMessage | undefined =>
        parentRequests()
          .flatMap((request) => request.body.messages)
          .find(
            (message) =>
              message.role === "tool" && message.tool_call_id === TOOL_CALL_ID,
          );

      // The spawn acknowledgement in the parent's conversation proves the
      // extension EXECUTED the call (a refusal would leave an error result).
      await expect
        .poll(() => acknowledgement() !== undefined, { timeout: 20_000 })
        .toBe(true);

      const acknowledgementText = messageText(acknowledgement()?.content);
      expect(acknowledgementText).toContain("[Agent spawned]");
      const agentId = reportedAgentId(acknowledgementText);
      expect(agentId).not.toBe("");

      // No cleanup call is scripted, so remove the spawn's status directory;
      // a settlement of its own removes it first when the run settles below.
      onTestFinished(() => {
        rmSync(join(SUBAGENT_STATUS_DIR, agentId), {
          recursive: true,
          force: true,
        });
      });

      const delegatedRequests = (): ReturnType<typeof stub.requests> =>
        stub.requests({ method: "POST", path: delegatedChatPath });

      // The delegated agent's FIRST inference is in flight on its own route —
      // spawn marker, task, and no reply yet (`pendingRequests` pins the hold).
      await expect
        .poll(() => delegatedRequests().length, { timeout: 20_000 })
        .toBe(1);
      expect(
        stub.pendingRequests({ method: "POST", path: delegatedChatPath }),
      ).toHaveLength(1);

      const delegatedRequest = delegatedRequests()[0];
      expect(systemPromptText(delegatedRequest.body)).toContain(
        `${SUBAGENT_MARKER}${agentId}`,
      );
      expect(lastUserText(delegatedRequest.body)).toContain(DELEGATED_TASK);

      // The process awaiting it is a real pi in a herdr pane.
      expect(await herdrAgentProcessId(ctx, agentId)).toBeGreaterThan(0);

      // The exact-one result makes the release itself an assertion.
      expect(stub.release({ method: "POST", path: delegatedChatPath })).toBe(1);

      // Nothing reports the failure. Every settlement message names its agent id,
      // and the orchestrator's own conversation is the only place a test can read
      // them (the supervisor's state and the result files live inside the
      // orchestrator's process). Real time, not fake timers: the supervisor's
      // report poll runs inside that process, which no test clock can reach.
      const outcomeMessages = (): string[] =>
        parentRequests()
          .flatMap((request) => request.body.messages)
          .map((message) => messageText(message.content))
          .filter((text) =>
            text.includes(`[Cowboy agent "general-purpose" ${agentId}`),
          );

      // Four supervisor poll intervals (2000 ms each) with the failure in place:
      // no report exists, so no settlement message can be produced.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(outcomeMessages()).toEqual([]);

      // Pi does not retry a 4xx: the first inference was the last.
      expect(delegatedRequests()).toHaveLength(1);

      // The failed turn did not end the run: its pi process still holds the pane.
      expect(await herdrAgentProcessId(ctx, agentId)).toBeGreaterThan(0);

      orchestrator.handle.endInput();
      const result = await orchestrator.result;

      expect(result.code).toBe(0);
    }, 30_000);

    it("announces the report once when the same words are written again", async () => {
      // The delegated agent's script: it writes its report, then confirms in one
      // line. Its report path is not known before the spawn, so the child finds
      // its own staging directory.
      stub.enqueue({
        method: "POST",
        path: delegatedChatPath,
        reply: {
          kind: "tool-call",
          text: "",
          calls: [
            {
              id: "call_write",
              name: "bash",
              arguments: { command: WRITE_REPORT_COMMAND },
            },
          ],
        },
      });
      stub.on({
        method: "POST",
        path: delegatedChatPath,
        reply: { kind: "text", text: "report written" },
      });

      const orchestrator = engageOrchestrator(ctx, ORCHESTRATOR_PROMPT);

      const parentRequests = (): ReturnType<typeof stub.requests> =>
        stub.requests({ method: "POST", path: ctx.chatPath });

      const acknowledgement = (): StubChatMessage | undefined =>
        parentRequests()
          .flatMap((request) => request.body.messages)
          .find(
            (message) =>
              message.role === "tool" && message.tool_call_id === TOOL_CALL_ID,
          );

      await expect
        .poll(() => acknowledgement() !== undefined, { timeout: 20_000 })
        .toBe(true);

      const agentId = reportedAgentId(messageText(acknowledgement()?.content));
      expect(agentId).not.toBe("");
      const resultFile = join(SUBAGENT_STATUS_DIR, agentId, "result.md");
      onTestFinished(() => {
        rmSync(join(SUBAGENT_STATUS_DIR, agentId), {
          recursive: true,
          force: true,
        });
      });

      // The report is the parent's news: the completion message carries it, and
      // the conversation is where the delivery is read. Each later request
      // repeats the whole history, so the count is of DISTINCT messages.
      const reportMessages = (): string[] => [
        ...new Set(
          parentRequests()
            .flatMap((request) => request.body.messages)
            .map((message) => messageText(message.content))
            .filter((text) =>
              text.includes(`[Cowboy agent "general-purpose" ${agentId}`),
            ),
        ),
      ];

      // The child's own write, held one confirm poll, reported once.
      await expect
        .poll(() => reportMessages().length, { timeout: 30_000 })
        .toBe(1);
      expect(reportMessages()[0]).toContain("completed");
      expect(reportMessages()[0]).toContain(REPORT_BODY);

      // The child writes the very same words again: one deliverable, a second
      // write of it. A settled run is not owed a second message for words its
      // parent already holds, so three poll intervals produce nothing.
      writeFileSync(resultFile, `${REPORT_BODY}\n`);
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      expect(reportMessages()).toHaveLength(1);

      orchestrator.handle.endInput();
      const result = await orchestrator.result;

      expect(result.code).toBe(0);
    }, 60_000);
  });
});
