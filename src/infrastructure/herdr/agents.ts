/**
 * agents.ts — Layer 2: herdr agent resources.
 *
 * Start an agent into a pane, read the registry, send it input. One non-obvious
 * rule: herdr's start-CLI readiness gate is meaningless for a subagent launched
 * with an input message, so a readiness timeout is success here and only a
 * transient "not an available shell" rejection is retried (retries are Layer 1
 * polling).
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../logger.js";
// isTaskAgentName lives in src/predicates.ts (shared leaf) so this layer never
// imports across into spawn/.
import { isTaskAgentName } from "../../predicates.js";
import type { LiveAttempt } from "../../task-registry.js";
import { errorMessage } from "../../utils.js";
import {
  HerdrError,
  HerdrTransport,
  herdrErrorCode,
  isAgentGoneError,
  objectField,
  strField,
} from "./herdr-transport.js";
import { keepPolling, pollUntil, settled } from "./polling.js";

const log = createLogger("herdr.agents");

// --- Constants ---

/**
 * `herdr agent start` timeout (ms), at herdr's minimum (the CLI requires >3000).
 * The gate it waits for ("ready for interactive input" = `idle`) never arrives for
 * a subagent launched with an input message — it goes straight to `working` — so
 * a `cli:agent:start:timeout` means "spawn accepted, pi booting".
 */
export const AGENT_START_TIMEOUT_MS = 5_000;

/**
 * Max `herdr agent start` attempts. Only transient pre-start rejections (a fresh
 * tab's shell not yet at its prompt) are retried; readiness timeouts mean the
 * spawn was accepted and are never retried.
 */
export const AGENT_START_MAX_ATTEMPTS = 5;

/** Agent-start retry base delay (ms); grows linearly (base * attempt). */
export const AGENT_START_RETRY_BASE_DELAY_MS = 500;

/** Extra budget for the start CLI call itself beyond the start timeout (ms). */
const AGENT_START_CALL_SLACK_MS = 30_000;

/** Agent command budget (ms). */
const AGENT_COMMAND_TIMEOUT_MS = 15_000;

// --- Types ---

/** Agent state as reported by herdr (`done` is the unseen-background idle state). */
export type HerdrAgentState =
  "idle" | "working" | "blocked" | "done" | "unknown";

/** Snapshot of one herdr agent (from `herdr agent list`). */
export interface HerdrAgentInfo {
  /** Custom herdr name, when present. Herdr 0.8.x usually drops it (see `listAgentRecords`). */
  name?: string;
  state: HerdrAgentState;
  /** Workspace containing the agent pane, when available. */
  workspaceId?: string;
  /** Tab containing the agent pane, when available. */
  tabId?: string;
  /** The pane's working directory: the durable link from a nameless record to its worktree. */
  cwd?: string;
  paneId: string;
  interactiveReady: boolean;
}

/** Agent registry namespace. */
export class HerdrAgents {
  constructor(private readonly transport: HerdrTransport) {}

  /**
   * Start pi in the pane as a herdr agent. Returns when herdr accepted the spawn —
   * NOT when pi is ready. Readiness timeouts return normally (the name is
   * registered and pi is booting; retrying would start a second agent); transient
   * pre-start rejections are retried with backoff; permanent errors propagate.
   */
  async startPiAgent(options: {
    name: string;
    paneId: string;
    piArgs: string[];
  }): Promise<void> {
    let lastError: unknown;
    const started = await pollUntil<true>(
      async () => {
        try {
          await this.transport.call(
            [
              "agent",
              "start",
              options.name,
              "--kind",
              "pi",
              "--pane",
              options.paneId,
              "--timeout",
              String(AGENT_START_TIMEOUT_MS),
              "--",
              ...options.piArgs,
            ],
            { timeoutMs: AGENT_START_TIMEOUT_MS + AGENT_START_CALL_SLACK_MS },
          );
          return settled(true);
        } catch (err) {
          // Spawn accepted but readiness never observed — never retry (a retry
          // would start a second agent).
          if (isNonFatalStartError(err)) return settled(true);
          lastError = withHerdrCode(err);
          if (!isTransientAgentStartError(err)) {
            // A refusal reports herdr's name bookkeeping, not whether a launch
            // happened: the agent may be running under a name herdr dropped, or a
            // name this same launch now holds.
            if (await this.paneHostsAgent(options.paneId)) return settled(true);
            throw lastError;
          }
          return keepPolling();
        }
      },
      {
        intervalMs: (attempt) => AGENT_START_RETRY_BASE_DELAY_MS * attempt,
        maxAttempts: AGENT_START_MAX_ATTEMPTS,
      },
    );
    if (started) return;

    // Every attempt was refused as a pre-start rejection, but a pane that hosts an
    // agent now is a launch that happened.
    if (await this.paneHostsAgent(options.paneId)) return;

    const msg =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new HerdrError(
      `herdr agent start failed after ${AGENT_START_MAX_ATTEMPTS} attempts (the target pane never became an available shell): ${msg}`,
      lastError instanceof HerdrError ? lastError.code : undefined,
    );
  }

