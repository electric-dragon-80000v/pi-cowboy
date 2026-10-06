/**
 * steer-batch.schema.ts — TypeBox schema and derived type for the
 * steer_cowboy_agent tool's parameters.
 *
 * One call steers one or more agents with a single message: every id in
 * `agent_ids` receives the same `message` independently (best effort) in
 * input order, so a batch can partially succeed. A settled agent is revived
 * by the delivery; a queued agent (no pane yet) and a cleaned-up agent
 * (pane gone) are refused per item. The TS type derives from the schema via
 * `Static<>` — there is no parallel hand-written interface.
 */

import { Type, type Static } from "typebox";

const AGENT_IDS_DESCRIPTION =
  "REQUIRED. One or more agent ids to steer (as printed by the cowboy_agent spawn result or a completion message). Every id is handled independently in input order — delivered, or refused with its reason — and one id's refusal never blocks the rest. A settled agent is revived by the delivery. A repeated id is rejected before anything is delivered — pass each id once.";

const MESSAGE_DESCRIPTION =
  "REQUIRED. The single message delivered verbatim to every id in `agent_ids`. Plain instructions work best (e.g. \"stop refactoring; just fix the failing test and report\"). Delivery is fire-and-forget: nothing here waits for an agent to act on it. Because the text is entered into the agent's pi session, a command prefixed with `!` runs and adds its output to that agent's context, while `!!` runs it without adding the output to its context.";

/** The call shape: one or more agent ids plus the one message they all receive. No call-level flags. */
export const SteerBatchSchema = Type.Object(
  {
    agent_ids: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: AGENT_IDS_DESCRIPTION,
    }),
    message: Type.String({ description: MESSAGE_DESCRIPTION }),
  },
  { additionalProperties: false, required: ["agent_ids", "message"] },
);

/** Type follows the schema. No redeclaration. */
export type SteerBatchParams = Static<typeof SteerBatchSchema>;
