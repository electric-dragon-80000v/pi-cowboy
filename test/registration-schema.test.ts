/**
 * registration-schema.test.ts — the cowboy_agent tool's batched parameter
 * shape. Pins: `agents` is the required array (minItems 1), the per-item
 * `model` field is a nullable union, the call-level `run_in_background` is
 * a nullable union (the cross-field rule lives in the parse layer, not the
 * schema), the per-item `prompt` description names the commit-after-approval
 * contract, and the long description names the batching contract.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { isRecord } from "../src/predicates.js";
import { registerAgentTool, registerTools } from "../src/registration.js";

interface CapturedTool {
  name: string;
  description: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

interface ItemsShape {
  type: string;
  minItems?: number;
  items: {
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function captureAgentTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool: (tool: CapturedTool) => {
      captured = tool;
    },
  } as unknown as ExtensionAPI;
  registerAgentTool(pi);
  if (!captured) throw new Error("registerAgentTool registered no tool");
  return captured;
}

function stringMember(property: unknown): { description?: string } | undefined {
  if (!isRecord(property) || property.type !== "string") return undefined;
  const description = property.description;
  return {
    description: typeof description === "string" ? description : undefined,
  };
}

function captureTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];
  const pi = {
    registerTool: (tool: CapturedTool) => {
      captured.push(tool);
    },
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  registerTools(pi);
  return captured;
}

function itemProperties(
  tool: CapturedTool,
): Record<string, unknown> | undefined {
  const agents = tool.parameters.properties?.agents as ItemsShape | undefined;
  return agents?.items.properties;
}

function itemRequired(tool: CapturedTool): string[] | undefined {
  const agents = tool.parameters.properties?.agents as ItemsShape | undefined;
  return agents?.items.required;
}

describe("cowboy_agent registration", () => {
  it("requires an `agents` array of at least one item", () => {
    const tool = captureAgentTool();
    const agents = tool.parameters.properties?.agents as ItemsShape | undefined;
    expect(agents?.type).toBe("array");
    expect(agents?.minItems).toBe(1);
    expect(tool.parameters.required).toEqual(["agents"]);
  });

  it("exposes per-item `model` as an optional string, never required", () => {
    const tool = captureAgentTool();
    const model = itemProperties(tool)?.model;
    expect(model).toBeDefined();
    expect(isRecord(model) ? model.type : undefined).toBe("string");
    expect(itemRequired(tool) ?? []).not.toContain("model");
  });

  it("documents the per-item `prompt` param as the task itself, committing only what needs changes", () => {
    const tool = captureAgentTool();
    const description =
      stringMember(itemProperties(tool)?.prompt)?.description ?? "";
    expect(description).toContain("isolated branch");
    expect(description).toContain(
      "Do not instruct the agent to avoid committing",
    );
  });

  it("documents the per-item `model` param as optional and states what unset means", () => {
    const tool = captureAgentTool();
    const description =
      stringMember(itemProperties(tool)?.model)?.description ?? "";
    expect(description).toMatch(/^Optional\b/);
    expect(description).toContain('"provider/model-id"');
    expect(description).toContain("unset");
    expect(description).toContain("configured default");
    expect(description).toContain("fails the call");
    expect(description).toContain("provider/model error");
    expect(description).toContain("continue where the failed attempt left off");
  });

  it("advertises batching, the cross-field rule, and the report file in the long description", () => {
    const tool = captureAgentTool();
    expect(tool.description).toContain("`agents`");
    expect(tool.description).toContain("single-item");
    // The subagent is told to write its own deliverable; the orchestrator must not repeat that.
    expect(tool.description).toContain("report file");
    expect(tool.description).toContain("do not repeat reporting instructions");
    // The cross-field rule: non-background call with multiple items is rejected.
    expect(tool.description).toContain("run_in_background: false");
    expect(tool.description).toMatch(/exactly one item/);
  });

  it("forbids extra properties at the call level and on each item", () => {
    const tool = captureAgentTool();
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(Object.keys(tool.parameters.properties ?? {})).not.toContain(
      "orchestrator",
    );
    expect(Object.keys(tool.parameters.properties ?? {})).not.toContain(
      "fork_session",
    );
    expect(Object.keys(tool.parameters.properties ?? {})).not.toContain(
      "agent_guidance",
    );
    expect(Object.keys(itemProperties(tool) ?? {})).not.toContain(
      "orchestrator",
    );
    expect(Object.keys(itemProperties(tool) ?? {})).not.toContain(
      "agent_guidance",
    );
  });
});

describe("removed guidance-generation tools", () => {
  it("registers neither GenerateAgentGuidance nor DiscardGeneratedAgentGuidance", () => {
    const names = captureTools().map((tool) => tool.name);

    expect(names).not.toContain("GenerateAgentGuidance");
    expect(names).not.toContain("DiscardGeneratedAgentGuidance");
  });

  it("drops the two-call protocol from the cowboy_agent description", () => {
    const tool = captureAgentTool();

    expect(tool.description).not.toContain("GenerateAgentGuidance");
    expect(tool.description).not.toContain("two-call");
  });
});

describe("batch tool registration (stop, cleanup, merge, steer)", () => {
  function toolByName(name: string): CapturedTool {
    const tool = captureTools().find((t) => t.name === name);
    if (!tool) throw new Error(`${name} was not registered`);
    return tool;
  }

  function arrayProperty(
    tool: CapturedTool,
    key: string,
  ): { minItems?: number; itemsType?: string } {
    const prop = tool.parameters.properties?.[key] as
      | { type?: string; minItems?: number; items?: { type?: string } }
      | undefined;
    return {
      minItems: prop?.type === "array" ? prop.minItems : undefined,
      itemsType: prop?.type === "array" ? prop.items?.type : undefined,
    };
  }

  it.each([
    ["stop_cowboy_agent", "agent_ids"],
    ["cleanup_cowboy_agent", "agent_ids"],
    ["merge_cowboy_branch", "branches"],
  ])(
    "%s requires a non-empty string array in `%s` and nothing else",
    (name, key) => {
      const tool = toolByName(name);
      expect(arrayProperty(tool, key)).toEqual({
        minItems: 1,
        itemsType: "string",
      });
      expect(tool.parameters.required).toEqual([key]);
      expect(tool.parameters.additionalProperties).toBe(false);
    },
  );

  it("requires steer agent_ids plus the one message every id receives", () => {
    const tool = toolByName("steer_cowboy_agent");
    expect(arrayProperty(tool, "agent_ids")).toEqual({
      minItems: 1,
      itemsType: "string",
    });
    expect(tool.parameters.required).toEqual(["agent_ids", "message"]);
    expect(tool.parameters.additionalProperties).toBe(false);
    const message = tool.parameters.properties?.message as
      { type?: string; description?: string } | undefined;
    expect(message?.type).toBe("string");
    expect(message?.description).toContain("every id");
  });

  it("keeps merge's target and repo optional and call-level", () => {
    const tool = toolByName("merge_cowboy_branch");
    const props = tool.parameters.properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["branches", "repo", "target"]);
    expect(tool.parameters.required).toEqual(["branches"]);
  });

  it.each([
    ["stop_cowboy_agent", "agent_ids"],
    ["cleanup_cowboy_agent", "agent_ids"],
    ["merge_cowboy_branch", "branches"],
    ["steer_cowboy_agent", "agent_ids"],
  ])("%s advertises the batch contract in its description", (name, key) => {
    const tool = toolByName(name);
    expect(tool.description).toContain(`\`${key}\``);
    expect(tool.description).toMatch(/independently|sequentially/);
  });

  it("advertises that one steer message applies to every id", () => {
    const tool = toolByName("steer_cowboy_agent");
    expect(tool.description).toContain("single `message`");
  });

  it.each([
    ["stop_cowboy_agent", "agent_ids", "before anything is stopped"],
    ["cleanup_cowboy_agent", "agent_ids", "before anything is removed"],
    ["merge_cowboy_branch", "branches", "before anything merges"],
    ["steer_cowboy_agent", "agent_ids", "before anything is delivered"],
  ])("%s rejects a repeated id before touching anything", (name, key, tail) => {
    const tool = toolByName(name);
    expect(tool.description).toContain(`is rejected ${tail}`);
    const param = tool.parameters.properties?.[key] as
      { description?: string } | undefined;
    expect(param?.description).toContain(`is rejected ${tail}`);
  });
});
