/**
 * cow-clone.test.ts — the Node materialization orchestrator's own logic: entry
 * planning, the wipe, the probe's ordering, and failure reporting. The clone
 * itself runs in the integration sibling; here it is a fake, so nothing needs
 * python3.
 */

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CowCloneError,
  containsPath,
  defaultCowCloneDeps,
  materializeCowClone,
  missingCloneProgramReport,
  missingClonePrograms,
  type CloneEntry,
  type CowCloneDeps,
} from "../src/infrastructure/git/cow-clone.js";

const tmpDirs: string[] = [];

function freshTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cow-clone-unit-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The real directory listing, a silent probe, and a recording clone. */
function fakeDeps(over: Partial<CowCloneDeps> = {}): CowCloneDeps & {
  readonly calls: string[];
  readonly cloned: CloneEntry[];
} {
  const calls: string[] = [];
  const cloned: CloneEntry[] = [];
  return {
    calls,
    cloned,
    mechanism: "clonefile",
    list: (dir) => readdir(dir, { withFileTypes: true }),
    probe: async () => {
      calls.push("probe");
    },
    cloneEntry: async (src, dst) => {
      calls.push(`clone ${basename(src)}`);
      cloned.push({ src, dst });
    },
    ...over,
  };
}

describe("containsPath", () => {
  it("is true for the path itself and for anything inside it", () => {
    expect(containsPath("/a/b", "/a/b")).toBe(true);
    expect(containsPath("/a/b", "/a/b/c")).toBe(true);
  });

  it("is false for a parent, a sibling and a name that merely shares a prefix", () => {
    expect(containsPath("/a/b/c", "/a/b")).toBe(false);
    expect(containsPath("/a/b", "/a/c")).toBe(false);
    expect(containsPath("/a/b", "/a/bc")).toBe(false);
  });
});

