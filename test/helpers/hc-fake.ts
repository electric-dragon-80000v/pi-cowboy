/**
 * hc-fake.ts — an in-memory herdr-core for the hc-plane suites.
 *
 * Answers `pi.exec("hc", …)` the way the CLI does: JSON on stdout, and a
 * `{ error: { kind, message } }` line on stderr with hc's exit code. Terminals
 * are plain records a test can read and rearrange; `onSend` decides what a
 * typed line does (by default, a line typed at a shell prompt starts a
 * status-reporting agent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type FakeStatus = "idle" | "working" | "done" | "blocked" | "error";

export interface FakeTerminal {
  address: string;
  name: string | undefined;
  parent: string | undefined;
  cwd: string;
  labels: Record<string, string>;
  argv: string[];
  state: "live" | "finished";
  pid: number;
  /** The foreground process; the root pid means the shell is in front. */
  foregroundPid: number;
  foregroundName: string;
  status: FakeStatus | null;
  screen: string;
  sent: string[];
  keys: string[];
  notify: boolean;
}

export interface ExecCall {
  cmd: string;
  args: string[];
}

interface Answer {
  code: number;
  stdout: string;
  stderr: string;
}

const EXIT_CODE: Record<string, number> = {
  not_found: 3,
  invalid_params: 6,
  blocked: 9,
  status_mismatch: 10,
  finished: 11,
};

class HcFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

