/**
 * herdr-fake.ts — a herdr session of the test's own for delegating tests.
 *
 * "Fake" is the WORLD, not the binary: a real `herdr` server in a named
 * session, so a delegation's panes are real panes while the developer's session
 * stays out of it. Nothing outside the delegation paths touches herdr.
 *
 * - A pane inherits the SERVER's environment, not the caller's (measured via
 *   `printenv`): the server is spawned here with `piIsolatedEnv`, so the
 *   subagent sees the test's temp agent dir and stub. Never delegate into a
 *   session the test did not start — the developer's agent dir has no stub.
 * - A named session keeps its own socket: `HERDR_SOCKET_PATH` aims every herdr
 *   call of the run at this session.
 *
 * The session reaches the run through `ScenarioContext.runEnv`; teardown here
 * stops/deletes the session (killing its panes and subagents) and signals the
 * server child last. `herdrAgentProcessId` answers the pid of the subagent's
 * own `pi` over the session socket — pi's rewritten process title hides it
 * from the process table.
 */

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { onTestFinished } from "vitest";
import { resolvedBin } from "../helpers/resolved-bin.js";
import { piIsolatedEnv } from "./pi-headless.js";
import type { ScenarioContext } from "./scenario-steps.js";

/** Generous: a cold `herdr` start is the slowest thing a step integration test does. */
const HERDR_SESSION_READY_TIMEOUT_MS = 30_000;

const HERDR_SESSION_RETRY_DELAY_MS = 250;

interface FakeHerdr {
  name: string;
  socketPath: string;
}

/**
 * Bring up the test's own herdr session and aim its run at it (the run's
 * environment is extended in place, so spawned subagents talk to it too).
 */
export async function startFakeHerdr(ctx: ScenarioContext): Promise<FakeHerdr> {
  const name = `pi-cowboy-step-${randomBytes(4).toString("hex")}`;
  const server = spawn(resolvedBin("herdr"), ["--session", name, "server"], {
    env: piIsolatedEnv(ctx.agentDir, join(ctx.workDir, "sessions")),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Registered up front, so a failure below cannot leave a session behind.
  const cleanUp = async (): Promise<void> => {
    await runHerdr(["session", "stop", name], process.env).catch(
      () => undefined,
    );
    await runHerdr(["session", "delete", name], process.env).catch(
      () => undefined,
    );
    server.kill("SIGTERM");
  };
  onTestFinished(cleanUp);

  let socketPath: string;
  let workspace: { workspaceId: string; tabId: string; paneId: string };
  try {
    socketPath = await herdrApiSocket(server, HERDR_SESSION_READY_TIMEOUT_MS);
    workspace = await createHerdrWorkspace(socketPath, name);
  } catch (err) {
    await cleanUp();
    throw err;
  }

  ctx.runEnv.HERDR_ENV = "1";
  ctx.runEnv.HERDR_SOCKET_PATH = socketPath;
  ctx.runEnv.HERDR_WORKSPACE_ID = workspace.workspaceId;
  ctx.runEnv.HERDR_TAB_ID = workspace.tabId;
  ctx.runEnv.HERDR_PANE_ID = workspace.paneId;

  return { name, socketPath };
}

/** One live agent record of this session, narrowed to what a delegating test reads. */
interface SessionAgent {
  /** herdr's custom `agent start` name, kept only while the launch is pending. */
  name: string;
  /**
   * The pane's terminal title (`π - <spawn id> - <cwd>`); herdr keeps it after
   * dropping the custom start name, so this is how a RUNNING agent is found.
   */
  terminalTitle: string;
  paneId: string;
  /** Its `agent start` call has not returned yet. */
  launchPending: boolean;
}

function carriesSpawnId(agent: SessionAgent, agentId: string): boolean {
  return agent.name.includes(agentId) || agent.terminalTitle.includes(agentId);
}

function sessionSocket(ctx: ScenarioContext): string {
  const socketPath = ctx.runEnv.HERDR_SOCKET_PATH;
  if (socketPath === undefined) {
    throw new Error(
      "herdr-fake: this test has no herdr session — startFakeHerdr must run before the session is queried",
    );
  }
  return socketPath;
}

/** The session's live agent records; an unreadable list reads as no agents. */
async function sessionAgents(ctx: ScenarioContext): Promise<SessionAgent[]> {
  const run = await runHerdr(
    ["agent", "list"],
    isolatedHerdrEnv(sessionSocket(ctx)),
  );
  if (run.code !== 0) return [];
  let listed: unknown;
  try {
    listed = herdrResult(run.stdout).agents;
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry) => {
    const paneId = stringField(entry, "pane_id");
    if (!paneId) return [];
    return [
      {
        name: stringField(entry, "name") || stringField(entry, "agent_name"),
        terminalTitle: stringField(entry, "terminal_title"),
        paneId,
        launchPending:
          (entry as Record<string, unknown> | null)?.launch_pending === true,
      },
    ];
  });
}

async function herdrAgentPaneId(
  ctx: ScenarioContext,
  agentId: string,
): Promise<string | undefined> {
  return (await sessionAgents(ctx)).find((agent) =>
    carriesSpawnId(agent, agentId),
  )?.paneId;
}

/**
 * The pid of the subagent's own `pi` (the pane's foreground process, measured).
 * Undefined when this session has no such agent pane.
 */
export async function herdrAgentProcessId(
  ctx: ScenarioContext,
  agentId: string,
): Promise<number | undefined> {
  const socketPath = sessionSocket(ctx);
  const paneId = await herdrAgentPaneId(ctx, agentId);
  if (paneId === undefined) return undefined;

  const run = await runHerdr(
    ["pane", "process-info", "--pane", paneId],
    isolatedHerdrEnv(socketPath),
  );
  if (run.code !== 0) return undefined;
  let processInfo: unknown;
  try {
    processInfo = herdrResult(run.stdout).process_info;
  } catch {
    return undefined;
  }
  const foreground = (
    processInfo as { foreground_processes?: unknown } | null | undefined
  )?.foreground_processes;
  const pid = Array.isArray(foreground)
    ? (foreground[0] as { pid?: unknown } | undefined)?.pid
    : undefined;
  return typeof pid === "number" ? pid : undefined;
}

/** The `api socket: <path>` line a fresh server prints; the banner goes to STDERR, so both streams are watched. */
function herdrApiSocket(
  server: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      stop();
      reject(
        new Error(
          `herdr server reported no api socket within ${timeoutMs}ms: ${output.slice(0, 300)}`,
        ),
      );
    }, timeoutMs);
    const watch = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const socket = /^api socket: (.+)$/m.exec(output)?.[1];
      if (socket === undefined) return;
      stop();
      // The server outlives the handshake and must never block on an unread stream.
      server.stdout.resume();
      server.stderr.resume();
      resolve(socket.trim());
    };
    const onExit = (code: number | null): void => {
      stop();
      reject(
        new Error(
          `herdr server exited (${code}) before reporting a socket: ${output.slice(0, 300)}`,
        ),
      );
    };
    const stop = (): void => {
      clearTimeout(timer);
      server.stdout.off("data", watch);
      server.stderr.off("data", watch);
      server.off("exit", onExit);
    };
    server.stdout.on("data", watch);
    server.stderr.on("data", watch);
    server.on("exit", onExit);
  });
}

