/**
 * hc-host.ts — AgentHost + AgentView + PaneControl over herdr-core (`hc`).
 *
 * herdr-core is the terminal core behind Herdr Desktop. It has no workspaces,
 * tabs or worktrees: it runs terminals, and a terminal started with a `parent`
 * is that terminal's child — Herdr Desktop shows it beneath its parent's tab as
 * a sub-agent, and hc ends it with its parent. So every placement here is a
 * terminal of its own, started with the spawning session's own
 * `HC_TERMINAL_ID` as its parent. Nothing else decides where a child is filed:
 * two chats in one repository each get their own children.
 *
 * A placement runs an interactive bash the harness types its launcher into,
 * exactly as it would into a herdr pane; the agent's status comes from its own
 * OSC 7501 reports (pi sends them), read back through `hc get`.
 *
 * Built once per parent session at the composition root.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentHost,
  AgentHostRef,
  AgentView,
  DeliverOutcome,
  ExecutionRuntime,
  HostObservation,
  LiveAttempt,
  PaneControl,
  PlacementCatalog,
  PlacementRecord,
  PlacementWorktree,
  ViewRequest,
} from "../agents/agent-host.js";
import { HERDR_CORE, hcTerminalId } from "../host-multiplexer.js";
import { createLogger } from "../logger.js";
import { canonicalPath } from "../paths.js";
import {
  AGENT_NAME_INDEX_MAX,
  HERDR_AGENT_NAME_MAX_LENGTH,
  agentNameWithIndex,
  isTaskAgentName,
} from "../predicates.js";
import { errorMessage, sleep } from "../utils.js";
import { removeGitWorktree } from "./git-client.js";
import {
  HcTerminals,
  shellInForeground,
  type HcTerminal,
} from "./hc/hc-terminals.js";
import { HcError, HcTransport, hcErrorKind } from "./hc/hc-transport.js";

const log = createLogger("hc-host");

/** The label every terminal this extension starts carries, so `hc ls` finds them. */
const OWNER_LABEL = "cowboy";
const OWNER_VALUE = "1";
/** The agent identity the terminal was started for (its hc name, kept even if renamed). */
const AGENT_LABEL = "cowboy.agent";
/** The checkout an adopted placement works in, and its main checkout. */
const CHECKOUT_LABEL = "cowboy.checkout";
const REPO_LABEL = "cowboy.repo";

/**
 * The shell a placement runs. Harness launchers are POSIX shell functions read
 * back with `typeset -f`, so the shell is fixed rather than the user's own (hc
 * otherwise starts the account's shell, which may be fish or nu). No rc files:
 * the core's login environment already carries PATH, and a user's rc must not
 * decide what a launch types into.
 */
const PLACEMENT_SHELL = ["bash", "--noprofile", "--norc", "-i"] as const;

/** How long `start` watches for the agent to take the foreground before handing over (ms). */
const START_READY_TIMEOUT_MS = 15_000;
/** Default budget for `waitUntilGone` (ms). */
const GONE_TIMEOUT_MS = 15_000;
/** Budget for a killed terminal to report finished before it is removed (ms). */
const KILL_SETTLE_TIMEOUT_MS = 5_000;
/** History lines `waitForOutput` searches. */
const OUTPUT_HISTORY_LINES = 200;

/** Tunables a test shortens; production uses the defaults. */
export interface HcRuntimeOptions {
  readonly pollIntervalMs?: number;
  /** How long a killed terminal has to finish before a close gives up. */
  readonly killSettleMs?: number;
}

type LiveTerminal = Extract<HcTerminal, { state: "live" }>;

/** Where an adopted placement's checkout lives, for releasing it with the placement. */
interface CheckoutCoordinates {
  readonly path: string;
  readonly repoCwd: string;
}

/**
 * The hc name for an agent identity: hc allows 1-32 of `a-z 0-9 - _ .`,
 * starting with a letter or digit and not shaped like a terminal id (`t7`).
 * Branch-derived identities (`cow-<task>-<id>`) already qualify; a free-text
 * label is folded into that alphabet.
 */
export function hcTerminalName(identity: string): string {
  let name = identity
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, HERDR_AGENT_NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  if (name === "" || /^t\d+[a-z]?$/.test(name)) {
    name = `cowboy-${name}`.slice(0, HERDR_AGENT_NAME_MAX_LENGTH);
  }
  return name;
}

