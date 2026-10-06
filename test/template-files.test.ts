/** template-files.test.ts — The generic `.toml` template helpers. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  compactDefined,
  describeParseError,
  parseTemplateToml,
  scanTemplateFilesInDir,
} from "../src/templates/template-files.js";

describe("parseTemplateToml", () => {
  it("reads TOML into an untrusted value", () => {
    expect(
      parseTemplateToml('name = "x"\ntools = ["read"]\nhidden = true'),
    ).toEqual({ name: "x", tools: ["read"], hidden: true });
  });

  it("throws on malformed TOML", () => {
    expect(() => parseTemplateToml("nope = ")).toThrow(/Invalid TOML document/);
  });
});

describe("compactDefined", () => {
  it("compacts undefined keys so a spread only overrides set fields", () => {
    expect(compactDefined({ a: 1, b: undefined, c: "" })).toEqual({
      a: 1,
      c: "",
    });
  });
});

describe("describeParseError", () => {
  it("collapses multi-line parse errors to one line", () => {
    expect(describeParseError(new Error("bad:\n  line 1\n  line 2"))).toBe(
      "bad: line 1 line 2",
    );
    expect(describeParseError("plain")).toBe("plain");
  });

  it("keeps a TOML error's message and position, dropping the code frame", () => {
    const err = (() => {
      try {
        parseTemplateToml('name = "x"\nnope = ');
      } catch (caught) {
        return caught;
      }
      throw new Error("expected a parse error");
    })();

    expect(describeParseError(err)).toBe(
      "Invalid TOML document: incomplete declaration: value expected (line 2, column 8)",
    );
  });

  it("names the failing path and issue of a ZodError", () => {
    const schema = z.strictObject({
      name: z.string(),
      cues: z.strictObject({ spawned: z.string() }),
    });
    const err = (() => {
      try {
        schema.parse({ name: "x", cues: { spawned: 5 } });
      } catch (caught) {
        return caught;
      }
      throw new Error("expected a shape error");
    })();

    expect(describeParseError(err)).toBe(
      "cues.spawned: Invalid input: expected string, received number",
    );
  });

  it("names an unrecognized key without a path prefix", () => {
    const err = (() => {
      try {
        z.strictObject({ name: z.string() }).parse({ name: "x", nope: 1 });
      } catch (caught) {
        return caught;
      }
      throw new Error("expected an unknown-key error");
    })();

    expect(describeParseError(err)).toBe('Unrecognized key: "nope"');
  });
});

describe("scanTemplateFilesInDir", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function scanDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cowboy-tpl-"));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  /** Toy parse: `name = "<x>"`, throws on `boom`. */
  function toyParse(content: string): { id: string } {
    if (content.includes("boom")) throw new Error("kaboom\n  at line 1");
    const id = /name = "(\S+)"/.exec(content)?.[1] ?? "";
    return { id };
  }

  const getName = (parsed: { id: string }) => parsed.id;

  it("returns [] for a directory that does not exist", async () => {
    const missing = path.join(os.tmpdir(), "pi-cowboy-does-not-exist-xyz");
    await expect(
      scanTemplateFilesInDir(missing, toyParse, getName),
    ).resolves.toEqual([]);
  });

  it("keeps named parses, skips unnamed ones silently, ignores non-.toml", async () => {
    const dir = scanDir({
      "a.toml": 'name = "alpha"',
      "nameless.toml": "nothing",
      "notes.md": 'name = "text"',
    });
    const notify = vi.fn();

    const found = await scanTemplateFilesInDir(dir, toyParse, getName, notify);

    expect(found).toEqual([{ id: "alpha" }]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns once, one line, when a file fails to parse", async () => {
    const dir = scanDir({
      "bad.toml": 'name = "bad"\nboom',
      "fine.toml": 'name = "fine"',
    });
    const notify = vi.fn();

    const found = await scanTemplateFilesInDir(dir, toyParse, getName, notify, {
      label: "Thing",
      problem: "was skipped",
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, kind] = notify.mock.calls[0];
    expect(kind).toBe("warning");
    expect(message).toBe(
      `[cowboy] Thing file ${path.join(dir, "bad.toml")} was skipped: kaboom at line 1`,
    );
    expect(found.map((t) => t.id)).toEqual(["fine"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "stays silent for an unreadable file",
    async () => {
      const dir = scanDir({ "locked.toml": 'name = "locked"' });
      fs.chmodSync(path.join(dir, "locked.toml"), 0o000);
      const notify = vi.fn();

      const found = await scanTemplateFilesInDir(
        dir,
        toyParse,
        getName,
        notify,
      );

      expect(notify).not.toHaveBeenCalled();
      expect(found).toEqual([]);
    },
  );
});
