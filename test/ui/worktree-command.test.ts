/**
 * worktree-command.test.ts — the `/cowboy worktree` flow: name → checkout → create → report.
 *
 * Faked boundaries: src/shell.js (store, pi, runtime host) and the outer half of
 * the git layer (`createWorktreeCheckout`, `isGitRepo`, `resolveMainCheckout`,
 * `gitProbe`, `removeGitWorktree`, `deleteCreatedBranch`), so no repository is
 * read and nothing is created on disk. The store is real, over an in-memory
 * config. The switch's own half — that `/cowboy worktree` reaches this flow
 * while the extension is off — is pinned in extension-switch.test.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { probed } from "../../src/availability.js";
import type { RawConfig } from "../../src/config/config-store.js";
import type { WorktreeMaterializationOutcome } from "../../src/infrastructure/git-client.js";
import { WORKTREE_COMMAND_NAME_MAX_LENGTH } from "../../src/ui/menu/submenus/worktree-command-name.js";
import { KEY, openMenu, type MenuSession } from "./harness.js";
import { resetShell, setPi, setRuntime, shellState } from "./shell-mock.js";
import { createMemoryStore, type MemoryStore } from "./store.js";

vi.mock("../../src/shell.js", () => import("./shell-mock.js"));

const git = vi.hoisted(() => ({
  isGitRepo: vi.fn(),
  resolveMainCheckout: vi.fn(),
  gitProbe: vi.fn(),
  removeGitWorktree: vi.fn(),
  deleteCreatedBranch: vi.fn(),
}));
vi.mock("../../src/infrastructure/git-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/infrastructure/git-client.js")
  >()),
  ...git,
}));

const launcher = vi.hoisted(() => ({ createWorktreeCheckout: vi.fn() }));
vi.mock("../../src/spawn/herdr-launcher.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/spawn/herdr-launcher.js")
  >()),
  createWorktreeCheckout: launcher.createWorktreeCheckout,
}));

const host = vi.hoisted(() => ({
  hostAt: vi.fn(),
  isAttached: vi.fn(),
  release: vi.fn(),
}));

const probes = vi.hoisted(() => ({
  startCowSupportProbe: vi.fn(),
  refreshCowSupportProbe: vi.fn(),
}));
vi.mock("../../src/cow-support-launch.js", () => probes);

/** The host address a faked pane adoption returns. */
const ADOPTED_REF = {
  engine: "herdr",
  name: "render-page",
  paneId: "pane-1",
  tabId: "tab-1",
  workspaceId: "ws-1",
  paneCreated: false,
};

const { showWorktreeCommandMenu } =
  await import("../../src/ui/menu/menu-worktree-command.js");

/** The configured worktree root, a real directory so a path collision can be staged in it. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-worktree-command-"));
const REPO = "/repo";

let memory: MemoryStore;

interface SetupOptions {
  /** Global-layer config; the worktree root is always this suite's temp directory. */
  global?: RawConfig;
}

function setup(options: SetupOptions = {}): void {
  resetShell();
  const configured = options.global ?? {};
  memory = createMemoryStore({
    projectStatus: "absent",
    global: {
      ...configured,
      agent: { worktreeRoot: ROOT, ...configured.agent },
    },
  });
  memory.install();
  setPi({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) });
  setRuntime({ host });
  git.isGitRepo.mockReset();
  git.isGitRepo.mockResolvedValue(true);
  git.resolveMainCheckout.mockReset();
  git.resolveMainCheckout.mockResolvedValue(REPO);
  git.gitProbe.mockReset();
  git.gitProbe.mockResolvedValue(undefined);
  git.removeGitWorktree.mockReset();
  git.removeGitWorktree.mockResolvedValue(undefined);
  git.deleteCreatedBranch.mockReset();
  git.deleteCreatedBranch.mockResolvedValue({ kind: "deleted" });
  launcher.createWorktreeCheckout.mockReset();
  launcher.createWorktreeCheckout.mockImplementation(async (_pi, options) =>
    checkout(options, { kind: "cow", clone: { mode: "cow" } }),
  );
  host.hostAt.mockReset();
  host.hostAt.mockResolvedValue({ ...ADOPTED_REF });
  host.isAttached.mockReset();
  host.isAttached.mockResolvedValue(false);
  host.release.mockReset();
  host.release.mockResolvedValue(true);
}

/** The checkout `createWorktreeCheckout` reports for the options it was handed. */
function checkout(
  options: { path: string; branch: string; repoCwd: string },
  materialization: WorktreeMaterializationOutcome,
) {
  return {
    path: options.path,
    branch: options.branch,
    repoCwd: options.repoCwd,
    materialization,
  };
}

