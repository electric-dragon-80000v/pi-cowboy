/**
 * Subagent model selection via pi's own model picker.
 *
 * openSubagentModelPicker: opens the /model dialog; a pick sets the SESSION default override.
 * cowboyCompletions: `/cowboy` subcommand completions (`status`, `spawn`, `worktree`, `model`, `enable`, `disable`), the `model` ones carrying full argument text.
 * handleModelArg: `clear` clears the session default, an exact key sets it, else the picker opens.
 *
 * A per-call cowboy_agent `model` wins for one spawn at the tool boundary without touching stored state.
 * The ModelRuntime hides behind ctx.modelRegistry's private `runtime` field; when unreachable,
 * the picker falls back to SearchableSelectDialog.
 */

import {
  ModelSelectorComponent,
  type ExtensionCommandContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getPiInstance, getSessionCtx, getStore } from "../../shell.js";
import { findModelInRegistry, parseModelKey } from "../../utils.js";
import type { ModelCatalog, ModelEntry } from "../../agents/harness.js";
import { harnessFor } from "../../agents/harness/registry.js";
import { SearchableSelectDialog } from "../searchable-select.js";
import { buildModelOptions } from "./helpers.js";
import { ScreenHost } from "./screen-host.js";

/** Minimal ModelRuntime surface ModelSelectorComponent uses. */
interface ModelRuntimeLike {
  getAvailableSnapshot(): Model<Api>[];
  getError(): string | undefined;
  refresh(options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Set the session default model. In-memory only (cleared at session_start); other layers live in Model settings. */
function applySessionDefault(
  store: ReturnType<typeof getStore>,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
): void {
  const key = `${model.provider}/${model.id}`;
  store.mutate.session.setOverride("default", key);
  ctx.ui.notify(`Subagent model set to ${key} (session)`, "info");
}

/** The model currently in effect for sub-agents (session → config → parent). */
function currentSubagentModel(
  ctx: ExtensionCommandContext,
): Model<Api> | undefined {
  const store = getStore();
  const session = getSessionCtx();
  const parentModelId = session.model ?? ctx.model;
  const parentKey = parentModelId
    ? `${parentModelId.provider}/${parentModelId.id}`
    : null;
  const currentKey =
    store.sessionDefaultModel ??
    store.agentConfigSnapshot().default ??
    parentKey;
  return currentKey
    ? findModelInRegistry(currentKey, ctx.modelRegistry, ctx.model)
    : undefined;
}

function sessionModelRuntime(
  ctx: ExtensionCommandContext,
): ModelRuntimeLike | undefined {
  const runtime = (
    ctx.modelRegistry as unknown as { runtime?: ModelRuntimeLike }
  ).runtime;
  return runtime && typeof runtime.getAvailableSnapshot === "function"
    ? runtime
    : undefined;
}

export async function openSubagentModelPicker(
  ctx: ExtensionCommandContext,
  opts?: { initialSearch?: string },
): Promise<void> {
  const store = getStore();
  const runtime = sessionModelRuntime(ctx);
  const scoped = ctx.scopedModels;
  // The fallback list is read before the screen opens, because the screen's
  // builder is synchronous. The runtime branch reads its own catalog instead.
  const entries = runtime ? [] : await piHarnessModels(ctx.modelRegistry);

  await new ScreenHost(ctx).open<void>(({ tui, theme, close }) => {
    const current = currentSubagentModel(ctx);

    if (!runtime) {
      const registry = getSessionCtx().modelRegistry;
      const keys = entries.map((entry) => entry.key);
      const items = buildModelOptions(keys, current?.id ?? null, []).filter(
        (o) => o.value != null,
      );
      const dialog = new SearchableSelectDialog(
        items,
        current ? `${current.provider}/${current.id}` : null,
        {
          onSelect: (value) => {
            const model = findModelInRegistry(value, registry, undefined);
            if (model) applySessionDefault(store, ctx, model);
            close();
          },
          onCancel: () => close(),
        },
        theme,
      );
      return dialog;
    }

    const selector = new ModelSelectorComponent(
      tui,
      current,
      runtime as unknown as ModelRuntime,
      scoped,
      (model) => {
        applySessionDefault(store, ctx, model);
        close();
      },
      () => close(),
      opts?.initialSearch,
    );
    return selector;
  });
}

/** `model` subcommand completions. Values carry full argument text, matching pi's prefix replacement. */
export async function cowboyCompletions(
  prefix: string,
): Promise<AutocompleteItem[] | null> {
  const text = prefix;
  const trimmed = text.trim();

  if (trimmed === "model" || trimmed.startsWith("model ")) {
    const rest = trimmed.slice("model".length).trim();
    const models = await availableModelsForCompletion();
    const items: AutocompleteItem[] = [
      {
        value: "model clear",
        label: "clear",
        description:
          "Clear the session model override (inherit parent/configured default)",
      },
      ...models.map((entry) => {
        const parsed = parseModelKey(entry.key);
        return {
          value: `model ${entry.key}`,
          label: parsed?.modelId ?? entry.key,
          description: parsed?.provider ?? "",
        };
      }),
    ];
    const filtered = fuzzyFilter(
      items,
      rest,
      (i) => `${i.label} ${i.description ?? ""} ${i.value}`,
    );
    return filtered.length > 0 ? filtered : null;
  }

  const items: AutocompleteItem[] = [
    {
      value: "status",
      label: "status",
      description: "List spawned, queued and settled agents",
    },
    {
      value: "spawn",
      label: "spawn",
      description: "Open the spawn wizard",
    },
    {
      value: "worktree",
      label: "worktree",
      description: "Create a git worktree with no agent attached",
    },
    {
      value: "model",
      label: "model",
      description: "Set the model sub-agents use (opens pi's model picker)",
    },
    {
      value: "enable",
      label: "enable",
      description: "Enable pi-cowboy",
    },
    {
      value: "disable",
      label: "disable",
      description: "Disable pi-cowboy",
    },
  ];
  const filtered = fuzzyFilter(items, trimmed, (i) => i.label);
  return filtered.length > 0 ? filtered : null;
}

/**
 * The pi family's model list, read through the harness the spawns run under
 * rather than from the registry directly, so every pi-catalog reader shares one
 * source. A catalog that cannot answer reads as no models: this picker is a
 * convenience, and it must still open.
 */
async function piHarnessModels(
  modelCatalog: ModelCatalog,
): Promise<readonly ModelEntry[]> {
  try {
    return await harnessFor("pi").listModels({
      pi: getPiInstance(),
      modelCatalog,
    });
  } catch {
    return [];
  }
}

async function availableModelsForCompletion(): Promise<readonly ModelEntry[]> {
  const session = getSessionCtx();
  const scoped = session.scopedModels;
  if (scoped.length > 0) {
    return scoped.map((s) => ({
      key: `${s.model.provider}/${s.model.id}`,
    }));
  }
  return await piHarnessModels(session.modelRegistry);
}

export async function handleModelArg(
  value: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const store = getStore();
  if (value === "clear") {
    store.mutate.session.clearOverride("default");
    ctx.ui.notify(
      "Subagent model override cleared (session) — inherits parent/configured default",
      "info",
    );
    return;
  }
  if (value !== "") {
    const model = findModelInRegistry(value, ctx.modelRegistry, undefined);
    if (model) {
      applySessionDefault(store, ctx, model);
      return;
    }
  }
  await openSubagentModelPicker(
    ctx,
    value !== "" ? { initialSearch: value } : undefined,
  );
}