describe("materializeCowClone", () => {
  it("wipes every worktree entry but .git, and never clones the worktree into itself", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(main, "holder", "wt");
    await mkdir(join(main, "holder"), { recursive: true });
    await writeFile(join(main, "tracked.txt"), "tracked\n");
    await writeFile(join(main, "holder", "sibling.txt"), "sibling\n");
    await mkdir(wt);
    await writeFile(join(wt, ".git"), "gitdir: elsewhere\n");
    await writeFile(join(wt, "stale.txt"), "stale\n");
    await mkdir(join(wt, "stale-dir"));
    await writeFile(join(wt, "stale-dir", "left.txt"), "left\n");

    const deps = fakeDeps();
    const result = await materializeCowClone(
      { wtPath: wt, mainRoot: main },
      { kind: "all" },
      deps,
    );

    expect(result.mechanism).toBe("clonefile");
    expect(deps.calls).toEqual(["probe", "clone tracked.txt"]);
    // .git survives the wipe; the stale entries do not.
    expect(readdirSync(wt)).toEqual([".git"]);
    // "holder" contains the worktree, so it is not a clone source.
    expect(deps.cloned).toEqual([
      { src: join(main, "tracked.txt"), dst: join(wt, "tracked.txt") },
    ]);
  });

  it("wipes every entry of the worktree, symlinks included, and leaves what they point at untouched", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(t, "wt");
    const outside = join(t, "outside");
    await mkdir(join(outside, "sub"), { recursive: true });
    await writeFile(join(outside, "keep.txt"), "keep\n");
    await writeFile(join(outside, "sub", "deep.txt"), "deep\n");
    await mkdir(join(main, ".git"), { recursive: true });
    await writeFile(join(main, "tracked.txt"), "tracked\n");
    await mkdir(join(wt, "nested"), { recursive: true });
    await writeFile(join(wt, ".git"), "gitdir: elsewhere\n");
    await writeFile(join(wt, "nested", "stale.txt"), "stale\n");
    // A link out of the worktree, one to its own parent, one to the main
    // checkout, and a pair pointing at each other.
    symlinkSync(outside, join(wt, "link-out"));
    symlinkSync(join("..", ".."), join(wt, "nested", "link-up"));
    symlinkSync(main, join(wt, "nested", "link-main"));
    symlinkSync("loop-b", join(wt, "loop-a"));
    symlinkSync("loop-a", join(wt, "loop-b"));

    const deps = fakeDeps();
    await materializeCowClone(
      { wtPath: wt, mainRoot: main },
      { kind: "all" },
      deps,
    );

    // The links are gone with the rest of the old tree, and the clone list is
    // still the main checkout's.
    expect(readdirSync(wt)).toEqual([".git"]);
    expect(deps.cloned).toEqual([
      { src: join(main, "tracked.txt"), dst: join(wt, "tracked.txt") },
    ]);
    // Nothing the links named was read or removed.
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(outside, "sub", "deep.txt"), "utf8")).toBe(
      "deep\n",
    );
    expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(readdirSync(t).sort()).toEqual(["main", "outside", "wt"]);
  });

  it("refuses a worktree that is a symlink to the main checkout", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    await mkdir(join(main, ".git"), { recursive: true });
    await writeFile(join(main, "tracked.txt"), "tracked\n");
    symlinkSync(main, join(t, "wt"));

    const deps = fakeDeps();
    const error = await materializeCowClone(
      { wtPath: join(t, "wt"), mainRoot: main },
      { kind: "all" },
      deps,
    ).catch((err: unknown) => err);

    expect((error as CowCloneError).reason).toBe("setup");
    expect((error as CowCloneError).message).toMatch(
      /the worktree is the main checkout/,
    );
    expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(deps.cloned).toEqual([]);
  });

  it("refuses a worktree that reaches the main checkout's parent through a symlink", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    await mkdir(join(main, ".git"), { recursive: true });
    await writeFile(join(main, "tracked.txt"), "tracked\n");
    symlinkSync(t, join(t, "wt"));

    const error = await materializeCowClone(
      { wtPath: join(t, "wt"), mainRoot: main },
      { kind: "all" },
      fakeDeps(),
    ).catch((err: unknown) => err);

    expect((error as CowCloneError).reason).toBe("setup");
    expect((error as CowCloneError).message).toMatch(
      /the worktree contains the main checkout/,
    );
    expect(readFileSync(join(main, "tracked.txt"), "utf8")).toBe("tracked\n");
    expect(existsSync(join(t, "wt"))).toBe(true);
    expect(lstatSync(join(t, "wt")).isSymbolicLink()).toBe(true);
  });

  it("refuses a probe path that is a symlink, before writing through it", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const t = freshTmp();
    const wt = join(t, "wt");
    const target = join(t, "target");
    await mkdir(wt);
    await mkdir(target);
    symlinkSync(target, join(wt, `.cow-probe-${process.pid}`));

    const deps = defaultCowCloneDeps(() => {
      throw new Error("the probe must not shell out");
    });

    await expect(deps.probe(wt)).rejects.toThrow(/not a directory/);
    expect(readdirSync(target)).toEqual([]);
  });

  it("clones on Linux through `cp --reflink=always -R`, which puts FICLONE on every file", async () => {
    if (process.platform !== "linux") return;
    const t = freshTmp();
    const calls: string[][] = [];
    const deps = defaultCowCloneDeps(async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", killed: false };
    });

    await deps.cloneEntry(join(t, "src"), join(t, "dst"));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["-P", "--reflink=always", "-R"]),
    );
  });

  it("probes on Linux through the same primitive the entries clone with", async () => {
    if (process.platform !== "linux") return;
    const t = freshTmp();
    const wt = join(t, "wt");
    await mkdir(wt);
    const calls: string[][] = [];
    const deps = defaultCowCloneDeps(async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "", killed: false };
    });

    await deps.probe(wt);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["--reflink=always"]));
    expect(existsSync(join(wt, `.cow-probe-${process.pid}`))).toBe(false);
  });

  it("reports a Linux volume that cannot clone as unsupported, from the probe", async () => {
    if (process.platform !== "linux") return;
    const t = freshTmp();
    const wt = join(t, "wt");
    await mkdir(wt);
    const deps = defaultCowCloneDeps(async () => ({
      code: 1,
      stdout: "",
      stderr: "cp: failed to clone: Not supported",
      killed: false,
    }));

    await expect(deps.probe(wt)).rejects.toThrow(
      /copy-on-write is not supported on the worktree volume/,
    );
  });

  it("seeds only existing paths, builds their parent directories, and wipes nothing", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(main, ".store", "wt");
    await mkdir(join(main, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(main, "node_modules", "pkg", "index.js"), "x\n");
    await writeFile(join(main, ".env"), "SECRET=1\n");
    await mkdir(join(main, ".store", "nested"), { recursive: true });
    await writeFile(join(main, ".store", "nested", "held.txt"), "held\n");
    await mkdir(join(main, "dist", "cache"), { recursive: true });
    await writeFile(join(main, "dist", "cache", "x"), "cached\n");
    await mkdir(join(main, ".git"));
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, "keep.txt"), "keep\n");

    const deps = fakeDeps();
    const result = await materializeCowClone(
      { wtPath: wt, mainRoot: main },
      {
        kind: "seed",
        rels: [
          "node_modules",
          ".env",
          "dist/cache/",
          ".store",
          "/",
          ".git",
          ".git/config",
          "missing",
          "",
        ],
      },
      deps,
    );

    expect(result.mechanism).toBe("clonefile");
    expect(deps.cloned).toEqual([
      { src: join(main, "node_modules"), dst: join(wt, "node_modules") },
      { src: join(main, ".env"), dst: join(wt, ".env") },
      {
        src: join(main, "dist", "cache"),
        dst: join(wt, "dist", "cache"),
      },
    ]);
    // ".store" holds the worktree, so seeding it would clone the worktree into
    // itself; it is skipped entirely.
    // A trailing separator is a directory reporting convention, not part of the
    // path: the clone destination must not carry one.
    expect(deps.cloned.every((entry) => !entry.dst.endsWith("/"))).toBe(true);
    // A nested seed path gets its parent chain before the clone runs (the path
    // itself is the clone's to create); the top-level ones only need the worktree
    // root, which already exists.
    expect(existsSync(join(wt, "dist"))).toBe(true);
    expect(readdirSync(wt).sort()).toEqual(["dist", "keep.txt"]);
  });

  it("probes the volume before wiping anything, and leaves the worktree alone when it fails", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(t, "wt");
    await mkdir(main);
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, "keep.txt"), "keep\n");

    const deps = fakeDeps({
      probe: async () => {
        throw new CowCloneError("unsupported", "no clone support here");
      },
    });

    await expect(
      materializeCowClone(
        { wtPath: wt, mainRoot: main },
        { kind: "all" },
        deps,
      ),
    ).rejects.toThrow(/no clone support here/);
    expect(readdirSync(wt)).toEqual(["keep.txt"]);
    expect(deps.cloned).toEqual([]);
  });

  it("reports per-entry failures, keeping the entries that did land", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(t, "wt");
    await mkdir(main);
    await mkdir(wt);
    await writeFile(join(main, "a.txt"), "a\n");
    await writeFile(join(main, "b.txt"), "b\n");

    const deps = fakeDeps({
      cloneEntry: async (src) => {
        if (src.endsWith("b.txt")) throw new Error("b.txt: no clone for you");
      },
    });

    const error = await materializeCowClone(
      { wtPath: wt, mainRoot: main },
      { kind: "all" },
      deps,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CowCloneError);
    expect((error as CowCloneError).reason).toBe("entry-failed");
    expect((error as CowCloneError).failures).toEqual([
      { path: join(main, "b.txt"), message: "b.txt: no clone for you" },
    ]);
  });

  it("lets a fatal clone reason through unchanged", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(t, "wt");
    await mkdir(main);
    await mkdir(wt);
    await writeFile(join(main, "x.txt"), "x\n");

    const deps = fakeDeps({
      cloneEntry: async () => {
        throw new CowCloneError("unsupported", "the volume lost clone support");
      },
    });

    await expect(
      materializeCowClone(
        { wtPath: wt, mainRoot: main },
        { kind: "all" },
        deps,
      ),
    ).rejects.toThrow(/lost clone support/);
  });

  it("reports an empty plan as empty", async () => {
    const t = freshTmp();
    const main = join(t, "main");
    const wt = join(t, "wt");
    await mkdir(main);
    await mkdir(wt);

    const result = await materializeCowClone(
      { wtPath: wt, mainRoot: main },
      { kind: "seed", rels: [] },
      fakeDeps(),
    );

    expect(result.mechanism).toBe("empty");
  });

  it("refuses a worktree that contains the main checkout", async () => {
    const t = freshTmp();
    const wt = join(t, "wt");
    const main = join(wt, "main");
    await mkdir(main, { recursive: true });

    const error = await materializeCowClone(
      { wtPath: wt, mainRoot: main },
      { kind: "all" },
      fakeDeps(),
    ).catch((err: unknown) => err);

    expect((error as CowCloneError).reason).toBe("setup");
    expect((error as CowCloneError).message).toMatch(
      /contains the main checkout/,
    );
  });

  it("wraps an unreadable directory as a setup failure", async () => {
    const t = freshTmp();
    const error = await materializeCowClone(
      { wtPath: join(t, "wt"), mainRoot: join(t, "nope") },
      { kind: "all" },
      fakeDeps(),
    ).catch((err: unknown) => err);

    expect((error as CowCloneError).reason).toBe("setup");
    expect((error as CowCloneError).message).toMatch(/cannot read/);
  });
});

