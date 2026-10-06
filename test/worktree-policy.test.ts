import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWorktreePath,
  buildTaskSlug,
  buildWorktreeBranch,
  DEFAULT_WORKTREE_CHECKOUT_TYPE,
  DEFAULT_WORKTREE_MATERIALIZATION,
  isExtensionWorktree,
  isWorktreeCheckoutType,
  isWorktreeMaterialization,
  parseWorktreeCheckoutType,
  parseWorktreeMaterialization,
  resolveWorktreeRoot,
  slugifyWorktreeType,
  VALID_WORKTREE_CHECKOUT_TYPES,
  VALID_WORKTREE_MATERIALIZATIONS,
} from "../src/spawn/worktree-policy.js";
import { EXTENSION_NAME } from "../src/paths.js";

describe("paths", () => {
  it("reads the extension name from package.json", () => {
    const pkgName = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf-8",
      ),
    ) as { name?: unknown };
    expect(EXTENSION_NAME).toBe(pkgName.name);
  });
});

describe("slugifyWorktreeType", () => {
  it("keeps simple type names as-is (lowercased)", () => {
    expect(slugifyWorktreeType("general-purpose")).toBe("general-purpose");
    expect(slugifyWorktreeType("Explore")).toBe("explore");
  });

  it("replaces unsafe characters and collapses runs", () => {
    expect(slugifyWorktreeType("My Agent (v2)!")).toBe("my-agent-v2");
    expect(slugifyWorktreeType("   ")).toBe("agent");
  });
});

describe("buildTaskSlug", () => {
  it("keeps an orchestrator-chosen 2-3 word name", () => {
    expect(buildTaskSlug("fix login flow")).toBe("fix-login-flow");
    expect(buildTaskSlug("research tooling")).toBe("research-tooling");
  });

  it("throws when the name exceeds the word limit, reporting the branch name it gives", () => {
    expect(() =>
      buildTaskSlug("write tests for the parser module today"),
    ).toThrow(
      /gives the branch name "write-tests-for-the-parser-module-today" with 7 words. The limit is 3 words/,
    );
  });

  it("throws when the slug exceeds the length limit, reporting the branch name it gives", () => {
    expect(() => buildTaskSlug("researching existing tool")).toThrow(
      /gives the branch name "researching-existing-tool" with 25 characters\. The limit is 19 characters/,
    );
  });

  it("never truncates a name that is over the limit", () => {
    expect(() => buildTaskSlug("researching existing tool")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => buildTaskSlug("")).toThrow(/empty/);
  });

  it("normalizes punctuation and casing", () => {
    expect(buildTaskSlug("  Fix.Login! Flow  ")).toBe("fix-login-flow");
  });
});

describe("buildWorktreeBranch", () => {
  it("prefixes with cow- and appends the id", () => {
    expect(buildWorktreeBranch("fix-login-flow", "abc12345")).toBe(
      "cow-fix-login-flow-abc12345",
    );
  });
});

describe("buildWorktreePath", () => {
  it("places worktrees under the root with the branch as basename", () => {
    expect(buildWorktreePath("/root", "fix-login-flow", "abc12345")).toBe(
      join("/root", "cow-fix-login-flow-abc12345"),
    );
  });
});

describe("resolveWorktreeRoot", () => {
  it("defaults to the extension working dir's worktrees subdir", () => {
    const pkgName = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf-8",
      ),
    ) as { name?: unknown };
    expect(resolveWorktreeRoot(undefined, "/work/repo")).toBe(
      join(homedir(), ".pi", "agent", pkgName.name as string, "worktrees"),
    );
  });

  it("uses an absolute configured root as-is", () => {
    expect(resolveWorktreeRoot("/abs/root", "/work/repo")).toBe("/abs/root");
  });

  it("resolves a relative configured root against the repo root", () => {
    expect(resolveWorktreeRoot("wt", "/work/repo")).toBe("/work/repo/wt");
  });
});

describe("isExtensionWorktree", () => {
  const root = "/work/.herdr-subagents/repo";

  it("matches a cow- worktree under the root", () => {
    expect(
      isExtensionWorktree(
        "/work/.herdr-subagents/repo/cow-fix-login-flow-abc12345",
        root,
      ),
    ).toBe(true);
  });

  it("rejects a user worktree under the root (wrong prefix)", () => {
    expect(
      isExtensionWorktree("/work/.herdr-subagents/repo/feature-x", root),
    ).toBe(false);
  });

  it("rejects a cow- worktree outside the root", () => {
    expect(
      isExtensionWorktree("/work/other/cow-fix-login-flow-abc12345", root),
    ).toBe(false);
  });

  it("rejects the root itself and non-descendants", () => {
    expect(isExtensionWorktree(root, root)).toBe(false);
    expect(isExtensionWorktree("/work/.herdr-subagents", root)).toBe(false);
    expect(isExtensionWorktree("/work/.herdr-subagentsX/repo/x", root)).toBe(
      false,
    );
  });

  it("is prefix-safe (root is not a string prefix of unrelated paths)", () => {
    expect(
      isExtensionWorktree(
        "/work/.herdr-subagents/repo-other/cow-fix-login-flow-abc12345",
        root,
      ),
    ).toBe(false);
  });

  it("recognizes a cow- worktree reached through a symlinked root", () => {
    const base = mkdtempSync(join(tmpdir(), "worktree-policy-"));
    try {
      const real = join(base, "real");
      mkdirSync(join(real, "cow-fix-login-abc12345"), { recursive: true });
      symlinkSync(real, join(base, "link"));
      expect(
        isExtensionWorktree(join(base, "link", "cow-fix-login-abc12345"), real),
      ).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("worktree materialization", () => {
  it("defaults to copy-on-write", () => {
    expect(DEFAULT_WORKTREE_MATERIALIZATION).toBe("copy-on-write");
    expect(VALID_WORKTREE_MATERIALIZATIONS).toContain(
      DEFAULT_WORKTREE_MATERIALIZATION,
    );
  });

  it.each([...VALID_WORKTREE_MATERIALIZATIONS])(
    "accepts and parses the known strategy %s",
    (value) => {
      expect(isWorktreeMaterialization(value)).toBe(true);
      expect(parseWorktreeMaterialization(value)).toBe(value);
    },
  );

  it.each(["", "COW", "Cow", "cow", "true", "1"])(
    "rejects the untrusted value %o (config / menu input)",
    (value) => {
      expect(isWorktreeMaterialization(value)).toBe(false);
      expect(parseWorktreeMaterialization(value)).toBeUndefined();
    },
  );
});

describe("worktree dirty-checkout policy", () => {
  it("defaults to clean, so a dirty parent's WIP stays out", () => {
    expect(DEFAULT_WORKTREE_CHECKOUT_TYPE).toBe("clean");
    expect(VALID_WORKTREE_CHECKOUT_TYPES).toContain(
      DEFAULT_WORKTREE_CHECKOUT_TYPE,
    );
  });

  it.each([...VALID_WORKTREE_CHECKOUT_TYPES])(
    "accepts and parses the known policy %s",
    (value) => {
      expect(isWorktreeCheckoutType(value)).toBe(true);
      expect(parseWorktreeCheckoutType(value)).toBe(value);
    },
  );

  it.each(["", "Dirty", "DIRTY", "clone", "seed", "true", "1"])(
    "rejects the untrusted value %o (config / menu / template input)",
    (value) => {
      expect(isWorktreeCheckoutType(value)).toBe(false);
      expect(parseWorktreeCheckoutType(value)).toBeUndefined();
    },
  );
});
