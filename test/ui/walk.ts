/**
 * walk.ts — traversal DSL: rows addressed by rendered label, Branch trees
 * flattened by expandTree, assertions as literals (never the app's own
 * descriptors — that would make the test a tautology).
 */
import type { ConfigStore } from "../../src/config/config-store.js";
import type { MenuSession } from "./harness.js";
import { KEY } from "./harness.js";

/** State assertions after a step; all optional, all must hold. */
export interface Expect {
  title?: string | RegExp;
  /** Frame contains each of these. */
  shows?: Array<string | RegExp>;
  /** Frame contains none of these. */
  hides?: Array<string | RegExp>;
  /** Cursor-glyph row. */
  active?: string | RegExp;
  activeValue?: string | RegExp;
  /** [label, value] pairs, each one rendered row. */
  rows?: Array<[string | RegExp, string | RegExp]>;
  /** No cursor row (e.g. a text field is focused). */
  noActiveRow?: boolean;
  store?: (store: ConfigStore) => void;
  /** Each pattern matches some emitted notification. */
  notified?: Array<string | RegExp>;
  notNotified?: Array<string | RegExp>;
}

type Checkpoint = { expect?: Expect };

/**
 * Traversal step: open/focus/press/type/fill/enter/escape. A bare `expect` is a
 * checkpoint asserting an intermediate menu state.
 */
type Step =
  | ({ open: string | RegExp } & Checkpoint)
  | ({ press: string } & Checkpoint)
  | ({ focus: string | RegExp } & Checkpoint)
  | ({ type: string } & Checkpoint)
  | ({ fill: string } & Checkpoint)
  | ({ enter: true } & Checkpoint)
  | ({ escape: true } & Checkpoint)
  | { expect: Expect };

/** Named, runnable traversal: a flattened root-to-leaf path. */
export interface Traversal {
  name: string;
  path: string[];
  steps: Step[];
}

/** Traversal-tree node: shared prefix plus continuations (leaves omit `branches`). */
export interface Branch {
  name: string;
  steps?: Step[];
  branches?: Branch[];
}

export function expandTree(root: Branch): Traversal[] {
  const out: Traversal[] = [];
  const visit = (branch: Branch, prefix: Step[], trail: string[]): void => {
    const steps = [...prefix, ...(branch.steps ?? [])];
    const path = [...trail, branch.name];
    const children = branch.branches ?? [];
    if (children.length === 0) {
      out.push({ name: path.join(" › "), path, steps });
      return;
    }
    for (const child of children) visit(child, steps, path);
  };
  visit(root, [], []);
  return out;
}

export interface TraversalInput {
  name: string;
  steps: Step[];
  path?: string[];
}

/** Map a data list to traversals. */
export function each<T>(
  items: readonly T[],
  make: (item: T, index: number) => TraversalInput,
): Traversal[] {
  return items.map((item, index) => {
    const traversal = make(item, index);
    return {
      name: traversal.name,
      path: traversal.path ?? [traversal.name],
      steps: traversal.steps,
    };
  });
}

function describe(value: string | RegExp): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function matches(actual: string, expected: string | RegExp): boolean {
  return typeof expected === "string"
    ? actual.includes(expected)
    : expected.test(actual);
}

function assertExpect(
  session: MenuSession,
  expect: Expect,
  store: ConfigStore,
  at: string,
): void {
  const fail = (detail: string): never => {
    throw new Error(
      `${at}: ${detail}\n--- frame ---\n${session.text()}\n-------------`,
    );
  };

  const frame = session.text();

  if (expect.title !== undefined && !matches(session.title(), expect.title)) {
    fail(`title ${describe(expect.title)} != ${describe(session.title())}`);
  }
  for (const pattern of expect.shows ?? []) {
    if (!matches(frame, pattern))
      fail(`frame does not show ${describe(pattern)}`);
  }
  for (const pattern of expect.hides ?? []) {
    if (matches(frame, pattern))
      fail(`frame unexpectedly shows ${describe(pattern)}`);
  }

  const active = session.activeRow();
  if (expect.noActiveRow === true && active !== null) {
    fail(`expected no active row, got ${describe(active.label)}`);
  }
  if (expect.active !== undefined) {
    if (active === null) {
      fail(`no active row; expected ${describe(expect.active)}`);
    } else if (!matches(active.label, expect.active)) {
      fail(
        `active row ${describe(active.label)} != ${describe(expect.active)}`,
      );
    }
  }
  if (expect.activeValue !== undefined) {
    if (active === null) {
      fail("no active row to read a value from");
    } else if (!matches(active.value, expect.activeValue)) {
      fail(
        `active value ${describe(active.value)} != ${describe(expect.activeValue)}`,
      );
    }
  }

  const rows = session.rows();
  for (const [label, value] of expect.rows ?? []) {
    const found = rows.some(
      (row) => matches(row.label, label) && matches(row.value, value),
    );
    if (!found) {
      fail(
        `no row matching ${describe(label)} = ${describe(value)}\n` +
          `rows: ${JSON.stringify(rows)}`,
      );
    }
  }

  if (expect.store) expect.store(store);

  const messages = session.notifications;
  for (const pattern of expect.notified ?? []) {
    if (!messages.some((note) => matches(note.message, pattern))) {
      fail(
        `no notification matching ${describe(pattern)}; got ` +
          JSON.stringify(messages.map((note) => note.message)),
      );
    }
  }
  for (const pattern of expect.notNotified ?? []) {
    if (messages.some((note) => matches(note.message, pattern))) {
      fail(`unexpected notification matching ${describe(pattern)}`);
    }
  }
}

export async function walk(
  session: MenuSession,
  steps: Step[],
  store: ConfigStore,
  name: string,
): Promise<void> {
  let index = 0;
  for (const step of steps) {
    index += 1;
    const at = `${name} [step ${index}]`;

    if ("open" in step) session.open(step.open);
    else if ("press" in step) session.press(step.press);
    else if ("focus" in step) session.focus(step.focus);
    else if ("type" in step) session.press(step.type);
    else if ("fill" in step) session.fillField(step.fill);
    else if ("enter" in step) session.press(KEY.enter);
    else if ("escape" in step) session.press(KEY.escape);

    await session.settle();
    if (step.expect) assertExpect(session, step.expect, store, at);
  }
}
