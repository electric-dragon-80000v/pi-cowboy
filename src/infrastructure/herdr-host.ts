/**
 * herdr-host.ts — AgentHost + AgentView over the herdr CLI.
 *
 * The only herdr-aware execution code; everything else talks to the
 * AgentHost/AgentView contracts (see src/agents/agent-host.ts). Built once per
 * parent session at the composition root.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentMultiplexer,
  AgentHost,
  AgentHostRef,
  DeliverOutcome,
  ExecutionRuntime,
  AgentView,
  PaneControl,
  PlacementCatalog,
  ViewRequest,
} from "../agents/agent-host.js";
import { errorMessage } from "../utils.js";
import { HERDR } from "../host-multiplexer.js";
import {
  AGENT_NAME_INDEX_MAX,
  HERDR_AGENT_NAME_MAX_LENGTH,
  agentNameWithIndex,
  parseAgentName,
} from "../predicates.js";
import {
  boolField,
  closePane,
  createAgentTab,
  findTaskAttempts,
  focusTab,
  getAgentInfo,
  getCurrentWorkspaceId,
  HerdrError,
  herdrErrorCode,
  listAgentRecords,
  listWorktrees,
  normalizeHerdrPath,
  objectField,
  removeHerdrWorktree,
  renamePane,
  renameTab,
  runHerdr,
  runInPane,
  sendAgentKeys,
  startAgent,
  strField,
  submitAgentPrompt,
  waitForAgentGone,
  waitForPaneOutput,
} from "./herdr-client.js";

/**
 * Marker a subagent's placement carries: a pane's label and a tab's label are
 * both the marker followed by the placement title, so a spawn this extension
 * made is recognizable in the tab bar, which is where herdr shows a label.
 */
const PLACEMENT_MARKER = "🐄";

/** A placement's label: the marker, then the placement title. An empty title leaves the marker alone, with no dangling separator. */
function markedLabel(title: string): string {
  return title === "" ? PLACEMENT_MARKER : `${PLACEMENT_MARKER} ${title}`;
}

/** Name a freshly placed subagent pane. Never throws (see HerdrPanes.renamePane). */
async function nameSubagentPane(
  pi: ExtensionAPI,
  paneId: string,
  title: string,
): Promise<void> {
  await renamePane(pi, paneId, { kind: "label", label: markedLabel(title) });
}

/**
 * Name the tab herdr created for an adopted worktree; the fresh-tab path passes
 * the same label at creation. Never throws (see HerdrPanes.renameTab).
 */
async function nameAdoptedTab(
  pi: ExtensionAPI,
  tabId: string,
  title: string,
): Promise<void> {
  await renameTab(pi, tabId, markedLabel(title));
}

/**
 * The workspace a checkout lives in, and any pane there free to carry a first
 * agent.
 *
 * `vacant` is the root pane of a workspace `worktree open` has just created: it
 * hosts no agent, so it is spot 1 rather than clutter to leave behind. A
 * workspace that was already open has no vacancy — its root pane belongs to the
 * agent that opened it, which is exactly the pane this must never reuse.
 */
interface WorktreeSpace {
  readonly workspaceId: string;
  readonly vacant?: { readonly tabId: string; readonly paneId: string };
}

/**
 * The workspace already hosting a checkout, or undefined when it is not open.
 * A failed read is not evidence either way, so it is left to `worktree open` to
 * answer — and `worktree open` reports `already_open` for the same case, which
 * is why the race is handled there rather than assumed away here.
 */
async function openWorkspaceFor(
  pi: ExtensionAPI,
  repoCwd: string,
  worktreePath: string,
): Promise<string | undefined> {
  const wanted = normalizeHerdrPath(worktreePath);
  const tracked = await listWorktrees(pi, repoCwd).catch(() => []);
  return tracked.find((entry) => normalizeHerdrPath(entry.path) === wanted)
    ?.openWorkspaceId;
}

/**
 * Ensure the checkout's herdr workspace exists, and report it along with the
 * free pane it may already hold. Adopting a checkout and finding one already
 * adopted answer the same way — a workspace to place into — because the step
 * after this one never asks how the space came to be.
 */
