/** result-file-permissions.test.ts — owner-only modes, including on paths that already exist, plus failure propagation. Real fs, temp dirs. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureResultDir,
  RESULT_DIR_MODE,
  RESULT_FILE_MODE,
  writeResultFile,
} from "../src/agents/result-file-permissions.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe("ensureResultDir", () => {
  it("creates a missing directory with mode 0o700", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-perms-"));
    const dir = path.join(tmpDir, "nested", "agent-id");

    ensureResultDir(dir);

    expect(fs.existsSync(dir)).toBe(true);
    expect(modeOf(dir)).toBe(RESULT_DIR_MODE);
    expect(RESULT_DIR_MODE).toBe(0o700);
  });

  it("enforces 0o700 on a directory that already exists with loose modes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-perms-"));
    const dir = path.join(tmpDir, "agent-id");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);

    ensureResultDir(dir);

    expect(modeOf(dir)).toBe(0o700);
  });

  it("throws instead of proceeding when the directory cannot be created", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-perms-"));
    // A regular file blocks the directory path.
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "x");

    expect(() => ensureResultDir(path.join(blocker, "child"))).toThrow();
  });
});

describe("writeResultFile", () => {
  it("creates the file with mode 0o600", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-perms-"));
    const file = path.join(tmpDir, "system.md");

    writeResultFile(file, "secret prompt");

    expect(fs.readFileSync(file, "utf-8")).toBe("secret prompt");
    expect(modeOf(file)).toBe(RESULT_FILE_MODE);
    expect(RESULT_FILE_MODE).toBe(0o600);
  });

  it("enforces 0o600 on a file that already exists with loose modes", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-perms-"));
    const file = path.join(tmpDir, "prompt.md");
    fs.writeFileSync(file, "stale task");
    fs.chmodSync(file, 0o644);

    writeResultFile(file, "new task");

    expect(fs.readFileSync(file, "utf-8")).toBe("new task");
    expect(modeOf(file)).toBe(0o600);
  });

  it("throws instead of proceeding when the file cannot be written", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-perms-"));

    expect(() =>
      writeResultFile(path.join(tmpDir, "no-such-dir", "prompt.md"), "x"),
    ).toThrow();
  });
});
