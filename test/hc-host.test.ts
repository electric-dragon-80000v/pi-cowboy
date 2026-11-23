/**
 * hc-host.test.ts — the herdr-core runtime against an in-memory hc.
 *
 * Every hc call goes through the fake's argv parser, so these cases pin the
 * command lines the runtime issues as well as what it does with the answers.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHostRef, ViewRequest } from "../src/agents/agent-host.js";
import {
  createHcRuntime,
  hcTerminalName,
} from "../src/infrastructure/hc-host.js";
import { FakeHc, type FakeTerminal } from "./helpers/hc-fake.js";

const { removeGitWorktreeMock } = vi.hoisted(() => ({
  removeGitWorktreeMock: vi.fn(),
}));

vi.mock("../src/infrastructure/git-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/infrastructure/git-client.js")
    >();
  return { ...actual, removeGitWorktree: removeGitWorktreeMock };
});

const FAST = { pollIntervalMs: 1, killSettleMs: 20 };

let hc: FakeHc;
let scratch: string;

beforeEach(() => {
  vi.stubEnv("HERDR_ENV", "");
  vi.stubEnv("HC_TERMINAL_ID", "t100");
  hc = new FakeHc();
  hc.add({ address: "t100", name: "chat-a" });
  scratch = mkdtempSync(path.join(os.tmpdir(), "hc-host-"));
  removeGitWorktreeMock
    .mockReset()
    .mockImplementation(async (_pi: unknown, _repo: string, wtPath: string) => {
      rmSync(wtPath, { recursive: true, force: true });
    });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function runtime() {
  return createHcRuntime(hc.pi, FAST);
}

function checkoutRequest(branch = "cow-fix-login-01234567"): ViewRequest {
  return {
    unit: "pane",
    cwd: "/repo",
    label: "fix login",
    name: branch,
    checkout: {
      path: path.join(scratch, branch),
      repoCwd: "/repo",
      branch,
    },
  };
}

/** A placement started and taken over by a status-reporting agent. */
async function startedAgent(
  request: ViewRequest = checkoutRequest(),
): Promise<{ ref: AgentHostRef; terminal: FakeTerminal }> {
  const rt = runtime();
  const ref = await rt.host.hostAt(request);
  await rt.host.start(ref, {
    name: ref.name,
    piArgs: ["--session", "x"],
    agentMultiplexerKind: "pi",
  });
  return { ref, terminal: hc.terminals.get(ref.paneId)! };
}

describe("hcTerminalName", () => {
  it("keeps a branch-shaped identity as it is", () => {
    expect(hcTerminalName("cow-fix-login-01234567")).toBe(
      "cow-fix-login-01234567",
    );
  });

  it("folds a free-text label into hc's name alphabet", () => {
    expect(hcTerminalName("General Purpose!")).toBe("general-purpose");
    expect(hcTerminalName("--x")).toBe("x");
  });

  it("never yields a name hc would read as a terminal address", () => {
    expect(hcTerminalName("t7")).toBe("cowboy-t7");
    expect(hcTerminalName("!!!")).toBe("cowboy-");
  });
});