const WIDE = 120;

/** Open the flow, as the command handler does with its inline name. */
function openFlow(inlineName = ""): MenuSession {
  return openMenu(
    (ctx: ExtensionCommandContext) => showWorktreeCommandMenu(ctx, inlineName),
    WIDE,
  );
}

/** The name step: submit `name`, or the field as it opened when none is given. */
async function submitName(session: MenuSession, name?: string): Promise<void> {
  await session.whenScreens(1);
  await session.settle();
  if (name !== undefined) session.fillField(name);
  session.press(KEY.enter);
  await session.settle();
}

/** The checkout step: pick one of the two policies. */
async function pickCheckout(
  session: MenuSession,
  policy: "dirty" | "clean",
): Promise<void> {
  session.open(policy);
  await session.settle();
}

/** Walk the whole flow: name → checkout → the report (or the refusal). */
async function createWorktree(
  session: MenuSession,
  options: { name?: string; policy?: "dirty" | "clean" } = {},
): Promise<void> {
  await submitName(session, options.name ?? "render-page");
  await pickCheckout(session, options.policy ?? "clean");
  await session.finished;
}

/** Every notification the flow emitted, in order. */
function notifications(session: MenuSession): string {
  return session.notifications.map((note) => note.message).join("\n");
}

/** The path the configured root gives a name. */
function pathOf(name: string): string {
  return path.join(ROOT, name);
}

beforeEach(() => setup());

describe("worktree command — the flow", () => {
  it("asks for the name, then the checkout policy, then creates and reports", async () => {
    const session = openFlow();
    await submitName(session, "render-page");

    expect(session.title()).toBe("Worktree Checkout");
    expect(session.rows().map((row) => row.label)).toEqual(
      expect.arrayContaining(["dirty", "clean"]),
    );
    // The selected policy's meaning reads with it.
    expect(session.text()).toContain("Start at HEAD");
    // The configured policy leads: clean is the default.
    expect(session.activeRow()?.label).toBe("clean");

    await pickCheckout(session, "dirty");
    await session.finished;

    expect(launcher.createWorktreeCheckout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        repoCwd: REPO,
        path: pathOf("render-page"),
        branch: "render-page",
        materialization: "copy-on-write",
        dirtyCheckout: "dirty",
      }),
    );
    // One message carries the four fields.
    expect(notifications(session)).toContain(
      [
        `✓ Worktree ready: ${pathOf("render-page")}`,
        "branch: render-page",
        "materialization: copy-on-write",
        "inherited: nothing uncommitted — the parent was clean, so the worktree is a clone at HEAD",
      ].join("\n"),
    );
    // A worktree is a git artifact: the flow writes no config.
    expect(memory.writes).toEqual([]);
  });

  it("prefills the name given on the command line", async () => {
    const session = openFlow("render-page");
    await session.whenScreens(1);
    await session.settle();

    expect(session.title()).toBe("Worktree Name");
    expect(session.text()).toContain("render-page");

    // Submitting the prefill unchanged takes it as the name.
    session.press(KEY.enter);
    await session.settle();
    expect(session.title()).toBe("Worktree Checkout");
    await pickCheckout(session, "clean");
    await session.finished;

    expect(launcher.createWorktreeCheckout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branch: "render-page" }),
    );
  });

  it("keeps the field open and re-prompts for a name it cannot use", async () => {
    const session = openFlow();
    await session.whenScreens(1);
    await session.settle();

    session.press(KEY.enter);
    await session.settle();
    expect(notifications(session)).toContain(
      "Enter a name: it becomes the worktree's directory and its git branch.",
    );

    const tooLong = "a".repeat(WORKTREE_COMMAND_NAME_MAX_LENGTH + 1);
    session.fillField(tooLong);
    session.press(KEY.enter);
    await session.settle();
    expect(notifications(session)).toContain(
      `Name is too long: the pane adoption carries it as a herdr agent name, which caps at ${WORKTREE_COMMAND_NAME_MAX_LENGTH} characters.`,
    );

    session.fillField("bad name");
    session.press(KEY.enter);
    await session.settle();
    expect(notifications(session)).toContain(
      "Invalid name: it must be a git branch name, so letters, digits, and - _ . / only — no spaces, and none of ~ ^ : ? * [ \\.",
    );

    // The refusal keeps the field up: no second screen was ever entered.
    expect(session.title()).toBe("Worktree Name");
    expect(session.screenCount).toBe(1);
    expect(launcher.createWorktreeCheckout).not.toHaveBeenCalled();
  });

  it("takes a name with a slash as one nested directory under the root", async () => {
    const nested = path.join(ROOT, "render");
    fs.rmSync(nested, { recursive: true, force: true });
    try {
      const session = openFlow();
      await createWorktree(session, { name: "render/page" });

      expect(launcher.createWorktreeCheckout).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          path: path.join(ROOT, "render", "page"),
          branch: "render/page",
        }),
      );
      // The name is the directory too, level by level.
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      fs.rmSync(nested, { recursive: true, force: true });
    }
  });

  it("creates nothing when the name step is escaped", async () => {
    const session = openFlow();
    await session.whenScreens(1);
    await session.settle();

    session.press(KEY.escape);
    await session.finished;

    expect(launcher.createWorktreeCheckout).not.toHaveBeenCalled();
    expect(session.notifications).toEqual([]);
  });

  it("creates nothing when the checkout step is escaped", async () => {
    const session = openFlow();
    await submitName(session, "render-page");
    expect(session.title()).toBe("Worktree Checkout");

    session.press(KEY.escape);
    await session.finished;

    expect(launcher.createWorktreeCheckout).not.toHaveBeenCalled();
  });
});

