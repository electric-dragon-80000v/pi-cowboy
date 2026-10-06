/**
 * merge-batch.schema.ts — TypeBox schema and derived type for the
 * merge_cowboy_branch tool's parameters.
 *
 * One call merges one or more settled agent branches into the same target:
 * every branch in `branches` merges sequentially in input order (merges share
 * one checkout, so parallel merging is impossible). A conflict halts the
 * batch — the conflicted merge stays in progress for the orchestrator to
 * resolve, and the remaining branches report as not attempted. The TS type
 * derives from the schema via `Static<>` — there is no parallel hand-written
 * interface.
 */

import { Type, type Static } from "typebox";

const BRANCHES_DESCRIPTION =
  "REQUIRED. One or more settled agent branches to merge (the `cow-<task>-<id>` branches from the cowboy_agent result notes). Every branch merges sequentially in input order into the same `target`: merged, reported as already merged, or reported per item on failure — a non-conflict failure never blocks the rest. A repeated branch is rejected before anything merges — pass each branch once. A conflict halts the batch: the conflicted merge is left in progress (never auto-resolved) and the remaining branches are reported as not attempted.";

const TARGET_DESCRIPTION =
  "Merge target branch (default: main). Applies to every branch in `branches`: the repo's main checkout must be on the target before anything merges.";

const REPO_DESCRIPTION =
  "Any path inside the repo (default: the parent session's cwd). Applies to the whole call: the merge always runs in the repo's main checkout.";

/** The call shape: one or more branches plus call-level `target`/`repo`. */
export const MergeBatchSchema = Type.Object(
  {
    branches: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: BRANCHES_DESCRIPTION,
    }),
    target: Type.Optional(Type.String({ description: TARGET_DESCRIPTION })),
    repo: Type.Optional(Type.String({ description: REPO_DESCRIPTION })),
  },
  { additionalProperties: false, required: ["branches"] },
);

/** Type follows the schema. No redeclaration. */
export type MergeBatchParams = Static<typeof MergeBatchSchema>;
