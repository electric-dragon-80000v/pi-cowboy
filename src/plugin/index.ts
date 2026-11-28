/**
 * plugin/index.ts — the `pi-cowboy/plugin` subpath: the whole of what a plugin
 * package imports.
 *
 * It exports the contract's types and the helpers a plugin's own harness code
 * is written against — the model-list reads, the pane launcher's staging
 * install, and the reserved-name rules — and nothing else. A plugin never
 * imports a pi-cowboy internal path, so this
 * subpath is the stable surface a plugin is written against and the only thing
 * that must stay compatible across versions.
 *
 * The list is deliberately complete rather than minimal: a plugin that writes a
 * helper function or class for its harness or multiplexer needs the parameter and
 * return types its callbacks already reference, and reaching them through
 * `Parameters<…>` / `ReturnType<…>` would be a worse contract than naming them.
 */

// The registration api and the things it registers.
export type {
  CowboyPluginApi,
  CowboyPluginDisposer,
  CowboyPluginFactory,
  PluginMultiplexer,
  PluginHarness,
} from "./contract.js";

// What a derived harness is handed, and the entry `getHarness` answers with.
export type { RegisteredHarness } from "../agents/harness/harness-registry.js";
export type {
  HarnessDerivation,
  HarnessPostStartHook,
  HarnessPrepareHook,
  HarnessTeardownHook,
} from "../agents/harness.js";

// What a harness's callbacks are handed and what they answer with.
export type {
  AnyHarnessId,
  Harness,
  HarnessAvailability,
  HarnessConfigCodec,
  HarnessConfigIssue,
  HarnessConfigLayers,
  HarnessConfigReport,
  HarnessListModelsRequest,
  HarnessExportRequest,
  HarnessContinuation,
  HarnessReadEnv,
  HarnessRunAddress,
  HarnessRunStaging,
  HandoverRecord,
  HandoverRecordSource,
  HarnessPrepareRequest,
  HarnessPostStartRequest,
  HarnessSteer,
  HarnessSteerRequest,
  HarnessStop,
  HarnessStopRequest,
  HarnessTeardownContext,
  HarnessTeardownRequest,
  ModelEntry,
  ModelList,
  ReadHandoverRecords,
  SubagentLaunchInputs,
  ThinkingLevels,
  ToolSelection,
} from "../agents/harness.js";

// The reads over a `ModelList` answer, so a plugin's own helper reads one
// without reaching into its arms.
export { modelListEntries, modelListNotice } from "../agents/harness.js";

// The constructor for a parsed record with no canonical kind, so every reader's
// `other` arm names the native type the same way.
export { otherRecord } from "../agents/harness.js";

// The pane-side launcher: its env, and the install that stages the launcher
// file and sources it in the pane. A plugin's body sources the staged file the
// launch carries rather than interpolating values into the typed command, and
// any other path it types is quoted the same way. The file's path comes from
// the staging directory helper beside it, so a plugin names a subagent, not a
// path inside pi-cowboy's staging layout.
export {
  installPaneLauncher,
  launchEnvBody,
  singleQuoteShellWord,
} from "../agents/harness/pane-launcher.js";
export type {
  PaneLauncherSpec,
  PaneProof,
} from "../agents/harness/pane-launcher.js";
export { subagentLauncherFileFor } from "../paths.js";

// Reserved environment variable rules enforced for launchers and agent templates.
export {
  isReservedEnvVar,
  isUniversalReservedEnvVar,
  reservedEnvVarsOf,
  RESERVED_ENV_VARS_BY_FAMILY,
} from "../agents/harness.js";
export type { HarnessEnvReservations } from "../agents/harness.js";

// The execution multiplexer a plugin multiplexer builds, and the surfaces it returns.
export type {
  AgentMultiplexer,
  AgentHost,
  AgentHostRef,
  AgentMultiplexerKind,
  AgentView,
  DeliverOutcome,
  ExecutionRuntime,
  HostObservation,
  LiveAttempt,
  PaneControl,
  PlacementCatalog,
  PlacementRecord,
  PlacementWorktree,
  ViewRequest,
} from "../agents/agent-host.js";
