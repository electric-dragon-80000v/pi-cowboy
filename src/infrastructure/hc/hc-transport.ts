/**
 * hc-transport.ts — the raw `hc` (herdr-core) CLI transport.
 *
 * The only module that runs `hc` and the only one that knows its wire format:
 * JSON on stdout under `--json`, and a `{ error: { kind, message, hint } }`
 * object on stderr with a non-zero exit. Runs through pi.exec (argv, no shell),
 * so the CLI inherits this process's `HC_TERMINAL_ID`/`HC_TERMINAL_SOCKET` — the
 * session it talks to and the terminal it speaks for are the ones pi runs in.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Per-call timeout for hc control commands (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** hc error text is truncated to this length. */
const ERROR_TEXT_LIMIT = 500;

/** The program this transport runs. */
export const HC_BINARY = "hc";

/** Non-zero hc exit; carries hc's error kind and message. */
export class HcError extends Error {
  constructor(
    message: string,
    /** hc's own error kind (`not_found`, `blocked`, …); absent when the failure is outside hc's error contract. */
    readonly kind: string | undefined,
  ) {
    super(message);
    this.name = "HcError";
  }
}

/** The hc error kind of a failure, or undefined when there is none. */
export function hcErrorKind(err: unknown): string | undefined {
  return err instanceof HcError ? err.kind : undefined;
}

/** True when hc reported that the addressed terminal does not exist. */
export function isTerminalGoneError(err: unknown): err is HcError {
  return err instanceof HcError && err.kind === "not_found";
}

/** Runs `hc` for one pi instance and decodes its JSON. */
export class HcTransport {
  constructor(private readonly pi: ExtensionAPI) {}

  /**
   * The parsed JSON a command printed. `--json` is always passed: the CLI
   * prints prose to a terminal, and a caller must not depend on whether pi.exec
   * happens to give it one. It goes straight after the subcommand, because
   * everything after a caller's `--` is positional.
   */
  async call(
    args: readonly [string, ...string[]],
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    const [command, ...rest] = args;
    const stdout = await this.run([command, "--json", ...rest], opts);
    if (stdout === "") return undefined;
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new HcError(
        `hc ${args.join(" ")} printed no JSON: ${stdout.slice(0, ERROR_TEXT_LIMIT)}`,
        undefined,
      );
    }
  }

  private async run(
    args: readonly string[],
    opts?: { timeoutMs?: number },
  ): Promise<string> {
    const result = await this.pi.exec(HC_BINARY, [...args], {
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      const failure = parseFailure(result.stderr.trim());
      const printed = (result.stderr.trim() || result.stdout.trim()).slice(
        0,
        ERROR_TEXT_LIMIT,
      );
      const message =
        failure?.message ??
        `hc ${args.join(" ")} exited with code ${result.code}${printed === "" ? "" : `: ${printed}`}`;
      throw new HcError(message.slice(0, ERROR_TEXT_LIMIT), failure?.kind);
    }
    return result.stdout.trim();
  }
}

/** hc's failure envelope, or undefined when stderr is not one. */
function parseFailure(
  stderr: string,
): { kind: string | undefined; message: string | undefined } | undefined {
  // The envelope is the last line; earlier lines can be warnings.
  const line = stderr.split("\n").at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    return undefined;
  }
  const error: unknown = parsed.error;
  if (typeof error !== "object" || error === null) return undefined;
  const kind =
    "kind" in error && typeof error.kind === "string" ? error.kind : undefined;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : undefined;
  return { kind, message };
}
