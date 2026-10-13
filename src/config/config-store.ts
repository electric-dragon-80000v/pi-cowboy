/**
 * config-store.ts — persisted config + per-session overrides.
 * Reads return defaults baked in. Each persisted mutation persists with its
 * side effect, so a side effect cannot be forgotten. Effective config
 * resolves session overrides → project file → global file → built-in
 * defaults. Per-session lifecycle: `reload()` at session_start, `dispose()`
 * at session_shutdown.
 */

import type {
  SubagentsConfig,
  SessionModelOverrides,
} from "../models/model-precedence.js";
import {
  harnessDefaultModel,
  resolveModel,
} from "../models/model-precedence.js";
import type { AgentManager } from "../agents/agent-manager.js";
import {
  DEFAULT_HARNESS,
  parseHarnessId,
  type HarnessId,
} from "../agents/harness.js";
import { harnessFamilyOf } from "../agents/harness-family.js";
import type { ModelsByFamily, SystemPromptMode } from "../agents/types.js";
import type { ThinkingLevel } from "../types.js";
import {
  DEFAULT_WORKTREE_CHECKOUT_TYPE,
  DEFAULT_WORKTREE_MATERIALIZATION,
  parseWorktreeCheckoutType,
  parseWorktreeMaterialization,
  type WorktreeCheckoutType,
  type WorktreeMaterialization,
} from "../spawn/worktree-policy.js";
import { DEFAULT_AGENT_TYPE, DEFAULT_ORCHESTRATOR_NAME } from "../types.js";
import type { ConcurrencyConfig } from "../concurrency-pools.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import { LayeredConfig } from "./layered-config.js";
import {
  VALID_SYSTEM_PROMPT_MODES,
  MODEL_FAMILY_KEYS,
  createConfigIO,
  isProjectAllowedAgentKey,
  type ConfigIO,
  type ConfigTarget,
  type RawConfig,
  type RawConcurrency,
} from "./config-io.js";
import {
  CONCURRENCY_LIMIT_EXPECTED,
  ConcurrencyLimitSchema,
} from "./concurrency-limit.js";

export type { ConfigIO, RawConfig, RawConcurrency } from "./config-io.js";

const fileConfigIO: ConfigIO = createConfigIO();

/** True when a raw agent layer carries a model setting (model family or per-type key). */
function agentLayerHasModelSettings(layer: RawConfig | null): boolean {
  const agent = layer?.agent;
  if (!agent) return false;
  return Object.keys(agent).some(
    (key) => isProjectAllowedAgentKey(key) && agent[key] !== undefined,
  );
}

/** True when a raw layer carries the agent key with a defined value. */
function layerHasAgentKey(layer: RawConfig | null, key: string): boolean {
  return layer?.agent != null && layer.agent[key] !== undefined;
}

function sessionOverridesHasModelSettings(
  overrides: SessionModelOverrides,
): boolean {
  return Object.values(overrides).some((value) => value != null);
}

function concurrencyLayerHasSettings(layer: RawConcurrency): boolean {
  return (
    layer.default !== undefined ||
    (layer.harnesses != null && Object.keys(layer.harnesses).length > 0) ||
    (layer.providers != null && Object.keys(layer.providers).length > 0) ||
    (layer.models != null && Object.keys(layer.models).length > 0)
  );
}

const CLEAR_ALL_KEPT_AGENT_KEYS: ReadonlySet<string> = new Set(
  CONFIG_AGENT_NON_MODEL_KEYS.filter((key) => !MODEL_FAMILY_KEYS.has(key)),
);

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A programmatic write is a caller bug, not a refused target: it throws
 * before anything is persisted, so a bad limit never reaches the file or the
 * session layer. The file path instead warns and drops the entry.
 */
function assertConcurrencyLimit(n: number): void {
  const parsed = ConcurrencyLimitSchema.safeParse(n);
  if (!parsed.success) {
    throw new RangeError(
      `Invalid concurrency limit ${JSON.stringify(n)}: expected ${CONCURRENCY_LIMIT_EXPECTED}.`,
    );
  }
}

/**
 * The per-harness defaults of one raw agent slice, however a hand-edited file
 * left them. Structural rather than cast-then-trust: a value that is not an
 * object reads as an empty map, which every reader below already handles.
 */
function rawHarnessDefaults(
  agent: Record<string, unknown>,
): Record<string, string | null> {
  const entries = agent["defaultModelByHarness"];
  return entries !== null && typeof entries === "object"
    ? (entries as Record<string, string | null>)
    : {};
}

