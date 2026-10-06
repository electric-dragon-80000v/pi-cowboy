/**
 * layered-config.test.ts — the three-layer routing on its own: which file a
 * change reaches, when the project layer may come into being, and what the
 * effective merge reads. An in-memory ConfigIO stands in for the two files.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayeredConfig } from "../src/config/layered-config.js";
import type {
  ConfigIO,
  LoadedConfig,
  ProjectLayerStatus,
  RawConfig,
} from "../src/config/config-io.js";

interface Save {
  layer: "global" | "project";
  config: RawConfig;
}

/** The two files the store reads, mutable so `reload` has something fresh to read. */
interface Files {
  global: RawConfig;
  project: RawConfig | null;
  projectStatus: ProjectLayerStatus;
}

interface Memory {
  layers: LayeredConfig;
  saves: Save[];
  files: Files;
}

/** In-memory ConfigIO: records every save so persistence is assertable. */
function createMemory(
  options: {
    global?: RawConfig;
    project?: RawConfig | null;
    projectStatus?: ProjectLayerStatus;
    globalWritable?: boolean;
  } = {},
): Memory {
  const files: Files = {
    global: structuredClone(options.global ?? {}),
    project:
      options.project === undefined ? null : structuredClone(options.project),
    projectStatus:
      options.projectStatus ?? (options.project ? "loaded" : "untrusted"),
  };
  const saves: Save[] = [];
  const io: ConfigIO = {
    load: (): LoadedConfig => ({
      global: structuredClone(files.global),
      project: files.project === null ? null : structuredClone(files.project),
      projectStatus: files.projectStatus,
    }),
    isGlobalWritable: () => options.globalWritable ?? true,
    saveGlobal: (config) => {
      files.global = structuredClone(config);
      saves.push({ layer: "global", config: structuredClone(config) });
    },
    saveProject: (config) => {
      files.project = structuredClone(config);
      files.projectStatus = "loaded";
      saves.push({ layer: "project", config: structuredClone(config) });
    },
  };
  return { layers: new LayeredConfig(io), saves, files };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writes", () => {
  it("applies a global change to the global layer and persists it", () => {
    const memory = createMemory();

    const wrote = memory.layers.mutate("global", (raw) => {
      raw.agent = { default: "openai/gpt-4o" };
    });

    expect(wrote).toBe(true);
    expect(memory.saves).toEqual([
      { layer: "global", config: { agent: { default: "openai/gpt-4o" } } },
    ]);
    expect(memory.layers.effective.agent.default).toBe("openai/gpt-4o");
  });

  it("creates an absent project layer on a write", () => {
    const memory = createMemory({ projectStatus: "absent" });

    const wrote = memory.layers.mutate("project", (raw) => {
      raw.agent = { default: "openai/gpt-4o" };
    });

    expect(wrote).toBe(true);
    expect(memory.saves).toEqual([
      { layer: "project", config: { agent: { default: "openai/gpt-4o" } } },
    ]);
    expect(memory.layers.project).toEqual({
      agent: { default: "openai/gpt-4o" },
    });
  });

  it("keeps writing to the project layer it created", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = createMemory({ projectStatus: "absent" });

    memory.layers.mutate("project", (raw) => {
      raw.agent = { default: "first" };
    });
    memory.layers.mutate("project", (raw) => {
      raw.concurrency = { default: 4 };
    });

    expect(memory.saves).toEqual([
      { layer: "project", config: { agent: { default: "first" } } },
      {
        layer: "project",
        config: { agent: { default: "first" }, concurrency: { default: 4 } },
      },
    ]);
    expect(memory.layers.isProjectWritable).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a project write while the file may not be created", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = createMemory({ projectStatus: "malformed" });

    const wrote = memory.layers.mutate("project", () => {
      throw new Error("the update must not run");
    });

    expect(wrote).toBe(false);
    expect(memory.saves).toEqual([]);
    expect(memory.layers.project).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[subagents] Project config target unavailable (malformed); change ignored",
    );
  });

  it("refuses a global write while the file could not be parsed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = createMemory({ globalWritable: false });

    const wrote = memory.layers.mutate("global", () => {
      throw new Error("the update must not run");
    });

    expect(wrote).toBe(false);
    expect(memory.saves).toEqual([]);
    expect(memory.layers.isGlobalWritable).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[subagents] Refusing to write global config (malformed); change not saved",
    );
  });
});