describe("worktree command — the checkout policy", () => {
  it("leads with the configured policy", async () => {
    setup({ global: { agent: { worktreeCheckoutType: "dirty" } } });
    const session = openFlow();
    await submitName(session, "render-page");

    expect(session.activeRow()?.label).toBe("dirty");
  });

  it("creates with the policy picked, not the configured one", async () => {
    setup({ global: { agent: { worktreeCheckoutType: "dirty" } } });
    const session = openFlow();
    await createWorktree(session, { policy: "clean" });

    expect(launcher.createWorktreeCheckout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dirtyCheckout: "clean" }),
    );
    // The choice is for this worktree only: the setting is untouched.
    expect(memory.store.agent.worktreeCheckoutType).toBe("dirty");
    expect(memory.writes).toEqual([]);
  });

  it("creates with the materialization the accessor resolves, not the raw setting", async () => {
    // A volume that cannot clone: the setting says copy-on-write, the accessor says checkout.
    setup({ global: { agent: { worktreeMaterialization: "copy-on-write" } } });
    shellState.cowAvailability = probed<"copy-on-write" | "checkout">([
      "checkout",
    ]);

    const session = openFlow();
    await createWorktree(session);

    expect(launcher.createWorktreeCheckout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ materialization: "checkout" }),
    );
  });
});

describe("worktree command — collisions", () => {
  it("refuses a name whose branch already exists, and says which", async () => {
    // `git rev-parse --verify refs/heads/<name>` answers with the commit it names.
    git.gitProbe.mockResolvedValue("9d1b2c3a4f5e6d7c8b9a0f1e2d3c4b5a6f7e8d9c");

    const session = openFlow();
    await createWorktree(session, { name: "render-page" });

    expect(notifications(session)).toContain(
      'Cannot create the worktree: the branch "render-page" already exists. Pick another name.',
    );
    expect(launcher.createWorktreeCheckout).not.toHaveBeenCalled();
    expect(git.removeGitWorktree).not.toHaveBeenCalled();
  });

  it("refuses a name whose directory already exists, and says which", async () => {
    const taken = pathOf("taken-directory");
    fs.mkdirSync(taken, { recursive: true });
    try {
      const session = openFlow();
      await createWorktree(session, { name: "taken-directory" });

      expect(notifications(session)).toContain(
        `Cannot create the worktree: ${taken} already exists. Pick another name.`,
      );
      expect(launcher.createWorktreeCheckout).not.toHaveBeenCalled();
      // Whatever is there is left alone.
      expect(fs.existsSync(taken)).toBe(true);
    } finally {
      fs.rmSync(taken, { recursive: true, force: true });
    }
  });
});