describe("hc host.hostAt", () => {
  it("files the terminal under this process's own terminal, without hc's exit notes", async () => {
    const ref = await runtime().host.hostAt(checkoutRequest());

    const [run] = hc.hcCalls("run");
    expect(run).toEqual(
      expect.arrayContaining(["--bg", "--no-notify", "--parent", "t100"]),
    );
    expect(run!.slice(run!.indexOf("--"))).toEqual([
      "--",
      "bash",
      "--noprofile",
      "--norc",
      "-i",
    ]);
    const terminal = hc.terminals.get(ref.paneId)!;
    expect(terminal.parent).toBe("t100");
    expect(terminal.notify).toBe(false);
    expect(terminal.cwd).toBe(path.join(scratch, "cow-fix-login-01234567"));
    expect(terminal.labels).toEqual({
      cowboy: "1",
      "cowboy.agent": "cow-fix-login-01234567",
      "cowboy.checkout": path.join(scratch, "cow-fix-login-01234567"),
      "cowboy.repo": "/repo",
    });
    expect(ref).toEqual({
      multiplexer: "herdr-core",
      name: "cow-fix-login-01234567",
      paneId: terminal.address,
      workspaceId: terminal.address,
      paneCreated: true,
    });
  });

  it("files two chats' children under their own chats, even in one repository", async () => {
    hc.add({ address: "t200", name: "chat-b" });

    const fromA = await runtime().host.hostAt(
      checkoutRequest("cow-task-aaaaaaaa"),
    );
    vi.stubEnv("HC_TERMINAL_ID", "t200");
    const fromB = await runtime().host.hostAt(
      checkoutRequest("cow-task-bbbbbbbb"),
    );

    expect(hc.terminals.get(fromA.paneId)!.parent).toBe("t100");
    expect(hc.terminals.get(fromB.paneId)!.parent).toBe("t200");
  });

  it("refuses to place an agent without a terminal to file it under", async () => {
    vi.stubEnv("HC_TERMINAL_ID", "");

    await expect(runtime().host.hostAt(checkoutRequest())).rejects.toThrow(
      /no HC_TERMINAL_ID/,
    );
    expect(hc.hcCalls("run")).toEqual([]);
  });

  it("takes the next spot when hc reports a name taken", async () => {
    hc.add({ name: "general-purpose-1" });

    const ref = await runtime().host.hostAt({
      unit: "pane",
      cwd: "/repo",
      label: "general-purpose",
    });

    expect(ref.name).toBe("general-purpose");
    expect(hc.terminals.get(ref.paneId)!.name).toBe("general-purpose-2");
    expect(hc.terminals.get(ref.paneId)!.cwd).toBe("/repo");
    expect(hc.terminals.get(ref.paneId)!.labels).toEqual({
      cowboy: "1",
      "cowboy.agent": "general-purpose",
    });
  });

  it("fails once every spot is taken", async () => {
    for (let index = 1; index <= 9; index++) {
      hc.add({ name: `general-purpose-${index}` });
    }

    await expect(
      runtime().host.hostAt({
        unit: "pane",
        cwd: "/repo",
        label: "general-purpose",
      }),
    ).rejects.toThrow(/no free terminal name/);
  });

  it("passes other hc failures through", async () => {
    const pi = {
      exec: async () => ({
        code: 6,
        stdout: "",
        stderr: JSON.stringify({
          error: { kind: "invalid_params", message: "bad cwd" },
        }),
      }),
    };

    await expect(
      createHcRuntime(pi as never, FAST).host.hostAt(checkoutRequest()),
    ).rejects.toThrow("bad cwd");
  });
});

describe("hc host.start", () => {
  it("types the agent kind as the command, then its quoted arguments, and waits for the agent", async () => {
    const { terminal } = await startedAgent();

    expect(terminal.sent).toEqual(["'pi' '--session' 'x'"]);
    expect(terminal.foregroundName).toBe("pi");
  });

  it("launches a harness under its own kind, so its launcher function answers", async () => {
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());

    await rt.host.start(ref, {
      name: ref.name,
      piArgs: ["--prompt", "x"],
      agentMultiplexerKind: "opencode",
    });

    expect(hc.terminals.get(ref.paneId)!.sent).toEqual([
      "'opencode' '--prompt' 'x'",
    ]);
  });

  it("quotes a word so the shell reads it as bytes", async () => {
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());

    await rt.host.start(ref, {
      name: ref.name,
      piArgs: ["it's $(here)"],
      agentMultiplexerKind: "pi",
    });

    expect(hc.terminals.get(ref.paneId)!.sent).toEqual([
      `'pi' 'it'\\''s $(here)'`,
    ]);
  });

  it("refuses to type into a placement a program already holds", async () => {
    const { ref, terminal } = await startedAgent();
    terminal.sent.length = 0;

    await expect(
      runtime().host.start(ref, {
        name: ref.name,
        piArgs: [],
        agentMultiplexerKind: "pi",
      }),
    ).rejects.toThrow(/already running pi/);
    expect(terminal.sent).toEqual([]);
  });

  it("reports a placement that ends while the agent starts", async () => {
    hc.onSend = (terminal) => {
      terminal.state = "finished";
    };
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());

    await expect(
      rt.host.start(ref, {
        name: ref.name,
        piArgs: [],
        agentMultiplexerKind: "pi",
      }),
    ).rejects.toThrow(/ended while/);
  });

  it("refuses a terminal that is not this placement any more", async () => {
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());
    hc.terminals.get(ref.paneId)!.labels = {};

    await expect(
      rt.host.start(ref, {
        name: ref.name,
        piArgs: [],
        agentMultiplexerKind: "pi",
      }),
    ).rejects.toThrow(/not this agent's placement/);
  });
});

