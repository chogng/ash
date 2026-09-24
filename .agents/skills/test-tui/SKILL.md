---
name: test-tui
description: Test Ash Code TUI behavior and rendering with owner-level Rust tests, App simulations, insta snapshots, real PTY scenarios, or an interactive run. Use for TUI changes, regressions, snapshots, and terminal verification; do not use for non-TUI Rust or desktop UI.
---

# Test Ash Code TUI

Choose the cheapest owner-level test that proves the behavior, and add an `insta` baseline when visible terminal output changes. Follow the Codex TUI test shape: simulate most interaction states against the real App or feature owner with typed inputs, and reserve full-process PTY tests for behavior that actually depends on the terminal or process boundary. A generated `.txt` file, screenshot, manual run, or environment-gated export is not a snapshot test because it cannot fail when the UI changes.

## Choose the owning test layer

| Change | Test owner | Snapshot input |
| --- | --- | --- |
| Component, feature, or fixed page rendering | `code/tui` sibling `*_tests.rs` | A fixed-size Ratatui `TestBackend` buffer or other user-visible text |
| Keyboard path, streaming phase, queue, approval, recovery, page navigation, or agent-manager flow | `code/tui` App or feature simulation test | The real App or feature after typed keys, events, commands, and scripted external responses have reached an explicit state |
| Raw mode, PTY encoding, process composition, terminal resize/reflow, signal handling, resume across process startup, or transport wiring | `ash-cli/tests/tui/{terminal,conversation,config,issues}.rs` | `TuiProcess::assert_snapshot` after an explicit process-observable state is reached |
| State transition, event routing, request payload, sequence, timing, or file/process side effect | The narrow owning test | A typed equality or semantic assertion; add a snapshot only when user-visible text or layout is also part of the behavior |

Prefer the cheapest layer that includes the behavior owner. Do not move a deterministic renderer or App interaction test into the full-process suite. Do not replace a PTY behavior assertion with a simulation when the real terminal lifecycle is the behavior. Do not duplicate the same screen-state matrix at every layer: simulations own detailed visual states, while PTY tests keep a small representative set of boundary checks.

Snapshot paths follow the owning Rust test module through `insta`; they do not follow a feature name merely because a CLI scenario also exercises that feature. For example, a Config page layout belongs to a `ash-tui` Config or App-frame snapshot, while a CLI scenario that changes the same setting should assert the persisted value without owning a duplicate screen baseline.

## Run interactively

Use `just ash` from the repository root when a real interactive terminal materially improves verification. When driving it programmatically, send text first and Enter in a separate write, then wait for a state-specific marker before the next action. Use an isolated profile or fixture for scenarios that write configuration or repository state. Interactive verification supplements the owning automated tests; it does not replace them.

## Simulate interaction flows

Use the same pattern as Codex TUI widget tests:

1. Construct a fresh real `App` or feature with fixed typed fixtures. Inject keys through `handle_key` and protocol-facing changes through the same typed event/update entrypoints used by production.
2. Capture and assert emitted `AppCommand` values, request payloads, lifecycle changes, and other semantic results separately from the snapshot.
3. Render the resulting state through a fixed-size `TestBackend` and snapshot the complete visible surface. Reuse one shared render helper within the owning test module instead of open-coding buffer extraction in every case.
4. Fake only external boundaries. Use manual channels and direct typed events when the App owner is enough; use the in-process App Server with a scripted `OperationClient` when the request, reducer, or streaming integration is part of the behavior. Do not recreate a production reducer inside a mock.
5. Drive asynchronous phases with explicit gates, received events, call counts, or state predicates. A timeout may bound the test, but a sleep must not be the condition that makes a snapshot ready.

For PTY input, wait for terminal output revision to advance and reach a quiet frame before capture. Keep that revision independent of any bounded raw-output diagnostic buffer so truncating diagnostics cannot make a changing screen look stable. A screen marker must distinguish the target state from the state before the action; text already visible in a background list, transcript, or covered screen does not prove that navigation completed.

Run real PTY scenarios through `just test-tui <test-filter>`. This entrypoint builds the matching App Server daemon before the CLI integration test; do not invoke the `ash-cli` PTY target directly because a stale daemon binary can disagree with the newly built client.

`code/tui/src/app/conversation_flow_tests.rs` is the in-process scripted-model example. Smaller App and feature scenarios should stay beside their owner and inject typed events directly. A `simulated/` copy of the full `real/` page hierarchy is not required; organize snapshots by the owning Rust test module, as Codex does.

## Snapshot temporary views

Snapshot an overlay, completion popup, approval, query, status notice, retry state, or other temporary view when it is represented by explicit App or feature state. Reach it through typed events or user input, assert that the expected temporary state is active, then render one deterministic frame. When dismissal or restoration is part of the contract, snapshot both the open state and the state after Esc, completion, timeout, or replacement, with semantic assertions proving which underlying screen and focus were restored.