/**
 * Run one `herdr` command. Never rejects: failures surface as a non-zero exit
 * with a JSON error envelope on stdout.
 */
function runHerdr(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(resolvedBin("herdr"), args, { env }, (error, stdout, stderr) => {
      // A spawn failure (ENOENT, EACCES, …) has no numeric code; count it as failed.
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** A herdr CLI call aimed at one session, with no ambient pane. */
function isolatedHerdrEnv(socketPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERDR_SOCKET_PATH: socketPath,
  };
  // The developer's own pane/workspace must never leak into the session lookup.
  delete env.HERDR_PANE_ID;
  delete env.HERDR_WORKSPACE_ID;
  delete env.HERDR_TAB_ID;
  return env;
}

/**
 * The workspace the delegation creates its pane in, retried until the fresh
 * server answers (its socket file appears slightly before it accepts requests).
 */
async function createHerdrWorkspace(
  socketPath: string,
  name: string,
): Promise<{ workspaceId: string; tabId: string; paneId: string }> {
  const env = isolatedHerdrEnv(socketPath);
  const deadline = Date.now() + HERDR_SESSION_READY_TIMEOUT_MS;
  let lastFailure = "";

  while (Date.now() < deadline) {
    const run = await runHerdr(["workspace", "create", "--label", name], env);
    if (run.code === 0) {
      const created = herdrResult(run.stdout);
      const workspaceId = stringField(created.workspace, "workspace_id");
      const tabId = stringField(created.tab, "tab_id");
      const paneId = stringField(created.root_pane, "pane_id");
      if (workspaceId && tabId && paneId) return { workspaceId, tabId, paneId };
      lastFailure = `unusable workspace create result: ${run.stdout.slice(0, 300)}`;
    } else {
      lastFailure = `${run.stdout}${run.stderr}`.trim().slice(0, 300);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, HERDR_SESSION_RETRY_DELAY_MS),
    );
  }

  throw new Error(
    `herdr session ${name} never accepted a workspace: ${lastFailure}`,
  );
}

function herdrResult(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  const result =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { result?: unknown }).result
      : undefined;
  if (typeof result !== "object" || result === null) {
    throw new Error(`herdr returned no result: ${stdout.slice(0, 300)}`);
  }
  return result as Record<string, unknown>;
}

function stringField(record: unknown, key: string): string {
  if (typeof record !== "object" || record === null) return "";
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