/**
 * The names a placement may take, in order, numbered as herdr numbers its
 * spots: `<base>-1` up to `<base>-9`, with the bare base standing in for spot 1
 * only when no suffix fits the name limit.
 */
function spotNames(base: string): string[] {
  const names: string[] = [];
  for (let index = 1; index <= AGENT_NAME_INDEX_MAX; index++) {
    if (base.length + String(index).length + 1 > HERDR_AGENT_NAME_MAX_LENGTH) {
      if (index === 1) names.push(base);
      break;
    }
    names.push(agentNameWithIndex(base, index));
  }
  return names;
}

function quoteWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Whether a terminal is the one this runtime started for `ref`. */
function owns(terminal: HcTerminal, ref: AgentHostRef): boolean {
  return (
    terminal.labels[OWNER_LABEL] === OWNER_VALUE &&
    terminal.labels[AGENT_LABEL] === ref.name
  );
}

/**
 * A live terminal's agent state, or undefined when no agent runs there. The
 * root shell back in the foreground is an agent that has exited; a program
 * that reports no status is running but unreadable.
 */
function observationOf(terminal: HcTerminal): HostObservation | undefined {
  if (terminal.state === "finished") return undefined;
  if (shellInForeground(terminal)) return undefined;
  switch (terminal.status) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return { state: terminal.status };
    case "error":
    case null:
      return { state: "unknown" };
  }
}

function checkoutOf(terminal: HcTerminal): CheckoutCoordinates | undefined {
  const { labels } = terminal;
  return Object.hasOwn(labels, CHECKOUT_LABEL) &&
    Object.hasOwn(labels, REPO_LABEL)
    ? { path: labels[CHECKOUT_LABEL], repoCwd: labels[REPO_LABEL] }
    : undefined;
}

function canonical(value: string): string {
  return canonicalPath(value) ?? path.resolve(value);
}

/** The hc surface every part of the runtime shares. */
class HcRuntimeCore {
  readonly terminals: HcTerminals;
  readonly pollIntervalMs: number;
  readonly killSettleMs: number;

  constructor(
    readonly pi: ExtensionAPI,
    options: HcRuntimeOptions,
  ) {
    this.terminals = new HcTerminals(new HcTransport(pi));
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.killSettleMs = options.killSettleMs ?? KILL_SETTLE_TIMEOUT_MS;
  }

  /** Poll until `probe` answers, or undefined once `timeoutMs` has passed. */
  async poll<T>(
    timeoutMs: number,
    probe: () => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const answer = await probe();
      if (answer !== undefined) return answer;
      if (Date.now() >= deadline) return undefined;
      await sleep(this.pollIntervalMs);
    }
  }

  /** The live terminal a pane address names, or undefined when it is not live. */
  async liveTerminal(paneId: string): Promise<LiveTerminal | undefined> {
    const terminal = await this.terminals.get(paneId);
    return terminal?.state === "live" ? terminal : undefined;
  }

  /** Every terminal this extension started, finished ones included, read in full. */
  async ownedTerminals(): Promise<HcTerminal[]> {
    const rows = await this.terminals.list({ [OWNER_LABEL]: OWNER_VALUE });
    const out: HcTerminal[] = [];
    for (const row of rows) {
      const terminal = await this.terminals.get(row.address);
      if (terminal !== undefined) out.push(terminal);
    }
    return out;
  }

  /**
   * End and remove a terminal. Killing a finished terminal is a no-op and a
   * terminal hc no longer has is already gone, so this is idempotent.
   */
  /** Kill and remove a terminal; answers false when it is still live after the settle window. */
  async close(address: string): Promise<boolean> {
    await this.terminals.kill(address);
    const settled = await this.poll(this.killSettleMs, async () => {
      const terminal = await this.terminals.get(address);
      return terminal === undefined || terminal.state === "finished"
        ? true
        : undefined;
    });
    if (settled !== true) return false;
    await this.terminals.remove(address);
    return true;
  }
}

function createHcView(pi: ExtensionAPI): AgentView {
  return {
    // herdr-app drives the window; `agent.focus` shows a sub-agent beneath
    // its parent's tab, which is where an unlabeled child lives.
    focus: async (ref) => {
      const result = await pi.exec(
        "herdr-app",
        ["do", "agent.focus", "--terminal", ref.paneId],
        { timeout: 15_000 },
      );
      if (result.code !== 0) {
        const printed = (result.stderr.trim() || result.stdout.trim()).slice(
          0,
          300,
        );
        throw new HcError(
          `herdr-app could not show terminal ${ref.paneId}${printed === "" ? "" : `: ${printed}`}`,
          undefined,
        );
      }
    },
  };
}