  /**
   * Whether the pane hosts an agent, whatever a start call reported. An agent
   * runs in a pane this extension owns for one spawn, while the name a start call
   * speaks in is bookkeeping herdr drops (`agent_name_not_found`) or finds taken by
   * that same agent (`agent_name_taken`).
   */
  private async paneHostsAgent(paneId: string): Promise<boolean> {
    try {
      const info = await this.getAgentInfo(paneId, {
        timeoutMs: AGENT_COMMAND_TIMEOUT_MS,
      });
      return info !== undefined && info.paneId === paneId;
    } catch (err) {
      // An unanswerable probe is not evidence that a launch happened.
      log.debug("agent start probe failed", {
        paneId,
        code: herdrErrorCode(err),
      });
      return false;
    }
  }

  /**
   * Every live agent record, nameless ones included. Herdr 0.8.x drops the custom
   * `agent start` name, so orphaned runs carry only address/state fields — the
   * read recovery and cleanup associate with a run.
   */
  async listAgentRecords(): Promise<HerdrAgentInfo[]> {
    const result = await this.transport.call(["agent", "list"]);
    // Herdr has shipped both envelope shapes; either is a complete answer.
    const listed = Array.isArray(result)
      ? result
      : objectField(result, "agents");
    if (!Array.isArray(listed)) {
      throw new HerdrError(
        `herdr agent list returned no agents array: ${JSON.stringify(result).slice(0, 300)}`,
        undefined,
      );
    }
    const out: HerdrAgentInfo[] = [];
    for (const entry of listed) {
      const info = parseAgentInfo(entry);
      if (info) out.push(info);
    }
    return out;
  }