interface ResolvedAgentSettings {
  /** Null = inherit parent. */
  readonly defaultModel: string | null;
  /** Falls back to "general-purpose". */
  readonly defaultAgentType: string;
  /** Falls back to "default". */
  readonly defaultOrchestrator: string;
  /** System prompt mode: replace (default), inherit parent, or custom file. */
  readonly systemPromptMode: SystemPromptMode;
  readonly includeContextFiles: boolean;
  /** Undefined = inherit from agent config. */
  readonly defaultThinking: ThinkingLevel | undefined;
  readonly loadSkillsImplicitly: boolean;
  readonly loadExtensionsImplicitly: boolean;
  readonly disableDefaultAgents: boolean;
  /** False: the Cowboy tools are inactive and completions are not nudged. */
  readonly extensionEnabled: boolean;
  /** False: the 🤠 marker is not drawn above the editor. */
  readonly showActiveIndicator: boolean;
  /**
   * False (the default): the cowboy stands alone, with no pasture drawn under
   * him. True: the pasture is drawn, and its herd may step to a neighbour.
   */
  readonly grazingEnabled: boolean;
  /** Undefined = the default worktree root. */
  readonly worktreeRoot: string | undefined;
  readonly worktreeMaterialization: WorktreeMaterialization;
  readonly worktreeCheckoutType: WorktreeCheckoutType;
  /** Harness for agents whose template omits `harness_type`. */
  readonly harnessType: HarnessId;
}

interface ConfigStoreDeps {
  manager?: AgentManager;
}

export class ConfigStore {
  private readonly layers: LayeredConfig;
  private sessionOverrides: SessionModelOverrides = { default: null };
  /** Per-harness defaults set for this session only; cleared at session_start. */
  private sessionHarnessDefaults: Partial<Record<HarnessId, string | null>> =
    {};
  private sessionConcurrencyLayer: RawConcurrency = {};
  private manager?: AgentManager;

  constructor(io: ConfigIO = fileConfigIO) {
    this.layers = new LayeredConfig(io);
  }

  /** Does not reload; session_start follows with reload(). */
  setProjectDir(projectDir: string | undefined): void {
    this.layers.setProjectDir(projectDir);
  }

  /** A write creates an absent project file; only an untrusted or malformed one is refused. */
  get isProjectWritable(): boolean {
    return this.layers.isProjectWritable;
  }

  get agent(): ResolvedAgentSettings {
    const a = this.layers.effective.agent;

    return {
      defaultModel: a.default ?? null,
      defaultAgentType:
        nonEmptyString(a.defaultAgentType) ?? DEFAULT_AGENT_TYPE,
      defaultOrchestrator:
        nonEmptyString(a.defaultOrchestrator) ?? DEFAULT_ORCHESTRATOR_NAME,
      systemPromptMode: VALID_SYSTEM_PROMPT_MODES.has(
        a.systemPromptMode as string,
      )
        ? (a.systemPromptMode as SystemPromptMode)
        : "replace",
      includeContextFiles: a.includeContextFiles ?? true,
      defaultThinking: a.defaultThinking as ThinkingLevel | undefined,
      loadSkillsImplicitly: a.loadSkillsImplicitly !== false,
      loadExtensionsImplicitly: a.loadExtensionsImplicitly !== false,
      disableDefaultAgents: a.disableDefaultAgents === true,
      extensionEnabled: a.extensionEnabled !== false,
      showActiveIndicator: a.showActiveIndicator !== false,
      grazingEnabled: a.grazingEnabled === true,
      worktreeRoot:
        typeof a.worktreeRoot === "string" && a.worktreeRoot.trim() !== ""
          ? a.worktreeRoot
          : undefined,
      worktreeMaterialization:
        parseWorktreeMaterialization(a.worktreeMaterialization) ??
        DEFAULT_WORKTREE_MATERIALIZATION,
      worktreeCheckoutType:
        parseWorktreeCheckoutType(a.worktreeCheckoutType) ??
        DEFAULT_WORKTREE_CHECKOUT_TYPE,
      harnessType: parseHarnessId(a.harnessType) ?? DEFAULT_HARNESS,
    };
  }

  get concurrency(): ConcurrencyConfig {
    const base = this.layers.effective.concurrency;
    const session = this.sessionConcurrencyLayer;
    return {
      default: session.default ?? base.default,
      harnesses: { ...base.harnesses, ...session.harnesses },
      providers: { ...base.providers, ...session.providers },
      models: { ...base.models, ...session.models },
    };
  }

  get sessionDefaultModel(): string | null {
    return this.sessionOverrides.default ?? null;
  }

