import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DeliverableSource,
  FileDeliverable,
} from "../src/subagent/deliverable.js";

/** Directories this file made; removed after every test, pass or fail. */
const madeDirs: string[] = [];

afterEach(() => {
  for (const dir of madeDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp directory this file will remove. */
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cowboy-deliverable-"));
  madeDirs.push(dir);
  return dir;
}

/** A result-file path under a fresh temp directory. */
function makeResultFile(): string {
  return join(makeTmpDir(), "result.md");
}

describe("FileDeliverable", () => {
  it("implements the DeliverableSource contract over its result file", () => {
    // Compile-time conformance: assignability to the port type.
    const deliverable: DeliverableSource = new FileDeliverable(
      makeResultFile(),
    );
    expect(typeof deliverable.readDeliverable).toBe("function");
  });

  describe("readDeliverable", () => {
    it("returns the report content with its write stamp when the result file is present", async () => {
      const resultFile = makeResultFile();
      const deliverable = new FileDeliverable(resultFile);
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, "# Final answer\n\nall done\n");

      expect(await deliverable.readDeliverable()).toEqual({
        content: "# Final answer\n\nall done",
        mtime: expect.any(Number),
      });
    });

    it("stamps a rewrite of the same words newer than the report it replaced", async () => {
      const resultFile = makeResultFile();
      const deliverable = new FileDeliverable(resultFile);
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, "same words");
      const first = await deliverable.readDeliverable();

      const later = new Date(first!.mtime + 1_000);
      utimesSync(resultFile, later, later);
      const second = await deliverable.readDeliverable();

      expect(second!.content).toBe(first!.content);
      expect(second!.mtime).toBeGreaterThan(first!.mtime);
    });

    it("returns null when the result file is absent", async () => {
      const deliverable = new FileDeliverable(makeResultFile());
      expect(await deliverable.readDeliverable()).toBeNull();
    });

    it("returns null for a whitespace-only result file", async () => {
      const resultFile = makeResultFile();
      const deliverable = new FileDeliverable(resultFile);
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, "   \n\t ");

      expect(await deliverable.readDeliverable()).toBeNull();
    });

    it("returns null when the result file is unreadable", async () => {
      // resultFile under a path whose parent is a regular file → ENOTDIR.
      const block = join(makeTmpDir(), "not-a-dir");
      writeFileSync(block, "x");
      const deliverable = new FileDeliverable(join(block, "result.md"));
      expect(await deliverable.readDeliverable()).toBeNull();
    });
  });
});
