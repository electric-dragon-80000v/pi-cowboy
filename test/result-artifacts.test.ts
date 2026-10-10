import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeResultArtifacts } from "../src/subagent/result-artifacts.js";

/** Directories this file made; removed after every test, pass or fail. */
const madeDirs: string[] = [];

afterEach(() => {
  for (const dir of madeDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A result-file path under a fresh temp directory. */
function makeResultFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cowboy-result-artifacts-"));
  madeDirs.push(dir);
  return join(dir, "result.md");
}

describe("removeResultArtifacts", () => {
  it("removes the agent's result directory", () => {
    const resultFile = makeResultFile();
    writeFileSync(join(dirname(resultFile), "prompt.md"), "task");
    expect(existsSync(dirname(resultFile))).toBe(true);

    removeResultArtifacts(resultFile);
    expect(existsSync(dirname(resultFile))).toBe(false);
  });

  it("is idempotent and never throws when already gone", () => {
    const resultFile = makeResultFile();
    removeResultArtifacts(resultFile);
    removeResultArtifacts(resultFile);
  });
});