  sessionModelOverride(type: string): string | null {
    return this.sessionOverrides[type] ?? null;
  }

  /**
   * One harness's default model, session over project over global. The pi
   * family's own `default` key answers for it; every other harness reads its
   * entry in `defaultModelByHarness`. Null when that harness has no default,
   * which leaves the rest of the chain to answer.
   *
   * A session entry set to null (the picker's "(none)") reads as no
   * session entry, exactly as the session default model does: it unpins the
   * session, leaving the configured layers to answer.
   */
  defaultModelForHarness(harness: HarnessId): string | null {
    const session = nonEmptyString(this.sessionHarnessDefaults[harness]);
    return session ?? harnessDefaultModel(this.layers.effective.agent, harness);
  }

  hasSessionHarnessDefaultModel(harness: HarnessId): boolean {
    return nonEmptyString(this.sessionHarnessDefaults[harness]) !== undefined;
  }

  hasGlobalHarnessDefaultModel(harness: HarnessId): boolean {
    return this.harnessDefaultAt(this.layers.global, harness);
  }

  hasProjectHarnessDefaultModel(harness: HarnessId): boolean {
    return this.harnessDefaultAt(this.layers.project, harness);
  }

  /** A layer carries the harness's entry when the key is present, even when null. */
  private harnessDefaultAt(
    layer: RawConfig | null,
    harness: HarnessId,
  ): boolean {
    if (!layer?.agent) return false;
    return Object.prototype.hasOwnProperty.call(
      rawHarnessDefaults(layer.agent),
      harness,
    );
  }

  hasGlobalModelKey(key: string): boolean {
    return layerHasAgentKey(this.layers.global, key);
  }

  hasProjectModelKey(key: string): boolean {
    return layerHasAgentKey(this.layers.project, key);
  }

  get hasSessionModelSettings(): boolean {
    return (
      sessionOverridesHasModelSettings(this.sessionOverrides) ||
      Object.keys(this.sessionHarnessDefaults).length > 0
    );
  }

  get hasGlobalModelSettings(): boolean {
    return agentLayerHasModelSettings(this.layers.global);
  }

  get hasProjectModelSettings(): boolean {
    return agentLayerHasModelSettings(this.layers.project);
  }

  get projectConcurrency(): RawConcurrency {
    return { ...this.layers.project?.concurrency };
  }

  get globalConcurrency(): RawConcurrency {
    return { ...this.layers.global.concurrency };
  }

  get sessionConcurrency(): RawConcurrency {
    return { ...this.sessionConcurrencyLayer };
  }

  get hasSessionConcurrencySettings(): boolean {
    return concurrencyLayerHasSettings(this.sessionConcurrencyLayer);
  }

  get hasGlobalConcurrencySettings(): boolean {
    return concurrencyLayerHasSettings(this.layers.global.concurrency ?? {});
  }

  get hasProjectConcurrencySettings(): boolean {
    return concurrencyLayerHasSettings(this.layers.project?.concurrency ?? {});
  }

  /** Raw agent config incl. dynamic per-type model keys. */
  agentConfigSnapshot(): Readonly<SubagentsConfig["agent"]> {
    return this.layers.effective.agent;
  }

  /**
   * Precedence: session per-type → config per-type → agent template →
   * session default → the launching harness's default → parentModelId. Null
   * when the whole chain is unset and the parent has no model to inherit.
   * `harnessId` must be the harness the launch resolves, because it names which
   * default the chain reads.
   */
  modelFor(
    type: string,
    parentModelId: string | null,
    agentConfig: { modelsByFamily?: ModelsByFamily } | undefined,
    harnessId: HarnessId,
  ): string | null {
    return resolveModel({
      subagentType: type,
      agentConfig,
      harnessFamily: harnessFamilyOf(harnessId),
      config: this.layers.effective,
      harnessDefault: this.defaultModelForHarness(harnessId),
      parentModelId,
      sessionOverrides: this.sessionOverrides,
    });
  }

  // Session methods are in-memory only. Target-aware methods default to the
  // global layer; "all" clears every layer.

