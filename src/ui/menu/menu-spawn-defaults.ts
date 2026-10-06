/**
 * menu-spawn-defaults.ts — the spawn-defaults rows the topmost agents menu hosts:
 * the default agent type and the default orchestrator, each with its picker.
 *
 * A pick pre-selects the value in force and persists through the store, so the
 * row's host repaints from the store rather than from the picker's return.
 */

import type { SettingItem } from "@earendil-works/pi-tui";
import type { Theme } from "../types.js";
import { getAgentConfig, getAvailableTypes } from "../../agents/agent-types.js";
import { getAvailableOrchestrators } from "../../orchestrators/orchestrator-types.js";
import { DEFAULT_ORCHESTRATORS } from "../../orchestrators/default-orchestrators.js";
import { DEFAULT_AGENT_TYPE, DEFAULT_ORCHESTRATOR_NAME } from "../../types.js";
import { SearchableSelectDialog } from "../searchable-select.js";
import { getStore } from "../../shell.js";
import { type Notify, type SubmenuFactory } from "./helpers.js";

/** Picker over registered agent types (current default carries ✓); applies to the next spawn. */
function createAgentTypeSubmenu(
  store: ReturnType<typeof getStore>,
  notify: Notify,
  theme: Theme,
): SubmenuFactory {
  return (_currentValue, done) => {
    const available = getAvailableTypes();
    const names = available.length > 0 ? available : [DEFAULT_AGENT_TYPE];
    const items = names.map((name) => ({
      value: name,
      label: name,
      provider: getAgentConfig(name)?.description ?? "",
    }));
    return new SearchableSelectDialog(
      items,
      store.agent.defaultAgentType,
      {
        onSelect: (value) => {
          if (value != null) {
            store.mutate.agent.setDefaultAgentType(value);
            notify(`Agent set to ${value}`, "info");
          }
          done(value ?? undefined);
        },
        onCancel: () => done(),
      },
      theme,
    );
  };
}

/** Picker over registered orchestrators (code defaults when the registry is empty); current default carries ✓. */
function createOrchestratorSubmenu(
  store: ReturnType<typeof getStore>,
  notify: Notify,
  theme: Theme,
): SubmenuFactory {
  return (_currentValue, done) => {
    const available = getAvailableOrchestrators();
    const names =
      available.length > 0 ? available : Object.keys(DEFAULT_ORCHESTRATORS);
    const items = names.map((name) => ({ value: name, label: name }));
    return new SearchableSelectDialog(
      items,
      store.agent.defaultOrchestrator,
      {
        onSelect: (value) => {
          if (value != null) {
            store.mutate.agent.setDefaultOrchestrator(value);
            notify(`Default orchestrator set to ${value}`, "info");
          }
          done(value ?? undefined);
        },
        onCancel: () => done(),
      },
      theme,
    );
  };
}

/** What a spawn-defaults row needs from its host menu. */
export interface SpawnDefaultsRowOptions {
  store: ReturnType<typeof getStore>;
  notify: Notify;
  theme: Theme;
}

export function buildDefaultAgentTypeRow(
  options: SpawnDefaultsRowOptions,
): SettingItem {
  return {
    id: "defaultAgentType",
    label: "Agent",
    currentValue: options.store.agent.defaultAgentType,
    submenu: createAgentTypeSubmenu(
      options.store,
      options.notify,
      options.theme,
    ),
    description: `Agent type used when cowboy_agent omits \`agent_type\`. Default: ${DEFAULT_AGENT_TYPE}.`,
  };
}

/** The persisted default orchestrator: every spawn resolves its orchestration template from this row alone. */
export function buildDefaultOrchestratorRow(
  options: SpawnDefaultsRowOptions,
): SettingItem {
  return {
    id: "defaultOrchestrator",
    label: "Default orchestrator",
    currentValue: options.store.agent.defaultOrchestrator,
    submenu: createOrchestratorSubmenu(
      options.store,
      options.notify,
      options.theme,
    ),
    description: `Orchestration template used for every cowboy_agent spawn; the tool accepts no per-call orchestrator input. Default: ${DEFAULT_ORCHESTRATOR_NAME}.`,
  };
}
