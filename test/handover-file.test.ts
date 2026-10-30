/**
 * handover-file.test.ts — the export's name, path, and write. The name carries
 * the run's three identities and nothing that could escape the directory.
 */
import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HANDOVER_EXPORT_DIR,
  handoverFileExists,
  handoverFileName,
  handoverFilePath,
  handoverNameField,
  writeHandoverFile,
} from "../src/agents/handover-file.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowboy-handover-file-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("handoverFileName", () => {
  it("joins the three identities with underscores", () => {
    expect(
      handoverFileName({
        worktree: "cow-fix-login-abcd1234",
        harness: "claude",
        sessionId: "3f9a1c2e-77bd-4d0e-9a1b-8f2c1d4e5f60",
      }),
    ).toBe(
      "cowboy-handover_cow-fix-login-abcd1234_claude_3f9a1c2e-77bd-4d0e-9a1b-8f2c1d4e5f60.md",
    );
  });

  it("keeps a parent-cwd run's `main-<agent id>` name", () => {
    expect(
      handoverFileName({
        worktree: "main-abcd1234",
        harness: "pi",
        sessionId: "ses_0f3c9a",
      }),
    ).toBe("cowboy-handover_main-abcd1234_pi_ses_0f3c9a.md");
  });

  it("flattens anything a field could introduce as a separator", () => {
    expect(
      handoverFileName({
        worktree: "feat/login",
        harness: "reg/plugin",
        sessionId: "ses-with space",
      }),
    ).toBe("cowboy-handover_feat-login_reg-plugin_ses-with-space.md");
  });
});

describe("handoverNameField", () => {
  it("keeps letters, digits, dot, underscore and dash", () => {
    expect(handoverNameField("cow-fix_1.0")).toBe("cow-fix_1.0");
  });
});

describe("handoverFilePath", () => {
  it("lands the name in /tmp", () => {
    expect(handoverFilePath("cowboy-handover_a_pi_s.md")).toBe(
      `${HANDOVER_EXPORT_DIR}/cowboy-handover_a_pi_s.md`,
    );
  });
});

describe("writeHandoverFile", () => {
  const target = (): string => path.join(dir, "artifact.md");

  it("creates the file, reporting that nothing was replaced", () => {
    expect(writeHandoverFile(target(), "first")).toEqual({ replaced: false });
    expect(fs.readFileSync(target(), "utf8")).toBe("first");
    expect(handoverFileExists(target())).toBe(true);
  });

  it("replaces an existing file, reporting it", () => {
    fs.writeFileSync(target(), "old");
    expect(writeHandoverFile(target(), "new")).toEqual({ replaced: true });
    expect(fs.readFileSync(target(), "utf8")).toBe("new");
  });

  it("reports a missing artifact", () => {
    expect(handoverFileExists(target())).toBe(false);
  });
});
