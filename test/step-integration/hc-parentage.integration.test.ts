/**
 * hc-parentage.integration.test.ts — two independent parent chats, each a real
 * `pi` running inside its own herdr-core (`hc`) terminal, share one repository
 * and each delegate once. Every child terminal must name the chat that spawned
 * it as its hc `parent`: parentage comes from the spawning process's own
 * `HC_TERMINAL_ID`, never from the repository, a name, or which chat is in view.
 *
 * The world is the test's own: an hc core in a uniquely named `HC_SESSION`
 * with scratch XDG directories, started with the isolated pi environment (an
 * hc terminal inherits the CORE's environment, not its caller's — measured),
 * so both parents and both children reach the stub. Teardown stops only that
 * core. The file skips where `hc` is not installed.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import {
  messageText,
  startFakeOpenAI,
  type FakeOpenAI,
} from "./fake-openai-server.js";
import { piIsolatedEnv, STUB_API_KEY } from "./pi-headless.js";
import {
  initialize,
  installLocalExtension,
  type ScenarioContext,
} from "./scenario-steps.js";

function hcInstalled(): boolean {
  try {
    execFileSync("/usr/bin/which", ["hc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const PARENTS = [
  { key: "a", taskName: "alpha probe", slug: "alpha-probe" },
  { key: "b", taskName: "beta probe", slug: "beta-probe" },
] as const;

const CLEANING_PARENT = "a";
const KEPT_PARENT = "b";
const CLEANUP_CALL_ID = "call_cleanup";

const REPORT_BODY = "hc child report body";

/** Written by the child itself; `$PWD` is its worktree, named `cow-<slug>-<spawn id>`. */
const WRITE_REPORT_COMMAND =
  'id="$(basename "$PWD")"; id="${id##*-}"; ' +
  `printf '${REPORT_BODY}\\n' > "${join(tmpdir(), "pi-cowboy")}/$id/result.md"; ` +
  'echo "wrote $id"';

const MODEL_ID = "pong-model";

/** Variables naming the developer's own terminal or session; none may reach the test's core. */
const AMBIENT_MULTIPLEXER_VARS = [
  "HC_TERMINAL_ID",
  "HC_TERMINAL_SOCKET",
  "HC_SCOPE",
  "HC_SOCKET",
  "HC_SESSION",
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
];

interface HcWorld {
  env: NodeJS.ProcessEnv;
  hc(args: string[]): Promise<unknown>;
}