describe("hc host.observe", () => {
  it.each(["idle", "working", "blocked", "done"] as const)(
    "reads the agent's own %s status",
    async (status) => {
      const { ref, terminal } = await startedAgent();
      terminal.status = status;

      await expect(runtime().host.observe(ref)).resolves.toEqual({
        state: status,
      });
    },
  );

  it("answers unknown for an error or a program that reports no status", async () => {
    const { ref, terminal } = await startedAgent();

    terminal.status = "error";
    await expect(runtime().host.observe(ref)).resolves.toEqual({
      state: "unknown",
    });
    terminal.status = null;
    await expect(runtime().host.observe(ref)).resolves.toEqual({
      state: "unknown",
    });
  });

  it("answers gone once the agent has exited to its shell, finished, or been removed", async () => {
    const { ref, terminal } = await startedAgent();

    terminal.foregroundPid = terminal.pid;
    await expect(runtime().host.observe(ref)).resolves.toBeUndefined();
    terminal.state = "finished";
    await expect(runtime().host.observe(ref)).resolves.toBeUndefined();
    hc.terminals.delete(ref.paneId);
    await expect(runtime().host.observe(ref)).resolves.toBeUndefined();
  });

  it("does not read another terminal that took over the address", async () => {
    const { ref, terminal } = await startedAgent();
    terminal.labels = { cowboy: "1", "cowboy.agent": "someone-else" };

    await expect(runtime().host.observe(ref)).resolves.toBeUndefined();
  });

  it("waits until the agent is gone", async () => {
    const { ref, terminal } = await startedAgent();
    setTimeout(() => {
      terminal.foregroundPid = terminal.pid;
    }, 5);

    await expect(
      runtime().host.waitUntilGone(ref, { timeoutMs: 2_000 }),
    ).resolves.toBe(true);
  });

  it("gives up waiting on an agent that stays", async () => {
    const { ref } = await startedAgent();

    await expect(
      runtime().host.waitUntilGone(ref, { timeoutMs: 20 }),
    ).resolves.toBe(false);
  });
});

