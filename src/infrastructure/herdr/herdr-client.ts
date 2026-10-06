/**
 * herdr-client.ts — Layer 2 facade: one pi-bound herdr client.
 *
 * Transport plus the `.panes`/`.agents`/`.worktrees` namespaces, and the one
 * workspace-scoped query that fits no namespace. One client shares a single
 * transport across its namespaces; the pi-bound function below builds a client
 * per call, for callers that hold only the pi instance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrAgents } from "./agents.js";
import {
  HerdrError,
  HerdrTransport,
  objectField,
  strField,
} from "./herdr-transport.js";
import { HerdrPanes } from "./panes.js";
import { HerdrWorktrees } from "./worktrees.js";

/** One pi-bound herdr client: transport plus the pane/agent/worktree namespaces. */
export class HerdrClient {
  readonly panes: HerdrPanes;
  readonly agents: HerdrAgents;
  readonly worktrees: HerdrWorktrees;
  private readonly transport: HerdrTransport;

  constructor(pi: ExtensionAPI) {
    this.transport = new HerdrTransport(pi);
    this.panes = new HerdrPanes(this.transport);
    this.agents = new HerdrAgents(this.transport);
    this.worktrees = new HerdrWorktrees(this.transport);
  }

  /** The calling pane's workspace. `--current` targets the caller, never the user's focus. */
  async getCurrentWorkspaceId(): Promise<string> {
    const result = await this.transport.call(["pane", "current", "--current"]);
    const ws = strField(objectField(result, "pane"), "workspace_id");
    if (ws === undefined)
      throw new HerdrError(
        "could not determine the current herdr workspace (not inside herdr?)",
        undefined,
      );
    return ws;
  }
}

export async function getCurrentWorkspaceId(pi: ExtensionAPI): Promise<string> {
  return new HerdrClient(pi).getCurrentWorkspaceId();
}