function createHcHost(core: HcRuntimeCore): AgentHost {
  const { terminals, pi } = core;
  /** Checkouts adopted by this session's placements, by terminal address. */
  const checkouts = new Map<string, CheckoutCoordinates>();

  const observe = async (
    ref: AgentHostRef,
  ): Promise<HostObservation | undefined> => {
    const terminal = await terminals.get(ref.paneId);
    if (terminal === undefined || !owns(terminal, ref)) return undefined;
    return observationOf(terminal);
  };

  /**
   * Close the terminal `ref` names, when it is still the one this runtime
   * started. Answers whether the address is now free of a live terminal: one
   * that is not this agent's is left running and answers false.
   */
  const closeOwned = async (ref: AgentHostRef): Promise<boolean> => {
    const terminal = await terminals.get(ref.paneId);
    if (terminal === undefined) return true;
    if (!owns(terminal, ref)) return terminal.state === "finished";
    return core.close(ref.paneId);
  };

  /**
   * Whether another of this extension's live terminals works in `checkout`. A
   * failed read answers yes: a sibling that cannot be ruled out is not one a
   * release may remove the checkout from under.
   */
  const hasSiblingIn = async (
    checkout: string,
    self: string,
  ): Promise<boolean> => {
    try {
      const wanted = canonical(checkout);
      return (await core.ownedTerminals()).some(
        (terminal) =>
          terminal.address !== self &&
          terminal.state === "live" &&
          canonical(terminal.cwd) === wanted,
      );
    } catch {
      return true;
    }
  };

  return {
    hostAt: async (request: ViewRequest): Promise<AgentHostRef> => {
      const parent = hcTerminalId();
      if (parent === undefined) {
        throw new HcError(
          "cannot place an agent: this process has no HC_TERMINAL_ID, so there is no herdr-core terminal to file it under",
          undefined,
        );
      }
      const cwd = request.checkout?.path ?? request.cwd;
      // The identity is what cleanup later names the agent by (its branch);
      // the terminal's hc name is only a free spot derived from it.
      const identity = request.name ?? request.label;
      const base = hcTerminalName(identity);
      for (const name of spotNames(base)) {
        let address: string;
        try {
          address = await terminals.run({
            name,
            cwd,
            parent,
            labels: {
              [OWNER_LABEL]: OWNER_VALUE,
              [AGENT_LABEL]: identity,
              ...(request.checkout === undefined
                ? {}
                : {
                    [CHECKOUT_LABEL]: request.checkout.path,
                    [REPO_LABEL]: request.checkout.repoCwd,
                  }),
            },
            argv: PLACEMENT_SHELL,
          });
        } catch (err) {
          // hc keeps names unique among live terminals, so a taken name is
          // the next spot's turn rather than a failure.
          if (hcErrorKind(err) === "name_taken") continue;
          throw err;
        }
        if (request.checkout !== undefined) {
          checkouts.set(address, {
            path: request.checkout.path,
            repoCwd: request.checkout.repoCwd,
          });
        }
        return {
          multiplexer: HERDR_CORE,
          name: identity,
          paneId: address,
          // hc has no workspaces: the terminal is the whole placement, so it is
          // the space cleanup tears down and the only tenant in it.
          workspaceId: address,
          paneCreated: true,
        };
      }
      throw new HcError(
        `"${base}" has no free terminal name left (spots 1-${AGENT_NAME_INDEX_MAX}) — stop or clean one up before spawning another`,
        "name_taken",
      );
    },

    start: async (ref, options) => {
      const terminal = await core.liveTerminal(ref.paneId);
      if (terminal === undefined || !owns(terminal, ref)) {
        throw new HcError(
          `cannot start ${options.name}: terminal ${ref.paneId} is not this agent's placement any more`,
          "not_found",
        );
      }
      if (!shellInForeground(terminal)) {
        throw new HcError(
          `cannot start ${options.name}: terminal ${ref.paneId} is already running ${terminal.foreground?.name ?? "a program"}`,
          undefined,
        );
      }
      // The kind is the command typed into the placement's shell, so a
      // harness's launcher function (installed by `prepare` under that name)
      // resolves it ahead of any binary on PATH.
      await terminals.send(
        ref.paneId,
        [options.agentMultiplexerKind, ...options.piArgs]
          .map(quoteWord)
          .join(" "),
      );
      // Returns once the agent holds the foreground. A slow boot is not a
      // failed one: retrying would start a second agent, so a launch that has
      // not shown itself within the budget is left to the supervisor.
      const started = await core.poll(START_READY_TIMEOUT_MS, async () => {
        const now = await terminals.get(ref.paneId);
        if (now === undefined || now.state === "finished") return "ended";
        return shellInForeground(now) ? undefined : "running";
      });
      if (started === "ended") {
        throw new HcError(
          `terminal ${ref.paneId} ended while ${options.name} was starting`,
          "finished",
        );
      }
      if (started === undefined) {
        log.debug("agent not yet in the foreground", { paneId: ref.paneId });
      }
    },

    observe,

    waitUntilGone: async (ref, options) => {
      const gone = await core.poll(
        options?.timeoutMs ?? GONE_TIMEOUT_MS,
        async () => {
          try {
            return (await observe(ref)) === undefined ? true : undefined;
          } catch {
            // Unreadable is not gone.
            return undefined;
          }
        },
      );
      return gone === true;
    },

    release: async (ref, scope) => {
      try {
        if (scope === "placement") {
          return ref.paneCreated ? await closeOwned(ref) : true;
        }
        const terminal = await terminals.get(ref.paneId);
        const checkout =
          checkouts.get(ref.paneId) ??
          (terminal !== undefined && owns(terminal, ref)
            ? checkoutOf(terminal)
            : undefined);
        if (checkout === undefined) {
          log.debug("no checkout recorded for placement", {
            paneId: ref.paneId,
          });
          return false;
        }
        if (await hasSiblingIn(checkout.path, ref.paneId)) return false;
        if (!(await closeOwned(ref))) return false;
        await removeGitWorktree(pi, checkout.repoCwd, checkout.path);
        if (fs.existsSync(checkout.path)) return false;
        checkouts.delete(ref.paneId);
        return true;
      } catch (err) {
        log.debug("release failed", {
          paneId: ref.paneId,
          scope,
          error: errorMessage(err),
        });
        return false;
      }
    },

    isAttached: async (worktreePath) => {
      const wanted = canonical(worktreePath);
      return (await core.ownedTerminals()).some(
        (terminal) =>
          terminal.state === "live" && canonical(terminal.cwd) === wanted,
      );
    },

    findAttempts: async (taskSlug): Promise<LiveAttempt[]> => {
      let rows;
      try {
        rows = await terminals.list({ [OWNER_LABEL]: OWNER_VALUE });
      } catch {
        return [];
      }
      const attempts: LiveAttempt[] = [];
      for (const row of rows) {
        if (row.state !== "live") continue;
        if (row.name !== undefined && isTaskAgentName(row.name, taskSlug)) {
          attempts.push({ name: row.name });
          continue;
        }
        const base = path.basename(row.cwd);
        if (isTaskAgentName(base, taskSlug)) attempts.push({ name: base });
      }
      return attempts;
    },
  };
}

