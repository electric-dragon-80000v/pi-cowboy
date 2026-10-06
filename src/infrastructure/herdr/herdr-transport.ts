/**
 * herdr-transport.ts — Layer 1: the raw `herdr` CLI transport.
 *
 * The only module that runs `herdr` and the only one that knows the 0.8.x wire
 * format: a `{ result }` JSON envelope on stdout, a JSON `{ error }` object on
 * stderr at exit 1. Runs through pi.exec so the child inherits the pane's HERDR_*
 * environment. `runHerdr` is the pi-bound entry for callers that hold only the
 * pi instance; it runs one call over a transport it builds itself.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Per-call timeout for herdr control commands (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

/** herdr error text is truncated to this length. */
const ERROR_TEXT_LIMIT = 500;

/** Per-call `HerdrTransport` options. */
export interface HerdrCallOptions {
  /** CLI invocation timeout (ms); defaults to 60s. */
  timeoutMs?: number;
}

/** Non-zero herdr exit; carries herdr's code and message. */
export class HerdrError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

/**
 * Herdr's "the addressed resource does not exist" codes. They are the expected
 * answer to a best-effort teardown or naming (the pane, tab, or agent is already
 * gone) and are the only failures those may treat as success.
 */
const PANE_GONE_CODES: readonly string[] = ["pane_not_found"];
const TAB_GONE_CODES: readonly string[] = ["tab_not_found"];
const AGENT_GONE_CODES: readonly string[] = [
  "agent_not_found",
  "agent_name_not_found",
];

/** True when herdr reported that the pane does not exist. */
export function isPaneGoneError(err: unknown): err is HerdrError {
  return (
    err instanceof HerdrError &&
    err.code !== undefined &&
    PANE_GONE_CODES.includes(err.code)
  );
}

/** True when herdr reported that the tab does not exist. */
export function isTabGoneError(err: unknown): err is HerdrError {
  return (
    err instanceof HerdrError &&
    err.code !== undefined &&
    TAB_GONE_CODES.includes(err.code)
  );
}

/** True when herdr reported that the agent target does not exist. */
export function isAgentGoneError(err: unknown): err is HerdrError {
  return (
    err instanceof HerdrError &&
    err.code !== undefined &&
    AGENT_GONE_CODES.includes(err.code)
  );
}

/**
 * The herdr code of a failure, or undefined when there is none: a killed or
 * timed-out CLI call and an unparseable envelope carry no code, so an absent
 * code marks a failure outside herdr's own error contract.
 */
export function herdrErrorCode(err: unknown): string | undefined {
  return err instanceof HerdrError ? err.code : undefined;
}

/** Herdr's success envelope. */
interface HerdrResult {
  result?: unknown;
}

/**
 * Runs `herdr` for one pi instance and decodes its envelopes. Every namespace
 * and state machine in this folder composes over one transport.
 */
export class HerdrTransport {
  constructor(private readonly pi: ExtensionAPI) {}

  /**
   * Parsed `result` of a herdr command's envelope. A command that exits 0
   * without printing the envelope is a contract violation, not a text result,
   * so it throws instead of handing the caller the raw stdout as its value.
   */
  async call<T = unknown>(args: string[], opts?: HerdrCallOptions): Promise<T> {
    const stdout = await this.exec(args, opts);

    if (!stdout) return undefined as T;
    let parsed: HerdrResult;
    try {
      parsed = JSON.parse(stdout) as HerdrResult;
    } catch {
      throw new HerdrError(
        `herdr ${args.join(" ")} printed no JSON result envelope: ${stdout.slice(0, ERROR_TEXT_LIMIT)}`,
        undefined,
      );
    }
    return parsed.result as T;
  }

  /** Run the CLI; a non-zero exit becomes a HerdrError. */
  private async exec(args: string[], opts?: HerdrCallOptions): Promise<string> {
    const exec = await this.pi.exec("herdr", args, {
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const stdout = exec.stdout.trim();
    const stderr = exec.stderr.trim();

    if (exec.code !== 0) {
      const envelope = parseFailure(stderr);
      const message =
        envelope === undefined
          ? printedFailure(
              printedText(stderr, stdout),
              args.join(" "),
              exec.code,
            )
          : (envelope.message ??
            `herdr reported ${envelope.code ?? "an error"}`);
      throw new HerdrError(message.slice(0, ERROR_TEXT_LIMIT), envelope?.code);
    }
    return stdout;
  }
}

/** Herdr's failure contract: the `{ error: { code?, message? } }` object it prints on stderr. */
interface HerdrFailure {
  code?: string;
  message?: string;
}

/** Herdr's failure envelope, or undefined when stderr is not one — empty and unparseable included. */
function parseFailure(stderr: string): HerdrFailure | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stderr);
  } catch {
    return undefined;
  }
  const error = objectField(parsed, "error");
  return error === undefined
    ? undefined
    : { code: strField(error, "code"), message: strField(error, "message") };
}

/** What herdr printed at all: stderr when it carried something, else stdout; undefined when silent. */
function printedText(stderr: string, stdout: string): string | undefined {
  if (stderr !== "") return stderr;
  return stdout === "" ? undefined : stdout;
}

/** The message for a failure that sent no envelope: herdr's own text, or a statement of silence. */
function printedFailure(
  printed: string | undefined,
  invocation: string,
  exitCode: number,
): string {
  return printed === undefined
    ? `herdr ${invocation} exited ${exitCode} without printing anything`
    : `herdr ${invocation} exited ${exitCode}: ${printed}`;
}

/** The object value at `key` of an unknown value, or undefined when it is not one. */
export function objectField(
  obj: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-empty string field of an unknown value, by key. */
export function strField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A boolean field of an unknown value, by key; undefined when absent or not a boolean. */
export function boolField(obj: unknown, key: string): boolean | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

export async function runHerdr(
  pi: ExtensionAPI,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<unknown> {
  const transport = new HerdrTransport(pi);
  const callOpts =
    opts?.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs };
  return transport.call(args, callOpts);
}
