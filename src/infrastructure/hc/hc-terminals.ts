/**
 * hc-terminals.ts — herdr-core's terminal resource, typed.
 *
 * Every `hc` command the herdr-core runtime issues goes through here, and every
 * record it reads back is narrowed from `unknown` here: the rest of the runtime
 * sees `HcTerminal`, never hc's JSON.
 */

import { HcError, HcTransport, isTerminalGoneError } from "./hc-transport.js";

/** The statuses a program reports through OSC 7501. */
export type HcStatus = "idle" | "working" | "done" | "blocked" | "error";

const HC_STATUSES: readonly string[] = [
  "idle",
  "working",
  "done",
  "blocked",
  "error",
];

/** The process in a live terminal's foreground. */
export interface HcForeground {
  readonly pid: number;
  readonly name: string;
}

interface HcTerminalBase {
  readonly address: string;
  readonly name: string | undefined;
  /** The terminal it was started from; children are grouped beneath it. */
  readonly parent: string | undefined;
  /** Launch folder. */
  readonly cwd: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * One terminal as `hc get` reports it. A finished terminal has no foreground
 * and no status to report, so those fields exist only on a live one.
 */
export type HcTerminal =
  | (HcTerminalBase & { readonly state: "finished" })
  | (HcTerminalBase & {
      readonly state: "live";
      /** The terminal's root process (the shell this runtime starts). */
      readonly pid: number;
      /** The program's last OSC 7501 report; null when it reports none or the root shell is back in front. */
      readonly status: HcStatus | null;
      readonly foreground: HcForeground | undefined;
    });

/** One `hc ls` row: enough to find a terminal, not to judge its state. */
export interface HcTerminalSummary {
  readonly address: string;
  readonly name: string | undefined;
  readonly parent: string | undefined;
  readonly cwd: string;
  readonly state: "live" | "finished";
}

/** Whether a live terminal's foreground is its root shell — nothing to talk to but a prompt. */
export function shellInForeground(
  terminal: Extract<HcTerminal, { state: "live" }>,
): boolean {
  return (
    terminal.foreground === undefined ||
    terminal.foreground.pid === terminal.pid
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function labelsOf(value: unknown): Record<string, string> {
  const entries = record(value);
  const out: Record<string, string> = {};
  if (entries === undefined) return out;
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function statusOf(value: unknown): HcStatus | null {
  // hc reports `status` as an object ({app, state, …}) or null.
  const state = str(record(value)?.state) ?? str(value);
  return state !== undefined && HC_STATUSES.includes(state)
    ? (state as HcStatus)
    : null;
}

function foregroundOf(value: unknown): HcForeground | undefined {
  const fg = record(value);
  if (fg === undefined) return undefined;
  const pid = fg.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return undefined;
  return { pid, name: str(fg.name) ?? "" };
}

/** Narrow one `hc get` record; undefined when it is not one. */
export function parseTerminal(value: unknown): HcTerminal | undefined {
  const raw = record(value);
  const address = str(raw?.address);
  if (raw === undefined || address === undefined) return undefined;
  const base: HcTerminalBase = {
    address,
    name: str(raw.name),
    parent: str(raw.parent),
    cwd: str(raw.cwd) ?? "",
    labels: labelsOf(raw.labels),
  };
  if (raw.state === "finished") return { ...base, state: "finished" };
  if (raw.state !== "live") return undefined;
  const pid = raw.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return undefined;
  return {
    ...base,
    state: "live",
    pid,
    status: statusOf(raw.status),
    foreground: foregroundOf(raw.foreground),
  };
}

function parseSummary(value: unknown): HcTerminalSummary | undefined {
  const raw = record(value);
  const address = str(raw?.address);
  if (raw === undefined || address === undefined) return undefined;
  if (raw.state !== "live" && raw.state !== "finished") return undefined;
  return {
    address,
    name: str(raw.name),
    parent: str(raw.parent),
    cwd: str(raw.cwd) ?? "",
    state: raw.state,
  };
}

/** What `hc run` needs to start a terminal this runtime owns. */
export interface HcRunRequest {
  readonly name: string;
  readonly cwd: string;
  /** The terminal it is filed under — always explicit, never hc's own default. */
  readonly parent: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
}

/** Commands against hc's terminals. Throws HcError unless a method says otherwise. */
export class HcTerminals {
  constructor(private readonly transport: HcTransport) {}

  /** Start a background terminal; resolves to its address. */
  async run(request: HcRunRequest): Promise<string> {
    const labels = Object.entries(request.labels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]);
    const result = await this.transport.call([
      "run",
      "--bg",
      // Cowboy reports a child's end itself; hc's own exit note would be typed
      // into the parent's chat as a second, unasked-for message.
      "--no-notify",
      "--name",
      request.name,
      "--cwd",
      request.cwd,
      "--parent",
      request.parent,
      ...labels,
      "--",
      ...request.argv,
    ]);
    const address = str(record(result)?.address);
    if (address === undefined) {
      throw new HcError(
        `hc run printed no terminal address: ${JSON.stringify(result).slice(0, 300)}`,
        undefined,
      );
    }
    return address;
  }

  /** One terminal, finished ones included; undefined when hc has no such terminal. */
  async get(target: string): Promise<HcTerminal | undefined> {
    let result: unknown;
    try {
      result = await this.transport.call(["get", target]);
    } catch (err) {
      if (isTerminalGoneError(err)) return undefined;
      throw err;
    }
    const terminal = parseTerminal(result);
    if (terminal === undefined) {
      throw new HcError(
        `hc get ${target} returned an unreadable terminal: ${JSON.stringify(result).slice(0, 300)}`,
        undefined,
      );
    }
    return terminal;
  }

  /** Every terminal carrying all of `labels`, finished ones included. */
  async list(
    labels: Readonly<Record<string, string>>,
  ): Promise<readonly HcTerminalSummary[]> {
    const filters = Object.entries(labels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]);
    const result = await this.transport.call(["ls", "--all", ...filters]);
    const rows = record(result)?.terminals;
    if (!Array.isArray(rows)) {
      throw new HcError(
        `hc ls returned no terminals array: ${JSON.stringify(result).slice(0, 300)}`,
        undefined,
      );
    }
    const out: HcTerminalSummary[] = [];
    for (const row of rows) {
      const summary = parseSummary(row);
      if (summary !== undefined) out.push(summary);
    }
    return out;
  }

  /**
   * Paste text and press Enter. `onlyIf` makes hc itself refuse unless the
   * program reports exactly that status (`status_mismatch`), so the check and
   * the write cannot be separated by a status change. hc refuses a `blocked`
   * program on its own.
   */
  async send(
    target: string,
    text: string,
    onlyIf?: "idle" | "working",
  ): Promise<void> {
    await this.transport.call([
      "send",
      ...(onlyIf === undefined ? [] : ["--if", onlyIf]),
      // A message may begin with `-`; it is text, never an option.
      "--",
      target,
      text,
    ]);
  }

  /** Press named keys, in order. */
  async keys(target: string, keys: readonly string[]): Promise<void> {
    await this.transport.call(["keys", "--", target, ...keys]);
  }

  /** Screen text plus `lines` of history (0: the visible screen only). */
  async read(target: string, lines: number): Promise<string> {
    const result = await this.transport.call([
      "read",
      target,
      "--lines",
      String(lines),
    ]);
    const text = record(result)?.text;
    if (typeof text !== "string") {
      throw new HcError(
        `hc read ${target} returned no text: ${JSON.stringify(result).slice(0, 300)}`,
        undefined,
      );
    }
    return text;
  }

  /** End a terminal's program. A terminal hc no longer has is already ended. */
  async kill(target: string): Promise<void> {
    try {
      await this.transport.call(["kill", target]);
    } catch (err) {
      if (isTerminalGoneError(err)) return;
      throw err;
    }
  }

  /** Remove a finished terminal. A terminal hc no longer has is already removed. */
  async remove(target: string): Promise<void> {
    try {
      await this.transport.call(["rm", target]);
    } catch (err) {
      if (isTerminalGoneError(err)) return;
      throw err;
    }
  }
}
