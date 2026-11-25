import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openableResultFile } from "../src/agents/result-file-open.js";

/** Directories this file made; removed after every test, pass or fail. */
const madeDirs: string[] = [];

afterEach(() => {
  for (const dir of madeDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A directory under a fresh temp root. */
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cowboy-result-file-open-"));
  madeDirs.push(dir);
  return dir;
}

describe("openableResultFile", () => {
  it("offers a non-empty result file on macOS", () => {
    const resultFile = join(makeDir(), "result.md");
    writeFileSync(resultFile, "# Final answer\n");

    expect(openableResultFile(resultFile, "darwin")).toBe(resultFile);
  });

  it("offers nothing on a platform without `open`", () => {
    const resultFile = join(makeDir(), "result.md");
    writeFileSync(resultFile, "# Final answer\n");

    expect(openableResultFile(resultFile, "linux")).toBeUndefined();
    expect(openableResultFile(resultFile, "win32")).toBeUndefined();
  });

  it("offers nothing for an absent file", () => {
    const resultFile = join(makeDir(), "result.md");

    expect(openableResultFile(resultFile, "darwin")).toBeUndefined();
  });

  it("offers nothing for an empty report", () => {
    const resultFile = join(makeDir(), "result.md");
    writeFileSync(resultFile, "");

    expect(openableResultFile(resultFile, "darwin")).toBeUndefined();
  });

  it("offers nothing for a directory at the result path", () => {
    const resultFile = join(makeDir(), "result.md");
    mkdirSync(resultFile);

    expect(openableResultFile(resultFile, "darwin")).toBeUndefined();
  });
});
