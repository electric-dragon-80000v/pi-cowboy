/**
 * git-merger.test.ts — git option injection in the merge path
 * (src/infrastructure/git/git-merger.ts).
 *
 * The ref validator is pure and tested directly; `--` hardening is tested through
 * `BranchMerger.merge` against a scripted runner (real-repository guardrails live
 * in git-merger.integration.test.ts).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertValidBranchRef,
  BranchMerger,
  BranchRefSchema,
} from "../../src/infrastructure/git/git-merger.js";
import type {
  GitCommandRunner,
  GitRunResult,
} from "../../src/infrastructure/git/git-runner.js";
import { cleanupTmpDirs, freshTmp } from "../helpers/git-repo.js";

afterEach(cleanupTmpDirs);

/** The schema's refusal clause for `ref`, or `undefined` when accepted. */
function refusalOf(ref: string): string | undefined {
  const parsed = BranchRefSchema.safeParse(ref);
  if (parsed.success) return undefined;
  return parsed.error.issues.map((issue) => issue.message).join("; ");
}

describe("BranchRefSchema", () => {
  it.each(["cow-fix-login-abc12345", "main", "feature/x", "a-b", "v1.2.3"])(
    "accepts %j",
    (ref) => {
      expect(refusalOf(ref)).toBeUndefined();
    },
  );

  it.each([
    ["", /is empty/],
    ["--upload-pack=x", /starts with "-"/],
    ["-D", /starts with "-"/],
    ["a..b", /contains "\.\."/],
    ["main@{1}", /contains "@\{"/],
  ])("rejects %j with a structured issue", (ref, clause) => {
    expect(refusalOf(ref)).toMatch(clause);
  });

  it("reports the earliest offense, not the last", () => {
    expect(refusalOf("--force..main")).toMatch(/starts with "-"/);
    expect(refusalOf("ab..c~d")).toMatch(/contains "\.\."/);
  });
});

describe("assertValidBranchRef", () => {
  it.each([
    ["cow-fix-login-abc12345", "branch" as const],
    ["main", "branch" as const],
    ["main", "target" as const],
    ["feature/x", "branch" as const],
    ["release-2.0_hotfix", "target" as const],
  ])("accepts %j as %s", (ref, role) => {
    expect(() => assertValidBranchRef(ref, role)).not.toThrow();
  });

  it.each([
    ["--upload-pack=x", "branch", /starts with "-"/],
    ["-D", "branch", /starts with "-"/],
    ["-D", "target", /starts with "-"/],
    ["a..b", "branch", /revision ranges/],
    ["HEAD..main", "target", /revision ranges/],
    ["a@{1}", "branch", /reflog/],
    ["main@{yesterday}", "target", /reflog/],
    ["", "branch", /empty/],
    ["", "target", /empty/],
    ["a b", "branch", /invalid character/],
    [" main ", "branch", /invalid character/],
    ["a\tb", "branch", /invalid character/],
    ["a\x01b", "branch", /U\+0001/],
    ["feature~1", "branch", /invalid character "~"/],
    ["feature^", "branch", /invalid character "\^"/],
    ["a:b", "branch", /invalid character ":"/],
    ["a*b", "branch", /invalid character "\*"/],
    ["@", "branch", /invalid character "@"/],
    ["a\\b", "branch", /invalid character/],
  ])("rejects %j as %s", (ref, role, message) => {
    expect(() => assertValidBranchRef(ref, role as "branch")).toThrow(message);
  });

  it("never coerces: surrounding whitespace is rejected, not trimmed", () => {
    expect(() => assertValidBranchRef(" main ", "target")).toThrow(
      /invalid character/,
    );
  });
});

/** Scripted runner: argv-based probe answers, records every invocation. */
class ScriptedRunner {
  readonly calls: string[][] = [];
  constructor(private readonly stubRoot: string) {}

  async probe(args: readonly string[]): Promise<string | undefined> {
    this.calls.push([...args]);
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return this.stubRoot;
    if (key === "rev-parse --git-common-dir") return ".git";
    if (key === "branch --show-current") return "main";
    if (key === "status --porcelain") return "";
    return undefined;
  }

  async test(): Promise<boolean> {
    this.calls.push(["test"]);
    return true;
  }

  async run(args: readonly string[]): Promise<GitRunResult | undefined> {
    this.calls.push([...args]);
    if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "merge")
      return { code: 0, stdout: "Fast-forward", stderr: "" };
    return undefined;
  }
}

function mergerWithStub(): { merger: BranchMerger; runner: ScriptedRunner } {
  const stubRoot = freshTmp();
  mkdirSync(join(stubRoot, ".git"), { recursive: true });
  const runner = new ScriptedRunner(stubRoot);
  const merger = new BranchMerger(runner as unknown as GitCommandRunner);
  return { merger, runner };
}

describe("BranchMerger.merge argv hardening", () => {
  it("rejects an option-like branch before running any git", async () => {
    const { merger, runner } = mergerWithStub();
    await expect(
      merger.merge({ cwd: "/repo", branch: "--upload-pack=x" }),
    ).rejects.toThrow(/starts with "-"/);
    expect(runner.calls).toEqual([]);
  });

  it("rejects an option-like target before running any git", async () => {
    const { merger, runner } = mergerWithStub();
    await expect(
      merger.merge({ cwd: "/repo", branch: "cow-ok-12345678", target: "-D" }),
    ).rejects.toThrow(/starts with "-"/);
    expect(runner.calls).toEqual([]);
  });

  it("rejects rev syntax in either ref before running any git", async () => {
    const { merger, runner } = mergerWithStub();
    await expect(
      merger.merge({ cwd: "/repo", branch: "a..b" }),
    ).rejects.toThrow(/revision ranges/);
    await expect(
      merger.merge({
        cwd: "/repo",
        branch: "cow-ok-12345678",
        target: "main@{1}",
      }),
    ).rejects.toThrow(/reflog/);
    expect(runner.calls).toEqual([]);
  });

  it("passes -- before ref operands to merge-base and merge", async () => {
    const { merger, runner } = mergerWithStub();
    const result = await merger.merge({
      cwd: "/repo",
      branch: "cow-ok-12345678",
    });
    expect(result).toMatchObject({ merged: true, target: "main" });
    expect(runner.calls).toContainEqual([
      "merge-base",
      "--is-ancestor",
      "--",
      "cow-ok-12345678",
      "HEAD",
    ]);
    expect(runner.calls).toContainEqual([
      "merge",
      "--no-edit",
      "--",
      "cow-ok-12345678",
    ]);
  });
});
