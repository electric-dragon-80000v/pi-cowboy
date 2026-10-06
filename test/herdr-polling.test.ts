/**
 * herdr-polling.test.ts — Layer 1: the shared poll/deadline loop.
 *
 * `pollUntil`'s exact shape is behavior contract: the first probe always runs, a
 * spent deadline is consulted between attempts, an abort costs no extra probe, and
 * `maxAttempts` stops the loop without one further sleep.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandoned,
  keepPolling,
  pollUntil,
  settled,
} from "../src/infrastructure/herdr/polling.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("pollUntil", () => {
  it("returns the settled value without sleeping", async () => {
    let probes = 0;
    const value = await pollUntil(
      () => {
        probes++;
        return settled("done");
      },
      { intervalMs: 1_000 },
    );
    expect(value).toBe("done");
    expect(probes).toBe(1);
  });

  it("probes once even when the budget is already spent", async () => {
    let probes = 0;
    const value = await pollUntil(
      () => {
        probes++;
        return keepPolling();
      },
      { intervalMs: 1_000, timeoutMs: 0 },
    );
    expect(value).toBeUndefined();
    expect(probes).toBe(1);
  });

  it("polls once per interval until the probe settles", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const promise = pollUntil(
      () => {
        probes++;
        return probes === 3 ? settled(probes) : keepPolling();
      },
      { intervalMs: 500 },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe(3);
    expect(probes).toBe(3);
  });

  it("consults the deadline between attempts (never shorter than one attempt)", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const promise = pollUntil(
      () => {
        probes++;
        return keepPolling();
      },
      { intervalMs: 1_000, timeoutMs: 1_500 },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeUndefined();
    expect(probes).toBe(3);
  });

  it("stops on an abandoned probe without probing again", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const promise = pollUntil(
      () => {
        probes++;
        return probes === 1 ? keepPolling() : abandoned();
      },
      { intervalMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBeUndefined();
    expect(probes).toBe(2);
  });

  it("backs off by the attempt-based interval and stops at maxAttempts", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const promise = pollUntil(
      () => {
        probes++;
        return keepPolling();
      },
      { intervalMs: (attempt) => attempt * 100, maxAttempts: 3 },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(probes).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBeUndefined();
    expect(probes).toBe(3);
  });

  it("checks the abort signal before every probe", async () => {
    vi.useFakeTimers();
    let probes = 0;

    const beforeFirstProbe = new AbortController();
    beforeFirstProbe.abort();
    const aborted = pollUntil(
      () => {
        probes++;
        return keepPolling();
      },
      { intervalMs: 100, signal: beforeFirstProbe.signal },
    );
    await expect(aborted).resolves.toBeUndefined();
    expect(probes).toBe(0);

    const midPoll = new AbortController();
    const abortedMidPoll = pollUntil(
      () => {
        probes++;
        return keepPolling();
      },
      { intervalMs: 100, signal: midPoll.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(probes).toBe(1);
    midPoll.abort();
    await vi.advanceTimersByTimeAsync(100);
    await expect(abortedMidPoll).resolves.toBeUndefined();
    expect(probes).toBe(1);
  });

  it("propagates a probe error", async () => {
    await expect(
      pollUntil(
        () => {
          throw new Error("probe exploded");
        },
        { intervalMs: 10 },
      ),
    ).rejects.toThrow("probe exploded");
  });
});
