/**
 * menu-system-prompt.ts — system prompt mode, AGENTS.md, skills, extensions.
 * Exports: showSystemPromptMenu.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import type { SystemPromptMode } from "../../agents/types.js";
import { getStore } from "../../shell.js";
import { errorMessage } from "../../utils.js";
import { customPromptPath } from "../../config/config-io.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { ScreenHost } from "./screen-host.js";
import { buildSettingsListTheme } from "./helpers.js";

export async function showSystemPromptMenu(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const store = getStore();

  const buildItems = (): SettingItem[] => {
    const promptPath = customPromptPath();
    const items: SettingItem[] = [
      {
        id: "systemPromptMode",
        label: "System prompt mode",
        currentValue: store.agent.systemPromptMode,
        values: ["replace", "inherit", "custom"],
        description:
          "How the subagent system prompt is built: replace, inherit, or custom.",
      },
    ];

    if (
      store.agent.systemPromptMode === "custom" &&
      !fs.existsSync(promptPath)
    ) {
      items.push({
        id: "createPromptFile",
        label: "Create prompt file",
        currentValue: promptPath,
        values: ["Create"],
        description: `Create ${promptPath} with a starter template for custom mode.`,
      });
    }

    items.push(
      {
        id: "includeContextFiles",
        label: "Include context files",
        currentValue: store.agent.includeContextFiles ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description:
          "Load project and ~/.pi/agent AGENTS.md as shared <project_context>.",
      },
      {
        id: "loadSkillsImplicitly",
        label: "Load skills implicitly",
        currentValue: store.agent.loadSkillsImplicitly ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description:
          "Give new agents all skills when an agent template omits the field.",
      },
      {
        id: "loadExtensionsImplicitly",
        label: "Load extensions implicitly",
        currentValue: store.agent.loadExtensionsImplicitly ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description:
          "Give new agents all extensions when an agent template omits the field.",
      },
    );

    return items;
  };

  let items = buildItems();
  let rebuild: ((newItems: SettingItem[]) => void) | null = null;

  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "systemPromptMode":
        store.mutate.agent.setSystemPromptMode(newValue as SystemPromptMode);
        ctx.ui.notify(`System prompt mode set to ${newValue}`, "info");
        items = buildItems();
        rebuild?.(items);
        break;
      case "createPromptFile":
        try {
          const promptPath = customPromptPath();
          fs.mkdirSync(path.dirname(promptPath), { recursive: true });
          fs.writeFileSync(
            promptPath,
            "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously",
            "utf-8",
          );
          ctx.ui.notify(`Created prompt file: ${promptPath}`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Failed to create prompt file: ${errorMessage(err)}`,
            "error",
          );
        }
        return;
      case "includeContextFiles":
        store.mutate.agent.setIncludeContextFiles(newValue === "ON");
        ctx.ui.notify(`Include context files set to ${newValue}`, "info");
        break;
      case "loadSkillsImplicitly":
        store.mutate.agent.setLoadSkillsImplicitly(newValue === "ON");
        ctx.ui.notify(`Load skills implicitly set to ${newValue}`, "info");
        break;
      case "loadExtensionsImplicitly":
        store.mutate.agent.setLoadExtensionsImplicitly(newValue === "ON");
        ctx.ui.notify(`Load extensions implicitly set to ${newValue}`, "info");
        break;
    }
  };

  await new ScreenHost(ctx).open<void>(({ theme, close }) => {
    const settingsList = new SettingsList(
      items,
      10,
      buildSettingsListTheme(theme),
      onChange,
      close,
    );
    return new SettingsListWrapper(settingsList, {
      title: "System Prompt",
      theme,
      onCancel: close,
      onRebuild: (r) => {
        rebuild = r;
      },
    });
  });
}