describe("missingClonePrograms", () => {
  const realPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = realPath;
  });

  it("needs python3 on macOS, and reports it with the fix", () => {
    process.env.PATH = "";
    expect(missingClonePrograms("darwin")).toEqual(["python3"]);

    const report = missingCloneProgramReport("darwin");
    expect(report).toMatch(/python3/);
    expect(report).toMatch(/xcode-select --install/);
    expect(report).toMatch(/macOS/);
    expect(report).toMatch(/stays inactive/);
  });

  it("needs nothing on Linux, where the clone runs through cp", () => {
    process.env.PATH = "";
    expect(missingClonePrograms("linux")).toEqual([]);
    expect(missingCloneProgramReport("linux")).toBeUndefined();
  });

  it("says nothing when the program is on PATH", () => {
    const t = freshTmp();
    const python = join(t, "python3");
    writeFileSync(python, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = t;

    expect(missingClonePrograms("darwin")).toEqual([]);
    expect(missingCloneProgramReport("darwin")).toBeUndefined();
  });

  it("treats a non-executable file as missing", () => {
    const t = freshTmp();
    writeFileSync(join(t, "python3"), "#!/bin/sh\n", { mode: 0o644 });
    process.env.PATH = t;

    expect(missingClonePrograms("darwin")).toEqual(["python3"]);
  });
});