export class FakeHc {
  readonly terminals = new Map<string, FakeTerminal>();
  /** Addresses whose program ignores `hc kill`. */
  readonly unkillable = new Set<string>();
  readonly calls: ExecCall[] = [];
  /** What a line typed into a live terminal does. */
  onSend: (terminal: FakeTerminal, text: string) => void = (terminal) => {
    if (terminal.foregroundPid === terminal.pid) {
      terminal.foregroundPid = terminal.pid + 1;
      terminal.foregroundName = "pi";
      terminal.status = "idle";
    }
  };
  /** Answers for programs other than hc (herdr-app, git). */
  other: (cmd: string, args: string[]) => Answer = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  });
  private next = 1;

  readonly pi: ExtensionAPI = {
    exec: async (cmd: string, args: string[]) => {
      this.calls.push({ cmd, args: [...args] });
      if (cmd !== "hc") return this.other(cmd, args);
      try {
        const out = this.dispatch(args);
        return {
          code: 0,
          stdout: out === undefined ? "" : JSON.stringify(out),
          stderr: "",
        };
      } catch (err) {
        if (!(err instanceof HcFailure)) throw err;
        return {
          code: EXIT_CODE[err.kind] ?? 1,
          stdout: "",
          stderr: JSON.stringify({
            error: { kind: err.kind, message: err.message },
          }),
        };
      }
    },
  } as unknown as ExtensionAPI;

  /** Add a terminal as if something else had started it. */
  add(partial: Partial<FakeTerminal> & { name?: string }): FakeTerminal {
    const address = partial.address ?? `t${this.next++}`;
    const pid = partial.pid ?? 1000 + this.terminals.size * 10;
    const terminal: FakeTerminal = {
      address,
      name: undefined,
      parent: undefined,
      cwd: "/",
      labels: {},
      argv: ["bash"],
      state: "live",
      pid,
      foregroundPid: pid,
      foregroundName: "bash",
      status: null,
      screen: "",
      sent: [],
      keys: [],
      notify: true,
      ...partial,
    };
    this.terminals.set(address, terminal);
    return terminal;
  }

  /** The hc invocations, by subcommand. */
  hcCalls(command?: string): string[][] {
    return this.calls
      .filter((call) => call.cmd === "hc")
      .map((call) => call.args)
      .filter((args) => command === undefined || args[0] === command);
  }

  private find(target: string): FakeTerminal {
    const terminal =
      this.terminals.get(target) ??
      [...this.terminals.values()].find(
        (t) => t.name === target && t.state === "live",
      );
    if (terminal === undefined) {
      throw new HcFailure("not_found", `no terminal ${target}`);
    }
    return terminal;
  }

  private dispatch(raw: string[]): unknown {
    const [command, json, ...rest] = raw;
    if (json !== "--json") throw new Error(`hc ${command}: --json not second`);
    const { flags, positional } = parseArgs(rest);
    switch (command) {
      case "run":
        return this.run(flags, positional);
      case "get":
        return this.get(this.find(positional[0]!));
      case "ls": {
        const wanted = flags.get("--label") ?? [];
        return {
          hidden_finished: 0,
          terminals: [...this.terminals.values()]
            .filter((t) =>
              wanted.every((pair) => {
                const [k, v] = pair.split("=");
                return t.labels[k!] === v;
              }),
            )
            .map((t) => ({
              address: t.address,
              agent: t.foregroundName,
              cwd: t.cwd,
              ...(t.name === undefined ? {} : { name: t.name }),
              ...(t.parent === undefined ? {} : { parent: t.parent }),
              state: t.state,
              turn: 0,
            })),
        };
      }
      case "send": {
        const terminal = this.find(positional[0]!);
        if (terminal.state === "finished") {
          throw new HcFailure("finished", "finished");
        }
        if (terminal.status === "blocked" && !flags.has("--force")) {
          throw new HcFailure("blocked", "it is waiting on a dialog");
        }
        const onlyIf = flags.get("--if")?.[0];
        if (onlyIf !== undefined && terminal.status !== onlyIf) {
          throw new HcFailure(
            "status_mismatch",
            `status is ${terminal.status ?? "none"}`,
          );
        }
        terminal.sent.push(positional[1]!);
        this.onSend(terminal, positional[1]!);
        return { started: false, status: terminal.status, turn: 0 };
      }
      case "keys": {
        const terminal = this.find(positional[0]!);
        terminal.keys.push(...positional.slice(1));
        return { status: terminal.status, turn: 0 };
      }
      case "read":
        return {
          complete: true,
          how: "history",
          text: this.find(positional[0]!).screen,
        };
      case "kill": {
        const terminal = this.find(positional[0]!);
        if (!this.unkillable.has(terminal.address)) terminal.state = "finished";
        return { killed: terminal.address };
      }
      case "rm": {
        const terminal = this.find(positional[0]!);
        if (terminal.state !== "finished") {
          throw new HcFailure("invalid_params", "still live");
        }
        this.terminals.delete(terminal.address);
        return { removed: terminal.address };
      }
      default:
        throw new Error(`fake hc: unhandled ${command}`);
    }
  }

  private run(flags: Map<string, string[]>, argv: string[]): unknown {
    const name = flags.get("--name")?.[0];
    if (
      name !== undefined &&
      [...this.terminals.values()].some(
        (t) => t.name === name && t.state === "live",
      )
    ) {
      throw new HcFailure("name_taken", `${name} is taken`);
    }
    const labels: Record<string, string> = {};
    for (const pair of flags.get("--label") ?? []) {
      const at = pair.indexOf("=");
      labels[pair.slice(0, at)] = pair.slice(at + 1);
    }
    const terminal = this.add({
      ...(name === undefined ? {} : { name }),
      parent: flags.get("--parent")?.[0],
      cwd: flags.get("--cwd")?.[0] ?? "/",
      labels,
      argv,
      notify: !flags.has("--no-notify"),
    });
    return {
      address: terminal.address,
      agent: "bash",
      cwd: terminal.cwd,
      name: terminal.name,
      parent: terminal.parent,
      state: "live",
      turn: 0,
    };
  }

  private get(t: FakeTerminal): unknown {
    return {
      address: t.address,
      argv: t.argv,
      cwd: t.cwd,
      labels: t.labels,
      name: t.name,
      parent: t.parent ?? null,
      state: t.state,
      pid: t.pid,
      ...(t.state === "live"
        ? {
            foreground: {
              argv: [t.foregroundName],
              cwd: t.cwd,
              name: t.foregroundName,
              pid: t.foregroundPid,
            },
            status: t.status === null ? null : { state: t.status },
          }
        : { status: null }),
    };
  }
}

const VALUED = new Set(["--name", "--cwd", "--parent", "--label", "--if"]);

function parseArgs(args: string[]): {
  flags: Map<string, string[]>;
  positional: string[];
} {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const values = flags.get(arg) ?? [];
      if (VALUED.has(arg)) values.push(args[++i]!);
      flags.set(arg, values);
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}