function notSubmitted(detail: string): DeliverOutcome {
  return { kind: "not-submitted", detail: `${detail}; nothing was submitted.` };
}

function createHcPane(core: HcRuntimeCore): PaneControl {
  const { terminals } = core;

  const waitFor = async (
    paneId: string,
    output: string,
    lines: number,
    timeoutMs: number,
  ): Promise<void> => {
    const seen = await core.poll(timeoutMs, async () =>
      (await terminals.read(paneId, lines)).includes(output) ? true : undefined,
    );
    if (seen !== true) {
      throw new HcError(
        `terminal ${paneId} did not print "${output}" within ${timeoutMs}ms`,
        "timeout",
      );
    }
  };

  return {
    kind: HERDR_CORE,
    // Shell typing is only for the placement's own prompt: a command typed
    // while an agent holds the foreground would arrive as a chat message.
    run: async (paneId, command) => {
      const terminal = await core.liveTerminal(paneId);
      if (terminal === undefined) {
        throw new HcError(`terminal ${paneId} is not live`, "not_found");
      }
      if (!shellInForeground(terminal)) {
        throw new HcError(
          `refusing to type a shell command into terminal ${paneId}: ${terminal.foreground?.name ?? "a program"} holds its foreground`,
          undefined,
        );
      }
      await terminals.send(paneId, command);
    },
    // A harness's exit keys belong to its TUI. With the shell back in front
    // there is no agent to press them at, and pressing ctrl+d there would end
    // the placement's shell instead.
    sendKeys: async (paneId, keys) => {
      const terminal = await core.liveTerminal(paneId);
      if (terminal === undefined || shellInForeground(terminal)) return;
      await terminals.keys(paneId, keys);
    },
    // Delivered only to an agent that says what it is doing. The shell in
    // front, a program that reports no status, or one waiting on an approval
    // is refused before anything is typed; idle and working are re-checked by
    // hc itself (`--if`) in the same call that types, so a status change in
    // between refuses rather than lands.
    promptAgent: async (paneId, message): Promise<DeliverOutcome> => {
      let terminal: LiveTerminal | undefined;
      try {
        terminal = await core.liveTerminal(paneId);
      } catch (err) {
        return notSubmitted(
          `herdr-core could not read terminal ${paneId} (${errorMessage(err)})`,
        );
      }
      if (terminal === undefined) {
        return notSubmitted(`terminal ${paneId} is not live`);
      }
      if (shellInForeground(terminal)) {
        return notSubmitted(
          `terminal ${paneId} is at its shell prompt, not an agent`,
        );
      }
      switch (terminal.status) {
        case null:
          return notSubmitted(
            `the program in terminal ${paneId} reports no status, so an approval dialog cannot be ruled out`,
          );
        case "blocked":
          return notSubmitted(
            `the agent in terminal ${paneId} is waiting on an approval`,
          );
        case "idle":
        case "working":
        case "done":
        case "error":
          break;
      }
      // done and error are turn ends hc's `--if` cannot name; between them
      // and idle the agent is waiting for input, and hc still refuses blocked.
      const onlyIf = terminal.status === "working" ? "working" : "idle";
      const precondition =
        terminal.status === "idle" || terminal.status === "working"
          ? onlyIf
          : undefined;
      try {
        await terminals.send(paneId, message, precondition);
        return { kind: "submitted" };
      } catch (err) {
        const kind = hcErrorKind(err);
        return notSubmitted(
          `the agent's terminal did not take the message (${kind === undefined ? "" : `${kind}: `}${errorMessage(err)})`,
        );
      }
    },
    waitForVisibleOutput: (paneId, output, timeoutMs) =>
      waitFor(paneId, output, 0, timeoutMs),
    waitForOutput: (paneId, output, timeoutMs) =>
      waitFor(paneId, output, OUTPUT_HISTORY_LINES, timeoutMs),
  };
}

