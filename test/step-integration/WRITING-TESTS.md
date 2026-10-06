# How step integration tests are written

All integration tests that follow this approach are called step integration tests. All integration tests follow the same methodology. There are no other kinds of integration tests written this way. A test is constructed from a shared set of steps, arranged in nested blocks. The set grows over time: steps are added when a test needs a new application action, and existing steps are merged or split when tests demand it. What does not change is the split into three kinds below, and the tree shape of the tests.

## The three kinds

There are two categories of steps, plus one thing that is not a step.

**1. Application steps.** These are the actions that drive the session forward, or the actions going on in the test subject itself. Examples: Initialize, Send first prompt, Engage orchestrator, Spawn agent, Agent work, Agent finalize, Orchestrator gets notified, Orchestrator merge, Orchestrator cleanup. Each application step is factored out as a function. The function takes as little parameters as possible. Only what serves the test execution is a parameter: values the test must assert on later, and return values that the next step needs. A step receives the return of the previous step. Anything else that does not serve the test execution stays inside the function. Application steps are picked from the set. A test uses only the steps it needs.

**2. Verification steps.** These are the expectations from the program: the assertions, and the waits. A wait is also a kind of assertion, linked with an assertion — for example, awaiting settlement asserts that the agent settles within the timeout. Verification steps are not factored out. No abstractions are created for them. They are put right in the test so that all their parameters stay visible.

**3. Script.** This is not a step. This is the test code that sets up the run: the stub replies that are enqueued, the files that are written, the directories that are prepared. It is laid out in the test, as it needs to be visible. We need to see all the parameters for it. Nothing here is extracted into a function. What every path in a block shares is not one test's script: it is setup at that block's level, where every path below it receives it.

## The tree shape

Tests are arranged in nested blocks. One block opens a context. A block nested one level deeper extends that context. A further level of nesting extends it again. Each nesting can hold tests, and each nesting can hold more nestings. Every test runs as one path from the root to where the test sits. For example:

- A1
  - A1.1
    - A1.1.1
    - A1.1.2
  - A1.2
- B1
  - B1.1

runs four tests: A1-A1.1-A1.1.1, A1-A1.1-A1.1.2, A1-A1.2, B1-B1.1. Each test traverses its own path with the setup of every level above it. Nothing runs except these paths. A block that holds no test produces no run.

Setup that a whole block shares is placed at that block's level, so every path below it receives it. The fully qualified test name — the full path, for example `A1 > A1.1 > A1.1.1` — is available inside the test and is used as the stub route prefix, so no test can see another test's stub replies or recorded requests.

## Setup and teardown

The test body is flat. There is no try/finally nesting. The Initialize step prepares the test's directories and files and registers the test teardown for itself. The teardown runs when the test finishes, whether the test passes or fails. It runs only for tests that called Initialize. Tests that never call it are unaffected. There is no shared teardown for the whole file.

## Adding new tests

There is one tree, because there is one starting point. Before writing a test, look at all the branches that already exist. The new test goes into the existing tree: either as a new branch, or into an existing branch — for example, a new assertion added to a path that is already there. The tree holds the whole flow, so every new test is placed with the entire tree in mind. A separate tree is built only when the starting point is different, which is not the case.

A new path that opens the way an existing path opens is a branch of that path, and branches share by hoisting. Everything both paths receive — the isolated world, the installed extension, and the fixtures both paths read — moves to the block both paths sit under, in that block's `beforeEach`, so each path below still gets its own world and its own teardown. The existing path moves with its prefix: its shared setup lines leave its body for the block while its assertions move verbatim and keep passing. What stays inline in a test body is only what forks — the script that test writes (a reply parameter, for instance) and its own verification steps. The new test is then a sibling of the existing path inside the shared block, not a block of its own. A test that re-derives a prefix a path already has is not a branch: it is a second tree.

## What stays fixed and what may change

Fixed: the split into application steps, verification steps, and script. Application steps are functions with only the necessary parameters. Verification steps and script stay inline and visible. Tests are trees of nested blocks. All integration tests of this kind follow this methodology.

May change: the set of application steps. New steps are added when new tests need them. Steps are merged when two steps always appear together, and split when a test needs to act or assert between them. Names may change. The current set is a starting point, not the final set.
