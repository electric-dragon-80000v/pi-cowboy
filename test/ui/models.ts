/**
 * Model fixtures for the menu suites.
 *
 * `reasoning` drives pi-ai's supported thinking levels, which the menus offer.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelEntry, ThinkingLevels } from "../../src/agents/harness.js";

/** An empty closed list: the model has no thinking control. */
export const NO_THINKING_CONTROL: ThinkingLevels = {
  kind: "closed",
  levels: [],
};

/**
 * One model a harness's own list answers with. The default states no thinking
 * control, which is what a fixture that only cares about keys means.
 */
export function listedModel(
  key: string,
  thinkingLevels: ThinkingLevels = NO_THINKING_CONTROL,
): ModelEntry {
  return { key, thinkingLevels };
}

/** A reasoning model: supports every level except the opt-in xhigh/max. */
export function reasoningModel(provider: string, id: string): Model<Api> {
  return { provider, id, reasoning: true } as unknown as Model<Api>;
}

/** A non-reasoning model: supports only "off". */
export function plainModel(provider: string, id: string): Model<Api> {
  return { provider, id, reasoning: false } as unknown as Model<Api>;
}

/** A registry over a fixed model list, as pi's session context provides. */
export function registryOver(models: Model<Api>[]): {
  find(provider: string, modelId: string): Model<Api> | undefined;
} {
  return {
    find: (provider, modelId) =>
      models.find((m) => m.provider === provider && m.id === modelId),
  };
}
