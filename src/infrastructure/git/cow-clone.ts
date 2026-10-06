/**
 * cow-clone.ts — materialize a worktree's working tree as a copy-on-write clone.
 *
 * Node owns the orchestration, and every filesystem call here is asynchronous:
 * a wipe or a seed never blocks the event loop.
 *
 * The clone is one clonefile(2) call per entry through a tiny embedded python3
 * snippet — Node cannot make that call directly: libuv writes
 * the bytes for COPYFILE_FICLONE (measured: 512 MB written for a 512 MB file on
 * APFS) and fails ENOSYS for the forced flag. Linux clones through the FICLONE
 * ioctl instead, and `cp --reflink=always` is what reaches it for a whole tree:
 * fs.cp honours COPYFILE_FICLONE_FORCE on the top-level target alone and copies
 * every nested file byte for byte (measured on ext4, btrfs and ZFS), so the
 * forced flag there guarantees nothing. `always` makes the copy fail rather than
 * degrade, which is what keeps a clone a clone.
 *
 * A clone never degrades into a byte copy: the probe runs before anything is
 * wiped, and a volume that cannot clone fails the clone instead of quietly
 * copying bytes. The caller then completes the checkout with git
 * (see git-materializer.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { commandPath, resolveCommand } from "../exec-path.js";

// --- The clone primitives ---

/**
 * Embedded clonefile(2) helper: paths as argv, program as `-c`
 * (`python3 -c <snippet> <src> <dst>`), exit 1 when the call fails.
 */
const CLONEFILE_SNIPPET = `import ctypes, sys
libc = ctypes.CDLL(None, use_errno=True)
# CLONE_NOFOLLOW = 0x01; clonefile clones whole directory trees on APFS.
if libc.clonefile(sys.argv[1].encode(), sys.argv[2].encode(), 0x01) != 0:
    sys.exit(1)
`;

/** Budget for one clone call. */
const COW_CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * Whole-tree clonefile pays off above ~1 MB: below that, starting python3 costs
 * more than cloning the tree per file.
 */
const BIG_DIRECTORY_KB = 1024;

/** Absolute paths to the helpers; a bare name costs ~50 ms per spawn here. */
interface CloneTools {
  readonly cp: string;
  readonly du: string;
  readonly python: string;
}

/**
 * Programs the platform's clone path cannot run without. A missing one is a
 * setup problem the user must fix, not a volume that cannot clone, so it is
 * named before the first worktree is created.
 */
const REQUIRED_CLONE_PROGRAMS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["python3"],
  linux: [],
};

/** What the user has to do about each missing program, per platform. */
const CLONE_PROGRAM_HINTS: Readonly<
  Record<string, Readonly<Record<string, string | undefined>>>
> = {
  darwin: {
    python3: "install the Xcode Command Line Tools: xcode-select --install",
  },
};

/** How a platform is named in a message; the raw name reads like a bug report. */
const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  darwin: "macOS",
  linux: "Linux",
};

/** Programs the platform's clone path needs that are not on PATH. */
export function missingClonePrograms(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const required = REQUIRED_CLONE_PROGRAMS[platform] ?? [];
  return required.filter((name) => commandPath(name) === undefined);
}

/**
 * Why clone-on-write cannot run on this machine, in one sentence the user can
 * act on, or undefined when every program is present.
 */
export function missingCloneProgramReport(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const missing = missingClonePrograms(platform);
  if (missing.length === 0) return undefined;
  const label = PLATFORM_LABELS[platform] ?? platform;
  const named = missing
    .map((name) => {
      const hint = CLONE_PROGRAM_HINTS[platform]?.[name];
      return hint === undefined ? name : `${name}: ${hint}`;
    })
    .join(", ");
  return `Copy-on-write worktrees need ${named}, which ${missing.length === 1 ? "is" : "are"} not on PATH on ${label}. pi-cowboy stays inactive in this session. Install ${missing.length === 1 ? "it" : "them"} and start a new session.`;
}

// --- Types ---

