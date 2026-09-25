---
name: test-tui
description: Test Ash Code TUI behavior in process with ash-tui component and App tests and insta snapshots. Use test-tui-pty for real CLI, PTY, or host-terminal boundaries.
---

# Test Ash Code TUI behavior

Use this skill for `ash-tui` component, feature, and App behavior that can be verified in process. Choose the cheapest test owner that proves the behavior; use [test-tui-pty](../test-tui-pty/SKILL.md) only when the behavior depends on the real CLI process, PTY, or host terminal.

## Choose the owning test

| Change | Test owner | Verification |
| --- | --- | --- |
| Component, feature, or fixed page rendering | `code/tui` sibling `*_tests.rs` | Fixed-size Ratatui `TestBackend` and a snapshot of visible output |
| Keyboard path, streaming phase, queue, approval, recovery, page navigation, or agent-manager flow | `code/tui` App or feature simulation test | Drive the real App or feature with typed input and scripted external responses |
| State transition, event routing, request payload, sequence, or file side effect | Narrow owning test | Typed semantic assertions; add a snapshot when visible text or layout is part of the behavior |

Keep detailed screen-state coverage in the owning App or feature tests. Do not move deterministic rendering or App interaction into the PTY suite or duplicate the same screen matrix at every layer. Use the PTY skill for a small representative check of the actual process or terminal boundary.

## Simulate interaction flows

1. Construct a fresh real `App` or feature with fixed typed fixtures. Inject keys through `handle_key` and protocol-facing changes through the production typed event/update entrypoints.
2. Assert emitted `AppCommand` values, request payloads, lifecycle changes, and other semantic results separately from the snapshot.
3. Render the resulting state through a fixed-size `TestBackend` and snapshot the complete visible surface. Reuse one render helper within the owning test module.
4. Fake only external boundaries. Use manual channels and direct typed events when the App owner is enough; use the in-process App Server with a scripted `OperationClient` when request, reducer, or streaming integration is part of the behavior. Do not recreate a production reducer inside a mock.
5. Drive asynchronous phases with explicit gates, received events, call counts, or state predicates. A timeout may bound a test, but a sleep must not decide when the snapshot is ready.

`code/tui/src/app/conversation_flow_tests.rs` is the in-process scripted-model example. Smaller App and feature scenarios should stay beside their owner and inject typed events directly.

## Snapshot views

Add or update an `insta` baseline when visible terminal output changes. Snapshot overlays, completion popups, approvals, queries, status notices, retry states, and other temporary views when they are represented by explicit App or feature state. Reach the view through typed events or user input, assert that the expected state is active, then render one deterministic frame. When dismissal or restoration is part of the contract, cover the open state and the resulting state after dismissal, with semantic assertions proving which underlying screen and focus were restored.

Use fixed fixture values and terminal dimensions. Cover another width only when wrapping, truncation, or responsive layout is part of the behavior. Normalize host paths, generated IDs, wall-clock values, or platform separators only when they are outside the tested contract. Freeze or inject the relevant tick when a spinner or timeout state is visible; do not race the production clock.

Text snapshots do not capture foreground/background colors or modifiers. When these communicate state or focus, assert the actual rendered buffer cells separately, including marker position, theme color, and modifiers. For animation, inject fixed times into the production renderer and assert representative phases and repeatability; do not copy the animation formula into the test or test only a detached color helper. A `TestBackend` captures only the Ratatui buffer; use the owning host or PTY test for behavior outside that surface.

Use `insta::assert_snapshot!` for substantial external snapshots. Inline snapshots fit short local output that is easier to review beside the test. Give snapshots behavior-based names. A screenshot, manual run, generated text file, or environment-gated export is not a regression snapshot because it cannot fail when the UI changes. Do not add a new export environment variable, write tracked baselines with `fs::write`, or silently skip an assertion when an environment variable is absent. Files under `code/tui/page-snapshots` are review artifacts, not `insta` expectations. When replacing a view, replace its relevant snapshot coverage instead of deleting the old baselines without equivalents.

## Run and review

Start with the smallest package and test filter that owns the behavior:

```bash
just test ash-tui <test-filter>
```

An intentional new or changed external snapshot should fail first and leave a `.snap.new` file. Inspect pending snapshots and open each affected file directly:

```bash
find code -name '*.snap.new' -print
cargo insta show path/to/snapshot.snap.new
```

Read every changed row, including whitespace, wrapping, clipping, and omitted content. Confirm that the test reached the intended state and that no host path, credential, generated identity, unstable duration, or unrelated UI churn entered the baseline. Treat a snapshot diff as evidence, not approval; trace unexpected output to the state and renderer owner. If many unrelated snapshots change, inspect shared theme, width, wrapping, or normalization behavior instead of bulk-accepting unexplained churn.

Accept a reviewed snapshot by its exact expected path:

```bash
cargo insta accept --snapshot path/to/snapshot.snap
```

Use `cargo insta review --snapshot path/to/snapshot.snap` when interactive review is available. Accept snapshots individually unless all pending changes in scope have been reviewed. Do not use `INSTA_UPDATE=always` as the ordinary update workflow.

After acceptance, rerun the same targeted test without an update environment variable and confirm `find code -name '*.snap.new' -print` returns no pending snapshots. Review the `.snap`, `.snap.new`, test source, `git diff`, and `git status` together. For behavior requiring the real terminal or process boundary, continue with [test-tui-pty](../test-tui-pty/SKILL.md).