describe("clears", () => {
  it("clears the named layer and leaves the others alone", () => {
    const memory = createMemory({
      global: { agent: { default: "global" } },
      project: { agent: { default: "project" } },
    });
    const cleared: string[] = [];

    memory.layers.clear(
      "project",
      (raw) => {
        if (raw.agent) delete raw.agent.default;
      },
      () => cleared.push("session"),
    );

    expect(cleared).toEqual([]);
    expect(memory.saves).toEqual([{ layer: "project", config: { agent: {} } }]);
    expect(memory.layers.global).toEqual({ agent: { default: "global" } });
  });

  it('clears the session, then the global, then the project with "all"', () => {
    const memory = createMemory({
      global: { concurrency: { default: 9 } },
      project: { concurrency: { default: 7 } },
    });
    const cleared: string[] = [];

    memory.layers.clear(
      "all",
      (raw) => {
        delete raw.concurrency;
      },
      () => cleared.push("session"),
    );

    expect(cleared).toEqual(["session"]);
    expect(memory.saves).toEqual([
      { layer: "global", config: {} },
      { layer: "project", config: {} },
    ]);
  });

  it("never creates a project layer on a clear", () => {
    const memory = createMemory({ projectStatus: "absent" });

    memory.layers.clear(
      "project",
      (raw) => {
        delete raw.agent;
      },
      () => {},
    );

    expect(memory.saves).toEqual([]);
    expect(memory.layers.project).toBeNull();
  });

  it("touches no file when the session layer is the target", () => {
    const memory = createMemory({ global: { agent: { default: "global" } } });
    const cleared: string[] = [];

    memory.layers.clear(
      "session",
      (raw) => {
        raw.agent = { default: "wrong" };
      },
      () => cleared.push("session"),
    );

    expect(cleared).toEqual(["session"]);
    expect(memory.saves).toEqual([]);
    expect(memory.layers.global).toEqual({ agent: { default: "global" } });
  });

  it("always persists the global layer", () => {
    const memory = createMemory({ global: { concurrency: { default: 9 } } });

    memory.layers.clear(
      "global",
      (raw) => {
        delete raw.concurrency;
      },
      () => {},
    );

    expect(memory.saves).toEqual([{ layer: "global", config: {} }]);
  });
});

describe("effective", () => {
  it("folds the project over the global over the built-in defaults", () => {
    const memory = createMemory({
      global: { agent: { default: "global", extensionEnabled: false } },
      project: { agent: { default: "project", extensionEnabled: true } },
    });

    const effective = memory.layers.effective;

    expect(effective.agent.default).toBe("project");
    // A project file may carry model keys only; the flag keeps its global value.
    expect(effective.agent.extensionEnabled).toBe(false);
  });

  it("reads a change back as soon as it is written", () => {
    const memory = createMemory();

    memory.layers.mutate("global", (raw) => {
      raw.concurrency = { default: 2 };
    });

    expect(memory.layers.effective.concurrency.default).toBe(2);
  });
});

describe("reload and target availability", () => {
  it("re-reads both files", () => {
    const memory = createMemory({ global: { agent: { default: "before" } } });

    memory.files.global = { agent: { default: "after" } };
    memory.files.project = { agent: { default: "project" } };
    memory.files.projectStatus = "loaded";
    memory.layers.reload();

    expect(memory.layers.effective.agent.default).toBe("project");
    expect(memory.layers.global).toEqual({ agent: { default: "after" } });
    expect(memory.layers.project).toEqual({ agent: { default: "project" } });
  });

  it("is writable unless the file is untrusted or malformed", () => {
    const offered = (projectStatus: ProjectLayerStatus): boolean =>
      createMemory({ projectStatus }).layers.isProjectWritable;

    expect(offered("loaded")).toBe(true);
    expect(offered("absent")).toBe(true);
    expect(offered("untrusted")).toBe(false);
    expect(offered("malformed")).toBe(false);
  });
});