Freeze or inject the relevant tick when a spinner, timeout, or animation frame is visible; do not race the production clock. A `TestBackend` cannot capture terminal-emulator UI, an OS dialog, the host terminal's native selection, or another surface outside the Ratatui buffer. Cover those with the narrow host/PTY behavior test and assert its observable result rather than fabricating it inside App state.

Text snapshots do not capture foreground/background colors or modifiers. When these convey state or focus, assert the actual rendered buffer cells separately, including marker position, theme color, and modifiers. For animation, inject fixed times into the production renderer and assert representative phases and repeatability; do not copy the animation formula into the test or only test a detached color helper. Keep semantic assertions proving that input/events reached the intended state. When replacing a view, replace its relevant snapshot coverage rather than deleting the old baselines without equivalents.

## Author snapshots

1. Read the repository, Rust, testing, and `code` TUI instructions before editing.
2. Keep the test beside the owner in a sibling `*_tests.rs`; use the corresponding module under `ash-cli/tests/tui/` only for behavior that crosses a real CLI, transport, terminal, or process boundary. Keep `tui_real_scenarios.rs` as the single integration-test entry point and reuse `tests/support`; do not add scenario bodies to the entry point or make each module a separate Cargo test target.
3. Construct typed state and use a fixed terminal width and height. Cover another width only when wrapping, truncation, resize, or responsive layout is the behavior.
4. Stabilize the input rather than hiding changes in the output. Use fixed fixture values and normalize host paths, generated IDs, wall-clock values, or platform separators only when they are not the behavior under test.
5. Assert state, commands, payloads, lifecycle, and side effects independently. Snapshot the complete user-visible surface that makes the UI change reviewable.
6. Use `insta::assert_snapshot!` for substantial external snapshots. Inline snapshots are appropriate only for short, local output that remains easier to review beside the test.
7. Give explicit snapshot names in behavior language. For real PTY states, call `TuiProcess::assert_snapshot` or `assert_snapshot_containing`; the helper preserves the scenario directory in `ash-cli/tests/snapshots`.

Do not add a new export environment variable, write tracked baselines with `fs::write`, or silently skip an assertion when an environment variable is absent. Files under `code/tui/page-snapshots` are review artifacts rather than `insta` expectations and do not prove a snapshot test passed.

## Generate and review changes

Start with the smallest package and test filter that owns the behavior. Most new interaction snapshots should use the first command; use the second only for a real boundary:

```bash
just test ash-tui <test-filter>
just test-tui <test-filter>
```

An intentional new or changed external snapshot should first fail and leave a `.snap.new` file. Inspect pending snapshots and open each affected file directly:

```bash
find code -name '*.snap.new' -print
cargo insta show path/to/snapshot.snap.new
```

Read every changed row, including whitespace, wrapping, clipping, and omitted content. Confirm that the test reached the intended state and that no host path, credential, generated identity, unstable duration, or unrelated UI churn entered the baseline.

Accept a reviewed snapshot by its exact expected path:

```bash
cargo insta accept --snapshot path/to/snapshot.snap
```

Use `cargo insta review --snapshot path/to/snapshot.snap` when interactive review is available. Accept every pending snapshot separately unless all workspace-wide pending changes have been verified as part of the current task. Never use `INSTA_UPDATE=always` as the ordinary update workflow.

After acceptance, rerun the same targeted test without an update environment variable and confirm `find code -name '*.snap.new' -print` returns no pending snapshots.

## Review failures

- Treat a snapshot diff as evidence, not approval. Trace unexpected text or layout to the state and renderer owner before changing the baseline.
- If many unrelated snapshots change, find the shared theme, width, wrapping, or normalization owner; do not bulk-accept unexplained churn.
- If a detailed interaction scenario exists only in `tui_real_scenarios.rs`, first ask whether the behavior can be simulated against the real App owner. Keep or add a PTY case only for the boundary it uniquely verifies.
- If a transient PTY snapshot flakes, replace timing guesses with a gate, stable-screen wait, or an explicit expected marker before capture. Do not add sleeps as the pass condition.
- When a wait returns too early, first check whether its marker was already present before the action. Strengthen the state predicate instead of accepting the prematurely captured frame.
- Preserve intentional whitespace. Normalize only values that are nondeterministic and outside the tested contract.
- Keep terminal text snapshots secondary to command-line-observable state, events, output, timing, lifecycle, protocol payloads, and side effects.

## Finish

Run the smallest `just test` command covering the changed test and production owner. Review `.snap`, `.snap.new`, the test source, `git diff`, and `git status` together. Report which snapshots changed, why each change is intentional, which semantic assertions cover the behavior, and whether pending snapshots remain.
