/**
 * herdr-pi.ts — shared pi.exec doubles for the herdr-plane suites.
 *
 * One fake ExtensionAPI seam per suite: canned stdout/stderr answers, with the
 * wire shapes (`{ result }` / `{ error }` envelopes) described exactly once.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One canned `pi.exec` answer. */
interface CannedExec {
  code: number;
  stdout: string;
  stderr: string;
}

/** pi.exec mock answering per invocation. */
export function mockPi(
  respond: (cmd: string, args: string[]) => CannedExec,
): ExtensionAPI {
  return {
    exec: async (cmd: string, args: string[]) => respond(cmd, args),
  } as unknown as ExtensionAPI;
}

/**
 * pi.exec mock recording every invocation and answering from a queue. A dry queue
 * fails hard, so an unexpected extra call fails loudly.
 */
export function recordingPi(responses: CannedExec[]): {
  pi: ExtensionAPI;
  calls: Array<{ cmd: string; args: string[]; opts?: unknown }>;
} {
  const calls: Array<{ cmd: string; args: string[]; opts?: unknown }> = [];
  const pi = {
    exec: async (cmd: string, args: string[], opts?: unknown) => {
      const next = responses[calls.length] ?? fail("exhausted", "x");
      calls.push({ cmd, args, opts });
      return next;
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

/** Successful herdr JSON envelope around `result`. */
export function ok(result: unknown): CannedExec {
  return {
    code: 0,
    stdout: JSON.stringify({ id: "x", result }),
    stderr: "",
  };
}

/** Herdr CLI failure envelope on stderr. */
export function fail(code: string, message: string): CannedExec {
  return {
    code: 1,
    stdout: "",
    stderr: JSON.stringify({ error: { code, message } }),
  };
}