  /**
   * Snapshot for one herdr agent target, or undefined when gone. Herdr 0.8.x does
   * not retain the custom `agent start` name, so callers must pass the pane id.
   */
  async getAgentInfo(
    target: string,
    opts?: { timeoutMs?: number },
  ): Promise<HerdrAgentInfo | undefined> {
    try {
      const result = await this.transport.call(["agent", "get", target], opts);
      const info = parseAgentInfo(objectField(result, "agent") ?? result);
      if (!info) {
        log.debug("herdr record rejected", {
          target,
          result,
        });
        return undefined;
      }
      return { ...info, name: info.name ?? target };
    } catch (err) {
      // A missing target is normal during watcher shutdown; other failures stay
      // errors so callers can distinguish unknown from gone.
      if (isAgentGoneError(err)) {
        log.debug("agent not found", {
          target,
          code: err.code,
        });
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Live herdr agents for a task slug — the idempotent-spawn probe. A hit means an
   * attempt already exists. Herdr 0.8.x drops the custom `agent start` name, so a
   * record without one is matched by its worktree directory: extension worktrees
   * are `cow-<taskSlug>-<id>`, and the cwd outlives the name. A failed probe
   * returns [] so the spawn still proceeds.
   */
  async findTaskAttempts(taskSlug: string): Promise<LiveAttempt[]> {
    let records: HerdrAgentInfo[];
    try {
      records = await this.listAgentRecords();
    } catch {
      return [];
    }
    const attempts: LiveAttempt[] = [];
    for (const info of records) {
      if (info.name !== undefined && isTaskAgentName(info.name, taskSlug)) {
        // Only the conflicting identity; state is deliberately unclassified (a live
        // entry owns the task either way, and nothing downstream may end it).
        attempts.push({ name: info.name });
        continue;
      }
      // Nameless (or cosmetically renamed) record: the worktree directory
      // carries the same `cow-<slug>-<id>` identity and becomes the name.
      if (info.cwd === undefined) continue;
      const base = path.basename(info.cwd);
      if (isTaskAgentName(base, taskSlug)) attempts.push({ name: base });
    }
    return attempts;
  }

  /**
   * Send logical key presses to an agent. Herdr validates every key name before
   * writing any bytes, so an unsupported key fails without partial input. Throws
   * HerdrError.
   */
  async sendKeys(target: string, keys: readonly string[]): Promise<void> {
    await this.transport.call(["agent", "send-keys", target, ...keys], {
      timeoutMs: AGENT_COMMAND_TIMEOUT_MS,
    });
  }

  /**
   * Submit a prompt to an agent. herdr checks the target first — a pane hosting
   * no agent is `agent_not_found`, an approval dialog is `agent_blocked` — and
   * then writes the text and the encoded Enter as one ordered submission that
   * honours the pane's bracketed-paste mode.
   *
   * No `--wait`: a steer to an agent that is already working is this call's whole
   * reason, and the stall rule belongs to the waiting form. Throws HerdrError.
   */
  async submitPrompt(target: string, text: string): Promise<void> {
    await this.transport.call(["agent", "prompt", target, text], {
      timeoutMs: AGENT_COMMAND_TIMEOUT_MS,
    });
  }

  /**
   * Send a ctrl+c interrupt to a herdr agent. Non-fatal by intent: the agent
   * being gone already is the wanted outcome, while any other failure is logged
   * because the stopper then waits out its confirmation window on an agent it
   * never reached.
   */
  async interruptAgent(name: string): Promise<void> {
    try {
      await this.transport.call(["agent", "send-keys", name, "ctrl+c"], {
        timeoutMs: AGENT_COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      if (isAgentGoneError(err)) {
        log.debug("interrupt skipped: agent already gone", { name });
        return;
      }
      log.warn("agent interrupt failed", {
        name,
        code: herdrErrorCode(err),
        detail: errorMessage(err),
      });
    }
  }
}

/**
 * Whether a start failure is a non-fatal readiness timeout (spawn accepted, pi
 * booting; expected for subagents launched with an input message). Matches
 * `cli:agent:start:timeout` / `agent_not_ready` and the human timeout message.
 */
function isNonFatalStartError(err: unknown): boolean {
  if (!(err instanceof HerdrError)) return false;
  if (
    err.code === "cli:agent:start:timeout" ||
    err.code === "agent_not_ready"
  ) {
    return true;
  }
  return /timed out waiting for agent startup/i.test(err.message);
}

/** Whether a start failure is a transient not-ready shell worth retrying. */
function isTransientAgentStartError(err: unknown): boolean {
  if (!(err instanceof HerdrError)) return false;
  if (err.code === "agent_pane_unavailable" || err.code === "agent_pane_busy") {
    return true;
  }
  return /is not an available shell/i.test(err.message);
}

/**
 * The failure with herdr's code folded into its message. The message alone does
 * not name the failure — several codes share wording, so "no longer owns the
 * target terminal" and "is not an available shell" are indistinguishable by text
 * — and this message is the text a failed run reports to the orchestrator.
 */
function withHerdrCode(err: unknown): unknown {
  if (!(err instanceof HerdrError) || err.code === undefined) return err;
  return new HerdrError(`${err.message} (herdr code: ${err.code})`, err.code);
}

/** One herdr agent JSON record in the extension's shape. */
function parseAgentInfo(entry: unknown): HerdrAgentInfo | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const paneId = strField(record, "pane_id");
  if (!paneId) return undefined;
  const state = strField(record, "agent_status") as HerdrAgentState | undefined;
  return {
    name: strField(record, "name") ?? strField(record, "agent_name"),
    state: state ?? "unknown",
    workspaceId: strField(record, "workspace_id"),
    tabId: strField(record, "tab_id"),
    cwd: strField(record, "cwd"),
    paneId,
    interactiveReady: record.interactive_ready === true,
  };
}

/** Agent namespace for one pi instance. */
function agentNamespace(pi: ExtensionAPI): HerdrAgents {
  return new HerdrAgents(new HerdrTransport(pi));
}

export async function startPiAgent(
  pi: ExtensionAPI,
  options: { name: string; paneId: string; piArgs: string[] },
): Promise<void> {
  return agentNamespace(pi).startPiAgent(options);
}

export async function listAgentRecords(
  pi: ExtensionAPI,
): Promise<HerdrAgentInfo[]> {
  return agentNamespace(pi).listAgentRecords();
}

export async function getAgentInfo(
  pi: ExtensionAPI,
  target: string,
): Promise<HerdrAgentInfo | undefined> {
  return agentNamespace(pi).getAgentInfo(target);
}

export async function findTaskAttempts(
  pi: ExtensionAPI,
  taskSlug: string,
): Promise<LiveAttempt[]> {
  return agentNamespace(pi).findTaskAttempts(taskSlug);
}

export async function sendAgentKeys(
  pi: ExtensionAPI,
  target: string,
  keys: readonly string[],
): Promise<void> {
  return agentNamespace(pi).sendKeys(target, keys);
}

export async function submitAgentPrompt(
  pi: ExtensionAPI,
  target: string,
  text: string,
): Promise<void> {
  return agentNamespace(pi).submitPrompt(target, text);
}