  readonly mutate = {
    agent: {
      setDefaultModel: (
        value: string | null,
        target: ConfigTarget = "global",
      ): void => {
        this.setAgentModelKey("default", value, target);
      },
      setModelOverride: (
        type: string,
        value: string | null,
        target: ConfigTarget = "global",
      ): void => {
        this.setAgentModelKey(type, value, target);
      },
      clearModelOverride: (
        type: string,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.layers.clear(
          target,
          (raw) => {
            if (raw.agent) delete raw.agent[type];
          },
          () => {
            delete this.sessionOverrides[type];
          },
        );
      },
      /** Keeps non-model settings. */
      clearAllModelOverrides: (
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.layers.clear(
          target,
          (raw) => this.clearAgentModelKeys(raw),
          () => {
            this.sessionOverrides = { default: null };
            this.sessionHarnessDefaults = {};
          },
        );
      },
      /** Undefined clears back to the built-in fallback. */
      setDefaultAgentType: (type: string | undefined) =>
        this.setAgentLayerEntry("defaultAgentType", type, "global"),
      /** Undefined clears back to the built-in fallback. */
      setDefaultOrchestrator: (name: string | undefined) =>
        this.setAgentLayerEntry("defaultOrchestrator", name, "global"),
      setSystemPromptMode: (mode: SystemPromptMode) =>
        this.setAgentLayerEntry("systemPromptMode", mode, "global"),
      setIncludeContextFiles: (enabled: boolean) =>
        this.setAgentLayerEntry("includeContextFiles", enabled, "global"),
      setDefaultThinking: (
        level: ThinkingLevel | undefined,
        target: "global" | "project" = "global",
      ): void => {
        this.setAgentLayerEntry("defaultThinking", level, target);
      },
      setLoadSkillsImplicitly: (value: boolean) =>
        this.setAgentLayerEntry("loadSkillsImplicitly", value, "global"),
      setLoadExtensionsImplicitly: (value: boolean) =>
        this.setAgentLayerEntry("loadExtensionsImplicitly", value, "global"),
      setDisableDefaultAgents: (value: boolean) =>
        this.setAgentLayerEntry("disableDefaultAgents", value, "global"),
      setExtensionEnabled: (value: boolean) =>
        this.setAgentLayerEntry("extensionEnabled", value, "global"),
      setShowActiveIndicator: (value: boolean) =>
        this.setAgentLayerEntry("showActiveIndicator", value, "global"),
      setGrazingEnabled: (value: boolean) =>
        this.setAgentLayerEntry("grazingEnabled", value, "global"),
      /** Undefined clears back to the default. */
      setWorktreeRoot: (root: string | undefined) =>
        this.setAgentLayerEntry("worktreeRoot", root, "global"),
      setWorktreeMaterialization: (materialization: WorktreeMaterialization) =>
        this.setAgentLayerEntry(
          "worktreeMaterialization",
          materialization,
          "global",
        ),
      setWorktreeCheckoutType: (policy: WorktreeCheckoutType) =>
        this.setAgentLayerEntry("worktreeCheckoutType", policy, "global"),
      setHarnessType: (harnessType: HarnessId) =>
        this.setAgentLayerEntry("harnessType", harnessType, "global"),
      /**
       * One harness's default, written entry-wise: the map is a whole value in
       * the file, so writing it whole would drop every other harness's entry.
       * `null` is a real answer — that harness inherits the parent — and is
       * written as such rather than deleting the key.
       */
      setHarnessDefaultModel: (
        harness: HarnessId,
        value: string | null,
        target: ConfigTarget = "global",
      ): void => {
        if (target === "session") {
          this.sessionHarnessDefaults[harness] = value;
          return;
        }
        this.layers.mutate(target, (raw) => {
          raw.agent ??= {};
          raw.agent.defaultModelByHarness = {
            ...rawHarnessDefaults(raw.agent),
            [harness]: value,
          };
        });
      },
      clearHarnessDefaultModel: (
        harness: HarnessId,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.layers.clear(
          target,
          (raw) => {
            if (!raw.agent) return;
            const entries = rawHarnessDefaults(raw.agent);
            delete entries[harness];
            if (Object.keys(entries).length === 0) {
              delete raw.agent.defaultModelByHarness;
            } else {
              raw.agent.defaultModelByHarness = entries;
            }
          },
          () => {
            delete this.sessionHarnessDefaults[harness];
          },
        );
      },
    },
    concurrency: {
      setDefault: (n: number, target: ConfigTarget = "global"): void => {
        assertConcurrencyLimit(n);
        this.applyConcurrencyWrite(target, (layer) => {
          layer.default = n;
        });
      },
      setHarness: (
        harness: HarnessId,
        n: number,
        target: ConfigTarget = "global",
      ): void => {
        assertConcurrencyLimit(n);
        this.applyConcurrencyWrite(target, (layer) => {
          layer.harnesses = { ...layer.harnesses, [harness]: n };
        });
      },
      setProvider: (
        key: string,
        n: number,
        target: ConfigTarget = "global",
      ): void => {
        assertConcurrencyLimit(n);
        this.applyConcurrencyWrite(target, (layer) => {
          layer.providers = { ...layer.providers, [key]: n };
        });
      },
      setModel: (
        key: string,
        n: number,
        target: ConfigTarget = "global",
      ): void => {
        assertConcurrencyLimit(n);
        this.applyConcurrencyWrite(target, (layer) => {
          layer.models = { ...layer.models, [key]: n };
        });
      },
      removeHarness: (
        harness: HarnessId,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.removeConcurrencyEntry("harnesses", harness, target);
      },
      removeProvider: (
        key: string,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.removeConcurrencyEntry("providers", key, target);
      },
      removeDefault: (target: ConfigTarget | "all" = "global"): void => {
        this.removeConcurrencyEntry("default", undefined, target);
      },
      removeModel: (
        key: string,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.removeConcurrencyEntry("models", key, target);
      },
      /** Effective values fall through. */
      clearAll: (target: ConfigTarget | "all" = "global"): void => {
        this.layers.clear(
          target,
          (raw) => {
            delete raw.concurrency;
          },
          () => {
            this.sessionConcurrencyLayer = {};
          },
        );
        this.applyConcurrency();
      },
    },
    session: {
      /** Not persisted. */
      setOverride: (type: string, model: string): void => {
        this.sessionOverrides[type] = model;
      },
      clearOverride: (type: string): void => {
        delete this.sessionOverrides[type];
      },
      clearAll: (): void => {
        this.sessionOverrides = { default: null };
      },
    },
  };