describe("hc pane.promptAgent", () => {
  it("delivers to an idle agent with hc re-checking the status as it types", async () => {
    const { ref, terminal } = await startedAgent();

    await expect(
      runtime().pane.promptAgent!(ref.paneId, "-v tighten the loop"),
    ).resolves.toEqual({ kind: "submitted" });
    const send = hc.hcCalls("send").at(-1)!;
    expect(send).toEqual([
      "send",
      "--json",
      "--if",
      "idle",
      "--",
      ref.paneId,
      "-v tighten the loop",
    ]);
    expect(terminal.sent.at(-1)).toBe("-v tighten the loop");
  });

  it("delivers to a working agent only while it is still working", async () => {
    const { ref, terminal } = await startedAgent();
    terminal.status = "working";

    await expect(
      runtime().pane.promptAgent!(ref.paneId, "hi"),
    ).resolves.toEqual({ kind: "submitted" });
    expect(hc.hcCalls("send").at(-1)).toContain("working");
  });

  it("delivers to an agent whose turn is done", async () => {
    const { ref, terminal } = await startedAgent();
    terminal.status = "done";

    await expect(
      runtime().pane.promptAgent!(ref.paneId, "hi"),
    ).resolves.toEqual({ kind: "submitted" });
    expect(hc.hcCalls("send").at(-1)).not.toContain("--if");
  });

  it.each([
    [
      "the shell is in front",
      (t: FakeTerminal) => {
        t.foregroundPid = t.pid;
      },
      /shell prompt/,
    ],
    [
      "the program reports no status",
      (t: FakeTerminal) => {
        t.status = null;
      },
      /approval dialog cannot be ruled out/,
    ],
    [
      "the agent waits on an approval",
      (t: FakeTerminal) => {
        t.status = "blocked";
      },
      /waiting on an approval/,
    ],
    [
      "the terminal has finished",
      (t: FakeTerminal) => {
        t.state = "finished";
      },
      /not live/,
    ],
  ])("types nothing when %s", async (_why, arrange, detail) => {
    const { ref, terminal } = await startedAgent();
    arrange(terminal);
    const sends = hc.hcCalls("send").length;

    const outcome = await runtime().pane.promptAgent!(ref.paneId, "hi");

    expect(outcome).toEqual({
      kind: "not-submitted",
      detail: expect.stringMatching(detail),
    });
    expect(hc.hcCalls("send")).toHaveLength(sends);
  });

  it("reports a status change between the read and the send as not submitted", async () => {
    const { ref, terminal } = await startedAgent();
    // hc saw a different status than the read did.
    const exec = hc.pi.exec.bind(hc.pi);
    (hc.pi as { exec: typeof exec }).exec = async (cmd, args, opts) => {
      if (cmd === "hc" && args[0] === "send") terminal.status = "blocked";
      return exec(cmd, args, opts);
    };

    const outcome = await runtime().pane.promptAgent!(ref.paneId, "hi");

    expect(outcome.kind).toBe("not-submitted");
    expect(terminal.sent).not.toContain("hi");
  });

  it("reports an unreadable terminal as not submitted", async () => {
    const pi = {
      exec: async () => ({ code: 1, stdout: "", stderr: "core down" }),
    };

    await expect(
      createHcRuntime(pi as never, FAST).pane.promptAgent!("t5", "hi"),
    ).resolves.toEqual({
      kind: "not-submitted",
      detail: expect.stringContaining("could not read terminal t5"),
    });
  });
});

describe("hc pane shell control", () => {
  it("types a command only at the placement's shell prompt", async () => {
    const { terminal } = await startedAgent(checkoutRequest("cow-b-bbbbbbbb"));
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());
    hc.onSend = () => {};

    await rt.pane.run(ref.paneId, "typeset -f launcher");
    expect(hc.terminals.get(ref.paneId)!.sent).toEqual(["typeset -f launcher"]);
    await expect(rt.pane.run(terminal.address, "ls")).rejects.toThrow(
      /refusing to type a shell command/,
    );
  });

  it("presses an agent's exit keys, but never at a bare shell", async () => {
    const { ref, terminal } = await startedAgent();

    await runtime().pane.sendKeys(ref.paneId, ["ctrl+c", "ctrl+d"]);
    expect(terminal.keys).toEqual(["ctrl+c", "ctrl+d"]);

    terminal.foregroundPid = terminal.pid;
    await runtime().pane.sendKeys(ref.paneId, ["ctrl+d"]);
    expect(terminal.keys).toEqual(["ctrl+c", "ctrl+d"]);
  });

  it("waits for output on the screen", async () => {
    const { ref, terminal } = await startedAgent();
    setTimeout(() => {
      terminal.screen = "ready: MARK-1";
    }, 5);

    await runtime().pane.waitForVisibleOutput!(ref.paneId, "MARK-1", 2_000);
    expect(hc.hcCalls("read").at(-1)).toEqual([
      "read",
      "--json",
      ref.paneId,
      "--lines",
      "0",
    ]);
    await expect(
      runtime().pane.waitForOutput(ref.paneId, "never", 20),
    ).rejects.toThrow(/did not print "never"/);
  });
});

