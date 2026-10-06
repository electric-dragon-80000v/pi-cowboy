/**
 * polling.ts — Layer 1: the shared poll/deadline loop.
 *
 * `pollUntil` owns the probe/classify/sleep loop once. Its shape is load-bearing:
 * the first probe always runs (a `timeoutMs: 0` wait is a one-shot probe); the
 * deadline is checked after the probe and before the sleep; the abort signal is
 * checked before every probe, so aborting costs no further CLI call.
 */

import { sleep } from "../../utils.js";

/** Delay before the next attempt; a function receives the 1-based attempt just made. */
export type PollInterval = number | ((attempt: number) => number);

/**
 * One attempt's verdict. A union (not `T | undefined`) because "keep waiting"
 * and "stop with no result" differ for an unbounded wait.
 */
export type PollVerdict<T> =
  | { kind: "settled"; value: T }
  | { kind: "keep-polling" }
  | { kind: "abandoned" };

/** `pollUntil` options. */
export interface PollOptions {
  /** Delay before the next attempt. */
  intervalMs: PollInterval;
  /** Total wait budget (ms). Omitted: poll until the probe settles or abandons. */
  timeoutMs?: number;
  /** Hard cap on attempts. */
  maxAttempts?: number;
  /** Abort source. */
  signal?: AbortSignal;
}

/** The probe observed the polled condition. */
export function settled<T>(value: T): PollVerdict<T> {
  return { kind: "settled", value };
}

/** The probe must be repeated. */
export function keepPolling(): PollVerdict<never> {
  return { kind: "keep-polling" };
}

/** Further waiting is pointless (the target is gone). */
export function abandoned(): PollVerdict<never> {
  return { kind: "abandoned" };
}

/** Poll until settled; undefined when abandoned, aborted, timed out, or exhausted. */
export async function pollUntil<T>(
  probe: (attempt: number) => Promise<PollVerdict<T>> | PollVerdict<T>,
  options: PollOptions,
): Promise<T | undefined> {
  const deadline =
    options.timeoutMs === undefined
      ? undefined
      : Date.now() + options.timeoutMs;
  let attempt = 0;
  for (;;) {
    if (options.signal?.aborted) return undefined;
    attempt += 1;
    const verdict = await probe(attempt);
    if (verdict.kind === "settled") return verdict.value;
    if (verdict.kind === "abandoned") return undefined;
    if (options.maxAttempts !== undefined && attempt >= options.maxAttempts)
      return undefined;
    if (deadline !== undefined && Date.now() >= deadline) return undefined;
    const { intervalMs } = options;
    await sleep(
      typeof intervalMs === "function" ? intervalMs(attempt) : intervalMs,
    );
  }
}
