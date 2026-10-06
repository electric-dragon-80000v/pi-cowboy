/**
 * herdr-host.ts — AgentHost + AgentView over the herdr CLI.
 *
 * The only herdr-aware execution code; everything else talks to the
 * AgentHost/AgentView contracts (see src/agents/agent-host.ts). Built once per
 * parent session at the composition root.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentHost,
  AgentHostRef,
  DeliverOutcome,
  ExecutionRuntime,
  AgentView,
  ViewRequest,
} from "../agents/agent-host.js";
import { errorMessage } from "../utils.js";
import {
  closePane,
  createAgentTab,
  findTaskAttempts,
  focusTab,
  getAgentInfo,
  getCurrentWorkspaceId,
  HerdrError,
  herdrErrorCode,
  listWorktrees,
  normalizeHerdrPath,
  objectField,
  removeHerdrWorktree,
  renamePane,
  renameTab,
  runHerdr,
  startPiAgent,
  stopAgentAndWait,
  strField,
  submitAgentPrompt,
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
  return {
    hostAt: async (request: ViewRequest): Promise<AgentHostRef> => {
      if (request.checkout) {
        // Herdr titles the tab with the branch and verifies it; the request label
        // applies to the fresh-tab path below.
        const { path: wtPath, repoCwd: mainRoot, branch } = request.checkout;
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
        if (
          !openPath ||
          !workspaceId ||
          !tabId ||
          !paneId ||
          openBranch !== branch
        ) {
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
        await nameSubagentPane(pi, paneId, request.label);
        // Herdr created this tab, so it carries the marker only once named here.
        await nameAdoptedTab(pi, tabId, request.label);
        return {
          engine: "herdr",
          name: request.name ?? request.label,
          paneId,
          tabId,
          workspaceId,
          paneCreated: false,
        };
      }
      const workspaceId = await getCurrentWorkspaceId(pi);
      const created = await createAgentTab(pi, {
        workspaceId,
        cwd: request.cwd,
        label: markedLabel(request.label),
      });
      await nameSubagentPane(pi, created.paneId, request.label);
      return {
        engine: "herdr",
        name: request.name ?? request.label,
        paneId: created.paneId,
        tabId: created.tabId,
        workspaceId,
        paneCreated: true,
      };
    },

    start: (ref, options) =>
      startPiAgent(pi, {
        name: options.name,
        paneId: ref.paneId,
        piArgs: options.piArgs,
      }),

    observe: async (ref) => {
      const info = await getAgentInfo(pi, ref.paneId);
      if (!info) return undefined;
      return { state: info.state };
    },

    stop: (ref, options) =>
      stopAgentAndWait(pi, ref.paneId, {
        interruptGraceMs: options?.interruptGraceMs,
        confirmMs: options?.confirmMs,
      }),

    release: async (ref, scope) => {
      if (scope === "worktree-association") {
        return removeHerdrWorktree(pi, ref.workspaceId);
      }
      if (ref.paneCreated) {
        await closePane(pi, ref.paneId);
      }
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

    // The agent surface, never the pane surface. herdr refuses a target that is
    // not an agent (`agent_not_found`), refuses an approval dialog
    // (`agent_blocked`), and writes the text and the encoded Enter as one
    // ordered submission. Typing into the pane instead would put those bytes
    // wherever the pane's foreground happens to be — a shell prompt runs them
    // as a command.
    deliver: async (ref, message): Promise<DeliverOutcome> => {
      try {
        await submitAgentPrompt(pi, ref.paneId, message);
        return { kind: "submitted" };
      } catch (error) {
        const code = herdrErrorCode(error);
        return {
          kind: "not-submitted",
          detail: `the agent's pane did not take the message (${code === undefined ? "" : `${code}: `}${errorMessage(error)}); nothing was submitted.`,
        };
      }
    },
  };
}

export function createHerdrRuntime(pi: ExtensionAPI): ExecutionRuntime {
  return { host: createHerdrHost(pi), view: createHerdrView(pi) };
}
