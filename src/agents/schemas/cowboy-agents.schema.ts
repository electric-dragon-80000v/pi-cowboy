/**
 * cowboy-agents.schema.ts — TypeBox schemas and derived types for the
 * cowboy_agent tool's parameters.
 *
 * One schema describes one spawn (per-item params), the other describes the
 * call shape (one or more spawns plus an optional call-level blocking flag).
 * The TS types are derived from the schemas via `Static<>` — there is no
 * parallel hand-written interface, so a schema change cannot leave the
 * types behind.
 *
 * The cross-field rule (a non-background call requires exactly one agent)
 * is not expressible in JSON Schema. It lives as a one-line guard at the
 * top of `parseDelegationBatch` in `protocol.ts` — the schema file stays
 * a single source of truth for the per-field shape.
 */

import { Type, type Static } from "typebox";

const PROMPT_DESCRIPTION =
  "Task instructions for the agent. If the task requires code changes, the agent works in an isolated branch and will review and commit its changes upon approval. Do not instruct the agent to avoid committing when code modifications are needed.";

const TASK_NAME_DESCRIPTION =
  'REQUIRED. Short 2-3 word task name (e.g. "fix login flow"). This single value names the agent\'s branch/tab/worktree/agent so you can recognize it at a glance, and the extension appends a unique spawn id so parallel spawns — and every entry in a batch — are always distinct. Limits: 3 words, 19 characters when slugged (lowercase, dashes). A longer name throws with the exact overshoot — retry with a shorter name. Missing name throws too. The same name twice in one call is rejected before anything spawns.';

const AGENT_TYPE_DESCRIPTION =
  'Optional agent type; when omitted the configured default agent type is used ("general-purpose" unless changed in settings). An unknown or ambiguous name is rejected before any agent in the batch spawns. Available: general-purpose,Explore';

const MODEL_DESCRIPTION =
  'Optional model for THIS agent as "provider/model-id". Leave it unset (the default) to use the configured default for this session and agent type — the usual case. Pass it when the user asked for a specific model for this task. When a previous attempt failed with a provider/model error, pass a different model here and instruct the agent in plain text to continue where the failed attempt left off. A model that is not in this session\'s registry fails the call before anything is spawned — leave it unset to use the configured default instead.';

/** One spawn's parameters: prompt + task_name required, agent_type/model optional. */
const CowboyAgentParamsSchema = Type.Object(
  {
    prompt: Type.String({ description: PROMPT_DESCRIPTION }),
    task_name: Type.String({ description: TASK_NAME_DESCRIPTION }),
    agent_type: Type.Optional(
      Type.String({ description: AGENT_TYPE_DESCRIPTION }),
    ),
    model: Type.Optional(Type.String({ description: MODEL_DESCRIPTION })),
  },
  { additionalProperties: false, required: ["prompt", "task_name"] },
);

/**
 * The call shape: one or more spawns in `agents`, and an optional
 * `run_in_background` flag that applies to every item.
 *
 * The single-item blocking check (`run_in_background: false` requires
 * exactly one item in `agents`) is enforced at the parse layer, not in
 * the schema — see `protocol.ts`.
 */
export const CowboyAgentsSchema = Type.Object(
  {
    agents: Type.Array(CowboyAgentParamsSchema, { minItems: 1 }),
    run_in_background: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, required: ["agents"] },
);

/** Types follow the schemas. No redeclaration. */
export type CowboyAgentParams = Static<typeof CowboyAgentParamsSchema>;
export type CowboyAgents = Static<typeof CowboyAgentsSchema>;