  /** Called at session_start. */
  reload(): void {
    this.layers.reload();
    this.sessionOverrides = { default: null };
    this.sessionHarnessDefaults = {};
    this.sessionConcurrencyLayer = {};
    this.applyConcurrency();
  }

  /** Re-syncs whatever deps are present. */
  setDeps(deps: ConfigStoreDeps): void {
    if (deps.manager !== undefined) this.manager = deps.manager;
    this.applyConcurrency();
  }

  /** The manager is disposed by the composition root. */
  dispose(): void {
    this.manager = undefined;
  }

  /** Undefined deletes the key. */
  private setAgentLayerEntry(
    key: string,
    value: unknown,
    target: "global" | "project",
  ): void {
    this.layers.mutate(target, (raw) => {
      raw.agent ??= {};
      if (value === undefined) delete raw.agent[key];
      else raw.agent[key] = value;
    });
  }

  /** Session model overrides are in-memory; the raw layers hold the rest. */
  private setAgentModelKey(
    key: string,
    value: string | null,
    target: ConfigTarget,
  ): void {
    if (target === "session") {
      this.sessionOverrides[key] = value;
      return;
    }
    this.setAgentLayerEntry(key, value, target);
  }

  /** A session write lands in memory; a file write persists, then re-syncs. */
  private applyConcurrencyWrite(
    target: ConfigTarget,
    write: (layer: RawConcurrency) => void,
  ): void {
    if (target === "session") {
      write(this.sessionConcurrencyLayer);
    } else if (
      !this.layers.mutate(target, (raw) => {
        raw.concurrency ??= {};
        write(raw.concurrency);
      })
    ) {
      // The project target was unavailable: nothing changed, so nothing to sync.
      return;
    }
    this.applyConcurrency();
  }

  private clearAgentModelKeys(layer: RawConfig): void {
    if (!layer.agent) return;
    for (const key of Object.keys(layer.agent)) {
      if (!CLEAR_ALL_KEPT_AGENT_KEYS.has(key)) delete layer.agent[key];
    }
  }

  private removeConcurrencyEntry(
    section: "default" | "harnesses" | "providers" | "models",
    key: string | undefined,
    target: ConfigTarget | "all",
  ): void {
    const removeFrom = (layer: RawConcurrency | undefined): void => {
      if (!layer) return;
      if (section === "default") {
        delete layer.default;
        return;
      }
      if (key === undefined) return;
      if (section === "harnesses") {
        const harness = parseHarnessId(key);
        if (harness !== undefined && layer.harnesses) {
          delete layer.harnesses[harness];
        }
        return;
      }
      const entries = layer[section];
      if (entries) delete entries[key];
    };
    this.layers.clear(
      target,
      (raw) => removeFrom(raw.concurrency),
      () => removeFrom(this.sessionConcurrencyLayer),
    );
    this.applyConcurrency();
  }

  private applyConcurrency(): void {
    this.manager?.setConcurrency(this.concurrency);
  }
}
