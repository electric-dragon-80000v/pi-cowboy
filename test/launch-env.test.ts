/**
 * launch-env.test.ts — the launch's variables as a staged file and the launcher
 * body that sources it. Values must never be interpolated into the command
 * typed into the pane, so what is asserted here is the file's content and mode,
 * and the behavior of the body in a real shell.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchEnvBody } from "../src/agents/harness/pane-launcher.js";
import { stageLaunchEnv } from "../src/agents/harness/launch-env.js";

/** A shell that runs one script and answers with its stdout and stderr. */
function runShell(script: string): {
  out: string;
  err: string;
  status: number;
} {
  try {
    const out = execFileSync("/bin/sh", ["-c", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, err: "", status: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; status?: number };
    return {
      out: failed.stdout ?? "",
      err: failed.stderr ?? "",
      status: failed.status ?? 1,
    };
  }
}

let root: string;

function inRoot(name: string): string {
  return join(root, name);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cowboy-launch-env-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stageLaunchEnv", () => {
  it("stages nothing for a launch that carries no variables", () => {
    const file = inRoot("env.sh");

    expect(stageLaunchEnv(file, {})).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("writes one exported assignment per variable, owner-only", () => {
    const file = inRoot("env.sh");

    expect(stageLaunchEnv(file, { REVIEW_MODE: "fast" })).toBe(file);
    expect(readFileSync(file, "utf-8")).toBe("export REVIEW_MODE='fast'\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("quotes a value so the shell reads it as bytes", () => {
    const file = inRoot("env.sh");

    stageLaunchEnv(file, { SPACED: "a b'c $(touch nope) `id`" });

    const sourced = runShell(`. '${file}' && printf '%s' "$SPACED"`);
    expect(sourced.out).toBe("a b'c $(touch nope) `id`");
    // Nothing in the value was evaluated by the shell that sourced it.
    expect(existsSync(inRoot("nope"))).toBe(false);
  });
});

describe("launchEnvBody", () => {
  it("leaves the body untouched when the launch carries no variables", () => {
    expect(launchEnvBody(null, `command pi "$@"`)).toBe(`command pi "$@"`);
  });

  it("runs the body with the staged variables and leaves the pane's shell as it was", () => {
    const file = inRoot("env.sh");
    stageLaunchEnv(file, { LAUNCH_ENV_PROBE: "reached" });

    const result = runShell(
      `${launchEnvBody(file, 'printf "%s" "$LAUNCH_ENV_PROBE"')}; printf "|"; printenv LAUNCH_ENV_PROBE || printf "absent"`,
    );

    expect(result.out).toBe("reached|absent");
  });

  it("does not run the body when the env file cannot be read", () => {
    const result = runShell(
      launchEnvBody(inRoot("missing.sh"), 'printf "%s" "ran"'),
    );

    expect(result.out).toBe("");
    expect(result.status).not.toBe(0);
  });
});
