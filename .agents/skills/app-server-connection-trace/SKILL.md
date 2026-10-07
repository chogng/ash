---
name: app-server-connection-trace
description: Locate latency in Ash Desktop's App Server connection or reconnection, from Renderer acquire through protocol initialization. Trace the Electron and Rust boundaries, then route detailed investigation to the owning process.
---

# App Server connection trace

Use this skill to find which boundary delays a Desktop App Server connection. The primary interval starts when the Renderer calls `transport.acquire()` and ends when `client.connect()` and `transport.initialized()` complete. The daemon's compatibility probe happens before the Renderer protocol initialization; measure both. `initializeWorkspace()` and Workbench readiness follow connection completion and are separate outcomes.

## Follow the connection path

Read the current call path before adding marks:

| Boundary | Owner | Source |
| --- | --- | --- |
| Acquire a port, run protocol `initialize`, acknowledge initialization | Renderer | `src/ash/platform/native/electron-browser/rendererApi.ts` and `src/ash/platform/app-server/electron-browser/appServerMessagePortTransport.ts` |
| Validate and launch the command carrier, attach its port, relay frames | Electron Main | `src/ash/platform/app-server/electron-main/appServerConnectionRelay.ts` |
| Start or reuse the managed App Server, wait for its endpoint, probe `initialize` | Rust daemon | `crates/app-server-daemon/src/client.rs` and `process.rs` |
| Open the managed runtime and serve protocol `initialize` | Rust App Server | `crates/app-server/src/managed/registry.rs` and `crates/app-server/src/local.rs` |

On initial startup, Main's `startAppServerWithRecovery` precedes window creation, but the relay usually launches the command carrier when the Renderer acquires its connection. On reconnect, the Renderer disconnects its client, acquires a new port, and initializes again. Recheck these paths when they change. The Renderer's nonce identifies its exchange with Main; current code does not carry that nonce into the Rust daemon, so do not claim end-to-end correlation from it alone.

## Measure, then hand off to the owner

1. Choose the scenario: stopped daemon, reused daemon, or reconnect after a dropped connection. Add a fresh profile only when first-run storage or permission work is part of the question. Record build ID, OS and CPU, profile and workspace conditions, backend binary, connection mode, and whether the daemon was already running. Use an isolated test profile and credentials.
2. Mark the Renderer `acquire → client.connect → transport.initialized` interval with one monotonic clock. Record its result, run ID, and the nonce for the Renderer/Main exchange. In Main, mark validation, command launch, port attachment, and initialization acknowledgement. In Rust, mark process selection/spawn, endpoint readiness, the daemon probe, and App Server initialization at their owners. Record process, PID, phase, elapsed time, and error. Pair timestamps only within one process or at a single observer boundary unless clocks are aligned.
3. Follow the slow interval. For Main or Renderer CPU work, capture an Electron/Chromium trace or CPU profile and use [cpu-profile-analysis](../cpu-profile-analysis/SKILL.md). For idle time, inspect IPC, port delivery, process launch, and protocol responses. For daemon or App Server work, use narrowly scoped Rust `Instant` spans and inspect the daemon probe separately from the Renderer's later `initialize`. Keep instrumentation equivalent in baseline and candidate runs.
4. Run each relevant scenario at least five times on the same machine and build type. Keep timeouts and failures in the report with their errors. Compare individual samples, median, and error count for the slow owned interval and the complete Renderer connection interval. Verify the user's visible symptom separately after changing code.

VS Code's `../vscode/src/vs/workbench/services/timer/browser/timerService.ts` keeps startup marks with their process source; its `startupTimings.ts` checks startup conditions before interpreting a duration. Apply both practices here. A faster socket accept or daemon `--version` is evidence about that step only.

Rust's WebSocket span exporter uses `ASH_TRACE_WEBSOCKET_ADDR` and `ASH_TRACE_WEBSOCKET_TOKEN` for a directly launched App Server. Check `src/ash/platform/app-server/common/appServerEnvironment.ts` before expecting those variables in Desktop: its current allowlist does not forward them. Confirm that spans were captured before using them as evidence.

## Use Desktop startup as an impact check

The opt-in Playwright test below measures launch request through usable Workbench. It includes window creation, automation, connection, workspace setup, trust interaction on fresh profiles, and rendering. It does **not** identify an App Server connection bottleneck by itself. Use it after the connection trace to check whether a change improves the visible result:

```sh
ASH_DESKTOP_STARTUP_TRACE=1 pnpm exec playwright test test/smoke/areas/windows/desktop-startup-trace.spec.ts --project=electron-app-server
```

It records five samples each for fresh, stopped, reused, and UI-only cohorts under `.build/startup-trace/desktop-<run-id>/desktop-startup-trace.json`. Compare two reports with `python3 scripts/desktop_startup_trace.py <baseline-json> <candidate-json>`. The script checks matched conditions and shows samples, medians, observer intervals, and failures. These observer intervals share the Playwright worker clock; `first-window → workbench-ready` contains several stages and is not a backend duration. `test/smoke/areas/windows/home.spec.ts` separately covers reopening an authorized workspace after its backend stops.

## Report and cleanup

State the measured slow boundary, its process owner, samples, median, failures, and supporting raw marks or logs. Distinguish daemon probe, Renderer protocol initialization, workspace setup, and Workbench readiness. Save machine-readable evidence under ignored `.build/startup-trace/<run-id>/`; redact credentials and home paths before sharing it. Stop only processes and delete only profiles created for the trace. When code changes, follow the matching TypeScript, Rust, and testing instructions; use Playwright for Electron UI verification.

## Learnings

- Close each test Electron window before stopping its managed daemon. Stopping the daemon while its Renderer is still running triggers reconnect and can turn cleanup into a test-only initialization timeout.
