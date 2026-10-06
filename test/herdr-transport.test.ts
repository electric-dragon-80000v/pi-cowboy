/**
 * herdr-transport.test.ts — Layer 1: the raw herdr CLI transport.
 *
 * Pins the wire format: `{ result }` unwrap, `{ error }` failure mapping, the
 * missing-envelope violation, and the inherited 60s default timeout.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HerdrError,
  HerdrTransport,
  herdrErrorCode,
  isAgentGoneError,
  isPaneGoneError,
  isTabGoneError,
  runHerdr,
  strField,
} from "../src/infrastructure/herdr/herdr-transport.js";
import { fail, mockPi, ok, recordingPi } from "./helpers/herdr-pi.js";

describe("HerdrTransport.call", () => {
  it("unwraps the result envelope and passes the timeout through", async () => {
    let seenOpts: unknown;
    const pi = {
      exec: async (_cmd: string, _args: string[], opts?: unknown) => {
        seenOpts = opts;
        return ok({ pane: { workspace_id: "w1" } });
      },
    } as unknown as ExtensionAPI;

    const transport = new HerdrTransport(pi);
    await expect(
      transport.call(["pane", "current", "--current"], { timeoutMs: 1_234 }),
    ).resolves.toEqual({ pane: { workspace_id: "w1" } });
    expect(seenOpts).toEqual({ timeout: 1_234 });
  });

  it("defaults the CLI timeout to 60s", async () => {
    const { pi, calls } = recordingPi([ok({})]);
    await new HerdrTransport(pi).call(["agent", "list"]);
    expect(calls).toEqual([
      { cmd: "herdr", args: ["agent", "list"], opts: { timeout: 60_000 } },
    ]);
  });

  it("throws HerdrError with herdr's code and human message on exit 1", async () => {
    const pi = mockPi(() => fail("agent_not_found", "no such agent"));
    const err = await new HerdrTransport(pi)
      .call(["agent", "get", "p1"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).code).toBe("agent_not_found");
    expect((err as HerdrError).message).toBe("no such agent");
    expect((err as HerdrError).name).toBe("HerdrError");
  });

  it("names the command and quotes the text when the failure carries no envelope", async () => {
    const pi = mockPi(() => ({ code: 1, stdout: "", stderr: "herdr is down" }));
    const err = await new HerdrTransport(pi)
      .call(["agent", "list"])
      .catch((e: unknown) => e);
    expect((err as HerdrError).message).toBe(
      "herdr agent list exited 1: herdr is down",
    );
    expect((err as HerdrError).code).toBeUndefined();
  });

  it("states the invocation and exit code when the failure printed nothing", async () => {
    const pi = mockPi(() => ({ code: 3, stdout: "", stderr: "" }));
    const err = await new HerdrTransport(pi)
      .call(["worktree", "add", "/tmp/wt"])
      .catch((e: unknown) => e);
    expect((err as HerdrError).message).toBe(
      "herdr worktree add /tmp/wt exited 3 without printing anything",
    );
    expect((err as HerdrError).code).toBeUndefined();
  });

  it("does not invent a message for an envelope that carried none", async () => {
    const pi = mockPi(() => ({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "agent_not_ready" } }),
    }));
    const err = await new HerdrTransport(pi)
      .call(["agent", "get", "p1"])
      .catch((e: unknown) => e);
    expect((err as HerdrError).message).toBe("herdr reported agent_not_ready");
    expect((err as HerdrError).code).toBe("agent_not_ready");
  });

  it("returns undefined for an empty stdout envelope", async () => {
    const pi = mockPi(() => ({ code: 0, stdout: "", stderr: "" }));
    await expect(
      new HerdrTransport(pi).call(["pane", "close", "p1"]),
    ).resolves.toBeUndefined();
  });

  it("throws HerdrError when a successful command prints no JSON envelope", async () => {
    const pi = mockPi(() => ({
      code: 0,
      stdout: "not json at all",
      stderr: "",
    }));
    const err = await new HerdrTransport(pi)
      .call(["worktree", "list"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect((err as HerdrError).message).toContain("worktree list");
    expect((err as HerdrError).message).toContain("not json at all");
  });
});

describe("herdr not-found classification", () => {
  it("takes herdr's not-found codes as the target being gone", () => {
    expect(
      isPaneGoneError(new HerdrError("pane w1:p1 not found", "pane_not_found")),
    ).toBe(true);
    expect(
      isAgentGoneError(new HerdrError("agent target gone", "agent_not_found")),
    ).toBe(true);
    expect(
      isAgentGoneError(
        new HerdrError("agent target gone", "agent_name_not_found"),
      ),
    ).toBe(true);
    expect(
      isTabGoneError(new HerdrError("tab w1:t1 not found", "tab_not_found")),
    ).toBe(true);
  });

  it("keeps every other failure out of the gone case", () => {
    expect(isPaneGoneError(new HerdrError("boom", "server_error"))).toBe(false);
    expect(isPaneGoneError(new HerdrError("exited 1", undefined))).toBe(false);
    expect(isAgentGoneError(new Error("CLI timed out"))).toBe(false);
    expect(isAgentGoneError(undefined)).toBe(false);
    expect(isAgentGoneError(new HerdrError("boom", "pane_not_found"))).toBe(
      false,
    );
    expect(isTabGoneError(new HerdrError("boom", "pane_not_found"))).toBe(
      false,
    );
  });

  it("classifies the envelope the transport throws", async () => {
    const pi = mockPi(() => fail("pane_not_found", "pane w1:p1 not found"));
    const err = await new HerdrTransport(pi)
      .call(["pane", "close", "w1:p1"])
      .catch((e: unknown) => e);
    expect(isPaneGoneError(err)).toBe(true);
  });

  it("reports the herdr code, and nothing when herdr never answered", () => {
    expect(herdrErrorCode(new HerdrError("boom", "server_error"))).toBe(
      "server_error",
    );
    expect(
      herdrErrorCode(new HerdrError("exited 1", undefined)),
    ).toBeUndefined();
    expect(herdrErrorCode(new Error("CLI timed out"))).toBeUndefined();
  });
});

describe("strField", () => {
  it("narrows non-empty string fields and rejects everything else", () => {
    expect(strField({ a: "x" }, "a")).toBe("x");
    expect(strField({ a: "" }, "a")).toBeUndefined();
    expect(strField({ a: 3 }, "a")).toBeUndefined();
    expect(strField({}, "a")).toBeUndefined();
    expect(strField(undefined, "a")).toBeUndefined();
    expect(strField("x", "a")).toBeUndefined();
  });
});

describe("legacy runHerdr", () => {
  it("delegates to the transport, including the timeout", async () => {
    const { pi, calls } = recordingPi([ok({ worktrees: [] })]);
    await expect(
      runHerdr(pi, ["worktree", "list"], { timeoutMs: 5_000 }),
    ).resolves.toEqual({ worktrees: [] });
    expect(calls).toEqual([
      {
        cmd: "herdr",
        args: ["worktree", "list"],
        opts: { timeout: 5_000 },
      },
    ]);
  });

  it("propagates the transport's HerdrError", async () => {
    const pi = mockPi(() => fail("agent_not_ready", "startup timed out"));
    await expect(runHerdr(pi, ["agent", "start", "x"])).rejects.toMatchObject({
      name: "HerdrError",
      code: "agent_not_ready",
      message: "startup timed out",
    });
  });
});