async function ensureWorktreeSpace(
  pi: ExtensionAPI,
  checkout: { path: string; repoCwd: string; branch: string },
): Promise<WorktreeSpace> {
  const { path: wtPath, repoCwd: mainRoot, branch } = checkout;
  const openWorkspaceId = await openWorkspaceFor(pi, mainRoot, wtPath);
  if (openWorkspaceId !== undefined) return { workspaceId: openWorkspaceId };

  const result = await runHerdr(
    pi,
    [
      "worktree",
      "open",
      "--cwd",
      mainRoot,
      "--path",
      wtPath,
      "--label",
      branch,
      "--no-focus",
    ],
    { timeoutMs: 60_000 },
  );

  const openPath = strField(objectField(result, "worktree"), "path");
  const workspaceId = strField(
    objectField(result, "workspace"),
    "workspace_id",
  );
  const tabId = strField(objectField(result, "tab"), "tab_id");
  const paneId = strField(objectField(result, "root_pane"), "pane_id");
  const openBranch = strField(objectField(result, "worktree"), "branch");
  // The probe above is a separate round trip, so another spawn may have opened
  // the checkout in between; herdr says so in its own answer. Its tab and pane
  // then belong to that agent, and its workspace is not this launch's to remove.
  if (boolField(result, "already_open") === true) {
    if (workspaceId === undefined || openBranch !== branch) {
      throw new HerdrError(
        `herdr reports ${wtPath} already open, but not as "${branch}": ${JSON.stringify(result).slice(0, 300)}. Nothing was launched.`,
        undefined,
      );
    }
    return { workspaceId };
  }
  if (!openPath || !workspaceId || !tabId || !paneId || openBranch !== branch) {
    // Remove only what this adoption created; the git checkout and branch
    // belong to the caller, which rolls them back on this throw.
    const removed =
      workspaceId === undefined
        ? true
        : await removeHerdrWorktree(pi, workspaceId);
    // A failed removal leaves a workspace, tab and pane that nothing else
    // can locate: the caller clears the worktree it would search by. Say
    // so, and name the workspace so the user can close it by hand.
    const residue = removed
      ? ""
      : ` A herdr workspace, tab and pane for this worktree may still exist (workspace ${workspaceId}); close it with \`herdr worktree remove --workspace ${workspaceId} --force\`.`;
    throw new HerdrError(
      `herdr worktree open for ${wtPath} did not adopt "${branch}": ${JSON.stringify(result).slice(0, 300)}.${residue}`,
      undefined,
    );
  }
  return { workspaceId, vacant: { tabId, paneId } };
}

/**
 * Whether herdr has a live agent under this name. A probe that cannot answer is
 * not evidence the name is taken — the same rule every other probe here follows
 * — so the launch decides, loudly, if the name really was in use.
 */
