/**
 * cleanup-batch.schema.ts — TypeBox schema and derived type for the
 * cleanup_cowboy_agent tool's parameters.
 *
 * One call cleans up one or more agents: every id in `agent_ids` runs the
 * tracked-or-locate flow independently (best effort) and keeps its own
 * structured `CleanupReport`, so a batch can partially succeed. The TS type
 * derives from the schema via `Static<>` — there is no parallel hand-written
 * interface.
 */

import { Type, type Static } from "typebox";

const AGENT_IDS_DESCRIPTION =
  "REQUIRED. One or more agent ids to clean up (as printed by the cowboy_agent spawn result or a completion message). Every id is handled independently in input order — located (the locator runs for ids the store no longer tracks), cleaned up, and reported with its own agent status / pane / worktree / branch block — one id's outcome never blocks the rest. A repeated id is rejected before anything is removed — pass each id once. An agent that is still active is refused for its item only (stop it with stop_cowboy_agent, then clean up once it has settled).";

/** The call shape: one or more agent ids. No call-level flags. */
export const CleanupBatchSchema = Type.Object(
  {
    agent_ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: AGENT_IDS_DESCRIPTION,
    }),
  },
  { additionalProperties: false, required: ["agent_ids"] },
);

/** Type follows the schema. No redeclaration. */
export type CleanupBatchParams = Static<typeof CleanupBatchSchema>;
