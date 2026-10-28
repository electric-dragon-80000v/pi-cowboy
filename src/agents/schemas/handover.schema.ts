/**
 * handover.schema.ts — TypeBox schema and derived type for the
 * handover_cowboy_agent tool's parameters.
 *
 * One call hands one agent to one harness. The target is required: a handover
 * names where the work continues, so there is no configured fallback to
 * resolve — an unregistered or unlaunchable harness refuses the call. The
 * model is optional and belongs to the target harness's vocabulary.
 *
 * The TS type derives from the schema via `Static<>` — there is no parallel
 * hand-written interface.
 */

import { Type, type Static } from "typebox";
import { HARNESS_IDS } from "../harness.js";

const AGENT_ID_DESCRIPTION =
  "REQUIRED. The id of the SETTLED agent to hand over, as printed by the cowboy_agent spawn result or a completion message. A live agent is refused, never stopped — stop it with stop_cowboy_agent and hand it over once it has settled.";

const HARNESS_TYPE_DESCRIPTION = `REQUIRED. The harness that executes the next run of this agent. Available: the built-in harnesses (${HARNESS_IDS.join(", ")}) and any harness a plugin registered in this session. Unlike the configured default, an explicit harness never falls back: an ID this session did not register, or one this machine cannot launch, causes the call to be refused before anything is stopped. The source harness must be able to export its own session; a harness that cannot is reported in the result and nothing changes.`;

const MODEL_DESCRIPTION =
  "Optional model for the next run as \"provider/model-id\", in the target harness's own vocabulary. Omit it, or pass null, to leave it unset and let the harness choose its default. A model that is not in this session's registry (or in the target harness's list) refuses the call before anything is stopped.";

const THINKING_DESCRIPTION =
  "Optional thinking level for the next run, in the target harness's vocabulary. Omit it, or pass null, to leave it unset.";

/** One agent, one target harness. A batch is not offered: a handover replaces a run, not a list of them. */
export const HandoverAgentSchema = Type.Object(
  {
    agent_id: Type.String({
      minLength: 1,
      description: AGENT_ID_DESCRIPTION,
    }),
    harness_type: Type.String({ description: HARNESS_TYPE_DESCRIPTION }),
    model: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: MODEL_DESCRIPTION,
      }),
    ),
    thinking: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: THINKING_DESCRIPTION,
      }),
    ),
  },
  { additionalProperties: false, required: ["agent_id", "harness_type"] },
);

/** Type follows the schema. No redeclaration. */
export type HandoverAgentParams = Static<typeof HandoverAgentSchema>;