function runHc(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("hc", args, { env }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Start the test's own hc core and aim every call at it. */
async function startIsolatedHc(ctx: ScenarioContext): Promise<HcWorld> {
  const session = `cowboy-step-${randomBytes(4).toString("hex")}`;
  const xdg = mkdtempSync(join(tmpdir(), "hc-step-xdg-"));
  const env: NodeJS.ProcessEnv = {
    ...piIsolatedEnv(ctx.agentDir, join(ctx.workDir, "sessions")),
    HC_SESSION: session,
    XDG_CONFIG_HOME: join(xdg, "config"),
    XDG_DATA_HOME: join(xdg, "data"),
    XDG_STATE_HOME: join(xdg, "state"),
    XDG_CACHE_HOME: join(xdg, "cache"),
  };
  for (const name of AMBIENT_MULTIPLEXER_VARS) {
    if (name !== "HC_SESSION") delete env[name];
  }

  onTestFinished(async ({ task }) => {
    // A failure is read from the terminals themselves, before the stop ends them.
    if (task.result?.state === "fail") {
      const listed = await runHc(["ls", "--json", "--all"], env);
      console.error(`hc terminals:\n${listed.stdout}`);
      for (const row of terminalRows(JSON.parse(listed.stdout || "{}"))) {
        const got = await runHc(["get", "--json", row.address], env);
        console.error(`--- ${row.address} get\n${got.stdout}`);
        const screen = await runHc(["read", row.address], env);
        console.error(`--- ${row.address} ${row.name}\n${screen.stdout}`);
      }
    }
    // Only this test's session: HC_SESSION is unique to it.
    await runHc(["server", "stop", "--json"], env);
    rmSync(xdg, { recursive: true, force: true });
  });

  const started = await runHc(["server", "start", "--json"], env);
  if (started.code !== 0) {
    throw new Error(
      `hc server start failed: ${started.stdout}${started.stderr}`,
    );
  }

  return {
    env,
    hc: async (args) => {
      const [command, ...rest] = args;
      const run = await runHc([command, "--json", ...rest], env);
      if (run.code !== 0) {
        throw new Error(
          `hc ${args.join(" ")} failed: ${run.stdout}${run.stderr}`,
        );
      }
      return JSON.parse(run.stdout) as unknown;
    },
  };
}

interface TerminalRow {
  address: string;
  name: string;
  parent: string | null;
  cwd: string;
  labels: Record<string, string>;
}

function terminalRows(listed: unknown): TerminalRow[] {
  const terminals = (listed as { terminals?: unknown } | null)?.terminals;
  if (!Array.isArray(terminals)) return [];
  return terminals.map((entry: Record<string, unknown>) => ({
    address: String(entry.address),
    name: typeof entry.name === "string" ? entry.name : "",
    parent: typeof entry.parent === "string" ? entry.parent : null,
    cwd: typeof entry.cwd === "string" ? entry.cwd : "",
    labels:
      typeof entry.labels === "object" && entry.labels !== null
        ? (entry.labels as Record<string, string>)
        : {},
  }));
}

describe.skipIf(!hcInstalled())(
  "step integration: herdr-core parentage across two parent chats",
  () => {
    let stub: FakeOpenAI;

    beforeAll(async () => {
      stub = await startFakeOpenAI({ expectedApiKey: STUB_API_KEY });
    });

    afterAll(async () => {
      await stub.close();
    });

    it("gives each child the hc terminal of the chat that spawned it, reports to that chat, and cleans up only its own attempt", async () => {
      const testId = expect.getState().currentTestName ?? "hc-parentage";
      const ctx = await initialize(stub, testId);
      installLocalExtension(ctx);
      // This world is hosted by herdr-core: no herdr mark.
      delete ctx.runEnv.HERDR_ENV;

      const route = (segment: string): string => `${ctx.baseUrl}/${segment}`;
      const chatPath = (segment: string): string =>
        `${ctx.chatPath.replace(/\/chat\/completions$/, "")}/${segment}/chat/completions`;

      const providers: Record<string, unknown> = {};
      for (const parent of PARENTS) {
        providers[`hc-child-${parent.key}`] = {
          baseUrl: route(`child-${parent.key}`),
          apiKey: STUB_API_KEY,
          api: "openai-completions",
          models: [{ id: MODEL_ID }],
        };
        providers[`hc-parent-${parent.key}`] = {
          baseUrl: route(parent.key),
          apiKey: STUB_API_KEY,
          api: "openai-completions",
          models: [{ id: MODEL_ID }],
        };
      }
      writeFileSync(
        join(ctx.agentDir, "models.json"),
        JSON.stringify({ providers }, null, 2),
      );
      // Each child writes its report through its own bash tool, the way its
      // prompt tells it to: its spawn id ends its worktree's directory name.
      for (const parent of PARENTS) {
        stub.enqueue({
          method: "POST",
          path: chatPath(`child-${parent.key}`),
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
          path: chatPath(`child-${parent.key}`),
          reply: { kind: "text", text: "report written" },
        });
      }
      for (const parent of PARENTS) {
        stub.enqueue({
          method: "POST",
          path: chatPath(parent.key),
          reply: {
            kind: "tool-call",
            text: "",
            calls: [
              {
                id: `call_${parent.key}`,
                name: "cowboy_agent",
                arguments: {
                  agents: [
                    {
                      prompt: "Reply with one word",
                      task_name: parent.taskName,
                      model: `hc-child-${parent.key}/${MODEL_ID}`,
                    },
                  ],
                },
              },
            ],
          },
        });
        stub.on({
          method: "POST",
          path: chatPath(parent.key),
          reply: { kind: "text", text: "done" },
        });
      }

      const world = await startIsolatedHc(ctx);

      // Each parent chat is a real pi in its own hc terminal, in the SAME repo.
      const parentAddress = new Map<string, string>();
      for (const parent of PARENTS) {
        const started = (await world.hc([
          "run",
          "--bg",
          "--no-notify",
          "--name",
          `parent-${parent.key}`,
          "--cwd",
          ctx.workDir,
          "--",
          "pi",
          "--provider",
          `hc-parent-${parent.key}`,
          "--model",
          MODEL_ID,
          "--no-session",
        ])) as { address: string };
        parentAddress.set(parent.key, started.address);
      }

      // Typed only once pi has drawn its footer: a paste that lands while it
      // is still booting reaches the editor but loses its Enter (measured under
      // load). The footer, not hc's status, because the repo's pinned pi
      // reports no OSC 7501 status.
      for (const parent of PARENTS) {
        const target = parentAddress.get(parent.key) ?? "";
        await expect
          .poll(
            async () =>
              (await runHc(["read", target], world.env)).stdout.includes(
                `(hc-parent-${parent.key}) ${MODEL_ID}`,
              ),
            { timeout: 30_000, interval: 250 },
          )
          .toBe(true);
        await world.hc([
          "send",
          "--",
          target,
          "Delegate one task with cowboy_agent, then reply done",
        ]);
      }

      const acknowledgedAgentId = (key: string): string => {
        const text = stub
          .requests({ method: "POST", path: chatPath(key) })
          .flatMap((request) => request.body.messages)
          .filter(
            (message) =>
              message.role === "tool" && message.tool_call_id === `call_${key}`,
          )
          .map((message) => messageText(message.content))
          .join("\n");
        return /Agent ID: (\S+)/.exec(text)?.[1] ?? "";
      };

      for (const parent of PARENTS) {
        await expect
          .poll(() => acknowledgedAgentId(parent.key), { timeout: 60_000 })
          .not.toBe("");
        if (parent.key === CLEANING_PARENT) {
          // Its next turn is the completion message; it answers by cleaning up.
          stub.enqueue({
            method: "POST",
            path: chatPath(parent.key),
            reply: {
              kind: "tool-call",
              text: "",
              calls: [
                {
                  id: CLEANUP_CALL_ID,
                  name: "cleanup_cowboy_agent",
                  arguments: { agent_ids: [acknowledgedAgentId(parent.key)] },
                },
              ],
            },
          });
        }
      }
      onTestFinished(() => {
        for (const parent of PARENTS) {
          rmSync(join(tmpdir(), "pi-cowboy", acknowledgedAgentId(parent.key)), {
            recursive: true,
            force: true,
          });
        }
      });

      // Each child's own pi reached the stub: it was launched, not just placed.
      for (const parent of PARENTS) {
        await expect
          .poll(
            () =>
              stub
                .requests({
                  method: "POST",
                  path: chatPath(`child-${parent.key}`),
                })
                .some((request) =>
                  request.body.messages.some(
                    (message) =>
                      message.role === "system" &&
                      messageText(message.content).includes(
                        `cowboy-subagent-${acknowledgedAgentId(parent.key)}`,
                      ),
                  ),
                ),
            { timeout: 60_000 },
          )
          .toBe(true);
      }

      const childOf = new Map<string, TerminalRow>();
      const rows = terminalRows(await world.hc(["ls"]));
      const owned = await Promise.all(
        rows.map(async (row) => {
          const got = (await world.hc(["get", row.address])) as {
            labels?: Record<string, string>;
          };
          return { ...row, labels: got.labels ?? {} };
        }),
      );
      const children = owned.filter((row) => row.labels.cowboy === "1");
      expect(children).toHaveLength(2);

      const placement = PARENTS.map((parent) => {
        const address = parentAddress.get(parent.key);
        const mine = children.filter((child) => child.parent === address);
        if (mine.length === 1) childOf.set(parent.key, mine[0]);
        return {
          parent: parent.key,
          children: mine.length,
          namesSlug: mine.every((child) => child.name.includes(parent.slug)),
          namesAgent: mine.every((child) =>
            child.name.includes(acknowledgedAgentId(parent.key)),
          ),
          // The child works in its own worktree of the shared repo.
          inOwnWorktree: mine.every(
            (child) =>
              child.cwd !== ctx.workDir &&
              Object.hasOwn(child.labels, "cowboy.repo"),
          ),
        };
      });
      expect(placement).toEqual(
        PARENTS.map((parent) => ({
          parent: parent.key,
          children: 1,
          namesSlug: true,
          namesAgent: true,
          inOwnWorktree: true,
        })),
      );

      // Each parent hears its own child's report, and only its own.
      const reportsTo = (key: string): string[] => [
        ...new Set(
          stub
            .requests({ method: "POST", path: chatPath(key) })
            .flatMap((request) => request.body.messages)
            .map((message) => messageText(message.content))
            .filter((text) => text.includes("[Cowboy agent ")),
        ),
      ];
      await expect
        .poll(() => PARENTS.map((parent) => reportsTo(parent.key).length), {
          timeout: 60_000,
        })
        .toEqual(PARENTS.map(() => 1));
      expect(
        PARENTS.map((parent) => {
          const [report] = reportsTo(parent.key);
          return (
            report.includes(acknowledgedAgentId(parent.key)) &&
            report.includes("completed") &&
            report.includes(REPORT_BODY)
          );
        }),
      ).toEqual(PARENTS.map(() => true));

      // One parent cleans up: its own child's terminal and worktree go, and
      // nothing of the other chat's attempt is touched.
      const cleanupResult = (): string =>
        stub
          .requests({ method: "POST", path: chatPath(CLEANING_PARENT) })
          .flatMap((request) => request.body.messages)
          .filter(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === CLEANUP_CALL_ID,
          )
          .map((message) => messageText(message.content))
          .join("\n");
      await expect.poll(cleanupResult, { timeout: 60_000 }).not.toBe("");
      expect(cleanupResult()).toMatch(/worktree: removed/);
      expect(cleanupResult()).toMatch(/branch: deleted/);

      const cleaned = childOf.get(CLEANING_PARENT)!;
      const kept = childOf.get(KEPT_PARENT)!;
      const live = terminalRows(await world.hc(["ls"]));
      expect(live.map((row) => row.address)).not.toContain(cleaned.address);
      expect(existsSync(cleaned.cwd)).toBe(false);
      expect(live.find((row) => row.address === kept.address)?.parent).toBe(
        parentAddress.get(KEPT_PARENT),
      );
      expect(existsSync(kept.cwd)).toBe(true);
      expect(live.map((row) => row.address)).toEqual(
        expect.arrayContaining(
          PARENTS.map((parent) => parentAddress.get(parent.key)),
        ),
      );
    }, 180_000);
  },
);