/** One path to clone. The destination must not exist yet. */
export interface CloneEntry {
  readonly src: string;
  readonly dst: string;
}

/** The primitive the platform clones with; diagnostics only. */
type CowCloneMechanism = "clonefile" | "reflink" | "empty";

/** One entry that could not be cloned. */
interface CloneFailure {
  readonly path: string;
  readonly message: string;
}

/** How the worktree's working tree is populated. */
export type CowCloneMode =
  | { readonly kind: "all" }
  | { readonly kind: "seed"; readonly rels: readonly string[] };

interface CowCloneRequest {
  readonly wtPath: string;
  readonly mainRoot: string;
}

interface CowCloneResult {
  readonly mechanism: CowCloneMechanism;
}

/**
 * Why materialization failed. Fatal reasons are distinguished from per-entry
 * failures, so the caller can tell "this volume cannot clone" from "one entry in
 * this tree could not be cloned".
 */
type CowCloneReason =
  "unsupported" | "entry-failed" | "setup" | "timeout" | "launch";

export class CowCloneError extends Error {
  constructor(
    readonly reason: CowCloneReason,
    message: string,
    readonly failures: readonly CloneFailure[] = [],
  ) {
    super(message);
    this.name = "CowCloneError";
  }
}

/** The four fields of a `pi.exec` result this module reads. */
interface ExecResultLike {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the child was killed by the timeout or an abort. */
  readonly killed: boolean;
}

/**
 * The slice of `pi.exec` this module needs, structurally: every command goes
 * through the extension's one shelling-out seam, so children inherit the parent
 * pane's environment and the same timeout and abort protocol. The raw result is
 * required — not the git runner's `helper`, which drops `killed` and would make a
 * killed clone look like a successful one.
 */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { readonly cwd?: string; readonly timeout?: number },
) => Promise<ExecResultLike>;

/** Injected seams; the defaults are this platform's primitives and the real fs. */
export interface CowCloneDeps {
  /** The primitive the platform clones with. */
  readonly mechanism: CowCloneMechanism;
  /**
   * Entries in a directory, `.`/`..` excluded. The entry carries the type the
   * listing reported, so a caller never has to follow a name to classify it —
   * a symlink is known to be a link without being resolved.
   */
  readonly list: (dir: string) => Promise<readonly fs.Dirent[]>;
  /** Prove copy-on-write works on the destination volume before anything moves. */
  readonly probe: (wt: string) => Promise<void>;
  /** Clone one entry; a failure means that entry did not land. */
  readonly cloneEntry: (src: string, dst: string) => Promise<void>;
}

// --- Entry point ---

/**
 * Populate a worktree's working tree. "all" wipes the worktree (`.git` excepted)
 * and clones every entry of the main checkout; "seed" clones only the given
 * relative paths (ignored state for a dirty main).
 */
