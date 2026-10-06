/**
 * availability.ts — which values of a fixed vocabulary this machine can actually
 * use, and the narrowing that turns that answer into the values a setting offers.
 *
 * A probe answers for its whole vocabulary at once, because every member of a
 * vocabulary is judged the same way (one probe of a volume, one scan of PATH).
 *
 * The answer is carried, not awaited: a settings list is built synchronously, so
 * a probe records its verdict in the shell and every reader reads it there. A
 * verdict that is not in yet rules nothing out — "unknown" is the state before
 * the probe lands, and until it does every value stays on offer and every
 * configured value still resolves, so a slow probe never locks the user out of
 * the setting or silently rewrites it.
 */

/** A probe's answer about one vocabulary: nothing yet, or exactly these values. */
export type Availability<Id extends string> =
  | { readonly status: "unknown" }
  | { readonly status: "known"; readonly available: ReadonlySet<Id> };

/** A probe that has answered: these are the values the machine can use. */
export function probed<Id extends string>(
  available: Iterable<Id>,
): Availability<Id> {
  return { status: "known", available: new Set(available) };
}

/** A probe that has not answered yet. */
export function unprobed<Id extends string>(): Availability<Id> {
  return { status: "unknown" };
}

/**
 * Whether one value is usable. `NoInfer` keeps the value from setting the
 * vocabulary: which values exist is the availability's business, not the
 * caller's.
 */
export function isAvailable<Id extends string>(
  id: NoInfer<Id>,
  availability: Availability<Id>,
): boolean {
  return availability.status === "unknown" || availability.available.has(id);
}

/**
 * The members of `all` this machine can use, in `all`'s order — the setting's own
 * order, so a narrowed list never reshuffles. Nothing is dropped before a probe
 * answers.
 */
export function selectable<Id extends string>(
  all: readonly Id[],
  availability: Availability<Id>,
): readonly Id[] {
  return all.filter((id) => isAvailable(id, availability));
}
