/**
 * contract.ts — what a pi-cowboy plugin is handed and what it may register.
 *
 * A plugin is a plain pi package that declares a `pi-cowboy` key in its
 * package.json (see manifest.ts). pi-cowboy discovers it through pi's own
 * package manager (see discovery.ts) and calls its factory once, before the
 * session's first spawn, handing it an api. The factory registers harnesses and
 * execution multiplexers through that api and may return a disposer.
 *
 * The api is id-keyed and data-passed: a plugin package never shares a module
 * instance with pi-cowboy (pi packages share no dependency instances), so
 * registrations travel as plain data and every type here is structural. A plugin
 * imports these types from the `pi-cowboy/plugin` subpath — never from a
 * pi-cowboy internal path — so that subpath is the whole of the contract and a
 * plugin never reaches inside the extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MultiplexerRegistration } from "../agents/multiplexer-registry.js";
import type { PluginHarness } from "../agents/harness.js";

export type { PluginHarness } from "../agents/harness.js";
export type { MultiplexerRegistration as PluginMultiplexer } from "../agents/multiplexer-registry.js";

/**
 * What a plugin registers through. `pi` is the same extension api pi-cowboy
 * itself holds, so a plugin reaches sessions and events; `cwd` is the project
 * root the session loaded, for the user's paths only — a plugin's own files
 * resolve against its module (`import.meta.url`), never against `cwd`.
 */
export interface CowboyPluginApi {
  readonly pi: ExtensionAPI;
  /** The user's project root, not the plugin package's directory. */
  readonly cwd: string;
  /**
   * Register one harness. The first registration for an id is kept: a plugin
   * that claims a built-in's id, or an id another plugin already claimed in this
   * load, is refused with a warning. Plugins load in package-name order and a
   * load starts from a clean registry, so which plugin wins an id is the same
   * one every session.
   */
  registerHarness(harness: PluginHarness): boolean;
  /**
   * Register one execution multiplexer. Its `hosts()` decides whether this
   * process runs inside it, which is both what makes a session run at all and
   * what makes the `multiplexer` config key able to prefer it.
   */
  registerMultiplexer(multiplexer: MultiplexerRegistration): boolean;
}

/** Undoes what a plugin's factory set up; run when the process unloads. */
export type CowboyPluginDisposer = () => void | Promise<void>;

/**
 * A plugin module's default export: registers through the api and may leave a
 * disposer behind, or nothing when it has nothing to undo. The two arms are the
 * two shapes a module writes — `export default (api) => {…}` and
 * `export default async (api) => {…}` — so whether setup is asynchronous is a
 * property of the module, never of the branch a particular call happens to take.
 */
export type CowboyPluginFactory =
  | ((api: CowboyPluginApi) => CowboyPluginDisposer | void)
  | ((api: CowboyPluginApi) => Promise<CowboyPluginDisposer | void>);
