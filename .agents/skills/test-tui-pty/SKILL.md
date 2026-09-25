---
name: test-tui-pty
description: Test Ash Code behavior across the real CLI process, PTY, and host terminal. Use for raw mode, terminal encoding or resize, signals, process composition, resume across startup, and transport wiring; use test-tui for in-process App and rendering behavior.
---

# Test Ash Code across a real terminal boundary

Use this skill only when behavior depends on the real `ash` CLI process, PTY, or host terminal. Examples include raw-mode lifecycle, PTY encoding, terminal resize/reflow, signal handling, process composition, resume across process startup, and transport wiring. For detailed App interaction and rendering states, use [test-tui](../test-tui/SKILL.md); keep PTY snapshots to representative checks of the boundary that only a real process can exercise.

## Own the real-process scenario

- Put scenario bodies in `ash-cli/tests/tui/{terminal,conversation,config,issues}.rs` and keep `ash-cli/tests/tui_real_scenarios.rs` as the single integration-test entry point. Reuse `ash-cli/tests/support`; do not add a separate Cargo test target for each scenario.
- Drive the CLI through `TuiProcess` and use its `assert_snapshot` method for terminal frames. Snapshots are stored under `ash-cli/tests/snapshots/`.
- Assert observable state, output, timing, lifecycle, protocol payloads, and side effects separately where the scenario makes a behavioral claim. A terminal snapshot alone does not prove a command or side effect occurred.
- Keep detailed state combinations in App simulation tests. Add only the PTY cases needed to prove process, terminal, or transport behavior.

## Make capture deterministic

Wait for terminal output revision to advance and reach a quiet frame before capturing. Keep that revision independent of any bounded raw-output diagnostic buffer so truncating diagnostics cannot make a changing screen appear stable.

A screen marker must distinguish the target state from the state before the action. Text already visible in a background list, transcript, or covered screen does not prove that navigation completed. If a wait returns too early, check whether the marker was present before the action and strengthen the state predicate.

Replace timing guesses with a gate, stable-screen wait, or explicit expected marker. A timeout may bound the wait, but a sleep must not be the condition that makes a snapshot ready. Use fixed fixture values and normalize host paths, generated IDs, wall-clock values, or platform separators only when they are outside the tested contract.

## Run and review

Run real PTY scenarios through the repository entry point:

```bash
just test-tui <test-filter>
```

This entry point builds the matching App Server daemon before running the CLI integration test. Do not invoke the `ash-cli` PTY target directly: a stale daemon binary can disagree with the newly built client.

Review every affected pending snapshot, including snapshots outside `code/`:

```bash
find ash-cli -name '*.snap.new' -print
cargo insta show path/to/snapshot.snap.new
```

Read every changed row and confirm the frame reached the intended state. Treat diffs as evidence rather than approval; trace unexpected text or layout to its owner. Accept a reviewed snapshot by its exact expected path:

```bash
cargo insta accept --snapshot path/to/snapshot.snap
```

After acceptance, rerun the same `just test-tui` filter without an update environment variable and confirm `find ash-cli -name '*.snap.new' -print` returns no pending snapshots. Do not use `INSTA_UPDATE=always` as the ordinary update workflow.

Use `just ash` for an interactive terminal run when it materially improves verification. When driving it programmatically, send text and Enter in separate writes, wait for a state-specific marker before the next action, and use an isolated profile or fixture for scenarios that write configuration or repository state. Interactive verification supplements automated tests; it does not replace them.

Playwright's `validate-ui-scenario` covers Ash's graphical Web/Electron window. It does not replace this PTY flow for `ash code` terminal behavior.
