---
name: step-integration-tests
description: How step integration tests are written — the three kinds (application steps, verification steps, test setup), the nested-block tree shape, one tree that grows, and flat test bodies whose teardown the Initialize step registers for itself. Use when writing, extending or reviewing tests under test/step-integration/, or any integration test that drives a real `pi` process against a stub.
---

# Step integration tests

Applies when writing or changing step integration tests under
`test/step-integration/`.

The authority is
[test/step-integration/WRITING-TESTS.md](../../../test/step-integration/WRITING-TESTS.md).
Read it before writing a test; this skill is its short form. Where the two
disagree, the guide wins.

## The three kinds

A step integration test is built from exactly three kinds. There is no fourth
kind, and no test invents one.

1. **Application steps** — the application actions (initialize, send first
   prompt, engage orchestrator, spawn agent, …), each factored into a function.
   A step takes as few parameters as possible: only values the test asserts on
   later, and return values the next step needs. A step receives the previous
   step's return. Everything else — derivable plumbing — stays inside the
   function. A test picks only the steps it needs.
2. **Verification steps** — the assertions and the waits, never abstracted.
   A wait is an assertion too (awaiting settlement asserts settlement within
   the timeout), and it stays linked to the assertion it serves. They are put
   inline in the test body so all their parameters stay visible; no helper is
   created for them.
3. **Test setup** — not a step (the guide's third kind, there named _Script_).
   The setup of the run: the enqueued stub replies, the files written, the
   directories prepared. Laid out inline in the test, all parameters visible,
   nothing extracted into a function. Setup every path in a block shares is
   not one test's script: it is setup at that block's level.

## The tree shape

- Tests are nested blocks. A block opens a context; a nesting one level deeper
  extends it. A block holds tests and/or further nestings, and every test runs
  one path from the root down to itself, carrying the setup of every level
  above it.
- Nothing runs except those paths: a block with no test below it produces no
  run.
- Setup a whole block shares goes at that block's level, so every path below it
  receives it.
- The fully qualified test name (the full path) is used as the stub route
  prefix, so no test can see another test's stub replies or recorded requests.

## Flat bodies with self-registered teardown

- No `try`/`finally` nesting in a test body. The Initialize application step
  prepares the test's directories and files and registers the test teardown for
  itself (`onTestFinished`); it runs on pass and on failure, and only for tests
  that called Initialize. Tests that never call it are unaffected.
- No shared teardown for the whole file.

## One tree

There is one tree, because there is one starting point. Before writing a test,
survey the branches that already exist: the new test becomes a new branch or
joins an existing one (for example an extra assertion on a path that is already
there). The tree holds the whole flow, so every test is placed with the entire
tree in mind. A separate tree is built only when the starting point is
different — which is not the case.

## Adding a path: branch the tree, never re-derive the spine

A new test that opens the way an existing path opens is a branch of that path,
and branches share by hoisting:

- **Everything both paths receive moves to the shared block.** The isolated
  world (Initialize), the extension install, and the fixtures both paths use —
  the fixture path as a block variable — go in that block's `beforeEach`. Each
  path below still gets its own world and its own teardown; the block's paths
  take the running test's fully qualified name as their route prefix.
- **The existing path moves with its prefix.** Hoisting edits the existing
  test: its shared setup lines leave the body and join the block, while its
  assertions move verbatim and keep passing. Editing it is expected; leaving
  the prefix duplicated in the new test is the mistake.
- **Only the fork stays inline.** The test body keeps exactly what differs: the
  script the test writes — a parameter on the shared reply, for instance — and
  its own verification steps, the waits and the assertions. Duplicate the fork,
  never the prefix.
- **The new test is a sibling of the existing path**, inside the shared block.
  A whole path gets its own named block when it needs a name; a block that
  holds only the new test earns nothing, and neither does a second copy of the
  spine.

A test that re-derives a prefix another path already has is not a branch: it is
a second tree, and a second tree is built only when the starting point differs.

## What may change

The set of application steps. Add a step when a test needs a new application
action; merge two steps that always appear together; split a step when a test
must act or assert between them. Names may change. The current set is a
starting point, not the final set.

What does not change: the split into application steps, verification steps and
test setup, and the tree shape. Application steps are functions with only the
necessary parameters; verification steps and test setup stay inline and
visible.
