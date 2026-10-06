/**
 * Small append-only file logger for diagnostic traces.
 * The environment level is read once at module load; setLogLevel overrides it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { getDetailedString } from "caller-id";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
let minimumLevel = parseLevel(process.env.PI_COWBOY_LOG_LEVEL);
const logDir = join(process.cwd(), CONFIG_DIR_NAME);
const logFile = join(logDir, "pi-cowboy.log");

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

export function createLogger(module: string): Logger {
  function debug(msg: string, data?: Record<string, unknown>): void {
    write("debug", module, msg, data, debug);
  }
  function info(msg: string, data?: Record<string, unknown>): void {
    write("info", module, msg, data, info);
  }
  function warn(msg: string, data?: Record<string, unknown>): void {
    write("warn", module, msg, data, warn);
  }
  function error(msg: string, data?: Record<string, unknown>): void {
    write("error", module, msg, data, error);
  }
  return { debug, info, warn, error };
}

function parseLevel(value: string | undefined): LogLevel {
  const normalized = value?.toLowerCase();
  return normalized && LEVELS.includes(normalized as LogLevel)
    ? (normalized as LogLevel)
    : "info";
}

function write(
  level: LogLevel,
  module: string,
  msg: string,
  data: Record<string, unknown> | undefined,
  loggerMethod: (...args: never[]) => void,
): void {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(minimumLevel)) return;
  const caller = getDetailedString(loggerMethod);
  const suffix = data === undefined ? "" : serializeData(data);
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${module}] ${caller}() ${msg}${suffix}\n`;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logFile, line, "utf8");
  } catch {
    // Diagnostics must never change the supervised process's behavior.
  }
}

function serializeData(data: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const key of Object.keys(data)) {
    let value: unknown;
    try {
      value = data[key];
    } catch (err) {
      value = `unserializable: ${String(err)}`;
    }
    let rendered: string;
    try {
      // JSON.stringify is typed `string` but returns undefined for values it
      // cannot represent (undefined, functions, symbols).
      const json = JSON.stringify(value) as string | undefined;
      rendered = json ?? String(value);
    } catch {
      try {
        rendered = String(value);
      } catch {
        rendered = "[unserializable]";
      }
    }
    pairs.push(`${key}=${rendered}`);
  }
  return pairs.length === 0 ? "" : ` ${pairs.join(" ")}`;
}
