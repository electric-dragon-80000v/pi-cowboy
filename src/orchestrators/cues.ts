/**
 * cues.ts — Cue rendering and validation.
 *
 * Rendering is IDENTITY for the facts: HTML escaping is disabled, so a cue
 * reproduces code/Markdown/prose byte-for-byte. Validation is per-cue: a
 * template may only name variables its own cue supplies, so a typo fails at
 * load time instead of rendering as an invisible empty string.
 *
 * Partials and delimiter changes are rejected: a cue must be self-contained.
 * Comments and `{{{ }}}`/`{{& }}` are ordinary Mustache.
 */

import Mustache from "mustache";
import { cueVariables, type CueContextFor } from "./context.js";
import type { CueEvent, CueTemplates } from "./types.js";

/** Validation outcome: the reason travels with the failure, never optionally. */
type CueValidation = { ok: true } | { ok: false; reason: string };

const OK: CueValidation = { ok: true };

type TemplateSpan = Mustache.TemplateSpans[number];

const UNESCAPED = "&";

/** Token types carrying a variable name (sections resolve one too). */
const NAME_BEARING_TYPES = new Set<string>(["name", UNESCAPED, "#", "^"]);

/** Render one event's cue against that event's context. Absent facts render as nothing, never "null". */
export function renderCue<E extends CueEvent>(
  cues: CueTemplates,
  event: E,
  context: CueContextFor[E],
): string {
  return Mustache.render(cues[event], context, undefined, {
    // Cue text is plain TUI text, not HTML, and mustache calls this hook with
    // whatever the template interpolated — an arbitrary value by design.
    // oxlint-disable-next-line typescript/no-base-to-string -- the interpolated value is arbitrary
    escape: (value: unknown) => (value == null ? "" : String(value)),
  });
}

function spanChildren(span: TemplateSpan): Mustache.TemplateSpans | undefined {
  const children = (span as readonly unknown[])[4];
  return Array.isArray(children)
    ? (children as Mustache.TemplateSpans)
    : undefined;
}

/** First structural/variable problem in a token tree, if any. */
function findTemplateProblem(
  spans: Mustache.TemplateSpans,
  allowed: readonly string[],
  event: CueEvent,
): string | undefined {
  for (const span of spans) {
    const [type, value] = span;

    if (type === ">") {
      return `partials are not supported: "{{>${value}}}"`;
    }
    if (type === "=") {
      return `delimiter changes are not supported: "{{=${value}=}}"`;
    }
    if (NAME_BEARING_TYPES.has(type) && !allowed.includes(value)) {
      return `unknown variable "{{${value}}}" — allowed variables for the ${event} cue: ${allowed.join(", ")}`;
    }

    const children = spanChildren(span);
    if (children) {
      const childProblem = findTemplateProblem(children, allowed, event);
      if (childProblem) return childProblem;
    }
  }
  return undefined;
}

/**
 * Validate one cue template against its event's variable set. Rejects unknown
 * variables, partials, and delimiter changes with a one-line reason the
 * caller surfaces verbatim in a skip warning.
 */
export function validateCueTemplate(
  event: CueEvent,
  template: string,
): CueValidation {
  const allowed = cueVariables(event);
  if (!allowed) {
    return { ok: false, reason: `unknown cue event "${event}"` };
  }

  let spans: Mustache.TemplateSpans;
  try {
    spans = Mustache.parse(template);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `unparsable template: ${message.replace(/\s+/g, " ").trim()}`,
    };
  }

  const problem = findTemplateProblem(spans, allowed, event);
  return problem ? { ok: false, reason: problem } : OK;
}

/** Validate every cue a template defines (the base supplies the rest). Returns the first failure. */
export function validateOrchestratorCues(
  cues: Partial<CueTemplates>,
): CueValidation {
  for (const event of Object.keys(cues) as CueEvent[]) {
    const template = cues[event];
    if (template === undefined) continue;
    const result = validateCueTemplate(event, template);
    if (!result.ok) return result;
  }
  return OK;
}
