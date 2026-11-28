/**
 * plugin-surface.test.ts — the `pi-cowboy/plugin` subpath names everything a
 * plugin helper needs. `ModelList` is the return type of a callback a plugin
 * implements, so a helper that answers with one must be able to name it here
 * rather than reach for `ReturnType<…>`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installPaneLauncher,
  launchEnvBody,
  modelListEntries,
  modelListNotice,
  singleQuoteShellWord,
  subagentLauncherFileFor,
} from "../src/plugin/index.js";
import type {
  LiveAttempt,
  ModelEntry,
  ModelList,
  PaneControl,
  PaneLauncherSpec,
} from "../src/plugin/index.js";

/** Compiles only while the subpath exports `ModelList` as a type. */
const catalog: ModelList = {
  kind: "listed",
  entries: [
    { key: "openai/gpt", thinkingLevels: { kind: "closed", levels: [] } },
  ],
};

/** Compiles only while the subpath exports `LiveAttempt`, the element a helper's `findAttempts` answer is made of. */
const attempt: LiveAttempt = { name: "cow-fix-login-01234567" };

/** Compiles only while the subpath exports the reads over an answer. */
const reads: readonly [
  (list: ModelList) => readonly ModelEntry[],
  (list: ModelList) => string | undefined,
] = [modelListEntries, modelListNotice];

describe("the plugin subpath", () => {
  it("reads a listed answer through the helpers it exports", () => {
    const [entries, notice] = reads;
    expect(entries(catalog).map((entry) => entry.key)).toEqual(["openai/gpt"]);
    expect(notice(catalog)).toBeUndefined();
  });

  it("reads an unavailable answer as no models plus its reason", () => {
    const [entries, notice] = reads;
    const answer: ModelList = { kind: "unavailable", notice: "no catalog" };
    expect(entries(answer)).toEqual([]);
    expect(notice(answer)).toBe("no catalog");
  });

  it("names a live attempt without reaching for the method it came from", () => {
    expect(attempt.name).toBe("cow-fix-login-01234567");
  });

  it("quotes a path the way the pane's launchers do", () => {
    expect(singleQuoteShellWord("/a b/it's.sh")).toBe("'/a b/it'\\''s.sh'");
  });

  it("wraps a body so it sources the launch's staged env", () => {
    expect(launchEnvBody("/spawn/a/env.sh", 'command x "$@"')).toBe(
      `( . '/spawn/a/env.sh' && { command x "$@"; } )`,
    );
    expect(launchEnvBody(null, 'command x "$@"')).toBe('command x "$@"');
  });
});

describe("the plugin subpath's pane launcher", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cowboy-plugin-launcher-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stages the launcher and types only the line that sources it", async () => {
    const typed: string[] = [];
    const pane: PaneControl = {
      kind: "test",
      run: async (_paneId, command) => {
        typed.push(command);
      },
      sendKeys: async () => {},
      waitForOutput: async () => {},
    };
    const spec: PaneLauncherSpec = {
      file: join(root, "launcher.sh"),
      agentMultiplexerKind: "pi",
      body: launchEnvBody("/spawn/a/env.sh", 'command my-cli "$@"'),
      signature: "MY_CLI_LAUNCHER_1a2b3c",
      readyMarker: "MY_CLI_VERIFIED",
    };

    await installPaneLauncher(pane, "w1:p1", spec);

    expect(typed).toEqual([`. '${spec.file}'`]);
    const staged = readFileSync(spec.file, "utf8");
    expect(staged).toContain('pi() { : "MY_CLI_LAUNCHER_1a2b3c";');
    expect(staged).toContain('command my-cli "$@"');
  });

  it("names the launcher's file inside the spawn's staging directory", () => {
    expect(subagentLauncherFileFor("abc12345")).toMatch(
      /abc12345\/launcher\.sh$/,
    );
  });
});