async function isAgentNameTaken(
  pi: ExtensionAPI,
  name: string,
): Promise<boolean> {
  try {
    return (await getAgentInfo(pi, name)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * The name a placement's spot carries, or undefined when this base has no room
 * for it. Spot 1 of a base too long to take a suffix keeps the bare spelling —
 * the name every placement had before spots were numbered — and later spots are
 * then refused rather than truncated.
 */
function spotName(base: string, index: number): string | undefined {
  if (base.length + String(index).length + 1 <= HERDR_AGENT_NAME_MAX_LENGTH) {
    return agentNameWithIndex(base, index);
  }
  return index === 1 && base.length <= HERDR_AGENT_NAME_MAX_LENGTH
    ? base
    : undefined;
}

/** The spot a placement takes: its index, and the agent name that index carries. */
interface AgentSpot {
  readonly index: number;
  readonly name: string;
}

/**
 * The next free spot in a placement's space. herdr requires live agent names to
 * be unique, so a workspace's spots are its free names numbered from 1: the
 * first agent takes 1, the next takes 2, and so on up to `AGENT_NAME_INDEX_MAX`.
 *
 * Candidates are probed by name, so the answer does not depend on `agent list`
 * reporting the names of running agents. Spot 1 is also reachable under the
 * unsuffixed base, and both spellings have to be free before it is handed out.
 *
 * `claimed` holds the names this host has already reserved, because a spot is
 * not visible to herdr until `agent start` registers it — a second placement
 * taken from here before that would otherwise read the same spot as free.
 */
async function nextFreeSpot(
  pi: ExtensionAPI,
  base: string,
  claimed: ReadonlySet<string>,
): Promise<AgentSpot> {
  for (let index = 1; index <= AGENT_NAME_INDEX_MAX; index++) {
    const name = spotName(base, index);
    if (name === undefined) break;
    const taken =
      claimed.has(name) ||
      (index === 1 && name !== base && claimed.has(base)) ||
      (index === 1 && name !== base && (await isAgentNameTaken(pi, base))) ||
      (await isAgentNameTaken(pi, name));
    if (!taken) return { index, name };
  }
  throw new HerdrError(
    `checkout "${base}" has no free agent spot left (spots 1-${AGENT_NAME_INDEX_MAX} at this name length) — stop or clean one up before spawning another`,
    undefined,
  );
}

/**
 * Whether another placement still lives in this address's workspace. A failed
 * read answers yes: a sibling that cannot be ruled out is not one this release
 * may close.
 */
async function hasSiblingPlacement(
  pi: ExtensionAPI,
  ref: AgentHostRef,
): Promise<boolean> {
  try {
    const records = await listAgentRecords(pi);
    return records.some(
      (record) =>
        record.workspaceId === ref.workspaceId && record.paneId !== ref.paneId,
    );
  } catch {
    return true;
  }
}

function createHerdrView(pi: ExtensionAPI): AgentView {
  return {
    focus: async (ref) => {
      // An absent tab is a broken address, not a reason to silently do nothing.
      if (ref.tabId === undefined) {
        throw new HerdrError(
          `cannot focus pane ${ref.paneId}: the address carries no tab id`,
          undefined,
        );
      }
      await focusTab(pi, ref.tabId);
    },
  };
}

export function createHerdrHost(pi: ExtensionAPI): AgentHost {
  /**
   * Agent names this host has handed out but herdr does not yet list: a spot is
   * only visible to herdr once `agent start` registers it, and two spawns can be
   * placed before either launches. Kept per host, which is one parent session's
   * view — the lifetime over which placements are handed out.
   */
  const claimedNames = new Set<string>();
  /** Tail of the spot-taking chain, so two placements never read the same spot as free. */
  let spotQueue: Promise<unknown> = Promise.resolve();

  /**
   * Reserve the next free spot, one placement at a time. Serialized because
   * reading a free spot and claiming it are two steps: interleaved placements
   * would both see the same spot free.
   */
  const reserveSpot = (baseName: string): Promise<AgentSpot> => {
    const mine = spotQueue
      .catch(() => {})
      .then(async () => {
        const spot = await nextFreeSpot(pi, baseName, claimedNames);
        claimedNames.add(spot.name);
        // Spot 1 also answers to the unsuffixed base, so that spelling is taken
        // along with it.
        if (spot.index === 1) claimedNames.add(baseName);
        return spot;
      });
    spotQueue = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };

  /**
   * Take the next free spot in a workspace: number it, and give it a tab of its
   * own. A workspace this call created offers its root pane as spot 1 (nothing
   * lives there yet); every later spot is a new tab beside the ones in use.
   *
   * The spot is numbered before any tab exists, so a space with nothing left
   * refuses without leaving a tab no agent will ever fill.
   */
  const takeSpot = async (
    request: ViewRequest,
    space: WorktreeSpace,
    cwd: string,
    baseName: string,
  ): Promise<AgentHostRef> => {
    const spot = await reserveSpot(baseName);
    // Spot 1 of a workspace just created has a pane nothing occupies; every
    // other spot needs a tab of its own, so it never lands in a pane in use.
    const vacant = spot.index === 1 ? space.vacant : undefined;
    const placed =
      vacant ??
      (await createAgentTab(pi, {
        workspaceId: space.workspaceId,
        cwd,
        label: markedLabel(request.label),
      }));
    await nameSubagentPane(pi, placed.paneId, request.label);
    // A tab this launch created carries the marker in its label already; the one
    // `worktree open` made carries the branch, so it takes the title here.
    if (vacant !== undefined) {
      await nameAdoptedTab(pi, placed.tabId, request.label);
    }
    return {
      multiplexer: HERDR,
      name: spot.name,
      paneId: placed.paneId,
      tabId: placed.tabId,
      workspaceId: space.workspaceId,
      paneCreated: vacant === undefined,
    };
  };

  return {
    hostAt: async (request: ViewRequest): Promise<AgentHostRef> => {
      const baseName = request.name ?? request.label;
      if (request.checkout) {
        // Herdr titles the tab with the branch and verifies it; the request
        // label applies to the spots created below.
        const space = await ensureWorktreeSpace(pi, request.checkout);
        return await takeSpot(request, space, request.checkout.path, baseName);
      }
      // A parent-cwd placement takes a spot in the current workspace; its base
      // already carries the spawn id, so no other placement answers to it.
      const workspaceId = await getCurrentWorkspaceId(pi);
      const spot = await reserveSpot(baseName);
      const created = await createAgentTab(pi, {
        workspaceId,
        cwd: request.cwd,
        label: markedLabel(request.label),
      });
      await nameSubagentPane(pi, created.paneId, request.label);
      return {
        multiplexer: HERDR,
        name: spot.name,
        paneId: created.paneId,
        tabId: created.tabId,
        workspaceId,
        paneCreated: true,
      };
    },

    // The address is the identity authority: hostAt resolved which agent name is
    // free in this placement's checkout, and a caller's base name (the branch)
    // is shared by every agent there.
    start: (ref, options) =>
      startAgent(pi, {
        name: ref.name,
        paneId: ref.paneId,
        piArgs: options.piArgs,
        agentMultiplexerKind: options.agentMultiplexerKind,
      }),

    observe: async (ref) => {
      const info = await getAgentInfo(pi, ref.paneId);
      if (!info) return undefined;
      return { state: info.state };
    },

    waitUntilGone: (ref, options) =>
      waitForAgentGone(pi, ref.paneId, { timeoutMs: options?.timeoutMs }),

    release: async (ref, scope) => {
      // A released address frees its spot: its agent is going away, so a later
      // placement may take the same name.
      const releaseSpot = (): void => {
        claimedNames.delete(ref.name);
        claimedNames.delete(parseAgentName(ref.name).base);
      };
      if (scope === "worktree-association") {
        // Releasing the association closes the workspace, and a workspace can
        // host several agents' tabs: doing it while another one lives there
        // would close a sibling this release was never asked about.
        if (await hasSiblingPlacement(pi, ref)) return false;
        const removed = await removeHerdrWorktree(pi, ref.workspaceId);
        if (removed) releaseSpot();
        return removed;
      }
      if (ref.paneCreated) {
        await closePane(pi, ref.paneId);
      }
      releaseSpot();
      return true;
    },

    isAttached: async (worktreePath, opts) => {
      const tracked = await listWorktrees(pi, opts?.repoCwd);
      return tracked.some(
        (wt) =>
          normalizeHerdrPath(wt.path) === normalizeHerdrPath(worktreePath),
      );
    },

    findAttempts: (taskSlug) => findTaskAttempts(pi, taskSlug),
  };
}

/**
 * The herdr pane surface: the control-plane calls a harness types its launcher
 * through. The harness layer never imports herdr; it holds this interface, so
 * the same launcher install runs under any multiplexer that offers it.
 */
function createHerdrPane(pi: ExtensionAPI): PaneControl {
  return {
    kind: HERDR,
    launchEnvironment: (agentKind) => ({ HERDR_AGENT: agentKind }),
    run: (paneId, command) => runInPane(pi, paneId, command),
    // The agent surface, not pane-level typing: herdr validates the target is
    // an agent and every key name before writing any bytes.
    sendKeys: (paneId, keys) => sendAgentKeys(pi, paneId, keys),
    // The agent surface, never the pane surface. herdr refuses a target that is
    // not an agent (`agent_not_found`), refuses an approval dialog
    // (`agent_blocked`), and writes the text and the encoded Enter as one
    // ordered submission. Typing into the pane instead would put those bytes
    // wherever the pane's foreground happens to be — a shell prompt runs them
    // as a command.
    promptAgent: async (paneId, message): Promise<DeliverOutcome> => {
      try {
        await submitAgentPrompt(pi, paneId, message);
        return { kind: "submitted" };
      } catch (error) {
        const code = herdrErrorCode(error);
        return {
          kind: "not-submitted",
          detail: `the agent's pane did not take the message (${code === undefined ? "" : `${code}: `}${errorMessage(error)}); nothing was submitted.`,
        };
      }
    },
    waitForVisibleOutput: async (paneId, output, timeoutMs) => {
      await runHerdr(
        pi,
        [
          "pane",
          "wait-output",
          "--source",
          "visible",
          "--match",
          output,
          "--timeout",
          String(timeoutMs),
          paneId,
        ],
        { timeoutMs: timeoutMs + 15_000 },
      );
    },
    // The pane surface's raw writer: literal bytes to the pane's foreground
    // process, no Enter and no key translation. A harness that must report a
    // terminal sequence first (a TUI that ignores input until its terminal is
    // told it has focus) writes it here, on its own, so the following message
    // is not discarded by the focus transition.
    sendText: async (paneId, text) => {
      await runHerdr(pi, ["pane", "send-text", paneId, text], {
        timeoutMs: 15_000,
      });
    },
    submit: async (paneId, text, pid, signal) => {
      if (
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        Array.from(text).some((character) => {
          const code = character.charCodeAt(0);
          // ESC is the one control byte a harness may send: a TUI that ignores
          // input while its terminal is unfocused has to be told it has focus.
          return (code < 32 && code !== 0x1b) || code === 127;
        })
      ) {
        throw new Error(
          "Cannot submit pane text with an invalid process id or control characters",
        );
      }
      const verify = async () => {
        const info = objectField(
          await runHerdr(pi, ["pane", "process-info", "--pane", paneId], {
            timeoutMs: 15_000,
          }),
          "process_info",
        );
        const processes: unknown = info?.foreground_processes;
        if (
          !Array.isArray(processes) ||
          !processes.some(
            (process: unknown) =>
              typeof process === "object" &&
              process !== null &&
              "pid" in process &&
              process.pid === pid,
          )
        ) {
          throw new Error(
            `Expected process ${pid} is not in pane ${paneId}'s foreground`,
          );
        }
      };
      signal.throwIfAborted();
      await verify();
      signal.throwIfAborted();
      await runHerdr(pi, ["pane", "send-text", paneId, text], {
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      signal.throwIfAborted();
      await verify();
      signal.throwIfAborted();
      await runHerdr(pi, ["pane", "send-keys", paneId, "enter"], {
        timeoutMs: 15_000,
      });
    },
    waitForOutput: (paneId, output, timeoutMs) =>
      waitForPaneOutput(pi, paneId, output, timeoutMs),
  };
}

/**
 * The herdr placement catalog: the multiplexer's own reads, mapped to the contract's
 * vocabulary. Paths are canonicalized here so a caller comparing its own path
 * with a reported one never has to know how herdr spells a checkout.
 */
function createHerdrPlacements(
  pi: ExtensionAPI,
  multiplexer: AgentMultiplexer,
): PlacementCatalog {
  return {
    multiplexer,
    canonicalizePath: (value) => normalizeHerdrPath(value),
    listWorktrees: async () =>
      (await listWorktrees(pi)).map((entry) => ({
        path: normalizeHerdrPath(entry.path),
        label: entry.label,
        branch: entry.branch,
        workspaceId: entry.openWorkspaceId,
      })),
    listPlacements: async () =>
      (await listAgentRecords(pi)).map((record) => ({
        name: record.name,
        state: record.state,
        workspaceId: record.workspaceId,
        tabId: record.tabId,
        cwd: record.cwd,
        paneId: record.paneId,
      })),
    observePane: async (paneId) => {
      const info = await getAgentInfo(pi, paneId);
      return info === undefined ? undefined : { state: info.state };
    },
  };
}

export function createHerdrRuntime(pi: ExtensionAPI): ExecutionRuntime {
  return {
    host: createHerdrHost(pi),
    view: createHerdrView(pi),
    pane: createHerdrPane(pi),
    // The runtime's identity is the one source: the catalog reports it on the
    // addresses it builds, so a persisted spawn names the multiplexer that minted it.
    placements: createHerdrPlacements(pi, HERDR),
    multiplexer: HERDR,
  };
}