describe("hc host.release", () => {
  it("closes only a placement this runtime started", async () => {
    const { ref, terminal } = await startedAgent();

    terminal.labels = { cowboy: "1", "cowboy.agent": "someone-else" };
    await expect(runtime().host.release(ref, "placement")).resolves.toBe(true);
    expect(hc.terminals.has(ref.paneId)).toBe(true);
    expect(hc.hcCalls("kill")).toEqual([]);

    terminal.labels = { cowboy: "1", "cowboy.agent": ref.name };
    await expect(runtime().host.release(ref, "placement")).resolves.toBe(true);
    expect(hc.terminals.has(ref.paneId)).toBe(false);
  });

  it("treats an already-removed placement as released", async () => {
    const { ref } = await startedAgent();
    hc.terminals.delete(ref.paneId);

    await expect(runtime().host.release(ref, "placement")).resolves.toBe(true);
  });

  it("closes the agent's terminal for a ref rebuilt from its branch, even after the agent exited", async () => {
    const { ref, terminal } = await startedAgent();
    mkdirSync(checkoutRequest().checkout!.path);
    terminal.foregroundPid = terminal.pid;
    const rebuilt: AgentHostRef = {
      multiplexer: "herdr-core",
      name: "cow-fix-login-01234567",
      paneId: ref.paneId,
      workspaceId: ref.paneId,
      paneCreated: true,
    };

    await expect(
      runtime().host.release(rebuilt, "worktree-association"),
    ).resolves.toBe(true);
    expect(hc.hcCalls("kill")).toHaveLength(1);
    expect(hc.terminals.has(ref.paneId)).toBe(false);
  });

  it("keeps the checkout when the agent's terminal survives the kill", async () => {
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());
    mkdirSync(checkoutRequest().checkout!.path);
    hc.unkillable.add(ref.paneId);

    await expect(rt.host.release(ref, "worktree-association")).resolves.toBe(
      false,
    );
    expect(hc.terminals.get(ref.paneId)!.state).toBe("live");
    expect(hc.hcCalls("rm")).toEqual([]);
    expect(removeGitWorktreeMock).not.toHaveBeenCalled();
  });

  it("leaves the checkout under a live terminal that is not the agent's", async () => {
    const rt = runtime();
    const ref = await rt.host.hostAt(checkoutRequest());
    const terminal = hc.terminals.get(ref.paneId)!;
    mkdirSync(checkoutRequest().checkout!.path);
    terminal.labels = { ...terminal.labels, "cowboy.agent": "someone-else" };

    await expect(rt.host.release(ref, "worktree-association")).resolves.toBe(
      false,
    );
    expect(hc.terminals.has(ref.paneId)).toBe(true);
    expect(removeGitWorktreeMock).not.toHaveBeenCalled();
  });

  it("removes the placement's own checkout with it", async () => {
    const rt = runtime();
    const request = checkoutRequest();
    const ref = await rt.host.hostAt(request);
    const checkout = request.checkout!.path;
    mkdirSync(checkout);

    await expect(rt.host.release(ref, "worktree-association")).resolves.toBe(
      true,
    );
    expect(hc.terminals.has(ref.paneId)).toBe(false);
    expect(removeGitWorktreeMock).toHaveBeenCalledWith(
      hc.pi,
      "/repo",
      checkout,
    );
  });

  it("finds the checkout from the terminal's labels in a later session", async () => {
    const { ref } = await startedAgent();

    await expect(
      runtime().host.release(ref, "worktree-association"),
    ).resolves.toBe(true);
    expect(removeGitWorktreeMock).toHaveBeenCalledWith(
      hc.pi,
      "/repo",
      checkoutRequest().checkout!.path,
    );
  });

  it("keeps a checkout another live agent still works in", async () => {
    const { ref } = await startedAgent();
    hc.add({
      name: "cow-fix-login-01234567-2",
      cwd: checkoutRequest().checkout!.path,
      labels: { cowboy: "1", "cowboy.agent": "cow-fix-login-01234567-2" },
    });

    await expect(
      runtime().host.release(ref, "worktree-association"),
    ).resolves.toBe(false);
    expect(hc.terminals.has(ref.paneId)).toBe(true);
    expect(removeGitWorktreeMock).not.toHaveBeenCalled();
  });

  it("does not release a checkout it cannot attribute to the placement", async () => {
    const { ref, terminal } = await startedAgent();
    terminal.labels = { cowboy: "1", "cowboy.agent": "someone-else" };

    await expect(
      runtime().host.release(ref, "worktree-association"),
    ).resolves.toBe(false);
    expect(removeGitWorktreeMock).not.toHaveBeenCalled();
    expect(hc.hcCalls("kill")).toEqual([]);
  });

  it("answers false when git left the checkout behind", async () => {
    const { ref } = await startedAgent();
    mkdirSync(checkoutRequest().checkout!.path);
    removeGitWorktreeMock.mockResolvedValue(undefined);

    await expect(
      runtime().host.release(ref, "worktree-association"),
    ).resolves.toBe(false);
  });
});