/**
 * herdr-core's placements: the terminals this extension started. Each is its
 * own space, so a record's workspace is its own address.
 */
function createHcPlacements(core: HcRuntimeCore): PlacementCatalog {
  return {
    multiplexer: HERDR_CORE,
    canonicalizePath: canonical,
    listWorktrees: async (): Promise<PlacementWorktree[]> =>
      (await core.ownedTerminals()).flatMap((terminal) => {
        const checkout = checkoutOf(terminal);
        if (checkout === undefined) return [];
        return [
          {
            path: canonical(checkout.path),
            branch: path.basename(checkout.path),
            workspaceId: terminal.address,
          },
        ];
      }),
    listPlacements: async (): Promise<PlacementRecord[]> =>
      (await core.ownedTerminals()).flatMap((terminal) => {
        const observation = observationOf(terminal);
        if (observation === undefined) return [];
        return [
          {
            name: terminal.labels[AGENT_LABEL] ?? terminal.name,
            state: observation.state,
            workspaceId: terminal.address,
            cwd: terminal.cwd,
            paneId: terminal.address,
          },
        ];
      }),
    observePane: async (paneId) => {
      const terminal = await core.terminals.get(paneId);
      return terminal === undefined ? undefined : observationOf(terminal);
    },
  };
}

export function createHcRuntime(
  pi: ExtensionAPI,
  options: HcRuntimeOptions = {},
): ExecutionRuntime {
  const core = new HcRuntimeCore(pi, options);
  return {
    host: createHcHost(core),
    view: createHcView(pi),
    pane: createHcPane(core),
    placements: createHcPlacements(core),
    multiplexer: HERDR_CORE,
  };
}
