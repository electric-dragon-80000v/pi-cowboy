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
  SessionThinkingOverrides,
} from "../models/model-precedence.js";
import {
  harnessDefaultModel,
  harnessDefaultThinking,
  isNamedValue,
  resolveModel,
  resolveThinking,
} from "../models/model-precedence.js";
import type { AgentManager } from "../agents/agent-manager.js";
import {
  DEFAULT_HARNESS,
  isPiFamilyHarness,
  type AnyHarnessId,
  type HarnessConfigIssue,
} from "../agents/harness.js";
import { harnessFamilyOf } from "../agents/harness/harness-registry.js";
import { parsePoolKey } from "../concurrency-pools.js";
import type {
  ModelsByFamily,
  SystemPromptMode,
  ThinkingByFamily,
} from "../agents/types.js";

import {
  DEFAULT_WORKTREE_CHECKOUT_TYPE,
  DEFAULT_WORKTREE_MATERIALIZATION,
  type WorktreeCheckoutType,
  type WorktreeMaterialization,
} from "../spawn/worktree-policy.js";
import {
  DEFAULT_AGENT_TYPE,
  DEFAULT_ORCHESTRATOR_NAME,
  ThinkingLevelSchema,
  type ThinkingLevel,
} from "../types.js";
import type { ConcurrencyConfig } from "../concurrency-pools.js";
import {
  CONFIG_AGENT_NON_MODEL_KEYS,
  type ConfigLayerPresence,
} from "./types.js";
import { LayeredConfig } from "./layered-config.js";
import { FILE_FIX, incompatibleWarning } from "./config-validation.js";
import {
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

/**
 * Presence of one entry in a per-entry agent table. The value cannot answer:
 * a null entry is a real answer at that layer, masking the ones below, so only
 * the key's own presence tells it apart from an absent entry.
 */
function layerCarriesEntry<K extends string>(
  entries: Partial<Record<K, string | null>> | undefined,
  key: K,
): boolean {
  return entries != null && Object.hasOwn(entries, key);
}

/**
 * A token for the pi family's `agent.defaultThinking` scalar, whose type is pi's
 * own level list. A caller passing anything else is asking for a file the next
 * load would reject, so it fails before the write.
 */
function piThinkingLevel(token: string): ThinkingLevel {
  const parsed = ThinkingLevelSchema.safeParse(token);
  if (!parsed.success) {
    throw new RangeError(`Invalid pi thinking level ${JSON.stringify(token)}`);
  }
  return parsed.data;
}

/**
 * The session slot one harness's default thinking token lives in. The pi family
 * runs one binary, so pig and pi-bolt share pi's slot rather than each holding
 * a private default.
 */
function thinkingSlot(harness: AnyHarnessId): string {
  return isPiFamilyHarness(harness) ? "pi" : harness;
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

/** A value with a non-space character; an id or key is read as written. */
function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && /\S/.test(value) ? value : undefined;
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
 * The per-harness defaults of one agent layer: the map validation kept, or an
 * empty one when the layer has none.
 */
function rawHarnessDefaults(
  agent: Partial<SubagentsConfig["agent"]>,
): Record<string, string | null> {
  return agent.defaultModelByHarness ?? {};
}

/** The per-harness default thinking tokens of one agent layer, or an empty map. */
function rawThinkingByHarness(
  agent: Partial<SubagentsConfig["agent"]>,
): Record<string, string | null> {
  return agent.defaultThinkingByHarness ?? {};
}

/** The per-type thinking tokens of one agent layer, or an empty map. */
function rawThinkingByType(
  agent: Partial<SubagentsConfig["agent"]>,
): Record<string, string | null> {
  return agent.thinking ?? {};
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
  readonly harnessType: AnyHarnessId;
}

interface ConfigStoreDeps {
  manager?: AgentManager;
}

export class ConfigStore {
  private readonly layers: LayeredConfig;
  private sessionOverrides: SessionModelOverrides = { default: null };
  /** Per-type thinking tokens, in the vocabulary of each type's own harness. */
  private sessionThinking: SessionThinkingOverrides = {};
  /** Per-harness defaults set for this session only; cleared at session_start. */
  private sessionHarnessDefaults: Partial<Record<string, string | null>> = {};
  /** Per-harness default thinking tokens set for this session only; cleared at session_start. */
  private sessionThinkingDefaults: Partial<Record<string, string | null>> = {};
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
      defaultModel: a.default,
      defaultAgentType: a.defaultAgentType ?? DEFAULT_AGENT_TYPE,
      defaultOrchestrator: a.defaultOrchestrator ?? DEFAULT_ORCHESTRATOR_NAME,
      systemPromptMode: a.systemPromptMode ?? "replace",
      includeContextFiles: a.includeContextFiles ?? true,
      defaultThinking: a.defaultThinking,
      loadSkillsImplicitly: a.loadSkillsImplicitly ?? true,
      loadExtensionsImplicitly: a.loadExtensionsImplicitly ?? true,
      disableDefaultAgents: a.disableDefaultAgents ?? false,
      extensionEnabled: a.extensionEnabled ?? true,
      showActiveIndicator: a.showActiveIndicator ?? true,
      grazingEnabled: a.grazingEnabled === true,
      worktreeRoot: a.worktreeRoot,
      worktreeMaterialization:
        a.worktreeMaterialization ?? DEFAULT_WORKTREE_MATERIALIZATION,
      worktreeCheckoutType:
        a.worktreeCheckoutType ?? DEFAULT_WORKTREE_CHECKOUT_TYPE,
      harnessType: a.harnessType ?? DEFAULT_HARNESS,
    };
  }

  /**
   * The multiplexer this session runs: the id of a registered one (the built-in
   * `herdr`, or a plugin's). An unregistered id resolves to the built-in at
   * runtime (see multiplexer-registry.ts), so a stale value never leaves the
   * session without one.
   */
  get multiplexer(): string {
    return this.layers.effective.multiplexer;
  }

  /** The per-harness maps the registry validates after plugins register. */
  harnessConfigLayers(): {
    global: Record<string, Record<string, unknown>>;
    project: Record<string, Record<string, unknown>>;
  } {
    return {
      global: this.layers.global.harness ?? {},
      project: this.layers.project?.harness ?? {},
    };
  }

  /** Warns in the config layer's wording for a harness value its codec rejected. */
  reportHarnessConfigIssue(id: AnyHarnessId, issue: HarnessConfigIssue): void {
    const paths = this.layers.paths;
    const filePath =
      issue.layer === "project"
        ? (paths.project ?? paths.global)
        : paths.global;
    console.warn(
      incompatibleWarning(
        filePath,
        `harness.${id}${issue.keyPath === "" ? "" : `.${issue.keyPath}`}`,
        issue.got,
        issue.expected,
        FILE_FIX,
      ),
    );
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
  defaultModelForHarness(harness: AnyHarnessId): string | null {
    const session = nonBlankString(this.sessionHarnessDefaults[harness]);
    return session ?? harnessDefaultModel(this.layers.effective.agent, harness);
  }

  /** This session's per-type thinking token, or null when it sets none. */
  sessionThinkingOverride(type: string): string | null {
    return this.sessionThinking[type] ?? null;
  }

  /**
   * One harness's default thinking token, session over project over global. The
   * pi family's own `defaultThinking` answers for it; every other harness reads
   * its entry in `defaultThinkingByHarness`, in that harness's own vocabulary.
   * A session entry set to null reads as no session entry, exactly as the
   * session default model does.
   */
  defaultThinkingForHarness(harness: AnyHarnessId): string | null {
    const session = nonBlankString(
      this.sessionThinkingDefaults[thinkingSlot(harness)],
    );
    return (
      session ?? harnessDefaultThinking(this.layers.effective.agent, harness)
    );
  }

  /**
   * The thinking token a spawn of `type` runs at, resolved through the layers
   * in the order model-precedence.ts documents. Undefined when no layer names
   * one: the run asks for no level, and the harness's own default applies.
   * `harnessId` must be the harness the launch resolves, because it names both
   * the template family and the default the chain reads. `parentThinking` is
   * the session's current level; it is the pi family's last step.
   */
  thinkingFor(
    type: string,
    agentConfig: { thinkingByFamily?: ThinkingByFamily } | undefined,
    harnessId: AnyHarnessId,
    parentThinking?: string,
  ): string | undefined {
    return resolveThinking({
      subagentType: type,
      agentConfig,
      harnessFamily: harnessFamilyOf(harnessId),
      config: this.layers.effective,
      harnessDefault: this.defaultThinkingForHarness(harnessId),
      parentThinking,
      sessionThinking: this.sessionThinking,
    });
  }

  /**
   * Every harness id the config names, wherever it names one: the `harnessType`
   * setting, the `defaultModelByHarness` keys, the `concurrency.harnesses` keys,
   * the harness qualifier on any `concurrency.providers` / `concurrency.models`
   * pool key, and every `harness.<id>` section in either layer. A session
   * reports the ids nothing registered — config loads before plugins do, so
   * validation cannot answer that question, and a typo would otherwise be
   * silent (the launch simply falls back).
   */
  configuredHarnessIds(): AnyHarnessId[] {
    const ids = new Set<AnyHarnessId>([this.agent.harnessType]);
    for (const id of Object.keys(
      rawHarnessDefaults(this.layers.effective.agent),
    )) {
      ids.add(id);
    }
    for (const id of Object.keys(this.concurrency.harnesses)) ids.add(id);
    const harnessSections = this.harnessConfigLayers();
    for (const id of Object.keys(harnessSections.global)) ids.add(id);
    for (const id of Object.keys(harnessSections.project)) ids.add(id);
    for (const key of [
      ...Object.keys(this.concurrency.providers),
      ...Object.keys(this.concurrency.models),
    ]) {
      // An unqualified key carries the default harness, which is already named.
      const parsed = parsePoolKey(key);
      if (parsed !== undefined) ids.add(parsed.harness);
    }
    return [...ids];
  }

  /**
   * Which layers carry a model override for one type. Pi's own default rides
   * the reserved key `default`, so it is asked through this method too.
   *
   * A file layer carries the key when it has one, null included — a null there
   * masks the layers below. The session carries one only when its in-memory
   * value is non-null: a session null unpins the session instead of masking.
   */
  modelOverrideLevels(type: string): ConfigLayerPresence {
    return {
      session: this.sessionModelOverride(type) !== null,
      global: layerHasAgentKey(this.layers.global, type),
      project: layerHasAgentKey(this.layers.project, type),
    };
  }

  /**
   * Which layers carry a default model for one harness. Non-pi harnesses only:
   * the pi family's default is `agent.default`, which
   * `modelOverrideLevels("default")` answers, so asking here always reports no
   * session entry.
   */
  harnessDefaultModelLevels(harness: AnyHarnessId): ConfigLayerPresence {
    return {
      session:
        nonBlankString(this.sessionHarnessDefaults[harness]) !== undefined,
      global: layerCarriesEntry(
        this.layers.global.agent?.defaultModelByHarness,
        harness,
      ),
      project: layerCarriesEntry(
        this.layers.project?.agent?.defaultModelByHarness,
        harness,
      ),
    };
  }

  /**
   * Which layers carry a default thinking token for one harness. The pi family's
   * default is the `agent.defaultThinking` scalar every layer writes; every
   * other harness reads its own entry in `defaultThinkingByHarness`. The
   * session layer is one slot per family, so pig and pi-bolt answer through pi's.
   */
  harnessDefaultThinkingLevels(harness: AnyHarnessId): ConfigLayerPresence {
    return {
      session:
        nonBlankString(this.sessionThinkingDefaults[thinkingSlot(harness)]) !==
        undefined,
      global: this.harnessThinkingAt(this.layers.global, harness),
      project: this.harnessThinkingAt(this.layers.project, harness),
    };
  }

  /** A layer carries a harness's thinking default: pi's scalar, or the table's entry. */
  private harnessThinkingAt(
    layer: RawConfig | null,
    harness: AnyHarnessId,
  ): boolean {
    return isPiFamilyHarness(harness)
      ? layerHasAgentKey(layer, "defaultThinking")
      : layerCarriesEntry(layer?.agent?.defaultThinkingByHarness, harness);
  }

  /**
   * Which layers carry a thinking override for one type. A file layer carries
   * the entry when the key is present, null included — a null there masks the
   * layers below. The session carries one only when its in-memory value is
   * non-null: a session null unpins the session instead of masking.
   */
  thinkingOverrideLevels(type: string): ConfigLayerPresence {
    return {
      session: this.sessionThinking[type] != null,
      global: layerCarriesEntry(this.layers.global.agent?.thinking, type),
      project: layerCarriesEntry(this.layers.project?.agent?.thinking, type),
    };
  }

  /** The project layer's own model key, for the row tags model-groups derives. */
  hasProjectModelKey(key: string): boolean {
    return layerHasAgentKey(this.layers.project, key);
  }

  /**
   * Whether the project layer names a thinking token for one type, for the row
   * tags model-groups derives. A null entry there is a mask rather than a
   * level, so it does not count: the level the row shows came from elsewhere.
   */
  hasProjectThinkingKey(type: string): boolean {
    return isNamedValue(this.layers.project?.agent?.thinking?.[type]);
  }

  /** Which layers carry any model setting, for the Clear-all row. */
  modelSettingsLevels(): ConfigLayerPresence {
    return {
      session:
        sessionOverridesHasModelSettings(this.sessionOverrides) ||
        Object.keys(this.sessionHarnessDefaults).length > 0 ||
        Object.values(this.sessionThinking).some((value) => value != null) ||
        // A thinking default set to null unpins the session; only a real
        // token is something Clear-all would remove.
        Object.values(this.sessionThinkingDefaults).some(
          (value) => nonBlankString(value) !== undefined,
        ),
      global: agentLayerHasModelSettings(this.layers.global),
      project: agentLayerHasModelSettings(this.layers.project),
    };
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

  /** Which layers carry any concurrency limit, for the Clear-all row. */
  concurrencySettingsLevels(): ConfigLayerPresence {
    return {
      session: concurrencyLayerHasSettings(this.sessionConcurrencyLayer),
      global: concurrencyLayerHasSettings(this.layers.global.concurrency ?? {}),
      project: concurrencyLayerHasSettings(
        this.layers.project?.concurrency ?? {},
      ),
    };
  }

  /** Raw agent config incl. dynamic per-type model keys. */
  agentConfigSnapshot(): Readonly<SubagentsConfig["agent"]> {
    return this.layers.effective.agent;
  }

  /**
   * Precedence: session per-type → config per-type → agent template →
   * pi's session default → the launching harness's default → parentModelId.
   * The session default and the parent's key are pi's vocabulary, so only a
   * pi-family launch reads them. Null when the whole chain is unset and the
   * parent has no model to inherit.
   * `harnessId` must be the harness the launch resolves, because it names which
   * default the chain reads.
   */
  modelFor(
    type: string,
    parentModelId: string | null,
    agentConfig: { modelsByFamily?: ModelsByFamily } | undefined,
    harnessId: AnyHarnessId,
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
            this.sessionThinking = {};
            this.sessionHarnessDefaults = {};
            this.sessionThinkingDefaults = {};
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
      setHarnessType: (harnessType: AnyHarnessId) =>
        this.setAgentLayerEntry("harnessType", harnessType, "global"),
      /**
       * One harness's default, written entry-wise: the map is a whole value in
       * the file, so writing it whole would drop every other harness's entry.
       * `null` is a real answer — that harness has no default — and is written
       * as such rather than deleting the key.
       */
      setHarnessDefaultModel: (
        harness: AnyHarnessId,
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
        harness: AnyHarnessId,
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
      /**
       * One type's thinking token, entry-wise for the same reason the harness
       * map is: a whole-map write would drop every other type's entry. `null` is
       * a real answer at a file layer — it masks the layers below — while the
       * session's null unpins the session instead.
       */
      setThinkingOverride: (
        type: string,
        value: string | null,
        target: ConfigTarget = "global",
      ): void => {
        if (target === "session") {
          this.sessionThinking[type] = value;
          return;
        }
        this.layers.mutate(target, (raw) => {
          raw.agent ??= {};
          raw.agent.thinking = {
            ...rawThinkingByType(raw.agent),
            [type]: value,
          };
        });
      },
      clearThinkingOverride: (
        type: string,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.layers.clear(
          target,
          (raw) => {
            if (!raw.agent) return;
            const entries = rawThinkingByType(raw.agent);
            delete entries[type];
            if (Object.keys(entries).length === 0) {
              delete raw.agent.thinking;
            } else {
              raw.agent.thinking = entries;
            }
          },
          () => {
            delete this.sessionThinking[type];
          },
        );
      },
      /**
       * One harness's default thinking token. A non-pi harness writes its own
       * entry in the table, entry-wise: the map is a whole value in the file,
       * so writing it whole would drop every other harness's entry. The pi
       * family's file default is the scalar `agent.defaultThinking`, so a file
       * target for it writes that scalar. The session layer is one slot per
       * family, whichever target is asked for.
       */
      setHarnessDefaultThinking: (
        harness: AnyHarnessId,
        value: string | null,
        target: ConfigTarget = "global",
      ): void => {
        if (target === "session") {
          this.sessionThinkingDefaults[thinkingSlot(harness)] = value;
          return;
        }
        // A pi-family id reads the one `agent.defaultThinking` scalar, never a
        // table entry, so a file target writes that scalar. Null clears it: a
        // scalar has no mask to carry.
        if (isPiFamilyHarness(harness)) {
          const level = value === null ? undefined : piThinkingLevel(value);
          this.setAgentLayerEntry("defaultThinking", level, target);
          return;
        }
        this.layers.mutate(target, (raw) => {
          raw.agent ??= {};
          raw.agent.defaultThinkingByHarness = {
            ...rawThinkingByHarness(raw.agent),
            [harness]: value,
          };
        });
      },
      clearHarnessDefaultThinking: (
        harness: AnyHarnessId,
        target: ConfigTarget | "all" = "global",
      ): void => {
        this.layers.clear(
          target,
          (raw) => {
            if (!raw.agent) return;
            // The pi family's file default is the scalar, so clearing it is a
            // key delete rather than a table edit.
            if (isPiFamilyHarness(harness)) {
              delete raw.agent.defaultThinking;
              return;
            }
            const entries = rawThinkingByHarness(raw.agent);
            delete entries[harness];
            if (Object.keys(entries).length === 0) {
              delete raw.agent.defaultThinkingByHarness;
            } else {
              raw.agent.defaultThinkingByHarness = entries;
            }
          },
          () => {
            delete this.sessionThinkingDefaults[thinkingSlot(harness)];
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
        harness: AnyHarnessId,
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
        harness: AnyHarnessId,
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
    this.sessionThinking = {};
    this.sessionHarnessDefaults = {};
    this.sessionThinkingDefaults = {};
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
    value: SubagentsConfig["agent"][string],
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
        if (layer.harnesses) {
          delete layer.harnesses[key];
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
