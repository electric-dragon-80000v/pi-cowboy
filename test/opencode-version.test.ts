/**
 * opencode-version.test.ts — the installed binary's version read, against real
 * executables on a PATH this file owns.
 *
 * The harness's availability is a version judgment, so the read is what decides
 * whether opencode is on offer at all. PATH is replaced wholesale per case, so
 * the answer never depends on the machine running the suite.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSupportedOpencodeVersion,
  parseOpencodeVersion,
  probeOpencode,
} from "../src/agents/harness/opencode/version.js";

const realPath = process.env.PATH;
const tmpDirs: string[] = [];

/** A directory that becomes the whole PATH, so only what it holds is found. */
function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-version-"));
  tmpDirs.push(dir);
  process.env.PATH = dir;
  return dir;
}

/** A runnable `opencode` that prints `stdout` when it is run. */
function opencode(dir: string, stdout: string): void {
  const file = join(dir, "opencode");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, {
    mode: 0o755,
  });
  chmodSync(file, 0o755);
}

afterEach(() => {
  process.env.PATH = realPath;
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseOpencodeVersion", () => {
  it("reads the version out of the line the CLI prints", () => {
    expect(parseOpencodeVersion("opencode v2.0.28\n")).toBe("2.0.28");
  });

  it("reads nothing else", () => {
    expect(parseOpencodeVersion("")).toBeUndefined();
    expect(parseOpencodeVersion("2.0.28")).toBeUndefined();
    expect(parseOpencodeVersion("opencode v2\n")).toBeUndefined();
    expect(parseOpencodeVersion("opencode 2.0.28")).toBeUndefined();
  });
});

describe("isSupportedOpencodeVersion", () => {
  it("takes the major this harness builds argv against", () => {
    expect(isSupportedOpencodeVersion("2.0.0")).toBe(true);
    expect(isSupportedOpencodeVersion("2.0.28")).toBe(true);
  });

  it("refuses every other major, including one that merely starts with a two", () => {
    expect(isSupportedOpencodeVersion("1.19.0")).toBe(false);
    expect(isSupportedOpencodeVersion("3.0.0")).toBe(false);
    expect(isSupportedOpencodeVersion("20.0.0")).toBe(false);
  });
});

describe("probeOpencode", () => {
  it("is absent without the binary", () => {
    freshPath();

    expect(probeOpencode()).toEqual({ kind: "absent" });
  });

  it("is supported when the binary reports the major this harness speaks", () => {
    opencode(freshPath(), "opencode v2.0.28");

    expect(probeOpencode()).toEqual({ kind: "supported", version: "2.0.28" });
  });

  it("is unsupported, with the version, when the binary reports another major", () => {
    opencode(freshPath(), "opencode v1.19.0");

    expect(probeOpencode()).toEqual({
      kind: "unsupported",
      version: "1.19.0",
    });
  });

  it("is unreadable when the binary says nothing this can read", () => {
    opencode(freshPath(), "whatever this is");

    expect(probeOpencode()).toEqual({ kind: "unreadable" });
  });
});