describe("hc host lookups", () => {
  it("finds a task's live attempts by name or checkout folder", async () => {
    await startedAgent(checkoutRequest("cow-fix-login-01234567"));
    hc.add({
      name: "renamed",
      cwd: "/wt/cow-fix-login-89abcdef",
      labels: { cowboy: "1", "cowboy.agent": "renamed" },
    });
    hc.add({
      name: "cow-fix-login-11111111",
      state: "finished",
      labels: { cowboy: "1" },
    });
    hc.add({ name: "cow-fix-login-22222222" });

    await expect(runtime().host.findAttempts("fix-login")).resolves.toEqual([
      { name: "cow-fix-login-01234567-1" },
      { name: "cow-fix-login-89abcdef" },
    ]);
  });

  it("answers no attempts when hc cannot be read", async () => {
    const pi = {
      exec: async () => ({ code: 1, stdout: "", stderr: "down" }),
    };

    await expect(
      createHcRuntime(pi as never, FAST).host.findAttempts("x"),
    ).resolves.toEqual([]);
  });

  it("says whether a live agent is attached to a checkout", async () => {
    const { terminal } = await startedAgent();

    await expect(runtime().host.isAttached(terminal.cwd)).resolves.toBe(true);
    terminal.state = "finished";
    await expect(runtime().host.isAttached(terminal.cwd)).resolves.toBe(false);
  });

  it("lists placements and their checkouts, each its own space", async () => {
    const { ref, terminal } = await startedAgent();
    terminal.status = "working";
    const rt = runtime();

    await expect(rt.placements!.listPlacements()).resolves.toEqual([
      {
        name: ref.name,
        state: "working",
        workspaceId: ref.paneId,
        cwd: terminal.cwd,
        paneId: ref.paneId,
      },
    ]);
    await expect(rt.placements!.listWorktrees()).resolves.toEqual([
      {
        path: path.resolve(terminal.cwd),
        branch: "cow-fix-login-01234567",
        workspaceId: ref.paneId,
      },
    ]);
  });
});

describe("hc view.focus", () => {
  it("asks herdr-app to show the terminal", async () => {
    await runtime().view.focus({
      multiplexer: "herdr-core",
      name: "x",
      paneId: "t7",
      workspaceId: "t7",
      paneCreated: true,
    });

    expect(hc.calls.at(-1)).toEqual({
      cmd: "herdr-app",
      args: ["do", "agent.focus", "--terminal", "t7"],
    });
  });

  it("names a failure to show it", async () => {
    hc.other = () => ({ code: 1, stdout: "", stderr: "no window" });

    await expect(
      runtime().view.focus({
        multiplexer: "herdr-core",
        name: "x",
        paneId: "t7",
        workspaceId: "t7",
        paneCreated: true,
      }),
    ).rejects.toThrow(/could not show terminal t7: no window/);
  });
});
