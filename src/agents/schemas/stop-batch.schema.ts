/**
 * stop-batch.schema.ts — TypeBox schema and derived type for the
 * stop_cowboy_agent tool's parameters.
 *
 * One call stops one or more agents: every id in `agent_ids` is handled
 * independently (best effort) and reported with its own result line, so a
 * batch can partially succeed. The TS type derives from the schema via
 * `Static<>` — there is no parallel hand-written interface.
 */

import { Type, type Static } from "typebox";

const AGENT_IDS_DESCRIPTION =
  "REQUIRED. One or more agent ids to stop (as printed by the cowboy_agent spawn result or a completion message). Every id is handled independently in input order: stopped, reported as already settled, or reported unknown — one id's outcome never blocks the rest. A repeated id is rejected before anything is stopped — pass each id once. Nothing is removed — the worktree and branch are preserved for inspection, merging (merge_cowboy_branch), or later cleanup (cleanup_cowboy_agent).";

/** The call shape: one or more agent ids. No call-level flags — stopping never blocks, so there is no background/foreground split. */
export const StopBatchSchema = Type.Object(
  {
    agent_ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: AGENT_IDS_DESCRIPTION,
    }),
  },
  { additionalProperties: false, required: ["agent_ids"] },
);

/** Type follows the schema. No redeclaration. */
export type StopBatchParams = Static<typeof StopBatchSchema>;
