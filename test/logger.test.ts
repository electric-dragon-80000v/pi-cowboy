import { appendFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const originalLevel = process.env.PI_COWBOY_LOG_LEVEL;

afterEach(() => {
  if (originalLevel === undefined) delete process.env.PI_COWBOY_LOG_LEVEL;
  else process.env.PI_COWBOY_LOG_LEVEL = originalLevel;
  vi.restoreAllMocks();
  vi.mocked(appendFileSync).mockClear();
});

async function loggerAt(level?: string) {
  if (level === undefined) delete process.env.PI_COWBOY_LOG_LEVEL;
  else process.env.PI_COWBOY_LOG_LEVEL = level;
  vi.resetModules();
  return import("../src/logger.js");
}

describe("logger", () => {
  it("writes the exact format and derives the caller method", async () => {
    const { createLogger, setLogLevel } = await loggerAt("debug");
    setLogLevel("info");
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue(
      "2026-09-16T14:53:01.259Z",
    );
    const output = vi.mocked(appendFileSync);
    const log = createLogger("supervisor");
    function tickOnce(): void {
      log.info("full", { paneId: "w1:p2", missingTicks: 2 });
    }
    tickOnce();
    expect(output.mock.calls[0][1]).toContain(
      "2026-09-16T14:53:01.259Z INFO  [supervisor] tickOnce at ",
    );
    expect(output.mock.calls[0][1]).toContain(
      '() full paneId="w1:p2" missingTicks=2\n',
    );
  });

  it.each([
    ["debug", 4],
    ["info", 3],
    ["warn", 2],
    ["error", 1],
  ] as const)("gates at %s", async (threshold, expected) => {
    const { createLogger } = await loggerAt(threshold);
    const output = vi.mocked(appendFileSync);
    const log = createLogger("test");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(output).toHaveBeenCalledTimes(expected);
  });

  it("supports changing the block level", async () => {
    const { createLogger, setLogLevel } = await loggerAt("error");
    const output = vi.mocked(appendFileSync);
    const log = createLogger("test");
    log.info("blocked");
    setLogLevel("debug");
    log.info("enabled");
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("defaults debug off", async () => {
    const { createLogger } = await loggerAt();
    const output = vi.mocked(appendFileSync);
    createLogger("test").debug("off");
    expect(output).not.toHaveBeenCalled();
  });

  it("treats malformed levels as info and serializes bad values per pair", async () => {
    const { createLogger } = await loggerAt("not-a-level");
    const output = vi.mocked(appendFileSync);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    createLogger("test").info("bad", {
      circular,
      bigint: BigInt(2),
      good: "kept",
    });
    const line = String(output.mock.calls[0][1]);
    expect(line).toContain('good="kept"');
    expect(line).toContain("circular=");
    expect(line).toContain("bigint=");
  });
});