describe("worktree command — failures", () => {
  it("refuses outside a git repository", async () => {
    git.isGitRepo.mockResolvedValue(false);

    const session = openFlow();
    await createWorktree(session);

    expect(notifications(session)).toContain(
      "Cannot create a worktree: this session is not inside a git repository.",
    );
    expect(launcher.createWorktreeCheckout).not.toHaveBeenCalled();
  });

  it("reports a failed git create and leaves nothing behind", async () => {
    launcher.createWorktreeCheckout.mockRejectedValue(
      new Error("branch exists"),
    );

    const session = openFlow();
    await createWorktree(session);

    expect(notifications(session)).toContain(
      `✗ Worktree creation failed: could not create the herdr worktree: branch exists`,
    );
    expect(notifications(session)).toContain(
      `Launch-failure cleanup: worktree ${pathOf("render-page")} removed.`,
    );
    expect(notifications(session)).not.toContain("Worktree ready");
  });

  it("rolls the worktree and its branch back when the pane adoption fails", async () => {
    host.hostAt.mockRejectedValue(new Error("herdr worktree open failed"));

    const session = openFlow();
    await createWorktree(session);

    expect(git.removeGitWorktree).toHaveBeenCalledWith(
      expect.anything(),
      REPO,
      pathOf("render-page"),
    );
    // By name, not by path basename: the branch is a free-form name here.
    expect(git.deleteCreatedBranch).toHaveBeenCalledWith(
      expect.anything(),
      "render-page",
      REPO,
    );
    expect(notifications(session)).toContain(
      "✗ Worktree creation failed: could not create the herdr worktree: herdr worktree open failed",
    );
    expect(notifications(session)).toContain(
      `Launch-failure cleanup: worktree ${pathOf("render-page")} removed. branch render-page deleted.`,
    );
    expect(notifications(session)).not.toContain("Worktree ready");
  });
});

describe("worktree command — the report", () => {
  interface ReportCase {
    name: string;
    materialization: WorktreeMaterializationOutcome;
    policy: "dirty" | "clean";
    inherited: string;
  }

  const CASES: ReportCase[] = [
    {
      name: "a clone of a dirty parent under dirty",
      materialization: {
        kind: "cow",
        clone: { mode: "cow", reason: "main checkout has uncommitted changes" },
      },
      policy: "dirty",
      inherited:
        "inherited: the parent's uncommitted work: its tracked edits and its untracked files",
    },
    {
      name: "seeded ignored state under clean",
      materialization: {
        kind: "cow",
        clone: {
          mode: "seeded",
          reason: "main checkout has uncommitted changes",
        },
      },
      policy: "clean",
      inherited:
        "inherited: nothing the parent had uncommitted: tracked files came from HEAD and only ignored state was seeded",
    },
    {
      name: "checkout of a dirty parent under dirty",
      materialization: { kind: "checkout" },
      policy: "dirty",
      inherited:
        "inherited: the parent's tracked changes, applied on top of git's checkout of HEAD (a clean parent carries none)",
    },
    {
      name: "checkout under clean",
      materialization: { kind: "checkout" },
      policy: "clean",
      inherited:
        "inherited: nothing: git checked out HEAD, and the parent's uncommitted work stays out",
    },
    {
      name: "a fallback to checkout on a volume that cannot clone",
      materialization: {
        kind: "cow-fallback",
        reason: "the worktree volume cannot clone",
      },
      policy: "dirty",
      inherited:
        "inherited: nothing: the fallback checkout starts at HEAD, whatever the checkout policy says",
    },
  ];

  it.each(CASES)(
    "reports the materialization that ran and what it inherited — $name",
    async (testCase) => {
      launcher.createWorktreeCheckout.mockImplementation(async (_pi, options) =>
        checkout(options, testCase.materialization),
      );

      const session = openFlow();
      await createWorktree(session, { policy: testCase.policy });

      expect(notifications(session)).toContain(testCase.inherited);
      expect(notifications(session)).toContain("branch: render-page");
      expect(notifications(session)).toContain(
        `Worktree ready: ${pathOf("render-page")}`,
      );
    },
  );

  it("names the checkout a fallback volume actually ran", async () => {
    launcher.createWorktreeCheckout.mockImplementation(async (_pi, options) =>
      checkout(options, {
        kind: "cow-fallback",
        reason: "the worktree volume cannot clone",
      }),
    );

    const session = openFlow();
    await createWorktree(session);

    expect(notifications(session)).toContain(
      "materialization: checkout (the volume cannot clone, so copy-on-write was unavailable)",
    );
  });
});

describe("worktree command — the volume probe", () => {
  it("never asks the volume again; it reads what the launch probe already recorded", async () => {
    const session = openFlow();
    await createWorktree(session);

    expect(probes.startCowSupportProbe).not.toHaveBeenCalled();
    expect(probes.refreshCowSupportProbe).not.toHaveBeenCalled();
    // An unanswered probe stays unanswered: the command narrows nothing either.
    expect(shellState.cowAvailability).toEqual({ status: "unknown" });
  });
});

describe("worktree command — the switch", () => {
  it("creates a worktree while pi-cowboy is disabled", async () => {
    setup({ global: { agent: { extensionEnabled: false } } });
    const session = openFlow();
    await createWorktree(session);

    expect(launcher.createWorktreeCheckout).toHaveBeenCalled();
    expect(notifications(session)).toContain("Worktree ready");
    // Nothing refuses for the switch's sake.
    expect(notifications(session)).not.toContain("enable");
  });
});
