/**
 * concurrency-limit.ts — the concurrency limit grammar at the config/data
 * boundary: a positive integer. One schema for the file-validation path and
 * the store-mutation path, so both reject the same values.
 */

import { z } from "zod";

/** A concurrency slot limit: an integer of at least 1. */
export const ConcurrencyLimitSchema = z.number().int().min(1);

/** Expected-clause for warnings and refusals naming this schema. */
export const CONCURRENCY_LIMIT_EXPECTED = "positive integer";

/** True when the untrusted value is a storable concurrency limit. */
export function isConcurrencyLimit(value: unknown): value is number {
  return ConcurrencyLimitSchema.safeParse(value).success;
}