export async function materializeCowClone(
  request: CowCloneRequest,
  mode: CowCloneMode,
  deps: CowCloneDeps,
): Promise<CowCloneResult> {
  const wt = path.resolve(request.wtPath);
  const main = path.resolve(request.mainRoot);

  // What the wipe may touch is decided on the paths the roots really name: the
  // same directory can be spelled through a link (a symlinked worktree root, or
  // `/var` for `/private/var`), and a lexical compare cannot see that.
  const realWt = await resolvedRoot(wt);
  const realMain = await resolvedRoot(main);
  if (realWt === realMain) {
    throw new CowCloneError(
      "setup",
      "the worktree is the main checkout; refusing to materialize",
    );
  }
  if (containsPath(realWt, realMain)) {
    throw new CowCloneError(
      "setup",
      "the worktree contains the main checkout; refusing to materialize",
    );
  }

  // Before the wipe: an unsupported volume must cost the worktree nothing.
  await deps.probe(wt);

  const entries =
    mode.kind === "all"
      ? await withSetupContext(`cannot read ${main}`, () =>
          mainEntries(main, wt, deps),
        )
      : await withSetupContext(
          `cannot prepare the ignored paths in ${wt}`,
          () => seedEntries(main, wt, mode.rels),
        );

  if (mode.kind === "all") {
    await withSetupContext(`cannot wipe ${wt}`, () => wipeWorktree(wt, deps));
  }

  const failures: CloneFailure[] = [];
  for (const entry of entries) {
    try {
      await deps.cloneEntry(entry.src, entry.dst);
    } catch (err) {
      if (err instanceof CowCloneError && err.reason !== "entry-failed") {
        throw err;
      }
      failures.push({
        path: entry.src,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failures.length > 0) {
    throw new CowCloneError(
      "entry-failed",
      `${failures.length} ${failures.length === 1 ? "entry" : "entries"} could not be cloned`,
      failures,
    );
  }

  return { mechanism: entries.length === 0 ? "empty" : deps.mechanism };
}

/**
 * The directory a root really names; the root as given when it cannot be
 * resolved (a missing path is reported by the read that needs it).
 */
async function resolvedRoot(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return target;
  }
}

/** Whether either path is the other or lives inside it. */
function overlapsPath(a: string, b: string): boolean {
  return containsPath(a, b) || containsPath(b, a);
}

/** Whether `child` is `container` or lives inside it. */
export function containsPath(container: string, child: string): boolean {
  const from = path.resolve(container);
  const to = path.resolve(child);
  return to === from || to.startsWith(from + path.sep);
}

// --- Planning ---

/** The worktree's own entries, minus `.git`; the wipe list. */
async function wipeWorktree(wt: string, deps: CowCloneDeps): Promise<void> {
  for (const entry of await deps.list(wt)) {
    if (entry.name === ".git") continue;
    await removeEntry(path.join(wt, entry.name), entry);
  }
}

/**
 * Remove one entry, descending only into what the entry's own listing reported
 * as a directory and unlinking everything else: a symlink is never followed, so
 * a link out of the worktree — to another checkout, an ancestor, or in a loop
 * with a sibling — cannot redirect the wipe. Recursing here rather than through
 * `fs.rm` is the point: a path that ends in a separator is resolved through a
 * link, and this never hands one to a removal call.
 */
async function removeEntry(target: string, entry: fs.Dirent): Promise<void> {
  if (!entry.isDirectory()) {
    await ignoreMissing(() => fs.promises.unlink(target));
    return;
  }
  const children = await ignoreMissing(() =>
    fs.promises.readdir(target, { withFileTypes: true }),
  );
  for (const child of children ?? []) {
    await removeEntry(path.join(target, child.name), child);
  }
  await ignoreMissing(() => fs.promises.rmdir(target));
}

/** An entry that is already gone is removal that already happened. */
async function ignoreMissing<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if ((err as { readonly code?: unknown } | null)?.code !== "ENOENT")
      throw err;
    return undefined;
  }
}

/** Every main-checkout entry except `.git` and anything holding the worktree. */
async function mainEntries(
  main: string,
  wt: string,
  deps: CowCloneDeps,
): Promise<CloneEntry[]> {
  const entries: CloneEntry[] = [];
  for (const { name } of await deps.list(main)) {
    if (name === ".git") continue;
    const src = path.join(main, name);
    // eslint-disable-next-line lite/no-invariant-comment -- encodes a non-obvious choice; the type can't represent it
    // Never clone the worktree into itself, not even through an ancestor entry.
    if (overlapsPath(src, wt)) continue;
    entries.push({ src, dst: path.join(wt, name) });
  }
  return entries;
}

/** The listed ignored paths that exist in the main checkout. */
async function seedEntries(
  main: string,
  wt: string,
  rels: readonly string[],
): Promise<CloneEntry[]> {
  const entries: CloneEntry[] = [];
  for (const raw of rels) {
    // git reports ignored directories as "node_modules/"; clonefile(2) refuses a
    // destination that ends in a separator, so the trailing slash comes off here.
    const rel = raw.replace(/[/\\]+$/, "");
    if (rel === "") continue;
    // `.git` is the worktree's own link back to the main checkout, never state.
    if (rel === ".git" || rel.startsWith(".git/") || rel.startsWith(".git\\")) {
      continue;
    }
    const src = path.join(main, rel);
    // An ignored directory that holds the worktree (a store dir) is not state to
    // copy: seeding it would clone the worktree into itself.
    if (overlapsPath(src, wt)) continue;
    if (!(await exists(src))) continue;
    const dst = path.join(wt, rel);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    entries.push({ src, dst });
  }
  return entries;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.promises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Wrap a raw filesystem failure as a setup failure with a readable message. */
async function withSetupContext<T>(
  what: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CowCloneError) throw err;
    throw new CowCloneError(
      "setup",
      `${what}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- The platform primitives ---

/** One entry cloned by this platform's primitive. */
type CloneOne = (
  exec: ExecLike,
  tools: CloneTools,
  src: string,
  dst: string,
  timeoutMs: number,
) => Promise<void>;

/** This platform's probe and clone, over the real filesystem, through `pi.exec`. */
export function defaultCowCloneDeps(
  exec: ExecLike,
  timeoutMs: number = COW_CLONE_TIMEOUT_MS,
): CowCloneDeps {
  const list = (dir: string): Promise<readonly fs.Dirent[]> =>
    fs.promises.readdir(dir, { withFileTypes: true });
  // Resolved once: a bare name costs the child ~50 ms of PATH search, two orders
  // of magnitude over the child itself (1.3 ms), and `pi.exec` does not resolve
  // on our behalf.
  const tools: CloneTools = {
    cp: resolveCommand("cp"),
    du: resolveCommand("du"),
    python: resolveCommand("python3"),
  };
  switch (process.platform) {
    case "darwin":
      return {
        mechanism: "clonefile",
        list,
        probe: (wt) => probe(exec, wt, tools, timeoutMs, clonefileChild),
        cloneEntry: (src, dst) => darwinEntry(exec, tools, src, dst, timeoutMs),
      };
    case "linux":
      return {
        mechanism: "reflink",
        list,
        // The same probe, over the same primitive the real entries use.
        probe: (wt) => probe(exec, wt, tools, timeoutMs, reflinkChild),
        cloneEntry: (src, dst) =>
          reflinkChild(exec, tools, src, dst, timeoutMs),
      };
    default:
      return {
        mechanism: "empty",
        list,
        probe: () => Promise.reject(unsupportedPlatform()),
        cloneEntry: () => Promise.reject(unsupportedPlatform()),
      };
  }
}

function unsupportedPlatform(): CowCloneError {
  return new CowCloneError(
    "unsupported",
    `copy-on-write worktree materialization is not implemented on ${process.platform}`,
  );
}

/**
 * Create a small tree inside the worktree, clone it, drop it again. The clone
 * runs before anything is wiped, so an unsupported volume costs nothing.
 */
async function probe(
  exec: ExecLike,
  wt: string,
  tools: CloneTools,
  timeoutMs: number,
  clone: CloneOne,
): Promise<void> {
  const root = path.join(wt, `.cow-probe-${process.pid}`);
  const from = path.join(root, "p");
  try {
    // The worktree is the agent's, links included: the probe may only write under
    // a directory it created itself, never through a link left at that name.
    await fs.promises.mkdir(root, { recursive: true });
    if (!(await fs.promises.lstat(root)).isDirectory()) {
      throw new CowCloneError(
        "setup",
        `${root} is not a directory; refusing to probe the volume through it`,
      );
    }
    await fs.promises.mkdir(from, { recursive: true });
    await fs.promises.writeFile(path.join(from, "f"), "x");
    await clone(exec, tools, from, path.join(root, "p-clone"), timeoutMs);
  } catch (err) {
    if (err instanceof CowCloneError && err.reason === "entry-failed") {
      throw new CowCloneError(
        "unsupported",
        `copy-on-write is not supported on the worktree volume: ${err.message}`,
      );
    }
    throw err;
  } finally {
    await fs.promises
      .rm(root, { recursive: true, force: true })
      .catch(() => {});
  }
}

/**
 * macOS: a big directory goes through clonefile(2) — one call clones the whole
 * tree — while files and small directories go through `cp -c`, which is cheaper
 * to start. Either way the probe has
 * already proved this volume clones, so `cp -c` cannot be the silent byte copy
 * it would be on its own.
 */
async function darwinEntry(
  exec: ExecLike,
  tools: CloneTools,
  src: string,
  dst: string,
  timeoutMs: number,
): Promise<void> {
  const info = await fs.promises.lstat(src);
  if (!info.isDirectory()) {
    return copyChild(exec, tools, src, dst, timeoutMs, []);
  }
  const kb = await directoryKb(exec, tools, src, timeoutMs);
  return kb >= BIG_DIRECTORY_KB
    ? clonefileChild(exec, tools, src, dst, timeoutMs)
    : copyChild(exec, tools, src, dst, timeoutMs, ["-R"]);
}

/** `du -sk` in KB; an unreadable tree counts as small. */
async function directoryKb(
  exec: ExecLike,
  tools: CloneTools,
  src: string,
  timeoutMs: number,
): Promise<number> {
  try {
    const out = await run(
      exec,
      tools.du,
      ["-sk", src],
      timeoutMs,
      `du -sk ${src}`,
    );
    return Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * macOS: one clonefile(2) call through the embedded snippet. The child may block
 * for as long as the tree takes; Node waits on it asynchronously.
 */
function clonefileChild(
  exec: ExecLike,
  tools: CloneTools,
  src: string,
  dst: string,
  timeoutMs: number,
): Promise<void> {
  // `-c`, not stdin: `pi.exec` spawns with stdin ignored, so the snippet travels
  // as an argument, with src then dst following it in argv.
  return run(
    exec,
    tools.python,
    ["-c", CLONEFILE_SNIPPET, src, dst],
    timeoutMs,
    `clonefile ${src}`,
    "could not start python3 (needed to clone a worktree on macOS)",
  ).then(() => undefined);
}

/** macOS: clone one entry with `cp -P -c` (symlinks preserved). */
function copyChild(
  exec: ExecLike,
  tools: CloneTools,
  src: string,
  dst: string,
  timeoutMs: number,
  flags: readonly string[],
): Promise<void> {
  return run(
    exec,
    tools.cp,
    ["-P", "-c", ...flags, src, dst],
    timeoutMs,
    `cp -c ${src}`,
  ).then(() => undefined);
}

/**
 * Linux: clone one entry with `cp -P --reflink=always -R` (symlinks preserved).
 * `always` is the load-bearing part — the copy fails instead of falling back to
 * bytes. `-R` is what puts the FICLONE ioctl on every file in the tree; the
 * recursion belongs inside cp, not in a recursive fs.cp, which would only clone
 * the top-level target. One child per entry, as on macOS.
 */
function reflinkChild(
  exec: ExecLike,
  tools: CloneTools,
  src: string,
  dst: string,
  timeoutMs: number,
): Promise<void> {
  return run(
    exec,
    tools.cp,
    ["-P", "--reflink=always", "-R", src, dst],
    timeoutMs,
    `cp --reflink ${src}`,
  ).then(() => undefined);
}

/** Run one command that must exit 0; a kill or a non-zero exit is a failure. */
async function run(
  exec: ExecLike,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  what: string,
  launchHint?: string,
): Promise<string> {
  const result = await exec(command, [...args], { timeout: timeoutMs }).catch(
    (err: unknown) => {
      throw new CowCloneError(
        "launch",
        `${launchHint ?? `could not start ${command}`}: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  );
  // `pi.exec` reports a child it killed as code 0 with killed set.
  if (result.killed) {
    throw new CowCloneError(
      "timeout",
      `${what} exceeded ${Math.round(timeoutMs / 1000)}s`,
    );
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "";
    throw new CowCloneError(
      "entry-failed",
      `${what} exited ${String(result.code)}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result.stdout;
}
